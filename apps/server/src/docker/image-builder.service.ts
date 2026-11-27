import { RegistryCredentialsService } from '../projects/registry-credentials.service';
import { Injectable, BadRequestException, Optional } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { BuildKitPoolService } from './buildkit-pool.service';
import { loadKubeConfigFromPathOrBase64 } from '../kubernetes/kubeconfig';
import { OrgEventsService } from '../events/org-events.service';
import {
  startPhaseSpan,
  recordPhaseSpan,
  recordBuildOutcome,
  tagActiveSpan
} from '../analytics/datadog';
import { truncateK8sName } from '../projects/projects.utils';
import {
  RAILPACK_INFO_MARKER,
  ORCHARD_RAILPACK_CONFIG,
  parseRailpackInfo,
  railpackConfigOverride,
  resolveScratchMode
} from './build-config';
import { sandboxStartFailure } from './build-sandbox';
import { cacheEvictInitContainer } from './cache-evict';
import { NEXT_CACHE_SUFFIX, cacheSwapScript } from './build-cache-settings';
import { BuildCacheService } from './build-cache.service';
import { parseRepoUrl, withCloneCredentials } from './repo-url';
import { gitCloneScript } from './clone-script';
import { assertSafeBuildInputs, shellQuote } from './build-input';
import {
  injectBuildArgsScript,
  injectableBuildArgKeys,
  buildSecretFlags,
  secretBuildArgNotice
} from './build-args';
import {
  maskSecretValues,
  registryHostsOf,
  sanitizeBuildLogMessage,
  secretValuesToMask
} from './build-log-redaction';
import { BUILDER_NAMESPACE } from './builder-namespace';
import {
  BUILD_CACHE_KEY_TTL_MS,
  BUILD_CACHE_PURPOSE,
  buildkitdEnvPreamble,
  mintBuildCacheKey,
  S3_CACHE_KEY_ENV,
  S3_CACHE_SECRET_ENV,
  S3_TOUCH_REFRESH,
  s3CacheRoute,
  s3CacheRouteNotice,
  sharedS3KeyAllowed,
  tenantWritePrefix,
  type S3CacheTarget
} from './build-cache-s3';
import { objectStorage, tenantBackupTarget } from '../instance-config/object-storage';
import { parseImageRef, sameRegistryHost } from '../projects/image-ref';
import {
  assertBuildRegistryConfigured,
  BUILD_PLATFORM,
  buildArchNodeSelector
} from './build-platform';
import {
  builderContainerSecurityContext,
  buildkitImageFor,
  effectiveSidecarPush,
  logBuildPosture,
  rootlessAppArmorAnnotations,
  rootlessBuildkitdFlags,
  rootlessDaemonlessWrapper,
  rootlessDaemonStart,
  rootlessPreflightScript,
  resolveBuildPosture,
  ROOTLESS_CONFIG_KEY,
  ROOTLESS_DOCKER_CONFIG,
  ROOTLESS_UID
} from './build-posture';
import { BUILDER_ROLE, BUILDER_ROLE_BINDING } from './builder-rbac';
import { k8sErrorMessage } from '../kubernetes/k8s-error';
import { isSandboxStartFault } from './build-faults';
import { summarizeBuildFailure } from './build-summary';
import {
  createRawjsonTranscoder,
  transcodeRawjson,
  type RawjsonTranscoder
} from './buildkit-rawjson';
import { BUILDER_RESERVED_ENV_KEYS, builderContainerEnv, buildSafeEnv } from '../env/reserved-env';
import {
  FcBuildRequest,
  FcEvent,
  FcStep,
  FcStream,
  FcUnavailableError,
  FirecrackerClient
} from './fc/fc-client';
import {
  dockerConfigJson,
  hasRegistryAuths,
  mergeRegistryAuths,
  PullAuthError,
  pullAuthsFromEnv,
  registryAuth,
  type RegistryAuths
} from './registry-pull-auth';
import { daemonTenantLabel, TENANT_KEY_LABEL } from './buildkit-daemon-policy';
import { depotOutputFlags, depotScriptTail, depotSessionAuths } from './depot-session';
import { BuildJobInformerService } from './build-job-informer.service';
import { isUnseenTerminalSignal, remainingIntervalMs } from './build-poll-pacing';
import { podLogText } from '../kubernetes/pod-log-text';
import { platformRegistryApi } from './registry-api';
import { deleteTags, platformImage } from './registry-prune.service';
import {
  ALPINE_GIT_IMAGE,
  ALPINE_IMAGE,
  BUILDPACK_DEPS_SCM_IMAGE,
  RAILPACK_MISE_IMAGE,
  SKOPEO_IMAGE
} from './helper-images';

interface BuildJobOptions {
  repoUrl: string;
  branch: string;
  dockerfilePath: string;
  imageName: string;
  tag?: string;
  deploymentId?: string;
  accessToken?: string;
  target?: string;
  buildFromRoot?: boolean;
  buildType?: 'dockerfile' | 'railpack';
  /**
   * Repo-relative directory of the app for Railpack builds. Already validated
   * by normalizeRootDirectory before it reaches here: it is interpolated into
   * the prepare container's shell script.
   */
  rootDirectory?: string | null;
  envVars?: Record<string, string>;
  secretEnvKeys?: string[];
  buildWithDepot?: boolean;
  // Presigned GET URL for an uploaded build-context tarball ("orchard up").
  // When set, the git-clone init container is replaced by a fetch-and-extract
  // step; everything downstream (BuildKit, phases, log streaming) is
  // unchanged.
  localContextUrl?: string;
  // Per-tenant key used as the subPath on the shared buildkit-cache PVC.
  // Without this, every build pod sees the entire PVC and a malicious build
  // (root inside the Kata VM) can read/poison cache entries from other
  // tenants. With subPath, the Kata mount surface only exposes this tenant's
  // slice. Set to the project namespace by the caller.
  cacheTenantKey?: string;
  // When true, builds connect to a persistent BuildKit daemon pod (managed
  // by BuildKitPoolService) instead of running buildctl-daemonless.sh in
  // each Job. The daemon keeps its layer cache warm between builds, so
  // unchanged layers are instant cache hits (like Depot).
  persistentBuildCache?: boolean;
  disableSharedCache?: boolean;
  // Set only by buildAndPush's own retry after a Kata sandbox start fault, so
  // an unlucky pod gets a second attempt and a broken node still fails fast.
  sandboxRetried?: boolean;
  builder?: 'kubernetes' | 'depot' | 'firecracker';
}

export interface BuildJobStatus {
  jobName: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'unknown';
  logs?: string;
  pusherLogs?: string;
  imageRef?: string;
  /** Raw railpack-info.json line, when the prepare init container produced one. */
  railpackInfoLog?: string;
  /** Scheduler's reason when the pod could not be placed, e.g. an unbound PVC. */
  schedulingMessage?: string;
  /** Kubelet's reason when a scheduled pod's containers cannot be created. */
  startupMessage?: string;
}

const BUILDKIT_PUSH_PHASE_RE =
  /exporting to [^\n]*image|exporting layers|sending tarball|pushing manifest/i;

const BUILDKIT_STEP_RE = /(?:^|\n)#(?:[0-9a-f]{8}|\d+)\s/;

const MANIFEST_ACCEPT =
  'application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json';

/** Main container of a super build Job; BuildKit jobs use `buildkit`. */
const DEPOT_CONTAINER = 'depot-build';

const BUILD_ENV_SECRET_KEYS = {
  cloneUrl: 'orchard.clone-url',
  contextUrl: 'orchard.context-url',
  depotToken: 'orchard.depot-token',
  dockerAuthJson: 'orchard.docker-auth-json',
  s3CacheKeyId: 'orchard.s3-cache-key-id',
  s3CacheSecret: 'orchard.s3-cache-secret'
} as const;

type ScopedS3Cache = {
  target: S3CacheTarget;
  accessKey: string;
  secret: string;
};

type S3CachePlan = { kind: 'direct' } | { kind: 'scoped'; scoped: ScopedS3Cache } | { kind: 'off' };
const BUILD_ARG_ENV_PREFIX = 'ORCHARD_BUILD_ARG_';
const BUILD_META_VOLUME = 'build-meta';
const BUILD_META_PATH = '/orchard-build';
const BUILD_DIR_FILE = `${BUILD_META_PATH}/dir`;

export function dockerfileDirGuard(dockerfilePath?: string): string {
  const slash = dockerfilePath?.lastIndexOf('/') ?? -1;
  if (!dockerfilePath || slash <= 0) return '';
  const dir = `'${dockerfilePath.slice(0, slash).replace(/'/g, `'\\''`)}'`;
  return `
if [ -d ${dir} ]; then
  case "$(cd ${dir} && pwd -P)" in
    /workspace|/workspace/*) ;;
    *) echo "ERROR: refusing to build outside /workspace: ${dockerfilePath.replace(/["$`\\]/g, '')}"; exit 1 ;;
  esac
fi
`;
}

type BuildctlArg = string | { shell: string };

const renderBuildctlArg = (arg: BuildctlArg) =>
  typeof arg === 'string' ? shellQuote(arg) : arg.shell;

const secretEnv = (name: string, secretName: string, key: string): k8s.V1EnvVar => ({
  name,
  valueFrom: { secretKeyRef: { name: secretName, key } }
});

const buildArgEnvName = (index: number) => `${BUILD_ARG_ENV_PREFIX}${index}`;

@Injectable()
export class ImageBuilderService {
  private kc: k8s.KubeConfig | null = null;

  private buildkitLogOffsets = new Map<string, number>();

  private buildkitTranscoders = new Map<string, RawjsonTranscoder>();

  private buildkitPushDetected = new Set<string>();

  private buildSecretValues = new Map<string, string[]>();

  private buildkitBuildingDetected = new Set<string>();

  private railpackInfoFetched = new Set<string>();

  private readonly builderNamespace = BUILDER_NAMESPACE;

  // Internal Harbor registry for pushing (HTTP on port 80)
  private readonly harborRegistryPush = process.env.DOCKER_REGISTRY_PUSH || '';

  private readonly plainHttpRegistries = new Set<string>(
    (process.env.REGISTRY_HTTP_HOSTS || '').split(',').filter(Boolean)
  );

  private readonly pusherRegistryHost =
    this.plainHttpRegistries.has(this.harborRegistryPush) && !/:\d+$/.test(this.harborRegistryPush)
      ? `${this.harborRegistryPush}:80`
      : this.harborRegistryPush;

  private readonly harborRegistryPull = process.env.DOCKER_REGISTRY_PULL || '';

  private readonly harborProject = process.env.REGISTRY_PROJECT || 'orchard';

  private readonly registrySecretName =
    process.env.REGISTRY_PULL_SECRET_NAME || 'harbor-registry-creds';

  private readonly depotToken = process.env.DEPOT_TOKEN;

  private readonly depotProjectId = process.env.DEPOT_PROJECT_ID;

  // S3/R2 cache configuration
  // For Cloudflare R2, the endpoint format is: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
  private readonly s3CacheEnabled = process.env.BUILDKIT_S3_CACHE_ENABLED === 'true';

  private get s3Endpoint(): string | undefined {
    return process.env.BUILDKIT_S3_ENDPOINT || objectStorage().endpoint || undefined;
  }

  private readonly s3Region = process.env.BUILDKIT_S3_REGION || 'auto';

  private get s3Bucket(): string {
    return process.env.BUILDKIT_S3_BUCKET || objectStorage().bucketName || 'buildkit-cache';
  }

  private get s3AccessKeyId(): string | undefined {
    return process.env.BUILDKIT_S3_ACCESS_KEY_ID || objectStorage().accessKeyId || undefined;
  }

  private get s3SecretAccessKey(): string | undefined {
    return (
      process.env.BUILDKIT_S3_SECRET_ACCESS_KEY || objectStorage().secretAccessKey || undefined
    );
  }

  private readonly s3CachePrefix = process.env.BUILDKIT_S3_CACHE_PREFIX || 'buildkit-cache/';

  // Local cache configuration: when enabled, overrides S3 cache and uses a
  // path inside the build pod (optionally backed by a PVC for persistence).
  private readonly localCacheEnabled = process.env.BUILDKIT_LOCAL_CACHE_ENABLED === 'true';

  private readonly builderPosture = resolveBuildPosture();

  private readonly rootless = this.builderPosture === 'rootless';

  private readonly buildkitImage = buildkitImageFor(this.builderPosture);

  // rawjson landed in BuildKit v0.15. The escape hatch is for anyone pinning
  // BUILDKIT_IMAGE to something older, where buildctl rejects the mode
  // outright; `plain` still parses, just with BuildKit's own display lag.
  private readonly buildkitProgress = process.env.BUILDKIT_PROGRESS || 'rawjson';

  // Railpack ships three artefacts on independent version lines: the CLI that
  // writes the plan, the BuildKit gateway frontend that executes it, and the
  // mise base image the prepare step runs in. Left floating on `latest`, a
  // Railway release could change every Orchard build with no deploy on our side,
  // and a CLI/frontend plan-schema mismatch would break builds outright. Pin them
  // together; bump deliberately.
  private readonly railpackVersion = process.env.RAILPACK_VERSION || 'v0.43.0';

  private readonly railpackFrontendImage =
    process.env.RAILPACK_FRONTEND_IMAGE ||
    `ghcr.io/railwayapp/railpack-frontend:${process.env.RAILPACK_VERSION || 'v0.43.0'}`;

  private readonly railpackMiseImage = process.env.RAILPACK_MISE_IMAGE || RAILPACK_MISE_IMAGE;

  private readonly localCachePath = process.env.BUILDKIT_LOCAL_CACHE_PATH || '/cache/buildkit';

  private readonly localCachePvc = process.env.BUILDKIT_LOCAL_CACHE_PVC;

  // Mirrors builders.localCache.gcKeepBytes / gcEphemeralKeepBytes in the
  // chart. The chart renders a buildkit-config ConfigMap carrying these too,
  // but ensureBuildkitConfig replaces that ConfigMap wholesale at runtime, so
  // they have to be threaded through here as well or the chart's GC policy is
  // silently dropped on the first build.
  private readonly gcKeepBytes = process.env.BUILDKIT_GC_KEEP_BYTES || '18GB';

  private readonly gcEphemeralKeepBytes = process.env.BUILDKIT_GC_EPHEMERAL_KEEP_BYTES || '1GB';

  // BuildKit's GC only bounds a single worker's root, and every build gets its
  // own worker rooted in its own subPath of the shared PVC: nothing in
  // BuildKit bounds the *sum* across tenants. So the volume fills, kubelet can
  // no longer mkdir the next tenant's subPath, and the build dies with an
  // opaque CreateContainerConfigError. These knobs drive the tenant-level
  // sweep in cacheEvictInitContainer, which is what actually bounds the total.
  private readonly cacheEvictHighPct = Number(process.env.BUILDKIT_CACHE_HIGH_PCT || 80);

  private readonly cacheEvictTargetPct = Number(process.env.BUILDKIT_CACHE_TARGET_PCT || 60);

  private readonly cacheEvictMaxAgeDays = Number(process.env.BUILDKIT_CACHE_MAX_AGE_DAYS || 14);

  // A tenant whose cache was touched more recently than this is assumed to have
  // a build in flight and is never evicted under pressure.
  private readonly cacheEvictIdleMinutes = Number(process.env.BUILDKIT_CACHE_IDLE_MINUTES || 60);

  // When enabled, build jobs are pinned to nodes labelled `orchard-builder=true`
  // (and tolerate a matching `orchard-builder` NoSchedule taint if present).
  private readonly dedicatedNodeEnabled = process.env.BUILDER_DEDICATED_NODE === 'true';

  // Sandboxing toggles: both default off so prior versions behave identically.
  //   BUILDER_RUNTIME_CLASS: if set (e.g. "kata"), the build Job pod selects
  //     that RuntimeClass. With Kata each pod gets its own lightweight VM, so
  //     the privileged BuildKit container is privileged-in-VM, not on host.
  //   BUILDER_SIDECAR_PUSH: if "true", the BuildKit container runs as an
  //     init container with NO Harbor push creds mounted; a tiny `crane`
  //     pusher container runs after it (as the Job's main container) with
  //     the creds and pushes the OCI tarball BuildKit wrote to /output.
  //     Defence-in-depth against a malicious Dockerfile / BuildKit RCE
  //     exfiltrating `/root/.docker/config.json`.
  private readonly builderRuntimeClass =
    (process.env.BUILDER_RUNTIME_CLASS || '').trim() || undefined;

  // Super builds execute on Depot's machines; the in-cluster pod only clones,
  // tars and uploads, so it never runs repo code and does not need a VM per
  // build. Falls back to BUILDER_RUNTIME_CLASS when unset.
  private readonly depotRuntimeClass =
    (process.env.BUILDER_DEPOT_RUNTIME_CLASS || '').trim() || undefined;

  private readonly sidecarPushEnabled = effectiveSidecarPush(this.builderPosture);

  private readonly sourceCpuLimit = (process.env.BUILDER_SOURCE_CPU_LIMIT || '').trim() || '2';

  private readonly pusherImage = process.env.BUILDER_PUSHER_IMAGE || SKOPEO_IMAGE;

  private readonly workspaceTmpfs = process.env.BUILDER_WORKSPACE_TMPFS === 'true';

  // Scratch defaults to whatever the isolation setting implies.
  //
  // tmpfs exists to dodge virtio-fs, which is only in the path when the build
  // runs inside a kata VM. Without a runtime class the pod is plain runc on the
  // node, so RAM-backed scratch buys nothing and costs a lot: it is charged to
  // the pod's memory cgroup, so a 40Gi scratch against a 32Gi memory limit caps
  // how many builds fit on a node by RAM rather than by disk. Self-hosted
  // instances run without isolation by default and were paying that for free.
  //
  // BUILDER_SCRATCH_MODE still wins when set, so an operator (and prod, which
  // pins tmpfs explicitly) keeps whatever they chose.
  private readonly scratchMode = ((mode) => (this.rootless && mode === 'block' ? 'disk' : mode))(
    resolveScratchMode(process.env.BUILDER_SCRATCH_MODE, this.builderRuntimeClass)
  );

  private readonly scratchBlock = this.scratchMode === 'block';

  // Disk-backed scratch: a plain emptyDir on the node, reached over virtio-fs
  // instead of the hypervisor's virtio-blk path. Slower than a raw block device
  // for snapshotter metadata, but it is not RAM, so it does not compete with the
  // build's memory limit the way medium: Memory does. It also needs no CSI
  // driver, which makes it the portable option where none is configured.
  private readonly scratchDisk = this.scratchMode === 'disk';

  // RAM-backed scratch. tmpfs supports d_type and xattrs, so overlayfs can use
  // it as an upperdir and BuildKit keeps its copy-on-write snapshotter. It is
  // charged to the pod's memory cgroup and is not reclaimable, so it carries a
  // sizeLimit: without one a single build can consume the whole node.
  private readonly scratchTmpfs = this.scratchMode === 'tmpfs';

  private readonly scratchSize = process.env.BUILDER_SCRATCH_SIZE || '40Gi';

  private readonly scratchStorageClass = process.env.BUILDER_SCRATCH_STORAGE_CLASS || undefined;

  private readonly pendingScheduleTimeoutSeconds = Number(
    process.env.BUILDER_PENDING_SCHEDULE_TIMEOUT_SECONDS || 300
  );

  private static readonly SCRATCH_DEVICE = '/dev/buildscratch';

  private builderInfraReady = false;

  private deploymentOrgCache = new Map<string, { orgId: string; projectId: string }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    @Optional() private readonly buildKitPool?: BuildKitPoolService,
    @Optional() private readonly jobInformer?: BuildJobInformerService,
    @Optional() private readonly firecracker?: FirecrackerClient,
    @Optional() private readonly registryCredentials?: RegistryCredentialsService,
    @Optional() private readonly buildCache?: BuildCacheService
  ) {
    this.initKubeConfig();
    logBuildPosture(this.builderPosture, this.builderRuntimeClass);
    this.logS3CacheRoute();
  }

  private async emitBuildChanged(deploymentId: string | undefined) {
    if (!deploymentId) return;
    let ctx = this.deploymentOrgCache.get(deploymentId);
    if (!ctx) {
      const dep = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { projectId: true, project: { select: { organizationId: true } } }
      });
      if (!dep) return;
      ctx = { orgId: dep.project.organizationId, projectId: dep.projectId };
      this.deploymentOrgCache.set(deploymentId, ctx);
    }
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'build.changed',
      id: deploymentId,
      projectId: ctx.projectId
    });
  }

  private initKubeConfig() {
    try {
      this.kc = new k8s.KubeConfig();
      if (process.env.KUBECONFIG_BASE64) {
        let base64Value = process.env.KUBECONFIG_BASE64.trim();
        while (
          (base64Value.startsWith('"') && base64Value.endsWith('"')) ||
          (base64Value.startsWith("'") && base64Value.endsWith("'"))
        ) {
          base64Value = base64Value.slice(1, -1).trim();
        }
        const decoded = Buffer.from(base64Value, 'base64').toString('utf-8');
        this.kc.loadFromString(decoded);
      } else if (process.env.KUBECONFIG_PATH) {
        loadKubeConfigFromPathOrBase64(this.kc, process.env.KUBECONFIG_PATH);
      } else {
        this.kc.loadFromDefault();
      }
      console.log('[ImageBuilder] Successfully loaded kubeconfig');
    } catch (error) {
      console.error('[ImageBuilder] Error loading kubeconfig:', error.message);
      this.kc = null;
    }
  }

  private ensureKubeConfig() {
    if (!this.kc) {
      throw new BadRequestException('Kubernetes API not available');
    }
  }

  private generateJobName(imageName: string): string {
    const hash = crypto.randomBytes(4).toString('hex');
    const sanitized = truncateK8sName(
      imageName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/^-+/, ''),
      40
    );
    return `image-builder-${sanitized || 'image'}-${hash}`;
  }

  private sanitizeLogMessage(message: string, deploymentId?: string): string {
    const sanitized = sanitizeBuildLogMessage(
      message,
      registryHostsOf([this.harborRegistryPush, this.harborRegistryPull])
    );
    return deploymentId
      ? maskSecretValues(sanitized, this.buildSecretValues.get(deploymentId))
      : sanitized;
  }

  // BuildKit jobs run a `buildkit` container; super builds run `depot-build`
  // instead. Reading logs from a container the pod doesn't have throws, and a
  // super build would stream nothing at all.
  private mainContainerName(containerStatuses?: k8s.V1ContainerStatus[]): string {
    return containerStatuses?.some((cs) => cs.name === DEPOT_CONTAINER)
      ? DEPOT_CONTAINER
      : 'buildkit';
  }

  private async appendLog(
    deploymentId: string | undefined,
    message: string,
    level: 'INFO' | 'ERROR' | 'WARNING' = 'INFO'
  ) {
    if (!deploymentId) return;

    try {
      const timestamp = Date.now();
      const sanitizedMessage = this.sanitizeLogMessage(message, deploymentId);
      const line = `[${timestamp}] [${level}] ${sanitizedMessage}\n`;

      await this.prisma.$executeRaw`
        UPDATE "deployments"
        SET "build_logs" = COALESCE("build_logs", '') || ${line},
            "updated_at" = (NOW() AT TIME ZONE 'UTC')
        WHERE "id" = ${deploymentId}::uuid
      `;
    } catch (error) {
      console.error('[ImageBuilder] Failed to append log:', error);
    }
  }

  // Stream raw BuildKit pod output into deployment.buildLogs, appending only
  // the new chunk since last poll (so the frontend can parse the full #N step
  // history). Tracks offset per job so re-polling the full pod log doesn't
  // duplicate content. The pod emits rawjson, which is transcoded to the `#id`
  // text format here; super builds emit plain text and pass straight through.
  private async streamBuildkitOutput(
    deploymentId: string | undefined,
    jobName: string,
    fullLogs: string | undefined,
    final = false
  ) {
    if (!deploymentId || !fullLogs) return;
    const raw = this.takeLogChunk(jobName, fullLogs);
    const transcoder = this.transcoderFor(jobName);
    let chunk = raw === null ? '' : transcoder.feed(raw);
    if (final) chunk += transcoder.flush();
    if (!chunk) return;

    await this.appendStreamedChunk(deploymentId, chunk, jobName, fullLogs.length);

    if (!this.buildkitBuildingDetected.has(jobName) && BUILDKIT_STEP_RE.test(chunk)) {
      this.buildkitBuildingDetected.add(jobName);
      await this.setBuildStep(deploymentId, 'building');
    }

    if (!this.buildkitPushDetected.has(jobName) && BUILDKIT_PUSH_PHASE_RE.test(chunk)) {
      this.buildkitPushDetected.add(jobName);
      await this.setBuildStep(deploymentId, 'pushing');
    }

    this.emitBuildChanged(deploymentId).catch(() => {});
  }

  // Close every step still open on a build that will never report again.
  private async flushBuildkitSteps(deploymentId: string | undefined, jobName: string) {
    const transcoder = this.buildkitTranscoders.get(jobName);
    if (!deploymentId || !transcoder) return;
    const chunk = transcoder.flush();
    if (!chunk) return;
    await this.appendStreamedChunk(deploymentId, chunk);
    this.emitBuildChanged(deploymentId).catch(() => {});
  }

  private transcoderFor(jobName: string): RawjsonTranscoder {
    let transcoder = this.buildkitTranscoders.get(jobName);
    if (!transcoder) {
      transcoder = createRawjsonTranscoder();
      this.buildkitTranscoders.set(jobName, transcoder);
    }
    return transcoder;
  }

  private async streamPusherOutput(
    deploymentId: string | undefined,
    jobName: string,
    pusherLogs: string | undefined
  ) {
    if (!deploymentId || !pusherLogs) return;
    const chunk = this.takeLogChunk(`${jobName}:pusher`, pusherLogs);
    if (chunk === null) return;
    await this.appendStreamedChunk(deploymentId, chunk, `${jobName}:pusher`, pusherLogs.length);
    this.emitBuildChanged(deploymentId).catch(() => {});
  }

  private async seedLogOffsets(jobName: string, deploymentId?: string) {
    if (!deploymentId || this.buildkitLogOffsets.has(jobName)) return;
    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildStepTimestamps: true }
      });
      const offsets = ((deployment?.buildStepTimestamps as Record<string, any>)?.__logOffsets ??
        {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(offsets)) {
        if (key !== jobName && !key.startsWith(`${jobName}:`)) continue;
        if (typeof value === 'number' && !this.buildkitLogOffsets.has(key)) {
          this.buildkitLogOffsets.set(key, value);
        }
      }
    } catch {
      return;
    }
  }

  private takeLogChunk(offsetKey: string, fullLogs: string): string | null {
    const offset = this.buildkitLogOffsets.get(offsetKey) ?? 0;
    if (fullLogs.length <= offset) return null;
    this.buildkitLogOffsets.set(offsetKey, fullLogs.length);
    return fullLogs.slice(offset);
  }

  private async appendStreamedChunk(
    deploymentId: string,
    chunk: string,
    offsetKey?: string,
    offsetValue?: number
  ) {
    try {
      const sanitized = this.sanitizeLogMessage(chunk, deploymentId);
      if (offsetKey !== undefined && offsetValue !== undefined) {
        await this.prisma.$executeRaw`
          UPDATE "deployments"
          SET "build_logs" = CASE
            WHEN "build_logs" IS NULL OR "build_logs" = '' THEN ${sanitized}
            WHEN RIGHT("build_logs", 1) = E'\n' THEN "build_logs" || ${sanitized}
            ELSE "build_logs" || E'\n' || ${sanitized}
          END,
          "build_step_timestamps" = jsonb_set(
            jsonb_set(
              COALESCE("build_step_timestamps", '{}'::jsonb),
              '{__logOffsets}',
              COALESCE("build_step_timestamps"->'__logOffsets', '{}'::jsonb),
              true
            ),
            ARRAY['__logOffsets', ${offsetKey}],
            to_jsonb(${offsetValue}::bigint),
            true
          ),
          "updated_at" = (NOW() AT TIME ZONE 'UTC')
          WHERE "id" = ${deploymentId}::uuid
        `;
        return;
      }
      await this.prisma.$executeRaw`
        UPDATE "deployments"
        SET "build_logs" = CASE
          WHEN "build_logs" IS NULL OR "build_logs" = '' THEN ${sanitized}
          WHEN RIGHT("build_logs", 1) = E'\n' THEN "build_logs" || ${sanitized}
          ELSE "build_logs" || E'\n' || ${sanitized}
        END,
        "updated_at" = (NOW() AT TIME ZONE 'UTC')
        WHERE "id" = ${deploymentId}::uuid
      `;
    } catch (error) {
      console.error('[ImageBuilder] Failed to stream pod output:', error);
    }
  }

  private clearBuildkitOffset(jobName: string) {
    this.buildkitLogOffsets.delete(jobName);
    this.buildkitLogOffsets.delete(`${jobName}:pusher`);
    this.buildkitTranscoders.delete(jobName);
  }

  private async stampBuildTime(deploymentId: string | undefined, key: string) {
    if (!deploymentId) return;
    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildStepTimestamps: true }
      });
      if (!deployment) return;
      const timestamps = (deployment.buildStepTimestamps as Record<string, number> | null) || {};
      if (typeof timestamps[key] === 'number') return;
      timestamps[key] = Date.now();
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { buildStepTimestamps: timestamps }
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2025') return;
      console.error('[ImageBuilder] Failed to stamp build time:', error);
    }
  }

  private async markCloning(deploymentId: string | undefined) {
    if (!deploymentId) return;
    const updated = await this.prisma.$executeRaw`
      UPDATE "deployments"
      SET "build_step" = 'cloning',
          "build_step_timestamps" = jsonb_set(
            COALESCE("build_step_timestamps", '{}'::jsonb),
            '{cloning}',
            ${Date.now()}::text::jsonb
          ),
          "updated_at" = (NOW() AT TIME ZONE 'UTC')
      WHERE "id" = ${deploymentId}::uuid AND "build_step" IS NULL
    `;
    if (updated > 0) this.emitBuildChanged(deploymentId).catch(() => {});
  }

  private async setBuildStep(deploymentId: string | undefined, step: string) {
    if (!deploymentId) return;

    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildStepTimestamps: true }
      });
      if (!deployment) return;

      const timestamps = (deployment.buildStepTimestamps as Record<string, number> | null) || {};
      timestamps[step] = Date.now();

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { buildStep: step, buildStepTimestamps: timestamps }
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2025') return;
      console.error('[ImageBuilder] Failed to set build step:', error);
    }
  }

  async ensureBuilderNamespace(): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);

    const namespaceLabels = {
      'app.kubernetes.io/managed-by': 'orchard-image-builder',
      purpose: 'image-builds',
      // Required for BuildKit privileged containers - exempts from PodSecurity
      'pod-security.kubernetes.io/enforce': 'privileged',
      'pod-security.kubernetes.io/audit': 'privileged',
      'pod-security.kubernetes.io/warn': 'privileged'
    };

    try {
      const existingNs = await coreApi.readNamespace(this.builderNamespace);
      console.log(`[ImageBuilder] Namespace ${this.builderNamespace} already exists`);

      // Check if pod-security labels are set, if not, patch the namespace
      const existingLabels = existingNs.body.metadata?.labels || {};
      if (existingLabels['pod-security.kubernetes.io/enforce'] !== 'privileged') {
        console.log(
          `[ImageBuilder] Patching namespace ${this.builderNamespace} with pod-security labels`
        );
        await coreApi.patchNamespace(
          this.builderNamespace,
          { metadata: { labels: namespaceLabels } },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
        );
      }
    } catch (error) {
      if (error.statusCode === 404) {
        console.log(`[ImageBuilder] Creating namespace ${this.builderNamespace}`);
        await coreApi.createNamespace({
          metadata: {
            name: this.builderNamespace,
            labels: namespaceLabels
          }
        });
      } else {
        throw error;
      }
    }
  }

  private harborAuths(): RegistryAuths {
    const username = process.env.HARBOR_USERNAME || 'admin';
    const password = process.env.HARBOR_PASSWORD || '';
    const auth = registryAuth(username, password);
    const auths: RegistryAuths = {};
    for (const host of [
      this.harborRegistryPush,
      this.pusherRegistryHost,
      this.harborRegistryPull
    ]) {
      if (host) auths[host] = auth;
    }
    return auths;
  }

  private async secretExists(name: string): Promise<boolean> {
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    try {
      await coreApi.readNamespacedSecret(name, this.builderNamespace);
      return true;
    } catch (error) {
      if (error.statusCode === 404) return false;
      throw error;
    }
  }

  private dockerConfigSecretBody(
    name: string,
    auths: RegistryAuths,
    extraMetadata: k8s.V1ObjectMeta
  ): k8s.V1Secret {
    return {
      metadata: {
        name,
        namespace: this.builderNamespace,
        ...extraMetadata
      },
      type: 'kubernetes.io/dockerconfigjson',
      data: {
        '.dockerconfigjson': Buffer.from(JSON.stringify(dockerConfigJson(auths))).toString('base64')
      }
    };
  }

  private async createDockerConfigSecret(
    name: string,
    auths: RegistryAuths,
    extraMetadata: k8s.V1ObjectMeta = {}
  ): Promise<void> {
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    await coreApi.createNamespacedSecret(
      this.builderNamespace,
      this.dockerConfigSecretBody(name, auths, extraMetadata)
    );
  }

  private async upsertDockerConfigSecret(
    name: string,
    auths: RegistryAuths,
    extraMetadata: k8s.V1ObjectMeta = {}
  ): Promise<void> {
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    const body = this.dockerConfigSecretBody(name, auths, extraMetadata);
    try {
      await coreApi.readNamespacedSecret(name, this.builderNamespace);
      await coreApi.replaceNamespacedSecret(name, this.builderNamespace, body);
    } catch (error) {
      if (error.statusCode === 404) {
        await coreApi.createNamespacedSecret(this.builderNamespace, body);
      } else {
        throw error;
      }
    }
  }

  private async createOpaqueSecret(
    name: string,
    stringData: Record<string, string>,
    extraMetadata: k8s.V1ObjectMeta = {}
  ): Promise<void> {
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    await coreApi.createNamespacedSecret(this.builderNamespace, {
      metadata: { name, namespace: this.builderNamespace, ...extraMetadata },
      type: 'Opaque',
      stringData
    });
  }

  private async deleteBuildJobSecrets(jobName: string): Promise<void> {
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    const secrets = await coreApi.listNamespacedSecret(
      this.builderNamespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `orchard.my/build-job=${jobName}`
    );
    for (const secret of secrets.body.items) {
      const name = secret.metadata?.name;
      if (!name) continue;
      await coreApi.deleteNamespacedSecret(name, this.builderNamespace).catch(() => {});
    }
  }

  async ensureBuilderSecrets(): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    if (process.env.HARBOR_PASSWORD || !(await this.secretExists(this.registrySecretName))) {
      await this.upsertDockerConfigSecret(this.registrySecretName, this.harborAuths());
    }

    if (
      this.s3CacheEnabled &&
      sharedS3KeyAllowed(process.env) &&
      this.s3AccessKeyId &&
      this.s3SecretAccessKey
    ) {
      const s3SecretName = 'buildkit-s3-cache-creds';
      try {
        await coreApi.readNamespacedSecret(s3SecretName, this.builderNamespace);
        await coreApi.replaceNamespacedSecret(s3SecretName, this.builderNamespace, {
          metadata: {
            name: s3SecretName,
            namespace: this.builderNamespace
          },
          type: 'Opaque',
          stringData: {
            AWS_ACCESS_KEY_ID: this.s3AccessKeyId,
            AWS_SECRET_ACCESS_KEY: this.s3SecretAccessKey
          }
        });
      } catch (error) {
        if (error.statusCode === 404) {
          await coreApi.createNamespacedSecret(this.builderNamespace, {
            metadata: {
              name: s3SecretName,
              namespace: this.builderNamespace
            },
            type: 'Opaque',
            stringData: {
              AWS_ACCESS_KEY_ID: this.s3AccessKeyId,
              AWS_SECRET_ACCESS_KEY: this.s3SecretAccessKey
            }
          });
        } else {
          throw error;
        }
      }
    }

    await this.ensureBuilderConfigMap();
  }

  async ensureBuilderConfigMap(): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);

    const configMapName = 'buildkit-config';

    const httpRegistries = this.plainHttpRegistries;

    // For plain HTTP registries, use ONLY http=true
    // insecure=true means "HTTPS with self-signed cert", NOT "allow HTTP"
    // See: https://github.com/moby/buildkit/issues/4458
    // External registries (e.g. OVH, Docker Hub) use HTTPS and should NOT have http=true
    const registryConfigs = Array.from(httpRegistries)
      .map(
        (reg) => `[registry."${reg}"]
  http = true`
      )
      .join('\n\n');

    const rlimits = `
  [[worker.oci.rlimits]]
    type = "RLIMIT_NOFILE"
    soft = 1048576
    hard = 1048576
`;
    const buildConfig = (withRlimits: boolean) => `# BuildKit daemon configuration
debug = true

[worker.oci]
  max-parallelism = 4
  gc = true

  # This is a *per-tenant* ceiling: every build runs its own buildkitd rooted
  # in its own subPath, so N tenants can hold N x gcKeepBytes on one PVC. The
  # total is bounded by the cache-evict init container, not here. Keep this
  # well under the PVC size so a single tenant can't fill it alone.
  [[worker.oci.gcpolicy]]
    keepBytes = "${this.gcEphemeralKeepBytes}"
    filters = ["type==source.local", "type==exec.cachemount", "type==source.git.checkout"]

  [[worker.oci.gcpolicy]]
    all = true
    keepBytes = "${this.gcKeepBytes}"
${withRlimits ? rlimits : ''}
[worker.containerd]
  enabled = false

# Registry configuration for insecure registries
# The key must match exactly how the registry is referenced in the image name
${registryConfigs}
`;
    const buildkitConfig = buildConfig(true);
    const configData = {
      'buildkitd.toml': buildkitConfig,
      [ROOTLESS_CONFIG_KEY]: buildConfig(false)
    };

    try {
      await coreApi.readNamespacedConfigMap(configMapName, this.builderNamespace);
      await coreApi.replaceNamespacedConfigMap(configMapName, this.builderNamespace, {
        metadata: {
          name: configMapName,
          namespace: this.builderNamespace,
          labels: {
            'app.kubernetes.io/name': 'image-builder',
            'app.kubernetes.io/managed-by': 'orchard'
          }
        },
        data: configData
      });
    } catch (error) {
      if (error.statusCode === 404) {
        await coreApi.createNamespacedConfigMap(this.builderNamespace, {
          metadata: {
            name: configMapName,
            namespace: this.builderNamespace,
            labels: {
              'app.kubernetes.io/name': 'image-builder',
              'app.kubernetes.io/managed-by': 'orchard'
            }
          },
          data: configData
        });
      } else {
        throw error;
      }
    }
  }

  private s3CacheRoute() {
    return s3CacheRoute(process.env, tenantBackupTarget()?.bucket ?? null);
  }

  private async planS3Cache(
    deploymentId: string | undefined,
    cacheTenantKey: string | undefined
  ): Promise<S3CachePlan> {
    const route = this.s3CacheRoute();
    if (route.via === 'direct') {
      if (sharedS3KeyAllowed(process.env)) return { kind: 'direct' };
      console.warn(`[ImageBuilder] ${s3CacheRouteNotice(route, process.env).message}`);
      return { kind: 'off' };
    }
    try {
      const organizationId = deploymentId ? await this.organizationOf(deploymentId) : null;
      const writePrefix = tenantWritePrefix(route.basePrefix, cacheTenantKey);
      if (!organizationId || !writePrefix) {
        console.warn(
          '[ImageBuilder] S3 build cache skipped: no organization or tenant key to scope a cache key to'
        );
        return { kind: 'off' };
      }
      const minted = mintBuildCacheKey();
      await this.prisma.storageAccessKey.create({
        data: {
          accessKey: minted.accessKey,
          secret: minted.secret,
          organizationId,
          writePrefix,
          readPrefixes: [],
          purpose: BUILD_CACHE_PURPOSE,
          operationId: null,
          expiresAt: new Date(Date.now() + BUILD_CACHE_KEY_TTL_MS)
        }
      });
      return {
        kind: 'scoped',
        scoped: {
          target: {
            endpoint: route.endpoint,
            bucket: route.bucket,
            region: 'auto',
            basePrefix: writePrefix,
            scoped: true
          },
          accessKey: minted.accessKey,
          secret: minted.secret
        }
      };
    } catch (error) {
      console.warn(
        `[ImageBuilder] S3 build cache skipped, could not mint a tenant-scoped key: ${k8sErrorMessage(error)}`
      );
      return { kind: 'off' };
    }
  }

  private async organizationOf(deploymentId: string): Promise<string | null> {
    const cached = this.deploymentOrgCache.get(deploymentId);
    if (cached) return cached.orgId;
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { projectId: true, project: { select: { organizationId: true } } }
    });
    if (!dep) return null;
    this.deploymentOrgCache.set(deploymentId, {
      orgId: dep.project.organizationId,
      projectId: dep.projectId
    });
    return dep.project.organizationId;
  }

  private async revokeBuildCacheKey(accessKey: string): Promise<void> {
    await this.prisma.storageAccessKey.deleteMany({ where: { accessKey } }).catch(() => {});
  }

  private logS3CacheRoute(): void {
    if (!this.s3CacheEnabled || this.localCacheEnabled) return;
    const notice = s3CacheRouteNotice(this.s3CacheRoute(), process.env);
    console[notice.level](`[ImageBuilder] ${notice.message}`);
  }

  private buildCacheArgs(imageName?: string, s3Plan?: S3CachePlan): BuildctlArg[] {
    if (this.localCacheEnabled) {
      if (this.buildCache && !this.buildCache.current().enabled) return [];
      const sub = imageName ? imageName.replace(/[^a-z0-9-]/gi, '-') : 'default';
      const cacheDir = `${this.localCachePath}/${sub}`;
      console.log(`[ImageBuilder] Local cache enabled - path: ${cacheDir}`);
      const importCache = `type=local,src=${cacheDir}`;
      const exportCache = `type=local,dest=${cacheDir}${NEXT_CACHE_SUFFIX},mode=max,compression=zstd,ignore-error=true`;
      return ['--import-cache', importCache, '--export-cache', exportCache];
    }

    if (!s3Plan || s3Plan.kind === 'off') return [];
    const scoped = s3Plan.kind === 'scoped' ? s3Plan.scoped.target : null;
    const endpoint = scoped?.endpoint ?? this.s3Endpoint;
    const bucket = scoped?.bucket ?? this.s3Bucket;
    const region = scoped?.region ?? this.s3Region;
    const basePrefix = scoped?.basePrefix ?? this.s3CachePrefix;

    if (!this.s3CacheEnabled || !endpoint || !bucket) {
      console.log('[ImageBuilder] S3 cache disabled or not configured');
      return [];
    }

    // Namespace cache per image to prevent cross-deployment cache contamination.
    // Without this, BuildKit can resolve a multi-stage build's final image config
    // from cached layers of a different deployment sharing the same base image,
    // resulting in missing CMD/WORKDIR/ENTRYPOINT from the runner stage.
    const cachePrefix = imageName
      ? `${basePrefix}${imageName.replace(/[^a-z0-9-]/gi, '-')}/`
      : basePrefix;

    console.log(
      `[ImageBuilder] S3 cache enabled - endpoint: ${endpoint}, bucket: ${bucket}, prefix: ${cachePrefix}`
    );

    // BuildKit S3 cache format for Cloudflare R2
    // R2 is S3-compatible but requires specific settings:
    // - endpoint_url must be the full R2 endpoint
    // - region should be 'auto' for R2
    // - use_path_style should be true for R2
    // Note: buildctl uses --import-cache and --export-cache (not --cache-from/--cache-to)
    const touch = scoped ? `,touch_refresh=${S3_TOUCH_REFRESH}` : '';
    const importCache = `type=s3,endpoint_url=${endpoint},bucket=${bucket},region=${region},prefix=${cachePrefix},use_path_style=true${touch}`;
    const exportCache = `type=s3,endpoint_url=${endpoint},bucket=${bucket},region=${region},prefix=${cachePrefix},mode=min,use_path_style=true${touch}`;

    return ['--import-cache', importCache, '--export-cache', exportCache];
  }

  private createDepotContainer(opts: {
    dockerfilePath: string;
    fullImageName: string;
    target?: string;
    buildFromRoot: boolean;
    buildType: string;
    envVars: Record<string, string>;
    secretEnvKeys?: string[];
    envSecretName: string;
    sidecarPush: boolean;
  }): k8s.V1Container {
    const {
      dockerfilePath,
      fullImageName,
      target,
      buildFromRoot,
      buildType,
      envVars,
      secretEnvKeys,
      envSecretName,
      sidecarPush
    } = opts;
    const depotTail = depotScriptTail(sidecarPush);

    // Keys are interpolated into the depot build shell string below. Reject
    // anything that isn't a POSIX identifier: same rule applied elsewhere
    // in this service and in projects.service.
    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const key of Object.keys(envVars)) {
      if (!ENV_KEY_RE.test(key)) {
        throw new BadRequestException(`Invalid environment variable key: ${key}`);
      }
    }

    // Depot does not support Railpack here: the Railpack path writes a BuildKit
    // frontend plan (`railpack-plan.json`) and no Dockerfile ever exists, so the
    // build would fail deep inside depot with a confusing "not found". Fail fast
    // with something actionable instead.
    if (buildType === 'railpack') {
      throw new BadRequestException(
        "Super builds don't support automatic (Railpack) builds yet. Turn off super builds for this app, or switch it to a Dockerfile build."
      );
    }

    let contextDir = '.';
    let dockerfileFlag = dockerfilePath;

    if (!buildFromRoot && dockerfilePath.includes('/')) {
      contextDir = dockerfilePath.substring(0, dockerfilePath.lastIndexOf('/'));
      dockerfileFlag = dockerfilePath.substring(dockerfilePath.lastIndexOf('/') + 1);
    }

    const depotRegistry = this.harborRegistryPull;
    const depotImageName = fullImageName.startsWith(`${this.harborRegistryPush}/`)
      ? `${depotRegistry}/${fullImageName.slice(this.harborRegistryPush.length + 1)}`
      : fullImageName;

    // Build the depot build command parts safely.
    //
    // The values reach the script through the environment rather than the
    // command line so they stay out of the process list, but they are carried
    // under generated names: exporting them under the user's own names lets a
    // variable called PATH or DOCKER_CONFIG reconfigure the container running
    // the build. Indexes rather than a prefix, so a deployment that already has
    // an ORCHARD_BUILD_ARG_-shaped key cannot collide with a real one.
    const depotBuildArgs = Object.keys(envVars).map((key, index) => ({
      key,
      envName: buildArgEnvName(index)
    }));
    const buildArgLines = [
      ...depotBuildArgs.map(({ key, envName }) => `--build-arg "${key}=\${${envName}}"`),
      ...buildSecretFlags(Object.keys(envVars), secretEnvKeys, (_key, index) =>
        buildArgEnvName(index)
      ).map((flag) => `--secret "${flag}"`)
    ].join(' ');

    // Same lint behavior as the BuildKit path: without this, a repo's
    // "# check=error=true" directive fails depot builds that pass locally.
    const checkArgLine =
      'BUILDKIT_DOCKERFILE_CHECK' in envVars
        ? ''
        : '--build-arg "BUILDKIT_DOCKERFILE_CHECK=skip=SecretsUsedInArgOrEnv"';

    const targetFlag = target ? `--target ${shellQuote(target)}` : '';

    const injectGitSha = buildType !== 'railpack' && !('GIT_SHA' in envVars);
    const gitShaArgLine = injectGitSha ? '--build-arg "GIT_SHA=$GIT_SHA"' : '';

    const depotScript = `set -e
GIT_SHA=$(git -C /workspace rev-parse HEAD 2>/dev/null || echo unknown)
echo "=== Installing Super Build tools ==="
if ! command -v curl >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq curl
fi
curl -fsSL https://depot.dev/install-cli.sh | sh
export PATH="/root/.depot/bin:$PATH"
command -v depot >/dev/null 2>&1 || { echo "ERROR: Super Build CLI install failed"; exit 1; }

${depotTail.pre}mkdir -p /tmp/.docker
printf '%s\n' "$DOCKER_AUTH_JSON" > /tmp/.docker/config.json
export DOCKER_CONFIG=/tmp/.docker

echo "=== Building with Super Builds ==="
echo 0 > /tmp/build_rc
{ depot build \\
  --progress plain \\
  --platform ${BUILD_PLATFORM} \\
  -f ${shellQuote(dockerfileFlag)} \\
  ${depotOutputFlags({ sidecarPush, imageName: depotImageName })} \\
  ${targetFlag} \\
  ${checkArgLine} \\
  ${gitShaArgLine} \\
  ${buildArgLines} \\
  ${shellQuote(contextDir)} 2>&1 || echo "$?" > /tmp/build_rc; } | sed -u -e 's/\\[depot\\]/[super-build]/gi' -e 's|https://depot\\.dev/[^ ]*||g' -e 's/depot build/super build/gi'
BUILD_RC=$(cat /tmp/build_rc)
${depotTail.post}if [ "$BUILD_RC" -ne 0 ]; then
  echo "=== Super Build failed (exit code $BUILD_RC) ==="
  exit "$BUILD_RC"
fi

echo "=== Super Build completed ==="
`;

    return {
      name: DEPOT_CONTAINER,
      image: BUILDPACK_DEPS_SCM_IMAGE,
      command: ['/bin/sh', '-c'],
      args: [depotScript],
      workingDir: '/workspace',
      env: [
        secretEnv('DEPOT_TOKEN', envSecretName, BUILD_ENV_SECRET_KEYS.depotToken),
        ...(this.depotProjectId ? [{ name: 'DEPOT_PROJECT_ID', value: this.depotProjectId }] : []),
        secretEnv('DOCKER_AUTH_JSON', envSecretName, BUILD_ENV_SECRET_KEYS.dockerAuthJson),
        ...depotBuildArgs.map(({ key, envName }) => secretEnv(envName, envSecretName, key))
      ],
      volumeMounts: [
        {
          name: 'workspace',
          mountPath: '/workspace'
        },
        ...(sidecarPush ? [{ name: 'output', mountPath: '/output' }] : [])
      ],
      resources: {
        requests: {
          cpu: '200m',
          memory: '512Mi'
        },
        limits: {
          cpu: '1',
          memory: '2Gi'
        }
      }
    };
  }

  private readonly ramdiskPreamble: string = '';

  private get scratchMountPreamble(): string {
    if (!this.scratchBlock) return '';
    const dev = ImageBuilderService.SCRATCH_DEVICE;
    return `
if ! mountpoint -q /buildkit-state 2>/dev/null; then
  mkdir -p /buildkit-state
  for _i in $(seq 1 20); do [ -b ${dev} ] && [ "$(blockdev --getsize64 ${dev} 2>/dev/null)" -gt 0 ] 2>/dev/null && break; sleep 0.25; done
  if [ -b ${dev} ]; then
    command -v mkfs.ext4 >/dev/null 2>&1 || apk add --no-cache e2fsprogs >/dev/null 2>&1
    mkfs.ext4 -q -F -E lazy_itable_init=1,nodiscard ${dev} && sync
    for _i in 1 2 3 4 5; do mount ${dev} /buildkit-state 2>/dev/null && break; sleep 0.5; done
    if mountpoint -q /buildkit-state; then
      echo "=== Build scratch mounted on a dedicated disk ($(df -h /buildkit-state | awk 'NR==2{print $2}')) ==="
    else
      echo "WARNING: build scratch device present but mount failed; using container filesystem"
    fi
  else
    echo "WARNING: build scratch device ${dev} not present; using container filesystem"
  fi
fi
`;
  }

  /**
   * Generate a shell snippet that prunes *this tenant's own* per-image cache
   * directories when disk usage exceeds 80%, oldest-idle first, until usage
   * drops below 70%. It runs inside the buildkit container, whose cache mount
   * is the tenant's subPath, so `df` reports the whole shared PVC but the
   * loop can only ever delete our own entries. Cross-tenant eviction is
   * `cacheEvictInitContainer`'s job.
   */
  private cachePrunePreamble(selfCacheDir = ''): string {
    if (!this.localCacheEnabled) return '';
    return `
# --- Prune local build cache if disk is getting full ---
CACHE_ROOT="${this.localCachePath}"
CACHE_SELF="${selfCacheDir}"
if [ -d "$CACHE_ROOT" ]; then
  USAGE=$(df "$CACHE_ROOT" | awk 'NR==2 {sub(/%/,"",$5); print $5}')
  if [ "$USAGE" -gt 80 ] 2>/dev/null; then
    echo "=== Cache disk usage at \${USAGE}%, pruning oldest idle entries ==="
    ls -1dt "$CACHE_ROOT"/*/ 2>/dev/null | tac | while read -r dir; do
      [ -d "$dir" ] || continue
      [ -n "$CACHE_SELF" ] && [ "\${dir%/}" = "\${CACHE_SELF%/}" ] && continue
      if find "$dir" -maxdepth 1 -mmin -30 2>/dev/null | grep -q .; then continue; fi
      USAGE=$(df "$CACHE_ROOT" | awk 'NR==2 {sub(/%/,"",$5); print $5}')
      if [ "$USAGE" -le 70 ]; then
        echo "=== Cache pruned down to \${USAGE}% ==="
        break
      fi
      echo "Removing idle cache: $dir"
      rm -rf "$dir"
    done
    USAGE=$(df "$CACHE_ROOT" | awk 'NR==2 {sub(/%/,"",$5); print $5}')
    if [ "$USAGE" -gt 80 ] 2>/dev/null; then
      echo "=== WARNING: cache disk still at \${USAGE}%; every remaining entry is in use or is ours. Continuing without pruning further ==="
    fi
  fi
fi
# --- End cache prune ---
`;
  }

  // Waiting reasons kubelet retries forever without the pod ever leaving
  // Pending. ImagePullBackOff is deliberately absent: a registry blip does
  // recover on its own.
  private static readonly FATAL_WAITING_REASONS = new Set([
    'CreateContainerConfigError',
    'CreateContainerError',
    'InvalidImageName'
  ]);

  private static readonly GIT_SHA_PREAMBLE =
    'GIT_SHA=$(git -C /workspace rev-parse HEAD 2>/dev/null || echo unknown)\n';
  private static readonly GIT_SHA_BUILDCTL_OPT = ' --opt build-arg:GIT_SHA="$GIT_SHA"';

  /**
   * The railpack-prepare init container picks the directory the plan was
   * generated for (the repo root, or an app subdirectory outside a workspace)
   * and leaves it here. BuildKit's `--local context=.` has to resolve against
   * that same directory, and workingDir is fixed in the pod spec long before
   * the repository has been cloned. Dockerfile builds never write the file and
   * stay at /workspace.
   */
  private static readonly BUILD_DIR_PREAMBLE = `
if [ -f ${BUILD_DIR_FILE} ]; then
  ORCHARD_BUILD_DIR="$(cat ${BUILD_DIR_FILE})"
  cd "$ORCHARD_BUILD_DIR" || exit 1
  case "$(pwd -P)" in
    /workspace|/workspace/*) ;;
    *) echo "ERROR: refusing to build outside /workspace: $ORCHARD_BUILD_DIR"; exit 1 ;;
  esac
  echo "=== Building in $(pwd) ==="
fi
`;

  private generateBuildScriptWithCacheFallback(
    buildctlArgs: BuildctlArg[],
    injectGitSha = false,
    buildDirPreamble = ''
  ): string {
    const hasCacheEnabled = buildctlArgs.some(
      (arg) => arg === '--import-cache' || arg === '--export-cache'
    );

    const gitShaPreamble = injectGitSha ? ImageBuilderService.GIT_SHA_PREAMBLE : '';
    const gitShaOpt = injectGitSha ? ImageBuilderService.GIT_SHA_BUILDCTL_OPT : '';

    const argsWithCache = buildctlArgs.map(renderBuildctlArg).join(' ') + gitShaOpt;

    if (!hasCacheEnabled) {
      return (
        gitShaPreamble +
        buildDirPreamble +
        this.generateBuildScript(`buildctl-daemonless.sh ${argsWithCache}`)
      );
    }

    // Split the cache flags off the base args so the build can drop them at
    // runtime. Values are restricted to shellQuote's safe charset (no spaces),
    // so $CACHE_ARGS word-splits back into the original arguments.
    const isCacheFlag = (arg: BuildctlArg, idx: number, arr: BuildctlArg[]) =>
      arg === '--import-cache' ||
      arg === '--export-cache' ||
      (idx > 0 && (arr[idx - 1] === '--import-cache' || arr[idx - 1] === '--export-cache'));

    const baseArgs =
      buildctlArgs
        .filter((a, i, arr) => !isCacheFlag(a, i, arr))
        .map(renderBuildctlArg)
        .join(' ') + gitShaOpt;
    const cacheOnlyArgs = buildctlArgs.filter(isCacheFlag).map(renderBuildctlArg).join(' ');

    const argAfter = (flag: string) => {
      const found = buildctlArgs.find((_, i) => i > 0 && buildctlArgs[i - 1] === flag);
      return typeof found === 'string' ? found : '';
    };
    const importDir = argAfter('--import-cache').match(/(?:^|,)src=([^,]+)/)?.[1] ?? '';
    const exportDir = argAfter('--export-cache').match(/(?:^|,)dest=([^,]+)/)?.[1] ?? '';
    const cacheDir = importDir || exportDir.replace(new RegExp(`${NEXT_CACHE_SUFFIX}$`), '');
    const swapsCache = !!importDir && exportDir === `${importDir}${NEXT_CACHE_SUFFIX}`;

    // A broken cache is our problem, not the user's build's. Probe it up front
    // and drop the cache flags if it is unusable, so the build still produces
    // an image, but say so loudly, because a cache that silently stops working
    // is exactly the kind of fault worth noticing.
    const cachePreflight = cacheDir
      ? `
CACHE_ARGS="${cacheOnlyArgs}"
CACHE_DIR="${cacheDir}"
if ! mkdir -p "$CACHE_DIR" 2>/dev/null || ! touch "$CACHE_DIR/.orchard-probe" 2>/dev/null; then
  echo "=================================================="
  echo "WARNING: build cache at $CACHE_DIR is not writable"
  echo "Building WITHOUT cache. This is an Orchard-side fault, not a build error."
  echo "=================================================="
  CACHE_ARGS=""
fi
rm -f "$CACHE_DIR/.orchard-probe" 2>/dev/null || true
${swapsCache ? `rm -rf "$CACHE_DIR${NEXT_CACHE_SUFFIX}" 2>/dev/null || true\n` : ''}`
      : `
CACHE_ARGS="${cacheOnlyArgs}"
`;

    return `
set +e
${gitShaPreamble}${buildDirPreamble}
ulimit -n 1048576 2>/dev/null || true
${this.ramdiskPreamble}${this.scratchMountPreamble}${this.cachePrunePreamble(cacheDir)}${cachePreflight}
echo "=== Building image ==="
buildctl-daemonless.sh ${baseArgs} $CACHE_ARGS
BUILD_EXIT_CODE=$?

${swapsCache ? cacheSwapScript : ''}
if [ "$BUILD_EXIT_CODE" -eq 0 ]; then
  echo "=== Build completed successfully ==="
  exit 0
fi

echo "=== Build failed (exit code: $BUILD_EXIT_CODE) ==="
exit $BUILD_EXIT_CODE
`.trim();
  }

  /**
   * Run a build command once and surface its exit code.
   *
   * No retries: classifying failures by grepping the combined output for words
   * like "timeout" and "network" also reads the user's own program logs, so a
   * Django traceback ending in "connection timeout expired" looks like a
   * transient network blip and the build runs three more times, tripling wall
   * clock and holding a builder slot for a build that can never succeed. Masking
   * failures also hides our own infrastructure faults, which are the ones worth
   * seeing. One attempt, real exit code, fail loudly.
   */
  private generateBuildScript(command: string): string {
    return `
set +e
ulimit -n 1048576 2>/dev/null || true
${this.ramdiskPreamble}${this.scratchMountPreamble}${this.cachePrunePreamble()}
${command}
EXIT_CODE=$?

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "=== Build completed successfully ==="
  exit 0
fi

echo "=== Build failed (exit code: $EXIT_CODE) ==="
exit $EXIT_CODE
`.trim();
  }

  async createBuildJob(options: BuildJobOptions): Promise<string> {
    assertBuildRegistryConfigured();
    this.ensureKubeConfig();

    const {
      repoUrl,
      branch,
      dockerfilePath,
      imageName,
      tag = 'latest',
      deploymentId,
      accessToken,
      target,
      buildFromRoot = false,
      buildType = 'dockerfile',
      rootDirectory,
      envVars: requestedEnvVars = {},
      secretEnvKeys = [],
      buildWithDepot = false,
      cacheTenantKey,
      persistentBuildCache = false,
      localContextUrl
    } = options;
    assertSafeBuildInputs({ branch, dockerfilePath, target });

    // Filter once, here, so every consumer below agrees on the set: the ARG
    // declarations, the build args, the Railpack secrets that read the
    // container's own environment, and the container environment itself.
    let appPullAuths: RegistryAuths = {};
    try {
      appPullAuths = this.registryCredentials
        ? await this.registryCredentials.buildAuths(deploymentId, requestedEnvVars)
        : pullAuthsFromEnv(requestedEnvVars);
    } catch (error) {
      if (error instanceof PullAuthError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    const envVars = buildSafeEnv(requestedEnvVars);
    const hasAppPullAuth = hasRegistryAuths(appPullAuths);

    // Sanitize the tenant key for use as a PVC subPath. Anything outside
    // [a-z0-9-] gets squashed; missing key collapses to "_shared" which is
    // the legacy behaviour (every build in one directory), only used when
    // a caller hasn't been updated yet. New callers must pass this.
    const cacheSubPath = cacheTenantKey
      ? cacheTenantKey
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .slice(0, 63) || '_shared'
      : '_shared';

    if (!this.builderInfraReady) {
      await this.ensureBuilderNamespace();
      await Promise.all([this.ensureBuilderSecrets(), this.ensureServiceAccount()]);
      this.builderInfraReady = true;
    }

    const jobName = this.generateJobName(imageName);
    const buildEnvSecret = `benv-${crypto.randomBytes(16).toString('hex')}`;
    const jobDockerConfigSecret = hasAppPullAuth
      ? `bdc-${crypto.randomBytes(16).toString('hex')}`
      : null;
    if (jobDockerConfigSecret) {
      await this.createDockerConfigSecret(
        jobDockerConfigSecret,
        this.sidecarPushEnabled
          ? appPullAuths
          : mergeRegistryAuths(this.harborAuths(), appPullAuths),
        { labels: { 'orchard.my/build-job': jobName } }
      );
      this.appendLog(deploymentId, 'Using registry credentials to pull base images').catch(
        () => {}
      );
    }
    const buildkitAuthSecret =
      jobDockerConfigSecret ?? (this.sidecarPushEnabled ? null : this.registrySecretName);
    const fullImageName = `${this.harborRegistryPush}/${this.harborProject}/${imageName}:${tag}`;

    const buildMethodLabel = buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
    const builderLabel = buildWithDepot ? 'Super Builds' : 'BuildKit';
    this.appendLog(
      deploymentId,
      `Creating image-builder pod: ${jobName} (${buildMethodLabel} via ${builderLabel})`
    ).catch(() => {});

    const parsedRepo = localContextUrl ? null : parseRepoUrl(repoUrl);
    if (!localContextUrl && !parsedRepo) {
      throw new BadRequestException('Repository URL must be a plain https:// URL');
    }
    const cloneUrl = parsedRepo ? withCloneCredentials(parsedRepo, accessToken) : repoUrl;

    // Compute secrets hash for Railpack layer invalidation
    const secretsHash = this.computeSecretsHash(envVars);
    // Use deployment ID as cache key for multi-tenant isolation
    const cacheKey = deploymentId ? `orchard-${deploymentId.slice(0, 8)}` : undefined;

    const injectGitSha = buildType !== 'railpack' && !('GIT_SHA' in envVars);

    const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);

    // Build init containers list. Local-upload builds fetch the uploaded
    // tarball via a short-lived presigned URL instead of cloning; the URL is
    // passed as an env var so it never appears in the pod command (visible to
    // anyone who can read the pod spec).
    const sourceInit: k8s.V1Container = localContextUrl
      ? {
          name: 'context-fetch',
          image: ALPINE_IMAGE,
          command: ['/bin/sh', '-c'],
          args: [
            `set -e
echo "=== Fetching uploaded build context ==="
wget -qO /tmp/context.tar.gz "$CONTEXT_URL"
mkdir -p /workspace
tar xzf /tmp/context.tar.gz -C /workspace
rm -f /tmp/context.tar.gz
echo "=== Build context extracted ==="
ls -la /workspace
`
          ],
          env: [secretEnv('CONTEXT_URL', buildEnvSecret, BUILD_ENV_SECRET_KEYS.contextUrl)],
          volumeMounts: [
            {
              name: 'workspace',
              mountPath: '/workspace'
            }
          ],
          resources: {
            requests: {
              cpu: '100m',
              memory: '256Mi'
            },
            limits: {
              cpu: this.sourceCpuLimit,
              memory: '512Mi'
            }
          }
        }
      : {
          name: 'git-clone',
          image: ALPINE_GIT_IMAGE,
          command: ['/bin/sh', '-c'],
          args: [gitCloneScript(branch)],
          env: [secretEnv('CLONE_URL', buildEnvSecret, BUILD_ENV_SECRET_KEYS.cloneUrl)],
          volumeMounts: [
            {
              name: 'workspace',
              mountPath: '/workspace'
            }
          ],
          resources: {
            requests: {
              cpu: '100m',
              memory: '256Mi'
            },
            limits: {
              cpu: this.sourceCpuLimit,
              memory: '512Mi'
            }
          }
        };

    const initContainers: k8s.V1Container[] = [sourceInit];

    // Env keys flow into Dockerfile directives and unquoted shell positions
    // below; a key containing a newline or shell metachar would inject
    // arbitrary instructions. Reject early: projects.service already
    // validates on write, this is defense-in-depth at the build boundary.
    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const key of Object.keys(envVars)) {
      if (!ENV_KEY_RE.test(key)) {
        throw new BadRequestException(`Invalid environment variable key: ${key}`);
      }
    }

    const injectedArgKeys = injectableBuildArgKeys(Object.keys(envVars), secretEnvKeys);
    const secretArgNotice =
      buildType === 'dockerfile' ? secretBuildArgNotice(Object.keys(envVars), secretEnvKeys) : null;
    if (secretArgNotice) {
      this.appendLog(deploymentId, secretArgNotice, 'WARNING').catch(() => {});
    }
    if (buildType === 'dockerfile' && injectedArgKeys.length > 0) {
      initContainers.push({
        name: 'inject-build-args',
        image: ALPINE_IMAGE,
        command: ['/bin/sh', '-c'],
        args: [injectBuildArgsScript({ dockerfilePath, keys: injectedArgKeys })],
        workingDir: '/workspace',
        volumeMounts: [
          {
            name: 'workspace',
            mountPath: '/workspace'
          }
        ],
        resources: {
          requests: {
            cpu: '50m',
            memory: '64Mi'
          },
          limits: {
            cpu: '200m',
            memory: '128Mi'
          }
        }
      });
    }

    const buildArgEnv: k8s.V1EnvVar[] = Object.keys(envVars).map((key, index) =>
      secretEnv(buildArgEnvName(index), buildEnvSecret, key)
    );

    // For Railpack builds, add a second init container to run `railpack prepare`
    if (buildType === 'railpack') {
      initContainers.push({
        name: 'railpack-prepare',
        image: this.railpackMiseImage,
        command: ['/bin/sh', '-c'],
        args: [this.railpackPrepareScript(envVars, rootDirectory, true)],
        workingDir: '/workspace',
        env: buildArgEnv,
        volumeMounts: [
          {
            name: 'workspace',
            mountPath: '/workspace'
          },
          { name: BUILD_META_VOLUME, mountPath: BUILD_META_PATH }
        ],
        resources: {
          requests: {
            cpu: '200m',
            memory: '512Mi'
          },
          limits: {
            cpu: '1',
            memory: '2Gi'
          }
        }
      });
    }

    const dockerfileBuildArgEnv = buildType === 'dockerfile' ? buildArgEnv : [];
    const buildDirPreamble =
      buildType === 'railpack'
        ? ImageBuilderService.BUILD_DIR_PREAMBLE
        : dockerfileDirGuard(dockerfilePath);
    const buildMetaMount: k8s.V1VolumeMount[] =
      buildType === 'railpack'
        ? [{ name: BUILD_META_VOLUME, mountPath: BUILD_META_PATH, readOnly: true }]
        : [];

    // Persistent daemon mode: get/create a warm BuildKit daemon and build
    // a lightweight client container that connects to it via gRPC. The
    // daemon keeps its layer cache warm between builds (like Depot).
    let daemonIp: string | null = null;
    if (persistentBuildCache && !hasAppPullAuth && !buildWithDepot && this.buildKitPool) {
      try {
        const daemon = await this.buildKitPool.getOrCreateDaemon(cacheTenantKey || imageName);
        daemonIp = daemon.podIp;
        await this.appendLog(deploymentId, `Using persistent BuildKit daemon at ${daemon.podName}`);
      } catch (err) {
        console.warn(
          `[ImageBuilder] Failed to get daemon, falling back to daemonless:`,
          err.message
        );
        await this.appendLog(
          deploymentId,
          `Persistent daemon unavailable, using standard builder`,
          'WARNING'
        );
      }
    }

    const s3Plan: S3CachePlan =
      !daemonIp && !buildWithDepot && !this.localCacheEnabled && this.s3CacheEnabled
        ? await this.planS3Cache(deploymentId, cacheTenantKey)
        : { kind: 'off' };

    const buildctlArgs = this.generateBuildctlArgs({
      dockerfilePath,
      fullImageName,
      target,
      buildFromRoot,
      buildType,
      envVars,
      secretEnvKeys,
      secretsHash,
      cacheKey,
      skipCache: !!daemonIp,
      daemonClient: !!daemonIp,
      s3Plan
    });

    // Runs first, and only when the cache volume is the real shared PVC: the
    // disableSharedCache fallback swaps in an emptyDir with nothing to evict,
    // and daemon mode keeps its cache in the daemon pod.
    const sharedCacheVolume =
      !daemonIp &&
      !buildWithDepot &&
      this.localCacheEnabled &&
      !!this.localCachePvc &&
      !options.disableSharedCache;
    if (sharedCacheVolume) {
      initContainers.unshift(
        cacheEvictInitContainer({
          cacheSubPath,
          maxAgeDays: this.buildCache?.current().maxAgeDays ?? this.cacheEvictMaxAgeDays,
          maxGiB: this.buildCache?.current().maxGiB ?? null,
          highPct: this.cacheEvictHighPct,
          targetPct: this.cacheEvictTargetPct,
          idleMinutes: this.cacheEvictIdleMinutes,
          ...(this.rootless ? { chownUid: ROOTLESS_UID } : {})
        }) as k8s.V1Container
      );
    }

    // Build the BuildKit container spec.
    // Two modes:
    //   1. Daemon mode (daemonIp set): lightweight client runs `buildctl
    //      --addr tcp://<daemon>:1234 build ...`. Not privileged, no
    //      buildkitd flags, no cache volumes (daemon has those).
    //   2. Daemonless mode (default): runs `buildctl-daemonless.sh` which
    //      starts+stops its own buildkitd. Privileged, needs config/state.
    //
    // sidecarPushEnabled changes credential handling in both modes:
    //   - no docker-config mount: the build cannot exfiltrate push creds.
    //   - mount `output` emptyDir at /output for the OCI tarball.
    const buildkitContainer: k8s.V1Container | null = buildWithDepot
      ? null
      : (() => {
          if (daemonIp) {
            // Daemon client mode: buildctl sends the local context directory to the remote
            // daemon over gRPC, so the client needs /workspace but NOT privilege.
            const clientCmd = `buildctl --addr tcp://${daemonIp}:1234 ${buildctlArgs.map(renderBuildctlArg).join(' ')}${
              injectGitSha ? ImageBuilderService.GIT_SHA_BUILDCTL_OPT : ''
            }`;
            const clientScript =
              (injectGitSha ? ImageBuilderService.GIT_SHA_PREAMBLE : '') +
              // Same directory handoff as the daemonless path: buildctl streams the
              // local context from the client's cwd, so it must match the directory
              // railpack-prepare generated the plan for.
              buildDirPreamble +
              this.generateBuildScript(clientCmd);
            const wrappedClientScript = this.sidecarPushEnabled
              ? `mkdir -p /output
( ${clientScript} ); rc=$?
if [ "$rc" -eq 0 ]; then touch /output/.done; else touch /output/.failed; fi
exit $rc`
              : clientScript;

            return {
              name: 'buildkit',
              image: this.buildkitImage,
              imagePullPolicy: 'IfNotPresent',
              // Not privileged, just a gRPC client. With sidecar push the pusher
              // container pushes; otherwise the daemon pod has the registry creds.
              command: ['/bin/sh', '-c'],
              args: [wrappedClientScript],
              workingDir: '/workspace',
              env: [...builderContainerEnv(envVars, buildEnvSecret), ...dockerfileBuildArgEnv],
              volumeMounts: [
                { name: 'workspace', mountPath: '/workspace' },
                ...buildMetaMount,
                ...(this.sidecarPushEnabled ? [{ name: 'output', mountPath: '/output' }] : [])
              ],
              resources: {
                requests: { cpu: '200m', memory: '512Mi' },
                limits: { cpu: '2', memory: '4Gi' }
              }
            } as k8s.V1Container;
          }

          // Daemonless mode: cache export is only worth skipping for the S3 backend,
          // which round-trips the whole cache over the network before the pusher can read
          // the tarball. The local backend writes to a PVC and is independent of the
          // push, so keep it: without the export nothing ever populates the cache dir and
          // every build imports from an empty path.
          const stripExportCache = this.sidecarPushEnabled && !this.localCacheEnabled;
          const scriptArgs = stripExportCache
            ? buildctlArgs.filter((arg, idx, arr) => {
                if (arg === '--export-cache') return false;
                if (idx > 0 && arr[idx - 1] === '--export-cache') return false;
                return true;
              })
            : buildctlArgs;
          return {
            name: 'buildkit',
            image: this.buildkitImage,
            imagePullPolicy: 'IfNotPresent',
            securityContext: builderContainerSecurityContext(this.builderPosture),
            command: ['/bin/sh', '-c'],
            args: [
              buildkitdEnvPreamble() +
                this.generateBuildScriptWithCacheFallback(
                  scriptArgs,
                  injectGitSha,
                  buildDirPreamble
                )
            ],
            workingDir: '/workspace',
            env: [
              ...(buildkitAuthSecret
                ? [
                    {
                      name: 'DOCKER_CONFIG',
                      value: this.rootless ? ROOTLESS_DOCKER_CONFIG : '/root/.docker'
                    }
                  ]
                : []),
              {
                name: 'BUILDKITD_FLAGS',
                value: this.rootless
                  ? rootlessBuildkitdFlags('/buildkit-state')
                  : `--config /etc/buildkit/buildkitd.toml${this.workspaceTmpfs || this.scratchBlock || this.scratchDisk || this.scratchTmpfs ? ' --root /buildkit-state' : ''}`
              },
              ...builderContainerEnv(envVars, buildEnvSecret),
              ...dockerfileBuildArgEnv,
              // After the user's variables, not before. A build that pulls assets
              // from S3 sets AWS_ACCESS_KEY_ID for perfectly good reasons, and it
              // reaches the build by value as a --build-arg, so losing the race
              // here costs it nothing, while losing it the other way points our
              // cache exporter at someone else's bucket.
              ...(this.s3CacheEnabled && !this.localCacheEnabled && s3Plan.kind !== 'off'
                ? s3Plan.kind === 'scoped'
                  ? [
                      secretEnv(
                        S3_CACHE_KEY_ENV,
                        buildEnvSecret,
                        BUILD_ENV_SECRET_KEYS.s3CacheKeyId
                      ),
                      secretEnv(
                        S3_CACHE_SECRET_ENV,
                        buildEnvSecret,
                        BUILD_ENV_SECRET_KEYS.s3CacheSecret
                      )
                    ]
                  : [
                      {
                        name: S3_CACHE_KEY_ENV,
                        valueFrom: {
                          secretKeyRef: {
                            name: 'buildkit-s3-cache-creds',
                            key: 'AWS_ACCESS_KEY_ID',
                            optional: true
                          }
                        }
                      },
                      {
                        name: S3_CACHE_SECRET_ENV,
                        valueFrom: {
                          secretKeyRef: {
                            name: 'buildkit-s3-cache-creds',
                            key: 'AWS_SECRET_ACCESS_KEY',
                            optional: true
                          }
                        }
                      }
                    ]
                : [])
            ],
            volumeMounts: [
              { name: 'workspace', mountPath: '/workspace' },
              ...buildMetaMount,
              ...(buildkitAuthSecret
                ? [
                    {
                      name: 'buildkit-auth',
                      mountPath: this.rootless ? ROOTLESS_DOCKER_CONFIG : '/root/.docker',
                      readOnly: true
                    }
                  ]
                : []),
              { name: 'buildkit-config', mountPath: '/etc/buildkit', readOnly: true },
              ...(this.sidecarPushEnabled
                ? [
                    {
                      name: 'output',
                      mountPath: '/output'
                    }
                  ]
                : []),
              ...((this.workspaceTmpfs || this.scratchDisk || this.scratchTmpfs) &&
              !this.scratchBlock
                ? [
                    {
                      name: 'buildkit-state',
                      mountPath: '/buildkit-state'
                    }
                  ]
                : []),
              ...(this.localCacheEnabled
                ? [
                    {
                      name: 'buildkit-cache',
                      mountPath: this.localCachePath,
                      subPath: cacheSubPath
                    }
                  ]
                : [])
            ],
            ...(this.scratchBlock
              ? {
                  volumeDevices: [
                    { name: 'buildkit-state', devicePath: ImageBuilderService.SCRATCH_DEVICE }
                  ]
                }
              : {}),
            resources: {
              requests: { cpu: '500m', memory: process.env.BUILDER_MEMORY_REQUEST || '2Gi' },
              limits: { cpu: '4', memory: process.env.BUILDER_MEMORY_LIMIT || '32Gi' }
            }
          } as k8s.V1Container;
        })();

    // Why run BuildKit + pusher as PARALLEL main containers (not init→main):
    //   Under runtimeClassName=kata, transitioning from the last init
    //   container to the first main container triggers a 429 from the
    //   kata-shim's task-create RPC: the kata-agent inside the VM
    //   doesn't accept new tasks during sandbox-state-transition. Running
    //   both as `containers:` avoids that transition entirely; both tasks
    //   start once at pod startup, share /output via emptyDir, and
    //   coordinate via a filesystem marker.
    //
    // Threat model still holds: BuildKit and pusher have separate mount
    // namespaces inside the Kata VM, so a malicious Dockerfile RUN in
    // BuildKit cannot read the pusher container's
    // /root/.docker/config.json.
    // Daemon mode pushes from this pod too: the shared daemon holds no registry creds.
    const pusherImageRef = fullImageName.replace(/^[^/]+/, this.pusherRegistryHost);
    const pusherSource = buildWithDepot ? 'oci-archive:/output/image.tar' : 'oci:/output/image';
    const pusherContainer: k8s.V1Container | null =
      (buildkitContainer || buildWithDepot) && this.sidecarPushEnabled
        ? {
            name: 'pusher',
            image: this.pusherImage,
            imagePullPolicy: 'IfNotPresent',
            command: ['/bin/sh', '-c'],
            args: [
              `set -e
echo "[pusher] waiting for build to finish..."
TIMEOUT=1700
ELAPSED=0
while [ ! -f /output/.done ] && [ ! -f /output/.failed ]; do
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "[pusher] timed out waiting for build to produce a marker"
    exit 1
  fi
  sleep 1
  ELAPSED=$((ELAPSED + 1))
done
if [ -f /output/.failed ]; then
  echo "[pusher] build wrote .failed marker, not pushing"
  exit 1
fi
echo "[pusher] build done, pushing..."
exec skopeo copy --retry-times 3 --authfile /root/.docker/config.json --dest-tls-verify=false ${pusherSource} 'docker://${pusherImageRef.replace(/'/g, `'\\''`)}'`
            ],
            volumeMounts: [
              { name: 'output', mountPath: '/output' },
              { name: 'docker-config', mountPath: '/root/.docker', readOnly: true }
            ],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits: { cpu: '1', memory: '1Gi' }
            }
          }
        : null;

    const podRuntimeClass = buildWithDepot
      ? this.depotRuntimeClass || this.builderRuntimeClass
      : this.builderRuntimeClass;

    // Final container layout:
    //   - Depot: depot container as main, no buildkit/pusher.
    //   - sidecarPush off (default): buildkit as main, classic behaviour.
    //   - sidecarPush on: both run as main in parallel. BuildKit wraps
    //     its build script to write /output/.done or /output/.failed on
    //     exit so the pusher knows when to act.
    let containers: k8s.V1Container[];
    if (buildWithDepot) {
      containers = [
        this.createDepotContainer({
          dockerfilePath,
          fullImageName,
          target,
          buildFromRoot,
          buildType,
          envVars,
          secretEnvKeys,
          envSecretName: buildEnvSecret,
          sidecarPush: this.sidecarPushEnabled
        })
      ];
      if (pusherContainer) {
        containers.push(pusherContainer);
      }
    } else if (daemonIp && pusherContainer && buildkitContainer) {
      containers = [buildkitContainer, pusherContainer];
    } else if (this.sidecarPushEnabled && pusherContainer && buildkitContainer) {
      const innerScript = (buildkitContainer.args && buildkitContainer.args[0]) || '';

      const cacheExportArgs = buildctlArgs
        .filter(
          (arg, index, args) =>
            arg !== '--output' &&
            arg !== '--import-cache' &&
            (index === 0 ||
              (args[index - 1] !== '--output' && args[index - 1] !== '--import-cache'))
        )
        .map(renderBuildctlArg)
        .join(' ');
      const hasDeferredCacheExport =
        !this.localCacheEnabled && buildctlArgs.includes('--export-cache');

      const daemonStart = this.rootless
        ? `${rootlessPreflightScript('touch /output/.failed')}
${rootlessDaemonlessWrapper('')}
${rootlessDaemonStart()}`
        : `# Start buildkitd ourselves and replace buildctl-daemonless.sh with a
# passthrough so the inner build script (with all its retry logic) reuses
# our daemon instead of spawning its own.
printf '#!/bin/sh\\nexec buildctl "$@"\\n' > /usr/bin/buildctl-daemonless.sh

$BUILDKITD $BUILDKITD_FLAGS &
DAEMON_PID=$!
for i in $(seq 1 100); do
  buildctl debug workers >/dev/null 2>&1 && break
  sleep 0.1
done`;
      const exportBuildctl = this.rootless
        ? 'buildctl --addr "$ORCHARD_BUILDKIT_ADDR"'
        : 'buildctl';

      buildkitContainer.args = [
        `mkdir -p /output
${this.scratchMountPreamble}
${buildkitdEnvPreamble()}${daemonStart}

( ${innerScript} ); rc=$?

if [ "$rc" -eq 0 ]; then
  touch /output/.done
${
  hasDeferredCacheExport
    ? `  echo "=== Exporting build cache ==="
  (
${injectGitSha ? ImageBuilderService.GIT_SHA_PREAMBLE : ''}${buildDirPreamble}${exportBuildctl} ${cacheExportArgs}${injectGitSha ? ImageBuilderService.GIT_SHA_BUILDCTL_OPT : ''}
  ) >/dev/null 2>&1 || echo "=== Cache export failed (non-critical) ==="`
    : ''
}
else
  touch /output/.failed
fi

kill $DAEMON_PID 2>/dev/null
wait $DAEMON_PID 2>/dev/null || true
exit $rc`
      ];
      containers = [buildkitContainer, pusherContainer];
    } else {
      containers = [buildkitContainer!];
    }

    const job: k8s.V1Job = {
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: {
        name: jobName,
        namespace: this.builderNamespace,
        labels: {
          'app.kubernetes.io/name': 'image-builder',
          'app.kubernetes.io/managed-by': 'orchard',
          'orchard.my/deployment-id': deploymentId || 'unknown',
          'orchard.my/image-name': truncateK8sName(
            imageName
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, '-')
              .replace(/^-+/, ''),
            63
          ),
          'orchard.my/build-type': buildType
        },
        annotations: {
          'orchard.my/repo-url': repoUrl,
          'orchard.my/branch': branch,
          'orchard.my/full-image': fullImageName
        }
      },
      spec: {
        ttlSecondsAfterFinished: 3600, // Cleanup job after 1 hour
        backoffLimit: 0, // Don't retry failed builds
        activeDeadlineSeconds: 1800, // 30 minute timeout
        template: {
          metadata: {
            ...(this.rootless && !daemonIp && !buildWithDepot
              ? { annotations: rootlessAppArmorAnnotations(['buildkit']) }
              : {}),
            labels: {
              'app.kubernetes.io/name': 'image-builder',
              'orchard.my/deployment-id': deploymentId || 'unknown',
              ...(daemonIp
                ? { [TENANT_KEY_LABEL]: daemonTenantLabel(cacheTenantKey || imageName) }
                : {})
            }
          },
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: 'image-builder',
            // The build pod has no business talking to the kube-apiserver.
            // The image-builder SA's Role grants pods/secrets read in this
            // namespace; without this line the SA token is auto-mounted at
            // /var/run/secrets/kubernetes.io/serviceaccount/ inside BuildKit
            // and a Dockerfile that reaches BuildKit's container fs (via
            // any future BuildKit parser bug or `--mount` edge case) could
            // exfil the Harbor push creds via the apiserver.
            automountServiceAccountToken: false,
            // Builder pod runtime: Kata (lightweight VM) when configured.
            // Empty/undefined ⇒ default containerd handler (runc): matches
            // legacy behaviour on first upgrade.
            // Daemon-client mode doesn't need Kata: it's just a gRPC client,
            // the daemon pod itself runs with the runtime class.
            ...(!daemonIp && podRuntimeClass ? { runtimeClassName: podRuntimeClass } : {}),
            nodeSelector: {
              ...buildArchNodeSelector(),
              ...(this.dedicatedNodeEnabled ? { 'orchard-builder': 'true' } : {})
            },
            ...(this.dedicatedNodeEnabled
              ? {
                  tolerations: [
                    {
                      key: 'orchard-builder',
                      operator: 'Exists',
                      effect: 'NoSchedule'
                    }
                  ]
                }
              : {}),
            initContainers,
            containers,
            volumes: [
              {
                name: 'workspace',
                emptyDir: this.workspaceTmpfs ? { medium: 'Memory' } : {}
              },
              ...(buildType === 'railpack'
                ? [{ name: BUILD_META_VOLUME, emptyDir: { medium: 'Memory' } }]
                : []),
              {
                name: 'docker-config',
                secret: {
                  secretName: this.registrySecretName,
                  items: [
                    {
                      key: '.dockerconfigjson',
                      path: 'config.json'
                    }
                  ]
                }
              },
              ...(buildkitAuthSecret
                ? [
                    {
                      name: 'buildkit-auth',
                      secret: {
                        secretName: buildkitAuthSecret,
                        items: [
                          {
                            key: '.dockerconfigjson',
                            path: 'config.json'
                          }
                        ]
                      }
                    }
                  ]
                : []),
              // Daemon-client mode doesn't need buildkit-config, buildkit-state,
              // or buildkit-cache: the daemon pod has its own.
              ...(!daemonIp && !buildWithDepot
                ? [
                    {
                      name: 'buildkit-config',
                      configMap: {
                        name: 'buildkit-config'
                      }
                    }
                  ]
                : []),
              ...(this.sidecarPushEnabled
                ? [
                    {
                      name: 'output',
                      emptyDir: this.workspaceTmpfs ? { medium: 'Memory' } : {}
                    }
                  ]
                : []),
              ...(!daemonIp &&
              !buildWithDepot &&
              (this.workspaceTmpfs || this.scratchBlock || this.scratchDisk || this.scratchTmpfs)
                ? [
                    {
                      name: 'buildkit-state',
                      ...(this.scratchBlock
                        ? {
                            ephemeral: {
                              volumeClaimTemplate: {
                                spec: {
                                  accessModes: ['ReadWriteOnce'],
                                  storageClassName: this.scratchStorageClass,
                                  volumeMode: 'Block',
                                  resources: { requests: { storage: this.scratchSize } }
                                }
                              }
                            }
                          }
                        : this.scratchDisk
                          ? { emptyDir: { sizeLimit: this.scratchSize } }
                          : { emptyDir: { medium: 'Memory', sizeLimit: this.scratchSize } })
                    }
                  ]
                : []),
              ...(!daemonIp && !buildWithDepot && this.localCacheEnabled
                ? [
                    {
                      name: 'buildkit-cache',
                      ...(this.localCachePvc && !options.disableSharedCache
                        ? { persistentVolumeClaim: { claimName: this.localCachePvc } }
                        : { emptyDir: {} })
                    }
                  ]
                : [])
            ]
          }
        }
      }
    };

    let cacheBackend = 'none';
    if (this.localCacheEnabled) cacheBackend = 'local';
    else if (this.s3CacheEnabled) cacheBackend = 's3';

    console.log(`[ImageBuilder] Creating job ${jobName} in namespace ${this.builderNamespace}`, {
      imageName: fullImageName,
      repoUrl: this.sanitizeLogMessage(repoUrl),
      branch,
      dockerfilePath,
      buildType,
      initContainerCount: initContainers.length,
      hasCacheEnabled: this.localCacheEnabled || this.s3CacheEnabled,
      cacheBackend,
      envVarsCount: Object.keys(envVars).length
    });

    const buildEnvSecretData: Record<string, string> = {
      ...envVars,
      ...(s3Plan.kind === 'scoped'
        ? {
            [BUILD_ENV_SECRET_KEYS.s3CacheKeyId]: s3Plan.scoped.accessKey,
            [BUILD_ENV_SECRET_KEYS.s3CacheSecret]: s3Plan.scoped.secret
          }
        : {}),
      ...(localContextUrl
        ? { [BUILD_ENV_SECRET_KEYS.contextUrl]: localContextUrl }
        : { [BUILD_ENV_SECRET_KEYS.cloneUrl]: cloneUrl }),
      ...(buildWithDepot
        ? {
            [BUILD_ENV_SECRET_KEYS.depotToken]: this.depotToken || '',
            [BUILD_ENV_SECRET_KEYS.dockerAuthJson]: JSON.stringify(
              dockerConfigJson(
                depotSessionAuths({
                  sidecarPush: this.sidecarPushEnabled,
                  harborAuths: this.harborAuths(),
                  appPullAuths
                })
              )
            )
          }
        : {})
    };
    const jobSecrets = [buildEnvSecret, ...(jobDockerConfigSecret ? [jobDockerConfigSecret] : [])];

    try {
      await this.createOpaqueSecret(buildEnvSecret, buildEnvSecretData, {
        labels: { 'orchard.my/build-job': jobName }
      });
      const jobCreationResult = await batchApi.createNamespacedJob(this.builderNamespace, job);
      console.log(
        `[ImageBuilder] Job ${jobName} created successfully. UID: ${jobCreationResult.body.metadata?.uid}`
      );
      await this.stampBuildTime(options.deploymentId, 'submitted');

      const jobUid = jobCreationResult.body.metadata?.uid;
      if (jobUid) {
        const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
        for (const secretName of jobSecrets) {
          try {
            await coreApi.patchNamespacedSecret(
              secretName,
              this.builderNamespace,
              {
                metadata: {
                  ownerReferences: [
                    {
                      apiVersion: 'batch/v1',
                      kind: 'Job',
                      name: jobName,
                      uid: jobUid,
                      controller: true
                    }
                  ]
                }
              },
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              { headers: { 'Content-Type': 'application/merge-patch+json' } }
            );
          } catch (error) {
            console.warn(
              `[ImageBuilder] Could not attach ownerRef to ${secretName}:`,
              error.message
            );
          }
        }
      }

      if (deploymentId) {
        const now = Date.now();
        const logLine = `[${now}] [INFO] Build job ${jobName} created successfully\n`;
        await this.prisma.$executeRaw`
          UPDATE "deployments"
          SET "build_logs" = COALESCE("build_logs", '') || ${logLine},
              "build_step_timestamps" = jsonb_set(
                jsonb_set(
                  COALESCE("build_step_timestamps", '{}'::jsonb),
                  '{__jobName}',
                  ${JSON.stringify(jobName)}::jsonb
                ),
                '{__image}',
                ${JSON.stringify(`${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`)}::jsonb
              ),
              "updated_at" = (NOW() AT TIME ZONE 'UTC')
          WHERE "id" = ${deploymentId}::uuid
        `;
        this.emitBuildChanged(deploymentId).catch(() => {});
      }

      return jobName;
    } catch (error) {
      await this.deleteBuildJobSecrets(jobName).catch(() => {});
      if (s3Plan.kind === 'scoped') await this.revokeBuildCacheKey(s3Plan.scoped.accessKey);
      const errorDetails = error.body ? JSON.stringify(error.body, null, 2) : error.message;
      const errorMsg = `Failed to create build job: ${error.message}${error.body ? `\nDetails: ${errorDetails}` : ''}`;

      console.error('[ImageBuilder] Job creation failed:', {
        jobName,
        namespace: this.builderNamespace,
        error: error.message,
        statusCode: error.statusCode,
        errorBody: error.body,
        errorStack: error.stack
      });

      await this.appendLog(deploymentId, errorMsg, 'ERROR');
      await this.appendLog(deploymentId, `Job creation error details: ${errorDetails}`, 'ERROR');

      throw new BadRequestException(`Failed to create build job: ${error.message}`);
    }
  }

  railpackPrepareScript(
    envVars: Record<string, string>,
    rootDirectory: string | undefined,
    installRailpack: boolean
  ): string {
    const envArgs = Object.keys(envVars)
      .map((key, index) => ({ key, index, value: envVars[key] }))
      .filter(({ value }) => value && typeof value === 'string')
      .map(({ key, index }) => `--env "${key}=$${buildArgEnvName(index)}"`)
      .join(' ');

    // A railpack.json in the repo outranks env overrides, so the build
    // settings are re-emitted as the config file to keep the UI authoritative.
    // JSON.stringify never emits a raw newline, so the quoted heredoc below
    // cannot be broken out of by a command containing quotes or $.
    const overrideConfig = railpackConfigOverride(envVars);
    const configOverrideJson = overrideConfig ? JSON.stringify(overrideConfig) : '';
    const configFileArg = overrideConfig ? ` --config-file ${ORCHARD_RAILPACK_CONFIG}` : '';
    const configOverrideBlock = overrideConfig
      ? `
echo "=== Applying Orchard build settings over the repository config ==="
cat > /tmp/orchard-override.json <<'ORCHARD_RAILPACK_OVERRIDE'
${configOverrideJson}
ORCHARD_RAILPACK_OVERRIDE
if [ -f railpack.json ] && command -v jq >/dev/null 2>&1; then
  jq -s '.[0] * .[1]' railpack.json /tmp/orchard-override.json > ${ORCHARD_RAILPACK_CONFIG}
elif [ -f railpack.json ]; then
  echo "WARNING: jq unavailable; the build settings you set take precedence and railpack.json is ignored"
  cp /tmp/orchard-override.json ${ORCHARD_RAILPACK_CONFIG}
else
  cp /tmp/orchard-override.json ${ORCHARD_RAILPACK_CONFIG}
fi
`
      : '';

    const install = installRailpack
      ? `echo "=== Installing curl ==="
if command -v curl >/dev/null 2>&1${configOverrideJson ? ' && command -v jq >/dev/null 2>&1' : ''}; then
  echo "curl already installed, skipping"
elif command -v apt-get >/dev/null 2>&1; then
  # Tolerate non-fatal apt cleanup errors (e.g. I/O error closing
  # /var/lib/apt/extended_states) — verify curl exists after install.
  apt-get update || true
  apt-get install -y curl ${configOverrideJson ? 'jq' : ''} || true
  command -v curl >/dev/null 2>&1 || { echo "curl install failed"; exit 1; }
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache curl ${configOverrideJson ? 'jq' : ''}
elif command -v yum >/dev/null 2>&1; then
  yum install -y curl ${configOverrideJson ? 'jq' : ''}
fi

echo "=== Installing Railpack ${this.railpackVersion} ==="
case "$(uname -m)" in
  x86_64) RAILPACK_TARGET=x86_64-unknown-linux-musl ;;
  aarch64|arm64) RAILPACK_TARGET=arm64-unknown-linux-musl ;;
  *) echo "unsupported architecture: $(uname -m)"; exit 1 ;;
esac
RAILPACK_ASSET=railpack-${this.railpackVersion}-$RAILPACK_TARGET.tar.gz
RAILPACK_RELEASE=https://github.com/railwayapp/railpack/releases/download/${this.railpackVersion}
RAILPACK_TMP=$(mktemp -d)
cd "$RAILPACK_TMP"
curl -fsSL --retry 3 --retry-all-errors -O "$RAILPACK_RELEASE/$RAILPACK_ASSET"
curl -fsSL --retry 3 --retry-all-errors -O "$RAILPACK_RELEASE/checksums.txt"
grep " $RAILPACK_ASSET$" checksums.txt | sha256sum -c -
tar xzf "$RAILPACK_ASSET" railpack
install -m 0755 railpack /usr/local/bin/railpack
cd /
rm -rf "$RAILPACK_TMP"
export PATH="$PATH:/usr/local/bin"
railpack --version
`
      : 'railpack --version\n';
    return `set -ex
${install}
echo "=== Selecting build directory ==="
# Two monorepo shapes need opposite treatment:
#   * A plain repo with frontend/ and backend/ — point Railpack straight at the
#     subdirectory; it supports that natively via its app source dir.
#   * A pnpm/npm/yarn workspace — the lockfile and shared packages live at the
#     root, so building inside the subdirectory would fail to install. Stay at
#     the root; the build/start commands are already scoped to the package and
#     the output directory is already repo-relative.
ORCHARD_ROOT_DIR=${JSON.stringify(rootDirectory ?? '')}
ORCHARD_BUILD_DIR=/workspace
if [ -n "$ORCHARD_ROOT_DIR" ]; then
  if [ -f /workspace/pnpm-workspace.yaml ] || grep -q '"workspaces"' /workspace/package.json 2>/dev/null; then
    echo "workspace detected: building from the repo root, scoped to $ORCHARD_ROOT_DIR"
  elif [ -d "/workspace/$ORCHARD_ROOT_DIR" ]; then
    ORCHARD_BUILD_DIR="/workspace/$ORCHARD_ROOT_DIR"
    echo "building from $ORCHARD_BUILD_DIR"
  else
    echo "root directory '$ORCHARD_ROOT_DIR' not found in the repository"; exit 1
  fi
fi
# The BuildKit container reads this back: its working directory has to match
# the one the plan was generated for, and it is fixed in the pod spec before
# any of the above is known.
echo "$ORCHARD_BUILD_DIR" > ${BUILD_DIR_FILE}

cd "$ORCHARD_BUILD_DIR"
${configOverrideBlock}
echo "=== Running Railpack prepare ==="
# xtrace is off for exactly this command: --env carries every build-time
# variable, secrets included, and this container's log is both shown to the user
# and dumped verbatim into the build log when a build fails.
set +x
# --error-missing-start turns "no start command detected" from a warning
# (validate.go:71) into a hard failure. Without it Railpack still writes a plan,
# and buildkit/convert.go:65 bakes CMD ["/bin/bash"] into the image: the build
# reports success and ships a container that exits 0 with no output at all.
# Failing here costs a build and hands the user Railpack's own explanation of
# what to set; the alternative is a green build and a silent CrashLoopBackOff.
railpack prepare . --plan-out railpack-plan.json --info-out railpack-info.json --error-missing-start ${envArgs}${configFileArg}
set -x

echo "=== Railpack prepare completed ==="
echo "Generated files:"
ls -la railpack-plan.json railpack-info.json 2>/dev/null || echo "Warning: Some files may not have been generated"

# Show build info for logging
if [ -f railpack-info.json ]; then
  echo "=== Build Info ==="
  cat railpack-info.json
  # Single-line copy behind a sentinel so the server can reconcile what
  # Railpack actually detected against what the create form guessed. The
  # pretty-printed dump above is for humans reading the build log.
  # Container runtimes split log lines past ~16KB; if this info ever grows
  # beyond that the parser simply finds no detection, which costs a label
  # and never the build.
  echo "${RAILPACK_INFO_MARKER}$(tr -d '\\n' < railpack-info.json)"
fi
`;
  }

  private generateBuildctlArgsForDockerfile(options: {
    dockerfilePath: string;
    fullImageName: string;
    target?: string;
    buildFromRoot: boolean;
    envVars: Record<string, string>;
    secretEnvKeys?: string[];
    skipCache?: boolean;
    daemonClient?: boolean;
    s3Plan?: S3CachePlan;
  }): BuildctlArg[] {
    const { dockerfilePath, fullImageName, target, buildFromRoot, envVars, secretEnvKeys } =
      options;

    let dockerfileDir = '.';
    let dockerfileName = 'Dockerfile';

    if (buildFromRoot) {
      // Build from root, dockerfile path is relative to root
      dockerfileName = dockerfilePath;
    } else {
      // Build from dockerfile's directory
      const parts = dockerfilePath.split('/');
      if (parts.length > 1) {
        dockerfileName = parts.pop()!;
        dockerfileDir = parts.join('/');
      } else {
        dockerfileName = dockerfilePath;
      }
    }

    const args: BuildctlArg[] = [
      'build',
      '--progress',
      this.buildkitProgress,
      '--frontend',
      'dockerfile.v0',
      '--local',
      `context=${buildFromRoot ? '.' : dockerfileDir}`,
      '--local',
      `dockerfile=${buildFromRoot ? '.' : dockerfileDir}`,
      '--opt',
      `filename=${dockerfileName}`,
      '--opt',
      `platform=${BUILD_PLATFORM}`
    ];

    if (target) {
      args.push('--opt', `target=${target}`);
    }

    Object.keys(envVars).forEach((key, index) => {
      args.push('--opt', { shell: `build-arg:${key}="$${buildArgEnvName(index)}"` });
    });
    for (const flag of buildSecretFlags(Object.keys(envVars), secretEnvKeys, (_key, index) =>
      buildArgEnvName(index)
    )) {
      args.push('--secret', flag);
    }
    if (!('BUILDKIT_DOCKERFILE_CHECK' in envVars)) {
      args.push('--opt', 'build-arg:BUILDKIT_DOCKERFILE_CHECK=skip=SecretsUsedInArgOrEnv');
    }

    // Add cache arguments (namespaced per image to prevent cross-deployment contamination)
    // Skip when using persistent daemon: its content store IS the cache.
    // Strip the tag from the cache key: tags change per build (timestamp), so
    // including them means every build writes to a unique cache path and never
    // gets a hit. Also strip the registry/project prefix since it's constant.
    if (!options.skipCache) {
      const cacheImageKey = fullImageName.replace(/:[^/]*$/, '').replace(/^[^/]*\/[^/]*\//, '');
      const cacheArgs = this.buildCacheArgs(cacheImageKey, options.s3Plan);
      for (const cacheArg of cacheArgs) {
        args.push(cacheArg);
      }
    }

    if (this.sidecarPushEnabled && (!options.skipCache || options.daemonClient)) {
      args.push(
        '--output',
        `type=oci,"name=${fullImageName}",dest=/output/image,tar=false,compression=zstd,oci-mediatypes=true`
      );
    } else {
      args.push(
        '--output',
        `type=image,"name=${fullImageName}",push=true,compression=zstd,oci-mediatypes=true`
      );
    }

    return args;
  }

  private generateBuildctlArgsForRailpack(options: {
    fullImageName: string;
    envVars: Record<string, string>;
    secretsHash: string;
    cacheKey?: string;
    skipCache?: boolean;
    daemonClient?: boolean;
    s3Plan?: S3CachePlan;
  }): BuildctlArg[] {
    const { fullImageName, envVars, secretsHash, cacheKey } = options;

    const args: BuildctlArg[] = [
      'build',
      '--progress',
      this.buildkitProgress,
      '--frontend',
      'gateway.v0',
      '--opt',
      `source=${this.railpackFrontendImage}`,
      '--local',
      'context=.',
      '--local',
      'dockerfile=.'
    ];

    if (secretsHash) {
      args.push('--opt', `build-arg:secrets-hash=${secretsHash}`);
    }

    if (cacheKey) {
      args.push('--opt', `build-arg:cache-key=${cacheKey}`);
    }

    for (const key of Object.keys(envVars)) {
      args.push('--secret', `id=${key},env=${key}`);
    }

    // Skip cache when using persistent daemon: its content store IS the cache.
    if (!options.skipCache) {
      const cacheImageKey = fullImageName.replace(/:[^/]*$/, '').replace(/^[^/]*\/[^/]*\//, '');
      const cacheArgs = this.buildCacheArgs(cacheImageKey, options.s3Plan);
      for (const cacheArg of cacheArgs) {
        args.push(cacheArg);
      }
    }

    if (this.sidecarPushEnabled && (!options.skipCache || options.daemonClient)) {
      args.push(
        '--output',
        `type=oci,"name=${fullImageName}",dest=/output/image,tar=false,compression=zstd,oci-mediatypes=true`
      );
    } else {
      args.push(
        '--output',
        `type=image,"name=${fullImageName}",push=true,compression=zstd,oci-mediatypes=true`
      );
    }

    return args;
  }

  private generateBuildctlArgs(options: {
    dockerfilePath: string;
    fullImageName: string;
    target?: string;
    buildFromRoot: boolean;
    buildType: 'dockerfile' | 'railpack';
    envVars: Record<string, string>;
    secretEnvKeys?: string[];
    secretsHash?: string;
    cacheKey?: string;
    skipCache?: boolean;
    daemonClient?: boolean;
    s3Plan?: S3CachePlan;
  }): BuildctlArg[] {
    const {
      buildType,
      fullImageName,
      envVars,
      secretEnvKeys,
      secretsHash,
      cacheKey,
      skipCache,
      daemonClient,
      s3Plan,
      ...dockerfileOptions
    } = options;

    if (buildType === 'railpack') {
      return this.generateBuildctlArgsForRailpack({
        fullImageName,
        envVars,
        secretsHash: secretsHash || '',
        cacheKey,
        skipCache,
        daemonClient,
        s3Plan
      });
    }

    return this.generateBuildctlArgsForDockerfile({
      ...dockerfileOptions,
      fullImageName,
      envVars,
      secretEnvKeys,
      skipCache,
      daemonClient,
      s3Plan
    });
  }

  private computeSecretsHash(envVars: Record<string, string>): string {
    const secrets = Object.entries(envVars)
      .filter(([, value]) => value && typeof value === 'string')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    if (!secrets) {
      return '';
    }

    return crypto.createHash('sha256').update(secrets).digest('hex');
  }

  /**
   * Emit per-phase spans (clone / image build / registry push) for a finished
   * build job, using the exact container timestamps Kubernetes reports:
   * git-clone init container, buildkit main container, pusher sidecar.
   * Best-effort: failures here never affect the build result.
   */
  private async emitBuildPhaseSpans(jobName: string, deploymentId?: string): Promise<void> {
    try {
      this.ensureKubeConfig();
      const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
      const pods = await coreApi.listNamespacedPod(
        this.builderNamespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `job-name=${jobName}`
      );
      const pod = pods.body.items[0];
      if (!pod) return;

      const tags = { 'build.job_name': jobName, 'build.deployment_id': deploymentId };
      const windowOf = (s?: k8s.V1ContainerStatus) => {
        const t = s?.state?.terminated;
        if (!t?.startedAt || !t?.finishedAt) return null;
        return { start: new Date(t.startedAt).getTime(), end: new Date(t.finishedAt).getTime() };
      };

      const clone = windowOf(
        pod.status?.initContainerStatuses?.find((c) => c.name === 'git-clone')
      );
      if (clone) recordPhaseSpan('build.clone', clone.start, clone.end, tags);

      const mainName = this.mainContainerName(pod.status?.containerStatuses);
      const image = windowOf(pod.status?.containerStatuses?.find((c) => c.name === mainName));
      if (image) recordPhaseSpan('build.image', image.start, image.end, tags);

      // The pusher sidecar starts with the pod and idles until buildkit hands
      // it the image, so clamp its window to begin where the build ended,
      // otherwise "push" would include the whole build as wait time.
      const push = windowOf(pod.status?.containerStatuses?.find((c) => c.name === 'pusher'));
      if (push) {
        const start = image ? Math.max(push.start, image.end) : push.start;
        recordPhaseSpan('build.push', start, push.end, tags);
      }
    } catch (error) {
      console.warn(
        `[ImageBuilder] Failed to emit build phase spans for ${jobName}:`,
        (error as Error).message
      );
    }
  }

  /**
   * Record what Railpack actually detected, so the UI can show the real answer
   * instead of the create-form's guess. Best effort: a build that succeeded
   * must never fail because we could not store a label.
   */
  private async persistRailpackDetection(
    deploymentId: string | undefined,
    infoLog: string
  ): Promise<void> {
    if (!deploymentId) return;

    const detection = parseRailpackInfo(infoLog);
    if (!detection) return;

    try {
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { detectedConfig: detection as unknown as object }
      });
    } catch (error) {
      console.warn(
        `[ImageBuilder] Could not persist Railpack detection for ${deploymentId}:`,
        error.message
      );
    }
  }

  /**
   * Pull the marker line the railpack-prepare init container echoed.
   *
   * The normal log path only reads the buildkit container: init container
   * logs are a failure-path fallback, so this is a targeted read. It runs at
   * most once per job (the status poll is on a timer) and only after the
   * container has terminated, since the marker is the last thing it prints.
   */
  private async readRailpackInfoLog(
    coreApi: k8s.CoreV1Api,
    podName: string | undefined,
    jobName: string,
    initContainerStatuses: k8s.V1ContainerStatus[] | undefined
  ): Promise<string | undefined> {
    if (!podName || this.railpackInfoFetched.has(jobName)) return undefined;

    const prepare = initContainerStatuses?.find((ics) => ics.name === 'railpack-prepare');
    if (!prepare?.state?.terminated) return undefined;

    this.railpackInfoFetched.add(jobName);

    try {
      const res = await coreApi.readNamespacedPodLog(
        podName,
        this.builderNamespace,
        'railpack-prepare',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        // The marker is the final line, so the tail only has to be long enough
        // to reach it. It is generous because the same read is what gets shown
        // to the user: Railpack's detection summary, resolved package versions
        // and any warnings all print above the railpack-info.json dump, and
        // that is the only place a warning like "no start command detected"
        // ever appears.
        400
      );
      return podLogText(res.body);
    } catch (error) {
      console.warn(
        `[ImageBuilder] Could not read railpack-prepare logs for ${podName}:`,
        error.message
      );
      return undefined;
    }
  }

  /**
   * Put Railpack's own prepare output into the build log.
   *
   * Without it the build log for a Railpack build starts at the buildkit
   * container, so everything Railpack says about the repo (which provider it
   * picked, which versions it resolved, every warning it raised) is thrown away
   * on success and only survives when the build happens to fail. That is
   * precisely backwards: a warning matters most on the builds that go green.
   *
   * The read is guarded to once per job, so this appends once.
   */
  private async appendRailpackPrepareLog(deploymentId: string | undefined, prepareLog: string) {
    if (!deploymentId) return;

    const body = prepareLog
      // Everything from here down is the pretty-printed copy of
      // railpack-info.json plus the machine-readable marker line: the same
      // detection that already lands on the deployment as a label.
      .split(`=== Build Info ===`)[0]
      .split('\n')
      // Shell xtrace from the installer steps above; noise, not build output.
      .filter((line) => !line.startsWith('+ '))
      .join('\n')
      .trim();

    if (!body) return;

    const block = `\n=== Railpack ===\n${this.sanitizeLogMessage(body, deploymentId)}\n\n`;

    try {
      await this.prisma.$executeRaw`
        UPDATE "deployments"
        SET "build_logs" = COALESCE("build_logs", '') || ${block},
            "updated_at" = (NOW() AT TIME ZONE 'UTC')
        WHERE "id" = ${deploymentId}::uuid
      `;
    } catch (error) {
      console.warn(
        `[ImageBuilder] Could not append railpack-prepare log for ${deploymentId}:`,
        error.message
      );
    }
  }

  async getBuildJobStatus(jobName: string): Promise<BuildJobStatus> {
    this.ensureKubeConfig();
    const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);

    try {
      const job = await batchApi.readNamespacedJob(jobName, this.builderNamespace);
      const jobSpec = job.body;

      console.log(
        `[ImageBuilder] Job ${jobName} status:`,
        JSON.stringify({
          succeeded: jobSpec.status?.succeeded,
          failed: jobSpec.status?.failed,
          active: jobSpec.status?.active,
          conditions: jobSpec.status?.conditions,
          startTime: jobSpec.status?.startTime,
          completionTime: jobSpec.status?.completionTime
        })
      );

      let status: BuildJobStatus['status'] = 'unknown';
      let logs = '';
      let pusherLogs = '';
      let railpackInfoLog: string | undefined;
      let schedulingMessage: string | undefined;
      let startupMessage: string | undefined;

      if (jobSpec.status?.succeeded && jobSpec.status.succeeded > 0) {
        status = 'succeeded';
      } else if (jobSpec.status?.failed && jobSpec.status.failed > 0) {
        status = 'failed';
        console.error(
          `[ImageBuilder] Job ${jobName} failed. Conditions:`,
          JSON.stringify(jobSpec.status?.conditions)
        );
      } else if (jobSpec.status?.active && jobSpec.status.active > 0) {
        // A Job counts an unscheduled pod as active, so this is only a
        // provisional 'running': the pod's own phase decides, below.
        status = 'running';
      } else {
        status = 'pending';
      }

      try {
        const pods = await coreApi.listNamespacedPod(
          this.builderNamespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `job-name=${jobName}`
        );

        console.log(`[ImageBuilder] Found ${pods.body.items.length} pods for job ${jobName}`);

        if (pods.body.items.length > 0) {
          const pod = pods.body.items[0];
          const podName = pod.metadata?.name;
          const podPhase = pod.status?.phase;
          const podConditions = pod.status?.conditions;
          const containerStatuses = pod.status?.containerStatuses;
          const initContainerStatuses = pod.status?.initContainerStatuses;

          if (status === 'running' && podPhase === 'Pending') {
            status = 'pending';
          }

          const scheduled = podConditions?.find((c) => c.type === 'PodScheduled');
          if (scheduled?.status === 'False') {
            schedulingMessage =
              [scheduled.reason, scheduled.message].filter(Boolean).join(': ') ||
              'pod is not schedulable';
          }

          // A pod that scheduled fine but whose container config kubelet keeps
          // rejecting never leaves Pending and never writes a log line, so it
          // burns the entire build timeout in silence. Surface the waiting
          // reason so the caller can fail fast with something actionable.
          if (!schedulingMessage && podPhase === 'Pending') {
            const blocked = [...(initContainerStatuses ?? []), ...(containerStatuses ?? [])].find(
              (cs) => ImageBuilderService.FATAL_WAITING_REASONS.has(cs.state?.waiting?.reason ?? '')
            );
            const waiting = blocked?.state?.waiting;
            if (waiting) {
              startupMessage = `container ${blocked?.name}: ${waiting.reason}${waiting.message ? ` - ${waiting.message}` : ''}`;
            }
          }

          const sandboxMissing = podConditions?.some(
            (c) => c.type === 'PodReadyToStartContainers' && c.status === 'False'
          );
          if (!schedulingMessage && !startupMessage && podPhase === 'Pending' && sandboxMissing) {
            const events = await coreApi
              .listNamespacedEvent(
                this.builderNamespace,
                undefined,
                undefined,
                undefined,
                `involvedObject.name=${podName}`
              )
              .catch(() => null);
            startupMessage =
              sandboxStartFailure(events?.body.items ?? [], {
                runtimeClassName: pod.spec?.runtimeClassName,
                annotations: pod.metadata?.annotations
              }) ?? undefined;
          }

          railpackInfoLog = await this.readRailpackInfoLog(
            coreApi,
            podName,
            jobName,
            initContainerStatuses
          );

          console.log(
            `[ImageBuilder] Pod ${podName} details:`,
            JSON.stringify({
              phase: podPhase,
              conditions: podConditions,
              containerStatuses: containerStatuses?.map((cs) => ({
                name: cs.name,
                ready: cs.ready,
                state: cs.state,
                lastState: cs.lastState
              })),
              initContainerStatuses: initContainerStatuses?.map((ics) => ({
                name: ics.name,
                ready: ics.ready,
                state: ics.state,
                lastState: ics.lastState
              }))
            })
          );

          if (status === 'failed' || podPhase === 'Failed') {
            const failureReasons: string[] = [];

            if (pod.status?.reason) {
              failureReasons.push(
                `Pod ${pod.status.reason}: ${pod.status.message || 'No message'}`
              );
            }

            if (containerStatuses) {
              for (const cs of containerStatuses) {
                if (cs.state?.terminated) {
                  // The exit code is the only thing BuildKit leaves behind when
                  // it dies before producing output, and the summarizer drops
                  // any reason line that carries no detail. Without it a build
                  // that exited 127 reports as whatever the pusher said when
                  // its sibling container vanished underneath it.
                  const exit = cs.state.terminated.exitCode;
                  const detail =
                    cs.state.terminated.message ||
                    (typeof exit === 'number' ? `exit code ${exit}` : 'No message');
                  failureReasons.push(
                    `Container ${cs.name} terminated: ${cs.state.terminated.reason || 'Unknown'} - ${detail}`
                  );
                  console.error(
                    `[ImageBuilder] Container failure:`,
                    JSON.stringify(cs.state.terminated)
                  );
                }
                if (cs.state?.waiting) {
                  failureReasons.push(
                    `Container ${cs.name} waiting: ${cs.state.waiting.reason || 'Unknown'} - ${cs.state.waiting.message || 'No message'}`
                  );
                  console.error(
                    `[ImageBuilder] Container waiting:`,
                    JSON.stringify(cs.state.waiting)
                  );
                }
              }
            }

            if (initContainerStatuses) {
              for (const ics of initContainerStatuses) {
                if (ics.state?.terminated && ics.state.terminated.exitCode !== 0) {
                  failureReasons.push(
                    `Init container ${ics.name} failed with exit code ${ics.state.terminated.exitCode}: ${ics.state.terminated.reason || 'Unknown'} - ${ics.state.terminated.message || 'No message'}`
                  );
                  console.error(
                    `[ImageBuilder] Init container failure:`,
                    JSON.stringify(ics.state.terminated)
                  );
                }
                if (ics.state?.waiting) {
                  failureReasons.push(
                    `Init container ${ics.name} waiting: ${ics.state.waiting.reason || 'Unknown'} - ${ics.state.waiting.message || 'No message'}`
                  );
                  console.error(
                    `[ImageBuilder] Init container waiting:`,
                    JSON.stringify(ics.state.waiting)
                  );
                }
              }
            }

            if (failureReasons.length > 0) {
              logs = `Build job failed with the following reasons:\n${failureReasons.join('\n')}\n\n`;
            }
          }

          if (podName) {
            try {
              const logResponse = await coreApi.readNamespacedPodLog(
                podName,
                this.builderNamespace,
                this.mainContainerName(containerStatuses),
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                5000
              );
              logs += podLogText(logResponse.body);

              const hasPusherContainer = containerStatuses?.some((cs) => cs.name === 'pusher');
              if (hasPusherContainer && status !== 'pending') {
                try {
                  const pusherLog = await coreApi.readNamespacedPodLog(
                    podName,
                    this.builderNamespace,
                    'pusher',
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    5000
                  );
                  const pusherText = podLogText(pusherLog.body);
                  if (pusherText.trim().length > 0) {
                    pusherLogs = pusherText;
                  }
                } catch (pusherLogError) {
                  console.warn(
                    `[ImageBuilder] Could not fetch pusher logs for pod ${podName}:`,
                    pusherLogError.message
                  );
                }
              }
            } catch (buildkitLogError) {
              console.warn(
                `[ImageBuilder] Could not fetch buildkit logs for pod ${podName}:`,
                buildkitLogError.message
              );

              try {
                const allContainerLogs: string[] = [];

                if (initContainerStatuses) {
                  for (const ics of initContainerStatuses) {
                    try {
                      const initLogResponse = await coreApi.readNamespacedPodLog(
                        podName,
                        this.builderNamespace,
                        ics.name,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        undefined,
                        1000
                      );
                      allContainerLogs.push(
                        `\n=== Init Container: ${ics.name} ===\n${podLogText(initLogResponse.body)}`
                      );
                    } catch (initLogErr) {
                      console.warn(
                        `[ImageBuilder] Could not fetch logs for init container ${ics.name}:`,
                        initLogErr.message
                      );
                    }
                  }
                }

                if (allContainerLogs.length > 0) {
                  logs += allContainerLogs.join('\n');
                }
              } catch (fallbackError) {
                console.error(
                  `[ImageBuilder] Failed to fetch any container logs:`,
                  fallbackError.message
                );
              }
            }
          }
        }
      } catch (logError) {
        console.error(
          `[ImageBuilder] Error fetching pod details for job ${jobName}:`,
          logError.message
        );
        if (logError.body) {
          console.error(`[ImageBuilder] Error body:`, JSON.stringify(logError.body));
        }
      }

      const imageRef =
        jobSpec.metadata?.annotations?.['orchard.my/full-image'] ??
        jobSpec.metadata?.annotations?.['orchard.dev/full-image'];

      return {
        jobName,
        status,
        logs,
        pusherLogs,
        imageRef,
        railpackInfoLog,
        schedulingMessage,
        startupMessage
      };
    } catch (error) {
      if (error.statusCode === 404) {
        console.warn(`[ImageBuilder] Job ${jobName} not found (404)`);
        return {
          jobName,
          status: 'unknown',
          logs: 'Job not found'
        };
      }
      console.error(`[ImageBuilder] Error reading job ${jobName}:`, error.message);
      if (error.body) {
        console.error(`[ImageBuilder] Error body:`, JSON.stringify(error.body));
      }
      throw error;
    }
  }

  private async resolveVanishedJob(
    jobName: string,
    deploymentId: string | undefined,
    expectedImage: string | null | undefined,
    reason: string
  ): Promise<BuildJobStatus> {
    if (expectedImage) {
      const pushed = await this.imageExistsInRegistry(expectedImage);
      if (pushed === true) {
        await this.appendLog(
          deploymentId,
          `Build job ${jobName} is gone but ${expectedImage} is in the registry; treating the build as successful.`
        );
        return { jobName, status: 'succeeded', imageRef: expectedImage };
      }
    }
    await this.appendLog(
      deploymentId,
      `Build job ${jobName} disappeared before reporting a result (${reason}).`,
      'ERROR'
    );
    throw new BadRequestException(
      `Build failed: the build job disappeared before it reported a result (${reason}). Your code didn't cause this. Retry the build.`
    );
  }

  async waitForBuildJob(
    jobName: string,
    deploymentId?: string,
    timeoutMs = 1800000,
    opts?: { expectedImage?: string | null }
  ): Promise<BuildJobStatus> {
    const startTime = Date.now();
    const pollInterval = 3000;
    const missingGraceMs = 15000;
    const expectedImage = opts?.expectedImage ?? null;
    let lastLoggedStatus = '';
    let lastKnownPhase = 'unknown';
    let pollCount = 0;
    let missingSince: number | null = null;
    let lastTerminalSignalAt = 0;

    console.log(
      `[ImageBuilder] Starting to wait for build job ${jobName} (timeout: ${timeoutMs / 1000}s, deploymentId: ${deploymentId})`
    );
    await this.seedLogOffsets(jobName, deploymentId);
    await this.appendLog(deploymentId, `Waiting for build job ${jobName} to complete...`);

    // Scheduling wait: job submitted → pod actually running. Finishes on the
    // first non-pending status observed (5s poll granularity).
    const scheduleSpan = startPhaseSpan('build.schedule', {
      'build.job_name': jobName,
      'build.deployment_id': deploymentId
    });

    while (Date.now() - startTime < timeoutMs) {
      pollCount++;
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

      try {
        const status = await this.getBuildJobStatus(jobName);

        if (status.railpackInfoLog) {
          await this.persistRailpackDetection(deploymentId, status.railpackInfoLog);
          await this.appendRailpackPrepareLog(deploymentId, status.railpackInfoLog);
        }

        if (status.status !== 'pending' && status.status !== 'unknown') {
          scheduleSpan.finish({ 'build.schedule_outcome': status.status });
          await this.stampBuildTime(deploymentId, 'scheduled');
        }

        if (status.status === 'unknown') {
          const observed = this.jobInformer?.get(jobName) ?? null;
          if (observed?.phase === 'succeeded' || observed?.phase === 'failed') {
            lastKnownPhase = observed.phase;
          }
          missingSince ??= Date.now();
          const missingFor = Date.now() - missingSince;
          if (missingFor >= missingGraceMs) {
            lastKnownPhase = 'gone';
            scheduleSpan.finish({ 'build.schedule_outcome': 'gone' });
            // The pod is unreachable, so no step will ever report back. Close
            // out whatever was open rather than leaving it spinning forever.
            await this.flushBuildkitSteps(deploymentId, jobName);
            this.clearBuildkitOffset(jobName);
            this.buildkitPushDetected.delete(jobName);
            this.buildkitBuildingDetected.delete(jobName);
            this.jobInformer?.release(jobName);
            try {
              const resolved = await this.resolveVanishedJob(
                jobName,
                deploymentId,
                expectedImage ?? observed?.image ?? null,
                observed?.reason ?? 'not found'
              );
              recordBuildOutcome({
                outcome: 'succeeded',
                source: 'watch',
                reason: 'job_missing',
                deploymentId: deploymentId ?? 'unknown',
                jobName,
                durationMs: Date.now() - startTime,
                lastPhase: 'gone'
              });
              return resolved;
            } catch (vanished) {
              recordBuildOutcome({
                outcome: 'failed',
                source: 'watch',
                reason: observed?.reason === 'JobDeleted' ? 'job_deleted' : 'job_missing',
                deploymentId: deploymentId ?? 'unknown',
                jobName,
                durationMs: Date.now() - startTime,
                lastPhase: 'gone',
                detail: (vanished as Error)?.message
              });
              throw vanished;
            }
          }
        } else {
          missingSince = null;
          lastKnownPhase = status.status;
        }

        if (status.status !== lastLoggedStatus) {
          console.log(
            `[ImageBuilder] Job ${jobName} status changed: ${lastLoggedStatus} -> ${status.status} (poll #${pollCount}, elapsed: ${elapsedSeconds}s)`
          );
          lastLoggedStatus = status.status;
        }

        if (status.status === 'succeeded') {
          console.log(
            `[ImageBuilder] Build job ${jobName} completed successfully after ${elapsedSeconds}s`
          );
          await this.streamBuildkitOutput(deploymentId, jobName, status.logs, true);
          await this.streamPusherOutput(deploymentId, jobName, status.pusherLogs);
          this.appendLog(deploymentId, `Build job ${jobName} completed successfully`).catch(
            () => {}
          );
          this.clearBuildkitOffset(jobName);
          this.emitBuildPhaseSpans(jobName, deploymentId).catch(() => {});
          this.jobInformer?.release(jobName);
          recordBuildOutcome({
            outcome: 'succeeded',
            source: 'watch',
            deploymentId: deploymentId ?? 'unknown',
            jobName,
            durationMs: Date.now() - startTime,
            lastPhase: 'succeeded'
          });
          return status;
        }

        if (status.status === 'failed') {
          const failureLogs = transcodeRawjson(status.logs);
          const errorMsg = failureLogs || 'Unknown error - no logs available';
          console.error(
            `[ImageBuilder] Build job ${jobName} failed after ${elapsedSeconds}s. Error: ${errorMsg.substring(0, 500)}`
          );
          await this.streamBuildkitOutput(deploymentId, jobName, status.logs, true);
          await this.streamPusherOutput(deploymentId, jobName, status.pusherLogs);
          await this.appendLog(deploymentId, `Build job ${jobName} failed`, 'ERROR');

          if (!status.logs && !status.pusherLogs) {
            await this.appendLog(
              deploymentId,
              'No build logs available - this may indicate a pod scheduling or initialization failure',
              'ERROR'
            );
          }

          this.clearBuildkitOffset(jobName);
          this.buildkitPushDetected.delete(jobName);
          this.buildkitBuildingDetected.delete(jobName);
          await this.emitBuildPhaseSpans(jobName, deploymentId);

          this.jobInformer?.release(jobName);
          const summary = summarizeBuildFailure(failureLogs, status.pusherLogs);
          recordBuildOutcome({
            outcome: 'failed',
            source: 'watch',
            reason: 'build_error',
            deploymentId: deploymentId ?? 'unknown',
            jobName,
            durationMs: Date.now() - startTime,
            lastPhase: 'failed',
            detail: summary || errorMsg
          });
          throw new BadRequestException(
            summary
              ? `Build failed: ${summary}`
              : 'Build failed: No logs available. This typically indicates a pod scheduling failure, image pull error, or init container failure. Check Kubernetes pod events for more details.'
          );
        }

        if (status.status === 'running') {
          await this.markCloning(deploymentId);
          await this.streamBuildkitOutput(deploymentId, jobName, status.logs);
          if (this.buildkitPushDetected.has(jobName)) {
            await this.streamPusherOutput(deploymentId, jobName, status.pusherLogs);
          }
        } else if (deploymentId) {
          this.prisma.$executeRaw`
            UPDATE "deployments" SET "updated_at" = (NOW() AT TIME ZONE 'UTC') WHERE "id" = ${deploymentId}::uuid
          `.catch(() => {});
        }

        if (status.status === 'pending' && status.startupMessage && elapsedSeconds > 60) {
          await this.appendLog(
            deploymentId,
            `Build pod could not start: ${status.startupMessage}`,
            'ERROR'
          );
          await this.deleteBuildJob(jobName).catch(() => {});
          this.jobInformer?.release(jobName);
          recordBuildOutcome({
            outcome: 'failed',
            source: 'watch',
            reason: 'pod_start_failed',
            deploymentId: deploymentId ?? 'unknown',
            jobName,
            durationMs: Date.now() - startTime,
            lastPhase: 'pending',
            detail: status.startupMessage
          });
          throw new BadRequestException(`Build failed: ${status.startupMessage}`);
        }

        if (status.status === 'pending' && elapsedSeconds > 60) {
          const detail = status.schedulingMessage ? ` (${status.schedulingMessage})` : '';
          console.warn(
            `[ImageBuilder] Job ${jobName} still pending after ${elapsedSeconds}s - possible scheduling issue${detail}`
          );

          // An unschedulable pod does not recover on its own often enough to
          // justify burning the whole build timeout on it. Give the scheduler
          // a grace window, then fail with the reason instead of a silent wait.
          if (status.schedulingMessage && elapsedSeconds > this.pendingScheduleTimeoutSeconds) {
            await this.appendLog(
              deploymentId,
              `Build job could not be scheduled after ${elapsedSeconds}s: ${status.schedulingMessage}`,
              'ERROR'
            );
            await this.deleteBuildJob(jobName).catch(() => {});
            this.jobInformer?.release(jobName);
            recordBuildOutcome({
              outcome: 'failed',
              source: 'watch',
              reason: 'unschedulable',
              deploymentId: deploymentId ?? 'unknown',
              jobName,
              durationMs: Date.now() - startTime,
              lastPhase: 'pending',
              detail: status.schedulingMessage
            });
            throw new BadRequestException(
              `Build failed: could not schedule build pod after ${elapsedSeconds}s - ${status.schedulingMessage}`
            );
          }

          if (elapsedSeconds % 30 === 0) {
            await this.appendLog(
              deploymentId,
              `Build job still pending after ${elapsedSeconds}s${detail} - waiting for pod to be scheduled...`,
              'WARNING'
            );
          }
        }
      } catch (error) {
        console.error(
          `[ImageBuilder] Error polling build job ${jobName} status (poll #${pollCount}):`,
          error.message
        );
        if (error.body) {
          console.error(`[ImageBuilder] Error details:`, JSON.stringify(error.body));
        }

        if (error instanceof BadRequestException) {
          throw error;
        }

        await this.appendLog(
          deploymentId,
          `Warning: Error checking build status: ${error.message}`,
          'WARNING'
        );
      }

      const waitStartedAt = Date.now();
      const terminal = this.jobInformer
        ? await this.jobInformer.waitForTerminal(jobName, pollInterval)
        : null;
      const earlyWakeEarned = isUnseenTerminalSignal(terminal, lastTerminalSignalAt);
      if (earlyWakeEarned && terminal) {
        lastTerminalSignalAt = terminal.at;
        console.log(
          `[ImageBuilder] Job ${jobName} reached ${terminal.phase} via watch after ${Math.floor((Date.now() - startTime) / 1000)}s`
        );
      }
      const settleMs = remainingIntervalMs(
        pollInterval,
        Date.now() - waitStartedAt,
        earlyWakeEarned
      );
      if (settleMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, settleMs);
        });
      }
    }

    const finalElapsed = Math.floor((Date.now() - startTime) / 1000);
    console.error(
      `[ImageBuilder] Build job ${jobName} timed out after ${finalElapsed}s (${pollCount} polls)`
    );
    await this.appendLog(
      deploymentId,
      `Build job ${jobName} timed out after ${finalElapsed}s`,
      'ERROR'
    );

    let finalPhase = lastKnownPhase;
    try {
      const finalStatus = await this.getBuildJobStatus(jobName);
      finalPhase = finalStatus.status;
      await this.streamBuildkitOutput(deploymentId, jobName, finalStatus.logs, true);
      await this.streamPusherOutput(deploymentId, jobName, finalStatus.pusherLogs);
      await this.appendLog(deploymentId, `Final status: ${finalStatus.status}`, 'ERROR');
    } catch (finalCheckError) {
      console.error(`[ImageBuilder] Could not fetch final status:`, finalCheckError.message);
    }

    this.clearBuildkitOffset(jobName);
    this.buildkitPushDetected.delete(jobName);
    this.buildkitBuildingDetected.delete(jobName);
    this.jobInformer?.release(jobName);
    scheduleSpan.finish({ 'build.schedule_outcome': 'timeout' });
    recordBuildOutcome({
      outcome: 'timeout',
      source: 'watch',
      reason: 'watch_timeout',
      deploymentId: deploymentId ?? 'unknown',
      jobName,
      durationMs: Date.now() - startTime,
      lastPhase: finalPhase,
      detail: `timed out after ${finalElapsed}s; last status ${lastLoggedStatus || 'none'}`
    });
    throw new BadRequestException(
      `Build job timed out after ${finalElapsed} seconds (last status: ${lastLoggedStatus})`
    );
  }

  async deleteBuildJob(jobName: string): Promise<void> {
    this.ensureKubeConfig();
    const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);

    try {
      await batchApi.deleteNamespacedJob(
        jobName,
        this.builderNamespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'Background'
      );
      await this.deleteBuildJobSecrets(jobName).catch(() => {});
      console.log(`[ImageBuilder] Deleted job ${jobName}`);
    } catch (error) {
      if (error.statusCode !== 404) {
        console.error(`[ImageBuilder] Failed to delete job ${jobName}:`, error.message);
      }
    }
  }

  async cancelBuildJobsByDeploymentId(deploymentId: string): Promise<void> {
    this.ensureKubeConfig();
    const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);

    try {
      const labelSelector = `orchard.my/deployment-id=${deploymentId}`;
      console.log(`[ImageBuilder] Looking for build jobs with label selector: ${labelSelector}`);

      const [current, legacy] = await Promise.all([
        batchApi.listNamespacedJob(
          this.builderNamespace,
          undefined,
          undefined,
          undefined,
          undefined,
          labelSelector
        ),
        batchApi.listNamespacedJob(
          this.builderNamespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `orchard.dev/deployment-id=${deploymentId}`
        )
      ]);
      const jobNames = new Set<string>();
      const jobs = {
        body: {
          items: [...current.body.items, ...legacy.body.items].filter((j) => {
            const n = j.metadata?.name;
            if (!n || jobNames.has(n)) return false;
            jobNames.add(n);
            return true;
          })
        }
      };

      if (jobs.body.items.length === 0) {
        console.log(`[ImageBuilder] No build jobs found for deployment ${deploymentId}`);
        return;
      }

      console.log(
        `[ImageBuilder] Found ${jobs.body.items.length} build job(s) for deployment ${deploymentId}`
      );

      for (const job of jobs.body.items) {
        const jobName = job.metadata?.name;
        if (!jobName) continue;

        try {
          console.log(
            `[ImageBuilder] Deleting build job ${jobName} for deployment ${deploymentId}`
          );

          const pods = await coreApi.listNamespacedPod(
            this.builderNamespace,
            undefined,
            undefined,
            undefined,
            undefined,
            `job-name=${jobName}`
          );

          for (const pod of pods.body.items) {
            const podName = pod.metadata?.name;
            if (podName) {
              console.log(`[ImageBuilder] Force deleting pod ${podName} for job ${jobName}`);
              try {
                await coreApi.deleteNamespacedPod(
                  podName,
                  this.builderNamespace,
                  undefined,
                  undefined,
                  0,
                  undefined,
                  'Background'
                );
              } catch (podDeleteError) {
                if (podDeleteError.statusCode !== 404) {
                  console.warn(
                    `[ImageBuilder] Failed to delete pod ${podName}:`,
                    podDeleteError.message
                  );
                }
              }
            }
          }

          await batchApi.deleteNamespacedJob(
            jobName,
            this.builderNamespace,
            undefined,
            undefined,
            0,
            undefined,
            'Background',
            {
              propagationPolicy: 'Background'
            }
          );

          await this.deleteBuildJobSecrets(jobName).catch(() => {});
          console.log(`[ImageBuilder] Successfully deleted build job ${jobName} and its pods`);
        } catch (deleteError) {
          if (deleteError.statusCode !== 404) {
            console.error(`[ImageBuilder] Failed to delete job ${jobName}:`, deleteError.message);
          }
        }
      }
    } catch (error) {
      console.error(
        `[ImageBuilder] Error cancelling build jobs for deployment ${deploymentId}:`,
        error.message
      );
      throw error;
    }
  }

  async buildAndPush(options: BuildJobOptions): Promise<string> {
    assertBuildRegistryConfigured();
    const owned = this.trackBuildSecrets(options);
    try {
      return await this.runBuildAndPush(options);
    } finally {
      if (owned && options.deploymentId) this.buildSecretValues.delete(options.deploymentId);
    }
  }

  private trackBuildSecrets(
    options: Pick<BuildJobOptions, 'deploymentId' | 'envVars' | 'secretEnvKeys'>
  ): boolean {
    const { deploymentId } = options;
    if (!deploymentId || this.buildSecretValues.has(deploymentId)) return false;
    const values = secretValuesToMask(options.envVars ?? {}, options.secretEnvKeys ?? []);
    if (values.length === 0) return false;
    this.buildSecretValues.set(deploymentId, values);
    return true;
  }

  private async runBuildAndPush(options: BuildJobOptions): Promise<string> {
    const {
      imageName,
      tag = 'latest',
      deploymentId,
      repoUrl,
      branch,
      buildType = 'dockerfile'
    } = options;

    console.log(`[ImageBuilder] buildAndPush called with:`, {
      imageName,
      tag,
      deploymentId,
      repoUrl,
      branch,
      dockerfilePath: options.dockerfilePath,
      buildType,
      target: options.target,
      buildFromRoot: options.buildFromRoot,
      hasAccessToken: !!options.accessToken,
      envVarsCount: Object.keys(options.envVars || {}).length
    });

    let firecrackerFailure = false;
    try {
      await this.appendLog(
        deploymentId,
        `Starting BuildKit build for ${this.sanitizeLogMessage(repoUrl, deploymentId)}@${branch} (type: ${buildType})`
      );

      if (options.builder === 'firecracker') {
        await this.markCloning(deploymentId);
        try {
          return await this.buildWithFirecracker(options);
        } catch (error) {
          if (!(error instanceof FcUnavailableError)) {
            firecrackerFailure = true;
            throw error;
          }
          console.warn(
            `[ImageBuilder] Firecracker builder unavailable, falling back: ${error.message}`
          );
          await this.appendLog(
            deploymentId,
            'The fast builder is unavailable right now, using the standard builder.',
            'WARNING'
          );
          if (deploymentId) {
            await this.prisma.buildRun
              .updateMany({
                where: { deploymentId, status: 'building' },
                data: { builder: 'kubernetes' }
              })
              .catch(() => {});
          }
        }
      }

      const jobName = await this.createBuildJob({ ...options, builder: 'kubernetes' });
      console.log(`[ImageBuilder] Created build job: ${jobName}`);

      await this.waitForBuildJob(jobName, deploymentId, undefined, {
        expectedImage: `${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`
      });

      if (deploymentId && !this.buildkitPushDetected.has(jobName)) {
        this.prisma.$executeRaw`
          UPDATE "deployments"
          SET "build_step" = 'pushing',
              "build_step_timestamps" = jsonb_set(
                COALESCE("build_step_timestamps", '{}'::jsonb),
                '{pushing}',
                ${Date.now()}::text::jsonb
              )
          WHERE "id" = ${deploymentId}::uuid
        `.catch(() => {});
        this.emitBuildChanged(deploymentId).catch(() => {});
      }
      this.buildkitPushDetected.delete(jobName);
      this.buildkitBuildingDetected.delete(jobName);

      const fullImagePath = `${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`;

      console.log(`[ImageBuilder] Build completed successfully: ${fullImagePath}`);
      const imageRef = fullImagePath.split('/').slice(-1)[0] || fullImagePath;
      this.appendLog(deploymentId, `Build and push completed successfully.`).catch(() => {});
      this.appendLog(deploymentId, `Image: ${imageRef}`).catch(() => {});
      this.deleteBuildJob(jobName).catch((err) =>
        console.error('[ImageBuilder] Failed to delete build job:', err)
      );

      return fullImagePath;
    } catch (error) {
      // The build pod's Kata sandbox can fail to hand a container to the
      // hypervisor for reasons that have nothing to do with the repo being
      // built. Nothing ran, so there is nothing to report to the user beyond
      // a second attempt.
      if (
        !firecrackerFailure &&
        !options.sandboxRetried &&
        isSandboxStartFault(error?.message ?? '')
      ) {
        console.warn(
          `[ImageBuilder] Sandbox start fault for ${imageName}:${tag}, retrying: ${error.message}`
        );
        await this.appendLog(
          deploymentId,
          'The build sandbox failed to start. Retrying the build.'
        ).catch(() => {});
        return this.buildAndPush({ ...options, sandboxRetried: true });
      }

      if (
        !firecrackerFailure &&
        !options.disableSharedCache &&
        this.localCacheEnabled &&
        this.localCachePvc
      ) {
        let logTail = '';
        if (deploymentId) {
          const dep = await this.prisma.deployment
            .findUnique({ where: { id: deploymentId }, select: { buildLogs: true } })
            .catch(() => null);
          logTail = (dep?.buildLogs ?? '').slice(-20000);
        }
        // The shared cache is an optimisation, never a dependency: any fault
        // that is *specifically* the cache's gets one retry without it rather
        // than failing the user's build. Three shapes reach us:
        //   - ENOSPC, straight from buildctl or from cache-evict's mkdir.
        //   - kubelet refusing to leak the errno behind a failed subPath mkdir,
        //     which arrives as a bare CreateContainerConfigError with no build
        //     logs at all: matchable only by shape.
        //   - cache-evict exiting non-zero. That container touches nothing but
        //     the shared cache, so its failure can't mean anything else.
        const message = error?.message ?? '';
        const cacheUnusable =
          /no space left on device|ENOSPC/i.test(`${message}\n${logTail}`) ||
          /failed to create subPath directory for volumeMount "buildkit-cache"/i.test(message) ||
          /init container cache-evict failed/i.test(message);
        if (cacheUnusable) {
          console.warn(
            `[ImageBuilder] Shared cache unusable for ${imageName}:${tag}, retrying without it`
          );
          await this.appendLog(
            deploymentId,
            'The shared build cache is unavailable. Retrying the build without it.'
          ).catch(() => {});
          return this.buildAndPush({ ...options, disableSharedCache: true });
        }
      }

      const errorMsg = `Build failed: ${k8sErrorMessage(error)}`;
      const errorStack = error.stack || 'No stack trace available';

      console.error('[ImageBuilder] Build failed:', {
        deploymentId,
        imageName,
        tag,
        error: errorMsg,
        stack: errorStack,
        errorType: error.constructor.name,
        statusCode: error.statusCode || error.status,
        responseBody: error.body || error.response
      });

      await this.appendLog(deploymentId, errorMsg, 'ERROR');

      if (deploymentId) {
        try {
          // Don't overwrite a successful build status from a newer build
          const currentDeployment = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { buildStatus: true }
          });
          if (currentDeployment?.buildStatus === 'succeeded') {
            console.log(
              `[ImageBuilder] Deployment ${deploymentId} already has a succeeded build (likely from a newer build), skipping error status update`
            );
          } else {
            await this.prisma.deployment.update({
              where: { id: deploymentId },
              data: {
                buildStatus: 'failed',
                buildError: error.message
              }
            });
          }
        } catch (dbError) {
          console.error('[ImageBuilder] Failed to update deployment status:', dbError.message);
        }
      }

      throw error;
    }
  }

  private static readonly FC_PUSH_HOST = 'fc-registry:5000';

  private static readonly FC_BUILDKIT_ADDR = 'unix:///run/buildkit/buildkitd.sock';

  get firecrackerEnabled(): boolean {
    return !!this.firecracker?.enabled;
  }

  async firecrackerBuildStatus(
    hostId: string,
    buildId: string
  ): Promise<
    | { status: 'running' | 'succeeded' | 'failed' | 'lost'; error?: string }
    | 'not_found'
    | 'unknown_host'
  > {
    const host = this.firecracker?.hostById(hostId);
    if (!this.firecracker || !host) return 'unknown_host';
    return this.firecracker.status(host, buildId);
  }

  async cancelFirecrackerBuilds(deploymentId: string): Promise<number> {
    if (!this.firecracker?.enabled) return 0;
    try {
      return await this.firecracker.cancelDeployment(deploymentId);
    } catch (error) {
      console.warn(
        `[ImageBuilder] firecracker cancel for ${deploymentId} failed: ${(error as Error).message}`
      );
      return 0;
    }
  }

  private async firecrackerRequest(options: BuildJobOptions): Promise<{
    request: FcBuildRequest;
    pullRef: string;
  }> {
    const {
      repoUrl,
      branch,
      dockerfilePath,
      imageName,
      tag = 'latest',
      deploymentId,
      accessToken,
      target,
      buildFromRoot = false,
      buildType = 'dockerfile',
      rootDirectory,
      envVars: requestedEnvVars = {},
      secretEnvKeys = [],
      cacheTenantKey,
      localContextUrl
    } = options;
    assertSafeBuildInputs({ branch, dockerfilePath, target });

    let appPullAuths: RegistryAuths = {};
    try {
      appPullAuths = this.registryCredentials
        ? await this.registryCredentials.buildAuths(deploymentId, requestedEnvVars)
        : pullAuthsFromEnv(requestedEnvVars);
    } catch (error) {
      if (error instanceof PullAuthError) throw new BadRequestException(error.message);
      throw error;
    }
    const envVars = buildSafeEnv(requestedEnvVars);
    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const key of Object.keys(envVars)) {
      if (!ENV_KEY_RE.test(key)) {
        throw new BadRequestException(`Invalid environment variable key: ${key}`);
      }
    }

    const parsedRepo = localContextUrl ? null : parseRepoUrl(repoUrl);
    if (!localContextUrl && !parsedRepo) {
      throw new BadRequestException('Repository URL must be a plain https:// URL');
    }

    const pushRef = `${ImageBuilderService.FC_PUSH_HOST}/${this.harborProject}/${imageName}:${tag}`;
    const buildctlArgs = this.generateBuildctlArgs({
      dockerfilePath,
      fullImageName: pushRef,
      target,
      buildFromRoot,
      buildType,
      envVars,
      secretEnvKeys,
      secretsHash: this.computeSecretsHash(envVars),
      cacheKey: deploymentId ? `orchard-${deploymentId.slice(0, 8)}` : undefined,
      skipCache: true
    });
    const injectGitSha = buildType !== 'railpack' && !('GIT_SHA' in envVars);
    const argEnv: Record<string, string> = Object.fromEntries(
      Object.keys(envVars).map((key, index) => [buildArgEnvName(index), envVars[key]])
    );
    const secretEnv: Record<string, string> = Object.fromEntries(
      Object.entries(envVars).filter(([key]) => !BUILDER_RESERVED_ENV_KEYS.has(key))
    );

    const steps: FcStep[] = [];
    if (buildType === 'railpack') {
      steps.push({
        name: 'prepare',
        script: this.railpackPrepareScript(envVars, rootDirectory, false),
        env: argEnv
      });
    } else {
      const injectedArgKeys = injectableBuildArgKeys(Object.keys(envVars), secretEnvKeys);
      const secretArgNotice = secretBuildArgNotice(Object.keys(envVars), secretEnvKeys);
      if (secretArgNotice && deploymentId) {
        this.appendLog(deploymentId, secretArgNotice, 'WARNING').catch(() => {});
      }
      if (injectedArgKeys.length > 0) {
        steps.push({
          name: 'prepare',
          script: injectBuildArgsScript({ dockerfilePath, keys: injectedArgKeys })
        });
      }
    }
    const buildScript =
      (injectGitSha ? ImageBuilderService.GIT_SHA_PREAMBLE : '') +
      (buildType === 'railpack' ? ImageBuilderService.BUILD_DIR_PREAMBLE : '') +
      `buildctl --addr ${ImageBuilderService.FC_BUILDKIT_ADDR} ${buildctlArgs.map(renderBuildctlArg).join(' ')}` +
      (injectGitSha ? ImageBuilderService.GIT_SHA_BUILDCTL_OPT : '') +
      '\n';
    steps.push({
      name: 'build',
      script: buildScript,
      env: buildType === 'railpack' ? secretEnv : { ...secretEnv, ...argEnv }
    });

    const request: FcBuildRequest = {
      id: `${(deploymentId ?? imageName).slice(0, 40)}-${crypto.randomBytes(4).toString('hex')}`,
      deploymentId: deploymentId ?? '',
      tenant: cacheTenantKey || deploymentId || imageName,
      repository: `${this.harborProject}/${imageName}`,
      source: localContextUrl
        ? { kind: 'context', contextUrl: localContextUrl }
        : { kind: 'git', cloneUrl: withCloneCredentials(parsedRepo!, accessToken), branch },
      steps,
      dockerConfig: hasRegistryAuths(appPullAuths) ? dockerConfigJson(appPullAuths) : undefined,
      timeoutSeconds: 1800
    };
    return {
      request,
      pullRef: `${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`
    };
  }

  private async buildWithFirecracker(options: BuildJobOptions): Promise<string> {
    if (!this.firecracker?.enabled) throw new FcUnavailableError('firecracker builder disabled');
    const { request, pullRef } = await this.firecrackerRequest(options);
    if (request.dockerConfig) {
      this.appendLog(options.deploymentId, 'Using registry credentials to pull base images').catch(
        () => {}
      );
    }
    const label = options.buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
    await this.appendLog(options.deploymentId, `Starting fast build (${label}) in an isolated VM`);
    tagActiveSpan({ 'build.builder': 'firecracker' });
    const submittedAt = Date.now();
    const stream = await this.firecracker.start(request);
    return this.followFirecrackerBuild({
      deploymentId: options.deploymentId,
      stream,
      buildId: request.id,
      pullRef,
      offset: 0,
      buildType: options.buildType ?? 'dockerfile',
      submittedAt
    });
  }

  async adoptFirecrackerBuild(opts: {
    deploymentId: string;
    hostId: string;
    buildId: string;
    pullRef: string;
    offset: number;
    buildType?: string;
    envVars?: Record<string, string>;
    secretEnvKeys?: string[];
  }): Promise<string> {
    const host = this.firecracker?.hostById(opts.hostId);
    if (!this.firecracker || !host) {
      throw new FcUnavailableError(`firecracker host ${opts.hostId} is not configured`);
    }
    const owned = this.trackBuildSecrets({
      deploymentId: opts.deploymentId,
      envVars: opts.envVars,
      secretEnvKeys: opts.secretEnvKeys
    });
    try {
      const stream = await this.firecracker.resume(host, opts.buildId, opts.offset);
      return await this.followFirecrackerBuild({
        deploymentId: opts.deploymentId,
        stream,
        buildId: opts.buildId,
        pullRef: opts.pullRef,
        offset: opts.offset,
        buildType: opts.buildType ?? 'dockerfile',
        submittedAt: Date.now(),
        adopted: true
      });
    } finally {
      if (owned) this.buildSecretValues.delete(opts.deploymentId);
    }
  }

  private async followFirecrackerBuild(opts: {
    deploymentId: string | undefined;
    stream: FcStream;
    buildId: string;
    pullRef: string;
    offset: number;
    buildType: string;
    submittedAt: number;
    adopted?: boolean;
  }): Promise<string> {
    const { deploymentId, buildId, pullRef, buildType } = opts;
    const key = `fc:${buildId}`;
    const transcoder = createRawjsonTranscoder();
    const marks: Record<string, number> = { submitted: opts.submittedAt };
    let stream = opts.stream;
    let offset = opts.offset;
    let pending = '';
    let buildRaw = '';
    let sourceText = '';
    let prepareText = '';
    let prepareReported = false;
    let buildingSeen = false;
    let pushSeen = false;
    let result: FcEvent | null = null;
    let flushTimer: NodeJS.Timeout | null = null;

    const flush = async () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pending || !deploymentId) {
        pending = '';
        return;
      }
      const chunk = pending;
      pending = '';
      await this.appendStreamedChunk(deploymentId, chunk, key, offset);
      if (!buildingSeen && BUILDKIT_STEP_RE.test(chunk)) {
        buildingSeen = true;
        await this.setBuildStep(deploymentId, 'building');
      }
      if (!pushSeen && BUILDKIT_PUSH_PHASE_RE.test(chunk)) {
        pushSeen = true;
        marks.push = Date.now();
        await this.setBuildStep(deploymentId, 'pushing');
      }
      this.emitBuildChanged(deploymentId).catch(() => {});
    };

    const reportPrepare = async () => {
      if (prepareReported || !prepareText) return;
      prepareReported = true;
      if (buildType === 'railpack') {
        await this.persistRailpackDetection(deploymentId, prepareText);
        await this.appendRailpackPrepareLog(deploymentId, prepareText);
      }
    };

    const handle = async (event: FcEvent) => {
      switch (event.t) {
        case 'accepted': {
          marks.accepted = Date.now();
          if (!deploymentId) return;
          await this.stampBuildTime(deploymentId, 'submitted');
          const meta = JSON.stringify({
            __builder: 'firecracker',
            __fcHost: stream.host.id,
            __fcBuildId: buildId,
            __jobName: buildId,
            __image: pullRef
          });
          await this.prisma.$executeRaw`
            UPDATE "deployments"
            SET "build_step_timestamps" = COALESCE("build_step_timestamps", '{}'::jsonb) || ${meta}::jsonb
            WHERE "id" = ${deploymentId}::uuid
          `.catch(() => {});
          const acquireMs = event.timings?.acquireMs ?? 0;
          await this.appendLog(
            deploymentId,
            acquireMs > 200
              ? `Started a build VM in ${(acquireMs / 1000).toFixed(1)}s`
              : 'Using a warm build VM'
          );
          return;
        }
        case 'phase':
          if (event.phase === 'ready') {
            marks.ready = Date.now();
            await this.stampBuildTime(deploymentId, 'scheduled');
          } else if (event.phase === 'source') {
            marks.source = Date.now();
          } else if (event.phase === 'prepare') {
            marks.prepare = Date.now();
          } else if (event.phase === 'build') {
            marks.build = Date.now();
            await reportPrepare();
          }
          return;
        case 'log': {
          const data = event.data ?? '';
          if (event.stream === 'build') {
            buildRaw = (buildRaw + data).slice(-4_000_000);
            pending += transcoder.feed(data);
            if (pending.length > 64_000) {
              await flush();
            } else if (!flushTimer) {
              flushTimer = setTimeout(() => {
                flush().catch(() => {});
              }, 400);
              flushTimer.unref?.();
            }
          } else if (event.stream === 'prepare') {
            prepareText = (prepareText + data).slice(-256_000);
          } else if (deploymentId) {
            sourceText = (sourceText + data).slice(-64_000);
            await flush();
            await this.appendStreamedChunk(deploymentId, data);
            this.emitBuildChanged(deploymentId).catch(() => {});
          }
          return;
        }
        case 'result':
          result = event;
      }
    };

    for (let attempt = 0; !result; attempt++) {
      try {
        for await (const { event, offset: next } of stream.events) {
          offset = next;
          await handle(event);
          if (result) break;
        }
      } catch (error) {
        console.warn(
          `[ImageBuilder] firecracker stream for ${buildId} broke: ${(error as Error).message}`
        );
      }
      if (result) break;
      if (attempt >= 30) {
        throw new BadRequestException(
          `Build failed: lost contact with build host ${stream.host.id} for too long`
        );
      }
      await new Promise((r) => setTimeout(r, Math.min(1000 * (attempt + 1), 10_000)));
      let status: Awaited<ReturnType<FirecrackerClient['status']>>;
      try {
        status = await this.firecracker!.status(stream.host, buildId);
      } catch {
        continue;
      }
      if (status === 'not_found' || status.status === 'lost') {
        await flush();
        throw new FcUnavailableError('the build host restarted during the build');
      }
      try {
        stream = await this.firecracker!.resume(stream.host, buildId, offset);
      } catch {
        continue;
      }
    }

    pending += transcoder.flush();
    await flush();
    await reportPrepare();
    const end = Date.now();
    const final = result as unknown as FcEvent;
    const tags = {
      'build.builder': 'firecracker',
      'build.deployment_id': deploymentId ?? 'unknown',
      'build.fc_host': stream.host.id
    };
    if (marks.accepted) recordPhaseSpan('build.vm', marks.submitted, marks.accepted, tags);
    if (marks.source)
      recordPhaseSpan('build.clone', marks.source, marks.prepare ?? marks.build ?? end, tags);
    if (marks.build) recordPhaseSpan('build.image', marks.build, marks.push ?? end, tags);
    if (marks.push) recordPhaseSpan('build.push', marks.push, end, tags);

    if (final.ok) {
      if (deploymentId && !pushSeen) await this.setBuildStep(deploymentId, 'pushing');
      recordBuildOutcome({
        outcome: 'succeeded',
        source: opts.adopted ? 'resume' : 'watch',
        deploymentId: deploymentId ?? 'unknown',
        jobName: buildId,
        buildType,
        builder: 'firecracker',
        durationMs: end - opts.submittedAt,
        lastPhase: 'complete'
      });
      const imageRef = pullRef.split('/').slice(-1)[0] || pullRef;
      this.appendLog(deploymentId, `Build and push completed successfully.`).catch(() => {});
      this.appendLog(deploymentId, `Image: ${imageRef}`).catch(() => {});
      this.emitBuildChanged(deploymentId).catch(() => {});
      return pullRef;
    }

    const summary =
      summarizeBuildFailure(
        buildRaw ? transcodeRawjson(buildRaw) : `${sourceText}\n${prepareText}`,
        undefined
      ) ||
      final.error ||
      'unknown error';
    recordBuildOutcome({
      outcome: 'failed',
      source: opts.adopted ? 'resume' : 'watch',
      reason: 'build_error',
      deploymentId: deploymentId ?? 'unknown',
      jobName: buildId,
      buildType,
      builder: 'firecracker',
      durationMs: end - opts.submittedAt,
      lastPhase: marks.build ? 'build' : marks.prepare ? 'prepare' : 'source',
      detail: final.error
    });
    throw new BadRequestException(
      final.error === 'build cancelled'
        ? 'Build failed: build cancelled'
        : `Build failed: ${summary}`
    );
  }

  async ensureServiceAccount(): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    const rbacApi = this.kc!.makeApiClient(k8s.RbacAuthorizationV1Api);

    const saName = 'image-builder';

    try {
      await coreApi.readNamespacedServiceAccount(saName, this.builderNamespace);
    } catch (error) {
      if (error.statusCode === 404) {
        await coreApi.createNamespacedServiceAccount(this.builderNamespace, {
          metadata: {
            name: saName,
            namespace: this.builderNamespace
          }
        });
      }
    }

    for (const [kind, name, remove] of [
      [
        'rolebinding',
        BUILDER_ROLE_BINDING,
        () => rbacApi.deleteNamespacedRoleBinding(BUILDER_ROLE_BINDING, this.builderNamespace)
      ],
      [
        'role',
        BUILDER_ROLE,
        () => rbacApi.deleteNamespacedRole(BUILDER_ROLE, this.builderNamespace)
      ]
    ] as const) {
      try {
        await remove();
        console.log(`[ImageBuilder] removed legacy ${kind} ${name} from ${this.builderNamespace}`);
      } catch (error) {
        const status = error.statusCode ?? error.response?.statusCode;
        if (status !== 404) {
          console.warn(
            `[ImageBuilder] could not remove ${kind} ${name} in ${this.builderNamespace}: ${k8sErrorMessage(error)}`
          );
        }
      }
    }
  }

  async findBuildJobsForDeployment(
    deploymentId: string
  ): Promise<{ name: string; image: string | null; status: string }[] | null> {
    this.ensureKubeConfig();
    try {
      const batchApi = this.kc!.makeApiClient(k8s.BatchV1Api);
      const [current, legacy] = await Promise.all([
        batchApi.listNamespacedJob(
          this.builderNamespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `orchard.my/deployment-id=${deploymentId}`
        ),
        batchApi.listNamespacedJob(
          this.builderNamespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `orchard.dev/deployment-id=${deploymentId}`
        )
      ]);
      const seen = new Set<string>();
      const items = [...current.body.items, ...legacy.body.items].filter((j) => {
        const n = j.metadata?.name;
        if (!n || seen.has(n)) return false;
        seen.add(n);
        return true;
      });
      return items
        .sort((a, b) => {
          const ta = a.metadata?.creationTimestamp?.getTime() ?? 0;
          const tb = b.metadata?.creationTimestamp?.getTime() ?? 0;
          return tb - ta;
        })
        .map((j) => {
          let status = 'pending';
          if (j.status?.succeeded) status = 'succeeded';
          else if (j.status?.failed) status = 'failed';
          else if (j.status?.active) status = 'running';
          return {
            name: j.metadata?.name || '',
            image:
              j.metadata?.annotations?.['orchard.my/full-image'] ||
              j.metadata?.annotations?.['orchard.dev/full-image'] ||
              null,
            status
          };
        });
    } catch {
      return null;
    }
  }

  async imageExistsInRegistry(image: string): Promise<boolean | null> {
    try {
      const parsed = this.parseImageRef(image);
      if (!parsed?.tag) return null;
      const { repoName, tag } = parsed;
      const auth = this.getHarborAuth();
      if (!auth) return null;
      const url = `${auth.registryUrl}/api/v2.0/projects/${this.harborProject}/repositories/${encodeURIComponent(repoName)}/artifacts/${encodeURIComponent(tag)}`;
      const response = await fetch(url, { headers: { Authorization: auth.authHeader } }).catch(
        () => null
      );
      if (response?.ok) return true;
      const manifest = await this.manifestStatus(repoName, tag, auth.authHeader);
      if (manifest === 200) return true;
      if (manifest === 404 || response?.status === 404) return false;
      return null;
    } catch {
      return null;
    }
  }

  private async manifestStatus(
    repoName: string,
    tag: string,
    authHeader: string
  ): Promise<number | null> {
    const host = this.harborRegistryPush;
    if (!host) return null;
    const scheme = this.plainHttpRegistries.has(host) ? 'http' : 'https';
    const response = await fetch(
      `${scheme}://${host}/v2/${this.harborProject}/${repoName}/manifests/${encodeURIComponent(tag)}`,
      { method: 'HEAD', headers: { Authorization: authHeader, Accept: MANIFEST_ACCEPT } }
    ).catch(() => null);
    return response ? response.status : null;
  }

  getImagePath(imageName: string, tag = 'latest'): string {
    return `${this.harborRegistryPull}/${this.harborProject}/${imageName}:${tag}`;
  }

  /**
   * Parse an image string (e.g. registry.example.com/orchard/namespace-name:tag)
   * and return the repo name (without project prefix) and tag.
   */
  private parseImageRef(image: string): { repoName: string; tag: string | null } | null {
    const parsed = parseImageRef(image);
    if (!parsed?.host) return null;
    const hosts = [this.harborRegistryPush, this.harborRegistryPull, this.pusherRegistryHost];
    if (!hosts.some((host) => host && sameRegistryHost(parsed.host!, host))) return null;
    const [project, repoName, ...rest] = parsed.repository.split('/');
    if (rest.length > 0 || !repoName || project !== this.harborProject) return null;
    return { repoName, tag: parsed.tag };
  }

  private getHarborAuth(): { authHeader: string; registryUrl: string } | null {
    const harborUsername = process.env.HARBOR_USERNAME;
    const harborPassword = process.env.HARBOR_PASSWORD;
    if (!harborUsername || !harborPassword || !this.harborRegistryPull) {
      console.warn(
        '[ImageBuilder] Harbor credentials not configured, skipping registry image deletion'
      );
      return null;
    }
    const authHeader = `Basic ${Buffer.from(`${harborUsername}:${harborPassword}`).toString('base64')}`;
    const registryUrl = this.harborRegistryPull.startsWith('http')
      ? this.harborRegistryPull
      : `https://${this.harborRegistryPull}`;
    return { authHeader, registryUrl };
  }

  private async deleteRepositoryTags(repoName: string, authHeader: string): Promise<void> {
    const host = this.harborRegistryPush;
    if (!host) return;
    const scheme = this.plainHttpRegistries.has(host) ? 'http' : 'https';
    const base = `${scheme}://${host}/v2/${this.harborProject}/${repoName}`;
    const headers = { Authorization: authHeader };
    const list = await fetch(`${base}/tags/list`, { headers });
    if (!list.ok) return;
    const tags: string[] = (await list.json()).tags ?? [];
    for (const tag of tags) {
      const head = await fetch(`${base}/manifests/${encodeURIComponent(tag)}`, {
        method: 'HEAD',
        headers: { ...headers, Accept: MANIFEST_ACCEPT }
      });
      const digest = head.headers.get('docker-content-digest');
      if (!head.ok || !digest) continue;
      await fetch(`${base}/manifests/${digest}`, { method: 'DELETE', headers });
    }
  }

  /**
   * Delete an entire repository from Harbor.
   * Used when a deployment is fully deleted and all images should be removed.
   */
  async deleteRepositoryFromRegistry(image: string): Promise<void> {
    try {
      const parsed = this.parseImageRef(image);
      if (!parsed) return;
      const { repoName } = parsed;

      const auth = this.getHarborAuth();
      if (!auth) return;

      const deleteUrl = `${auth.registryUrl}/api/v2.0/projects/${this.harborProject}/repositories/${encodeURIComponent(repoName)}`;

      const response = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: { Authorization: auth.authHeader }
      }).catch(() => null);

      if (response?.ok) {
        console.log(
          `[ImageBuilder] Deleted repository from registry: ${this.harborProject}/${repoName}`
        );
      } else if (!response || response.status === 404) {
        await this.deleteRepositoryTags(repoName, auth.authHeader);
      } else {
        const body = await response.text();
        console.error(
          `[ImageBuilder] Failed to delete repository: ${this.harborProject}/${repoName}, status: ${response.status}, body: ${body}`
        );
      }
    } catch (error) {
      console.error(`[ImageBuilder] Error deleting repository from registry: ${image}`, error);
    }
  }

  async deleteArtifactsFromRegistry(images: string[]): Promise<void> {
    const api = platformRegistryApi();
    if (!api) return;
    const byRepository = new Map<string, string[]>();
    for (const image of images) {
      const target = platformImage(image);
      if (!target?.tag) {
        console.warn(`[ImageBuilder] Not deleting an image Orchard didn't build: ${image}`);
        continue;
      }
      byRepository.set(target.repository, [
        ...(byRepository.get(target.repository) ?? []),
        target.tag
      ]);
    }
    for (const [repository, tags] of byRepository) {
      try {
        const deleted = await deleteTags(api, repository, tags);
        console.log(
          `[ImageBuilder] Deleted ${deleted.length} manifests for ${tags.length} tags from ${repository}`
        );
      } catch (error) {
        console.error(`[ImageBuilder] Failed to delete tags from ${repository}:`, error);
      }
    }
  }

  /**
   * Delete entire repositories from Harbor.
   * Deduplicates by repo name so the same repository isn't deleted multiple times.
   */
  async deleteRepositoriesFromRegistry(images: string[]): Promise<void> {
    const seenRepos = new Set<string>();
    for (const image of images) {
      const repoName = this.parseImageRef(image)?.repoName;
      if (repoName && !seenRepos.has(repoName)) {
        seenRepos.add(repoName);
        await this.deleteRepositoryFromRegistry(image);
      }
    }
  }
}
