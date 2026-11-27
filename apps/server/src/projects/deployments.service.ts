import { assertOrgCanExposeNodePort, assertOrgCanExposePublicPort } from './public-exposure-quota';
import { assertOrgCanCreate } from '../quotas/org-limits';
import { assertVolumeQuantity } from '../kubernetes/pvc-limits';
import { pickPreviousImage } from './rollback-target';
import { findVolumeConflict, volumeClaim } from './volume-claims';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
  Logger,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
  HttpException
} from '@nestjs/common';
import { Prisma, ServiceType } from '@prisma/client';
import type * as k8s from '@kubernetes/client-node';
import type { V1EnvVar } from '@kubernetes/client-node';
import { planEnvAdoption, type EnvAdoptionPlan } from '../env/env-adoption';
import { PrismaService } from '../prisma/prisma.service';
import { storageShrinks } from '../kubernetes/pvc-status';
import { KubernetesService, CreateDeploymentOptions } from '../kubernetes/kubernetes.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import type { PodSizing } from '../kubernetes/resource-spec';
import {
  K8sNetworkService,
  certificateForSecret,
  certificateStatusFrom
} from '../kubernetes/k8s-network.service';
import { snapshotPublicPortState, publicPortKey } from '../kubernetes/port-utils';
import { UNKNOWN_PUBLIC_ENDPOINT } from '../kubernetes/public-endpoint';
import { resolvePullPolicy } from '../kubernetes/trusted-images';
import {
  deviceClasses,
  storedDevices,
  validateDeviceRequest,
  type DeviceRequest
} from '../kubernetes/devices';
import { startArgsFor, resolveStartArgs } from '../kubernetes/start-command';
import { disruptionBudgetActive } from '../kubernetes/disruption-budget';
import { publicDeploymentPorts } from '../kubernetes/security-policies';
import { UsersService } from '../users/users.service';
import { DockerService } from '../docker/docker.service';
import { RegistryPruneService } from '../docker/registry-prune.service';
import { FcUnavailableError } from '../docker/fc/fc-client';
import { isBuilderOverride } from '../docker/fc/build-backend-router';
import { BuildJobInformerService } from '../docker/build-job-informer.service';
import { GitHubService } from '../github/github.service';
import { parseDockerfileHealthCheck } from '../github/dockerfile-healthcheck';
import { normalizeWatchPaths, watchPathProblem, MAX_WATCH_PATHS } from '../github/watch-paths';
import { QuotasService } from '../quotas/quotas.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { AuthorizationService } from '../auth/authorization.service';
import {
  PERSONAL_CREDENTIAL_REFUSED,
  personalSourceSelectionRefused
} from '../auth/request-context';
import { AuditService, type AuditMetadataValue } from '../audit/audit.service';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ProjectAccessService } from './project-access.service';
import { EnvironmentsService } from './environments.service';
import { BuildQueueService, QueueSnapshot } from './build-queue.service';
import {
  resolveEnvVars,
  EnvVar,
  UnresolvedResourceRefError,
  type ResourceValues
} from '../env/env-resolver';
import { ResourceBindingsService } from './resource-bindings.service';
import { RegistryCredentialsService } from './registry-credentials.service';
import { GitConnectionsService } from '../git/git-connections.service';
import { ScoreService } from '../score/score.service';
import { hostOf } from '../git/git-provider';
import { parseRepoUrl } from '../docker/repo-url';
import { podRecord } from '../engine/pod-status';
import { normalizeRootDirectory } from '../docker/build-config';
import { applyEnvKeepRules, defaultSecretFlag, EnvVarWrite } from './env-write-rules';
import { assertEnvSetStorable } from './environment-shared-vars.service';
import {
  coerceDockerfileHealthCheck,
  resolveHealthCheck,
  ResolvedHealthCheck
} from './health-check-resolve';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { NodesService } from '../nodes/nodes.service';
import { StorageService } from '../organizations/storage.service';
import { LOCAL_DEPLOYS_NEED_S3 } from '../instance-config/object-storage';
import { ApplyQueueService } from '../apply/apply-queue.service';
import { ApplyExecutorService } from '../apply/apply-executor.service';
import { formatSlug, scrubIngress, isPlatformGeneratedHost } from './projects.utils';

const INGRESS_URL_SELECT = {
  host: true,
  path: true,
  tlsSecretName: true,
  entrypoints: true
} as const;
import {
  startBuildTrace,
  recordBuildOutcome,
  recordRecoveryDecision,
  type BuildOutcomeReason
} from '../analytics/datadog';
import { pipelineOutcome, recordBuildPipeline } from '../analytics/build-metrics';
import { createHash, randomUUID } from 'crypto';
import {
  isObservedJobStatus,
  decideBuildRecovery,
  needsRegistryProbe,
  isRequeueable,
  REQUEUE_DETAIL,
  type ObservedJobStatus,
  type RecoveryDeployment,
  type RecoveryJob,
  type FirecrackerHostStatus,
  firecrackerRecoveryJobs,
  type RecoveryReason,
  type RecoveryRun
} from './build-recovery';
import { buildStartedAtFrom } from './build-timing';
import { ReleasesService } from './releases.service';
import { DatabaseCheckpointsService } from './database-checkpoints.service';
import type { DeployStrategy } from '../kubernetes/rollout-strategy';
import {
  greenName as greenName_,
  summarizeBlueGreen,
  summarizeRollout
} from '../kubernetes/rollout-strategy';
import {
  assertImageOwnedByProject,
  assertIngressNameFree,
  assertRepoNameFree,
  newImageTag,
  splitRegistryCleanup
} from './image-ownership';

const ROLLBACK_GATE_TIMEOUT_MS = 90_000;

// Ceiling on the disruption budget. Nothing in Orchard scales anywhere near
// this, and it keeps a fat-fingered value from being stored as a number the
// replica count can never satisfy.
const MAX_PDB_MIN_AVAILABLE = 100;

/**
 * Recovery's own vocabulary for why it acted, mapped onto the build-outcome
 * reasons dashboards already group by. Only the decisions that can end a build
 * appear here; anything else falls back to `internal`.
 */
const RECOVERY_OUTCOME_REASON: Partial<
  Record<RecoveryReason | BuildOutcomeReason, BuildOutcomeReason>
> = {
  build_error: 'build_error',
  image_unknown: 'image_unknown',
  job_never_created: 'job_never_created',
  job_missing: 'job_missing',
  k8s_missing: 'k8s_missing',
  internal: 'internal'
};

const DOCKERFILE_TARGET_RE = /^[A-Za-z0-9._-]{1,128}$/;

function safeDockerfileTarget(raw: string | null | undefined): string | null {
  const target = raw?.trim() || null;
  if (target && !DOCKERFILE_TARGET_RE.test(target)) {
    throw new BadRequestException('Invalid Dockerfile target');
  }
  return target;
}

export const SUPER_BUILDS_UNAVAILABLE =
  "Super builds aren't set up on this instance. Set DEPOT_TOKEN on the server to use them.";

@Injectable()
export class DeploymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeploymentsService.name);

  private buildReconcileInterval: NodeJS.Timeout | null = null;

  private activeRecoveries = new Set<string>();

  private adoptedLogPumps = new Set<string>();

  private unsubscribeBuildJobs: (() => void) | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetesService: KubernetesService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly k8sNetwork: K8sNetworkService,
    private readonly usersService: UsersService,
    private readonly dockerService: DockerService,
    @Inject(forwardRef(() => GitHubService))
    private readonly githubService: GitHubService,
    @Inject(forwardRef(() => QuotasService))
    private readonly quotasService: QuotasService,
    private readonly tailscaleService: TailscaleService,
    private readonly membershipCache: MembershipCacheService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly access: ProjectAccessService,
    @Inject(forwardRef(() => NodesService))
    private readonly nodesService: NodesService,
    private readonly leaderElection: LeaderElectionService,
    private readonly notifications: NotificationsService,
    @Inject(forwardRef(() => EnvironmentsService))
    private readonly environments: EnvironmentsService,
    private readonly crypto: SecretCryptoService,
    @Inject(forwardRef(() => BuildQueueService))
    private readonly buildQueue: BuildQueueService,
    private readonly storage: StorageService,
    private readonly applyQueue: ApplyQueueService,
    private readonly resourceBindings: ResourceBindingsService,
    private readonly registryCredentials: RegistryCredentialsService,
    @Inject(forwardRef(() => GitConnectionsService))
    private readonly gitConnections: GitConnectionsService,
    @Inject(forwardRef(() => ScoreService))
    private readonly score: ScoreService,
    private readonly applyExecutor: ApplyExecutorService,
    private readonly instanceConfig: InstanceConfigService,
    private readonly releases: ReleasesService,
    @Optional() private readonly buildJobInformer?: BuildJobInformerService,
    @Optional() private readonly checkpoints?: DatabaseCheckpointsService,
    @Optional() private readonly registryPrune?: RegistryPruneService
  ) {}

  async runQueuedBuild(run: {
    id: string;
    deploymentId: string;
    triggerType: string;
    commitSha: string | null;
    commitMessage: string | null;
    commitAuthorName: string | null;
    commitAuthorUsername: string | null;
    triggeredById: string | null;
  }) {
    if (run.triggerType === 'manual') {
      await this.rebuildFromQueue(run.deploymentId, run.triggeredById, run.id);
    } else {
      await this.triggerAutoDeploy(
        run.deploymentId,
        run.commitSha ?? '',
        run.commitMessage ?? 'Queued deploy',
        run.commitAuthorName ?? undefined,
        run.commitAuthorUsername ?? undefined,
        run.id
      );
    }
  }

  onModuleInit() {
    setTimeout(() => this.recoverStuckBuilds(), 5_000);
    this.buildReconcileInterval = setInterval(() => this.recoverStuckBuilds(), 15_000);
    this.unsubscribeBuildJobs = this.buildJobInformer?.onTerminal((event) => {
      if (!event.deploymentId) return;
      this.reconcileBuild(event.deploymentId).catch((error) => {
        this.logger.warn(
          `[BuildRecovery] Event-driven reconcile of ${event.deploymentId} failed: ${error.message}`
        );
      });
    });
    this.applyExecutor.registerHandler('deployment.scale', async (item) => {
      await this.applyScaleToCluster(item.deploymentId!);
    });
    this.applyExecutor.registerHandler('deployment.updateEnv', async (item) => {
      await this.applyEnvToCluster(item.deploymentId!);
    });
    this.applyExecutor.registerHandler('deployment.disruptionBudget', async (item) => {
      await this.applyDisruptionBudgetToCluster(item.deploymentId!);
    });
    this.applyExecutor.registerHandler('deployment.volumes', async (item) => {
      await this.applyVolumesToCluster(item.deploymentId!);
    });
    this.applyExecutor.registerHandler('ingress.sync', async (item) => {
      const target = item.manifest as { namespace?: string; name?: string } | null;
      if (!target?.namespace || !target?.name) return;
      const result = await this.k8sNetwork.syncIngressBackends(target.namespace, target.name);
      if (result === 'failed')
        throw new Error(`ingress ${target.namespace}/${target.name} not synced`);
    });
  }

  async syncIngressesForService(serviceId: string, deploymentId: string): Promise<void> {
    const rows = await this.prisma.ingress.findMany({
      where: { serviceId },
      select: { namespace: true, name: true },
      distinct: ['namespace', 'name']
    });
    for (const { namespace, name } of rows) {
      let result: Awaited<ReturnType<K8sNetworkService['syncIngressBackends']>> | 'threw' = 'threw';
      try {
        result = await this.k8sNetwork.syncIngressBackends(namespace, name);
      } catch (error) {
        this.logger.warn(
          `ingress ${namespace}/${name} didn't follow the service port change: ${(error as Error)?.message}`
        );
      }
      if (result === 'failed' || result === 'threw') {
        await this.applyQueue.enqueue({
          dedupeKey: `op:ingress.sync:${namespace}/${name}`,
          opType: 'ingress.sync',
          manifest: { namespace, name },
          deploymentId
        });
      }
    }
  }

  private applyPipelineEnabled(): boolean {
    return process.env.APPLY_PIPELINE_ENABLED === 'true';
  }

  async retryApply(deploymentId: string, clerkId: string) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId);
    if (!user) throw new NotFoundException('User not found');
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { projectId: true }
    });
    if (!deployment) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    await this.authz.requireProjectEdit(deployment.projectId, user.id, 'retry apply');
    const retried = await this.applyQueue.retryForDeployment(deploymentId);
    return { success: true, retried };
  }

  private async applyVolumesToCluster(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { name: true, namespace: true, deployStrategy: true, volumes: true }
    });
    if (!deployment) return;
    const exists = await this.k8sWorkload
      .getKubernetesDeployment(deployment.name, deployment.namespace)
      .then((d) => d !== null);
    if (!exists) return;
    const volumes = deployment.volumes.map((vol) => ({
      name: vol.name,
      type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
      mountPath: vol.mountPath,
      pvcName: vol.pvcName,
      storageSize: vol.storageSize,
      hostPath: vol.hostPath,
      readOnly: vol.readOnly
    }));
    const hasPvc = volumes.some((v) => v.type === 'pvc');
    await this.k8sWorkload.updateDeploymentVolumes({
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      volumes,
      deployStrategy: hasPvc
        ? 'recreate'
        : deployment.deployStrategy === 'recreate'
          ? 'recreate'
          : 'rollingUpdate'
    });
  }

  private async applyScaleToCluster(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { name: true, namespace: true, replicas: true, stopped: true }
    });
    if (!deployment) return;
    const exists = await this.k8sWorkload
      .getKubernetesDeployment(deployment.name, deployment.namespace)
      .then((d) => d !== null);
    if (!exists) return;
    await this.applyExecutor.ssaApply({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: deployment.name, namespace: deployment.namespace },
      spec: { replicas: deployment.stopped ? 0 : deployment.replicas }
    } as never);
  }

  private async syncReplicasForRebuild(
    deploymentId: string,
    name: string,
    namespace: string,
    snapshotReplicas: number
  ): Promise<void> {
    const row = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { stopped: true }
    });
    const desiredReplicas = row?.stopped ? 0 : snapshotReplicas || 1;
    const k8sDeploy = await this.k8sWorkload.getKubernetesDeployment(name, namespace);
    if (k8sDeploy && k8sDeploy.status.replicas !== desiredReplicas) {
      await this.k8sWorkload.patchDeploymentReplicas(name, namespace, desiredReplicas);
    }
  }

  /**
   * The budget follows both the setting and the replica count, so this runs
   * after a scale as well as after an edit. K8sWorkloadService decides whether
   * that means writing the object or removing it.
   */
  private async applyDisruptionBudgetToCluster(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { name: true, namespace: true, replicas: true, stopped: true, pdbMinAvailable: true }
    });
    if (!deployment) return;
    const exists = await this.k8sWorkload
      .getKubernetesDeployment(deployment.name, deployment.namespace)
      .then((d) => d !== null);
    if (!exists) return;
    await this.k8sWorkload.applyPodDisruptionBudget({
      name: deployment.name,
      namespace: deployment.namespace,
      minAvailable: deployment.pdbMinAvailable,
      replicas: deployment.stopped ? 0 : deployment.replicas
    });
  }

  /**
   * Queue the budget reconcile when the apply pipeline owns cluster writes,
   * otherwise push it straight through. Never fatal to its caller: a scale
   * that landed is not undone because a budget failed to follow it, and the
   * queue (or the next apply) retries.
   */
  private async syncDisruptionBudget(deploymentId: string): Promise<void> {
    try {
      if (this.applyPipelineEnabled()) {
        await this.applyQueue.enqueue({
          dedupeKey: `op:deployment.disruptionBudget:${deploymentId}`,
          opType: 'deployment.disruptionBudget',
          deploymentId
        });
        return;
      }
      await this.applyDisruptionBudgetToCluster(deploymentId);
    } catch (error) {
      this.logger.warn(
        `[PDB] Failed to sync disruption budget for ${deploymentId}: ${(error as Error)?.message ?? error}`
      );
    }
  }

  private async applyEnvToCluster(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, name: true, namespace: true, environmentId: true }
    });
    if (!deployment) return;
    const exists = await this.k8sWorkload
      .getKubernetesDeployment(deployment.name, deployment.namespace)
      .then((d) => d !== null);
    if (!exists) return;
    const envVars = await this.readOwnEnvVars(deployment.id);
    const sharedVars = await this.loadSharedVarsForDeployment(
      deployment.id,
      deployment.environmentId
    );
    const resources = await this.resourceBindings.valuesFor(deployment.id);
    const { resolved } = resolveEnvVars(envVars, sharedVars, resources);
    await this.k8sWorkload.updateDeploymentEnv({
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      env: resolved
    });
  }

  /**
   * Push a deployment's env to the cluster again without any row changing.
   * Used when something an env value points at moved: a restored database
   * on a new host, a rotated password.
   */
  async reapplyEnv(deploymentId: string): Promise<void> {
    if (this.applyPipelineEnabled()) {
      await this.applyQueue.enqueue({
        dedupeKey: `op:deployment.updateEnv:${deploymentId}`,
        opType: 'deployment.updateEnv',
        deploymentId
      });
      return;
    }
    await this.applyEnvToCluster(deploymentId);
  }

  async reapplyEnvForResource(
    resourceType: 'database' | 'deployment',
    resourceId: string
  ): Promise<string[]> {
    const bound = await this.resourceBindings.boundDeployments(resourceType, resourceId);
    const results = await Promise.allSettled(bound.map((d) => this.reapplyEnv(d.id)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.logger.warn(
          `[Bindings] re-apply env to ${bound[i].name} failed: ${(r.reason as Error)?.message ?? r.reason}`
        );
      }
    });
    return bound.map((d) => d.name);
  }

  /**
   * A push re-reads score.yaml at the new ref. There is no person in the
   * request, so the app's creator stands in, the same identity the GitHub
   * user-token path already builds with.
   */
  private async reconcileScoreAsCreator(deploymentId: string, createdBy: string | null) {
    if (!createdBy) return;
    const creator = await this.prisma.user.findUnique({
      where: { id: createdBy },
      select: { id: true, externalAuthId: true, email: true, username: true }
    });
    if (!creator?.externalAuthId) return;
    await this.score
      .applyForDeployment(deploymentId, {
        clerkId: creator.externalAuthId,
        userId: creator.id,
        userData: { email: creator.email, username: creator.username ?? undefined }
      })
      .catch((e) => console.warn(`[Score] reconcile on push failed: ${(e as Error).message}`));
  }

  async adoptClusterEnv(
    deploymentId: string,
    live: V1EnvVar[],
    observation: string
  ): Promise<EnvAdoptionPlan | null> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        name: true,
        environmentId: true,
        projectId: true,
        project: { select: { organizationId: true } }
      }
    });
    if (!deployment) return null;

    const own = await this.readOwnEnvVars(deployment.id);
    const shared = await this.loadSharedVarsForDeployment(deployment.id, deployment.environmentId);
    const resources = await this.resourceBindings.valuesFor(deployment.id);
    let resolved: EnvVar[];
    try {
      resolved = resolveEnvVars(own, shared, resources).resolved;
    } catch (e) {
      if (e instanceof UnresolvedResourceRefError) {
        this.logger.warn(`[Env] not adopting env for ${deployment.name}: ${e.message}`);
        return null;
      }
      throw e;
    }

    const plan = planEnvAdoption({ deploymentName: deployment.name, live, own, resolved });
    const before = new Set(own.map((v) => v.key));
    await this.prisma.$transaction(async (tx) => {
      for (const entry of plan.upserts) {
        const value = this.crypto.encryptIfSecret(entry.value, Boolean(entry.secret));
        await tx.deploymentEnvVar.upsert({
          where: { deploymentId_key: { deploymentId: deployment.id, key: entry.key } },
          create: {
            deploymentId: deployment.id,
            key: entry.key,
            value,
            secret: Boolean(entry.secret)
          },
          update: { value, secret: Boolean(entry.secret) }
        });
      }
      if (plan.removals.length > 0) {
        await tx.deploymentEnvVar.deleteMany({
          where: { deploymentId: deployment.id, key: { in: plan.removals } }
        });
      }
      await tx.deployment.update({
        where: { id: deployment.id },
        data: {
          envObservedHash: observation,
          envConflicts: plan.conflicts.length > 0 ? (plan.conflicts as object[]) : Prisma.DbNull
        }
      });
    });

    if (plan.upserts.length > 0 || plan.removals.length > 0) {
      const added = plan.upserts.filter((v) => !before.has(v.key)).map((v) => v.key);
      const changed = plan.upserts.filter((v) => before.has(v.key)).map((v) => v.key);
      void this.audit.log({
        action: 'deployment.env.updated',
        organizationId: deployment.project.organizationId,
        projectId: deployment.projectId,
        deploymentId: deployment.id,
        targetType: 'deployment',
        targetId: deployment.id,
        targetLabel: deployment.name,
        metadata: {
          reason: 'edited in k8s',
          source: 'engine.workloads',
          added: added.join(',') || null,
          changed: changed.join(',') || null,
          removed: plan.removals.join(',') || null,
          conflicts: plan.conflicts.map((c) => c.key).join(',') || null
        }
      });
    }
    return plan;
  }

  async getDeploymentEnvKeys(deploymentId: string): Promise<{ key: string; secret: boolean }[]> {
    return this.prisma.deploymentEnvVar.findMany({
      where: { deploymentId },
      select: { key: true, secret: true },
      orderBy: { key: 'asc' }
    });
  }

  private resolveOrReject(env: EnvVar[], shared: EnvVar[], resources: ResourceValues) {
    try {
      return resolveEnvVars(env, shared, resources);
    } catch (e) {
      if (e instanceof UnresolvedResourceRefError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  onModuleDestroy() {
    this.unsubscribeBuildJobs?.();
    this.unsubscribeBuildJobs = undefined;
    if (this.buildReconcileInterval) {
      clearInterval(this.buildReconcileInterval);
      this.buildReconcileInterval = null;
    }
  }

  private async recoverStuckBuilds() {
    if (!this.leaderElection.isLeader()) return;
    try {
      const stuckBuilds = await this.prisma.deployment.findMany({
        where: {
          buildStatus: 'building',
          updatedAt: { lt: new Date(Date.now() - 15_000) }
        },
        select: {
          id: true,
          name: true,
          namespace: true,
          image: true,
          replicas: true,
          buildStep: true,
          buildStepTimestamps: true,
          projectId: true
        }
      });

      if (stuckBuilds.length === 0) return;
      this.logger.log(
        `[BuildRecovery] Found ${stuckBuilds.length} stuck build(s), attempting recovery`
      );

      for (const deployment of stuckBuilds) {
        try {
          await this.recoverStuckBuild(deployment);
        } catch (error) {
          this.logger.error(
            `[BuildRecovery] Failed to recover deployment ${deployment.id}: ${error.message}`
          );
        }
      }
    } catch (error) {
      this.logger.error(`[BuildRecovery] Recovery scan failed: ${error.message}`);
    }
  }

  private async reconcileBuild(deploymentId: string) {
    if (!this.leaderElection.isLeader()) return;
    const deployment = await this.prisma.deployment.findFirst({
      where: { id: deploymentId, buildStatus: 'building' },
      select: {
        id: true,
        name: true,
        namespace: true,
        image: true,
        replicas: true,
        buildStep: true,
        buildStepTimestamps: true,
        projectId: true
      }
    });
    if (!deployment) return;
    await this.recoverStuckBuild(deployment);
  }

  private async recoverStuckBuild(deployment: {
    id: string;
    name: string;
    namespace: string;
    image: string | null;
    replicas: number;
    buildStep: string | null;
    buildStepTimestamps: any;
    projectId: string;
  }) {
    if (this.activeRecoveries.has(deployment.id)) return;

    const staleCutoff = new Date(Date.now() - 15_000);
    // `updated_at` is a bare timestamp column, so NOW() would write the
    // session's local time here while every Prisma write puts UTC in it. On an
    // install whose Postgres is not UTC that skews the staleness comparison on
    // the next line by the offset, and the sweep either never fires or fires
    // constantly.
    const claimed: number = await this.prisma.$executeRaw`
      UPDATE "deployments"
      SET "updated_at" = (NOW() AT TIME ZONE 'UTC')
      WHERE "id" = ${deployment.id}::uuid
        AND "build_status" = 'building'
        AND "updated_at" < ${staleCutoff}
    `;
    if (claimed === 0) return;

    this.activeRecoveries.add(deployment.id);

    try {
      await this.doRecoverStuckBuild(deployment);
    } catch (error) {
      this.logger.error(
        `[BuildRecovery] Unexpected error recovering ${deployment.id}: ${error.message}`
      );
    } finally {
      this.activeRecoveries.delete(deployment.id);
    }
  }

  private async doRecoverStuckBuild(deployment: {
    id: string;
    name: string;
    namespace: string;
    image: string | null;
    replicas: number;
    buildStep: string | null;
    buildStepTimestamps: any;
    projectId: string;
  }) {
    const metadata = (deployment.buildStepTimestamps as Record<string, any>) || {};
    const now = Date.now();

    // The run in `building` if there is one. If there is not, the newest run
    // still matters: a run concluded out from under a live build is the row
    // that says whether this build can be retried, and reading "no building
    // run" as "no build" is how a running build got failed.
    const buildingRun = await this.prisma.buildRun.findFirst({
      where: { deploymentId: deployment.id, status: 'building' },
      orderBy: { startedAt: 'desc' },
      select: { workerId: true, heartbeatAt: true, triggerType: true, detail: true }
    });
    const fallbackRun = buildingRun
      ? null
      : await this.prisma.buildRun.findFirst({
          where: { deploymentId: deployment.id },
          orderBy: { createdAt: 'desc' },
          select: { workerId: true, heartbeatAt: true, triggerType: true, detail: true }
        });
    const runRow = buildingRun ?? fallbackRun;
    const run: RecoveryRun | null = runRow
      ? {
          isBuilding: buildingRun !== null,
          workerId: runRow.workerId,
          heartbeatAt: runRow.heartbeatAt?.getTime() ?? null,
          triggerType: runRow.triggerType,
          detail: runRow.detail
        }
      : null;

    const workerAlive =
      run?.isBuilding && run.workerId ? await this.isWorkerPodAlive(run.workerId) : null;

    // A run already waiting for a slot is a retry in flight. Concluding this
    // build now would end the attempt that is about to replace it.
    const retryPending =
      !buildingRun &&
      (await this.prisma.buildRun.count({
        where: { deploymentId: deployment.id, status: 'scheduled' }
      })) > 0;

    const recoveryDeployment: RecoveryDeployment = {
      buildStep: deployment.buildStep,
      image: deployment.image,
      startedAt: buildStartedAtFrom(deployment.buildStepTimestamps)?.getTime() ?? null,
      jobName: (metadata.__jobName as string | undefined) ?? null,
      expectedImage: (metadata.__image as string | undefined) ?? null
    };

    const isFirecracker = metadata.__builder === 'firecracker';
    const jobs = isFirecracker
      ? await this.listFirecrackerBuild(metadata)
      : await this.listClusterBuildJobs(deployment.id, recoveryDeployment.jobName);

    // Only spend a registry round-trip on the one branch that turns on it.
    const imagePushed =
      needsRegistryProbe({ deployment: recoveryDeployment, jobs }) &&
      recoveryDeployment.expectedImage
        ? await this.dockerService.imageExistsInRegistry(recoveryDeployment.expectedImage)
        : null;

    const decision = decideBuildRecovery({
      now,
      deployment: recoveryDeployment,
      run,
      retryPending,
      jobs,
      workerAlive,
      imagePushed
    });

    recordRecoveryDecision({
      action: decision.action,
      reason: decision.reason,
      deploymentId: deployment.id,
      deploymentName: deployment.name,
      namespace: deployment.namespace,
      buildStep: deployment.buildStep,
      jobName: decision.jobName ?? recoveryDeployment.jobName,
      jobCount: jobs === null ? -1 : jobs.length,
      informerHealthy: jobs !== null,
      buildAgeMs: recoveryDeployment.startedAt === null ? null : now - recoveryDeployment.startedAt,
      hadBuildingRun: buildingRun !== null,
      detail: decision.detail
    });

    if (decision.action === 'skip') return;

    if (decision.action === 'defer') {
      this.logger.log(
        `[BuildRecovery] Deferring ${deployment.id} (${decision.reason}); retrying next scan`
      );
      return;
    }

    this.logger.log(
      `[BuildRecovery] ${deployment.id} (step: ${deployment.buildStep}): ${decision.action} (${decision.reason})`
    );

    switch (decision.action) {
      case 'adopt':
        await this.buildQueue.adoptRun(deployment.id);
        if (isFirecracker) {
          this.followAdoptedFirecrackerBuild(deployment, metadata);
        } else if (decision.jobName) {
          this.streamAdoptedBuildLogs(deployment.id, decision.jobName);
        }
        return;

      case 'finish':
        await this.finishRecoveredBuild(deployment, decision.image!);
        if (decision.jobName && !isFirecracker) {
          this.dockerService.deleteBuildJob(decision.jobName).catch(() => {});
        }
        return;

      case 'requeue': {
        const outcome = await this.requeueOrphanedBuild(deployment.id);
        // `superseded` means a build or retry claimed this deployment while we
        // were deciding. That build owns the row now; ending it here would be
        // the original bug wearing a different hat.
        if (outcome === 'requeued' || outcome === 'superseded') return;
        await this.markBuildFailed(
          deployment.id,
          decision.detail ?? "The build couldn't be resumed or requeued",
          decision.reason
        );
        return;
      }

      case 'fail':
        await this.markBuildFailed(deployment.id, decision.detail!, decision.reason);
        if (decision.jobName && !isFirecracker) {
          this.dockerService.deleteBuildJob(decision.jobName).catch(() => {});
        }
        return;

      default: {
        // A new action with no arm here would silently leave the deployment
        // `building` forever. The sweep would retry it, but make it loud.
        const unhandled: never = decision.action;
        this.logger.error(`[BuildRecovery] Unhandled recovery action: ${String(unhandled)}`);
      }
    }
  }

  /**
   * Build jobs for this deployment as the cluster currently holds them, read
   * from the same Job watch cache the build watcher concludes from, so
   * recovery and the build path can never disagree about whether a build is
   * alive.
   *
   * `null` means the cluster did not answer, which the caller must treat as
   * "come back later" rather than "there are no jobs". A live list call is
   * only used when there is no informer at all (dev, no cluster config); a
   * *broken* informer reports null, because silence from a watch that should
   * be running looks exactly like an orphaned build and is not one.
   */
  private async listClusterBuildJobs(
    deploymentId: string,
    recordedJobName: string | null
  ): Promise<RecoveryJob[] | null> {
    if (this.buildJobInformer?.isEnabled()) {
      const observed = this.buildJobInformer.listForDeployment(deploymentId);
      if (observed === null) return null;
      const jobs: RecoveryJob[] = observed
        .filter((o) => isObservedJobStatus(o.phase))
        .map((o) => ({
          jobName: o.jobName,
          phase: o.phase as ObservedJobStatus,
          reason: o.reason,
          image: o.image
        }));
      // A cache that has only just listed may not hold a job we recorded by
      // name yet. Ask for that one directly instead of calling it gone, but
      // only if the watch has never heard of it. If the watch saw it deleted,
      // that is the answer, and re-reading it every pass would hammer the API
      // for the whole time a stuck deployment sits in `building`.
      if (
        recordedJobName &&
        !jobs.some((j) => j.jobName === recordedJobName) &&
        !this.buildJobInformer.hasSeen(recordedJobName)
      ) {
        let direct: Awaited<ReturnType<DockerService['getBuildJobStatus']>>;
        try {
          direct = await this.dockerService.getBuildJobStatus(recordedJobName);
        } catch {
          return null;
        }
        if (direct && isObservedJobStatus(direct.status)) {
          jobs.unshift({
            jobName: recordedJobName,
            phase: direct.status,
            reason: null,
            image: null
          });
        }
      }
      return jobs;
    }

    const listed = await this.dockerService.findBuildJobsForDeployment(deploymentId);
    if (listed === null) return null;
    return listed
      .filter((j) => isObservedJobStatus(j.status))
      .map((j) => ({
        jobName: j.name,
        phase: j.status as ObservedJobStatus,
        reason: null,
        image: j.image
      }));
  }

  private async listFirecrackerBuild(metadata: Record<string, any>): Promise<RecoveryJob[] | null> {
    const hostId = metadata.__fcHost as string | undefined;
    const buildId = metadata.__fcBuildId as string | undefined;
    if (!hostId || !buildId) return [];
    let status: FirecrackerHostStatus | null;
    try {
      status = await this.dockerService.firecrackerBuildStatus(hostId, buildId);
    } catch {
      status = null;
    }
    return firecrackerRecoveryJobs(
      status,
      buildId,
      (metadata.__image as string | undefined) ?? null
    );
  }

  private followAdoptedFirecrackerBuild(
    deployment: { id: string; name: string; namespace: string },
    metadata: Record<string, any>
  ) {
    if (this.adoptedLogPumps.has(deployment.id)) return;
    const buildId = metadata.__fcBuildId as string;
    const offsets = (metadata.__logOffsets ?? {}) as Record<string, unknown>;
    const offset =
      typeof offsets[`fc:${buildId}`] === 'number' ? (offsets[`fc:${buildId}`] as number) : 0;
    this.adoptedLogPumps.add(deployment.id);
    this.dockerService
      .adoptFirecrackerBuild({
        deploymentId: deployment.id,
        hostId: metadata.__fcHost as string,
        buildId,
        pullRef: metadata.__image as string,
        offset
      })
      .then((image) => this.finishRecoveredBuild(deployment, image))
      .catch(async (error: Error) => {
        if (error instanceof FcUnavailableError) {
          const outcome = await this.requeueOrphanedBuild(deployment.id);
          if (outcome === 'requeued' || outcome === 'superseded') return;
        }
        await this.markBuildFailed(deployment.id, error.message, 'build_error');
      })
      .catch((error: Error) =>
        this.logger.error(`[BuildRecovery] adopted firecracker build ${buildId}: ${error.message}`)
      )
      .finally(() => this.adoptedLogPumps.delete(deployment.id));
  }

  private streamAdoptedBuildLogs(deploymentId: string, jobName: string) {
    if (this.adoptedLogPumps.has(deploymentId)) return;
    this.adoptedLogPumps.add(deploymentId);
    this.dockerService
      .waitForBuildJob(jobName, deploymentId)
      .catch(() => {})
      .finally(() => this.adoptedLogPumps.delete(deploymentId));
  }

  private async isWorkerPodAlive(workerId: string): Promise<boolean | null> {
    if (!process.env.KUBERNETES_SERVICE_HOST) return null;
    const podName = workerId.replace(/-\d+$/, '');
    if (!podName || podName === workerId) return null;
    const namespace =
      process.env.ORCHARD_SERVER_NAMESPACE || process.env.POD_NAMESPACE || 'orchard';
    try {
      await this.k8sWorkload.getPod(podName, namespace);
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      return null;
    }
  }

  private async finishRecoveredBuild(
    deployment: { id: string; name: string; namespace: string },
    image: string
  ) {
    try {
      let k8sExists: boolean;
      try {
        k8sExists =
          (await this.k8sWorkload.getKubernetesDeployment(
            deployment.name,
            deployment.namespace
          )) !== null;
      } catch (error) {
        this.logger.warn(
          `[BuildRecovery] couldn't read ${deployment.namespace}/${deployment.name}, retrying later: ${(error as Error)?.message ?? error}`
        );
        return;
      }
      if (k8sExists) {
        await this.prisma.deployment.update({
          where: { id: deployment.id },
          data: { image, buildStep: 'deploying' }
        });
        const healthCheck = await this.resolveStoredHealthCheck(deployment.id);
        await this.k8sWorkload.updateDeploymentImage(
          deployment.name,
          deployment.namespace,
          image,
          healthCheck,
          await this.loadStartArgs(deployment.id),
          await this.rolloutSizing(deployment.id)
        );
        await this.recordRecoveredImageHistory(deployment.id, image).catch((error) => {
          this.logger.warn(
            `[BuildRecovery] Failed to record image history for ${deployment.id}: ${error.message}`
          );
        });
        await this.markBuildSucceeded(deployment.id, 'Build recovered and deployed.');
        this.logger.log(`[BuildRecovery] Completed succeeded build for ${deployment.id}`);
      } else {
        await this.markBuildFailed(
          deployment.id,
          "The build succeeded, but Orchard couldn't find the app in Kubernetes. Redeploy it.",
          'k8s_missing'
        );
      }
    } catch (error) {
      await this.markBuildFailed(deployment.id, `Recovery failed: ${error.message}`, 'internal');
    }
  }

  private async recordRecoveredImageHistory(deploymentId: string, image: string) {
    const run = await this.prisma.buildRun.findFirst({
      where: { deploymentId, status: 'building' },
      orderBy: { startedAt: 'desc' },
      select: {
        commitSha: true,
        commitMessage: true,
        commitAuthorName: true,
        commitAuthorUsername: true,
        branch: true,
        triggerType: true,
        triggeredById: true,
        startedAt: true
      }
    });
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { buildLogs: true }
    });
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.imageHistory.findFirst({
        where: { deploymentId, image },
        orderBy: { createdAt: 'desc' }
      });
      if (existing) {
        await tx.imageHistory.updateMany({
          where: { deploymentId, isActive: true, id: { not: existing.id } },
          data: { isActive: false }
        });
        await tx.imageHistory.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            buildLogs: existing.buildLogs ?? dep?.buildLogs ?? null,
            buildCompletedAt: existing.buildCompletedAt ?? new Date()
          }
        });
        return;
      }
      await tx.imageHistory.updateMany({
        where: { deploymentId, isActive: true },
        data: { isActive: false }
      });
      await tx.imageHistory.create({
        data: {
          deploymentId,
          image,
          tag: image.split(':').pop() || 'latest',
          commitSha: run?.commitSha ?? null,
          commitMessage: run?.commitMessage ?? null,
          commitAuthorName: run?.commitAuthorName ?? null,
          commitAuthorUsername: run?.commitAuthorUsername ?? null,
          branch: run?.branch ?? null,
          buildLogs: dep?.buildLogs ?? null,
          buildStartedAt: run?.startedAt ?? null,
          buildCompletedAt: new Date(),
          triggerType: run?.triggerType ?? null,
          triggeredById: run?.triggeredById ?? null,
          isActive: true
        }
      });
    });
  }

  // Recovery finalizer companion: conclude the GitHub check run and
  // deployment marker that the dead process left open. The ids live on the
  // BuildRun row (persisted at check creation) precisely so a different
  // process can close them.
  private async closeGitHubCheckForDeployment(deploymentId: string, ok: boolean, detail: string) {
    try {
      const run = await this.prisma.buildRun.findFirst({
        where: { deploymentId, checkRunId: { not: null } },
        orderBy: { scheduledAt: 'desc' },
        select: { checkRunId: true, githubInstallationId: true, repoFullName: true }
      });
      if (!run?.checkRunId || !run.githubInstallationId || !run.repoFullName) return;
      const [owner, repo] = run.repoFullName.split('/');
      if (!owner || !repo) return;
      const logUrl = await this.getDeploymentProgressUrl(deploymentId);
      await this.githubService.updateCheckRun(
        run.githubInstallationId,
        owner,
        repo,
        Number(run.checkRunId),
        {
          status: 'completed',
          conclusion: ok ? 'success' : 'failure',
          output: {
            title: ok ? 'Deployment Successful' : 'Deployment Failed',
            summary: detail,
            text: logUrl ? `[View the full build log in Orchard](${logUrl})` : undefined
          }
        }
      );
      const marker = await this.prisma.gitHubDeployment.findFirst({
        where: { deploymentId, status: { in: ['pending', 'in_progress'] } },
        orderBy: { createdAt: 'desc' }
      });
      if (marker) {
        await this.githubService.updateDeploymentStatusWithApp(
          run.githubInstallationId,
          marker.owner,
          marker.repo,
          Number(marker.githubDeploymentId),
          ok ? 'success' : 'failure',
          { description: detail.substring(0, 130), logUrl: logUrl ?? undefined }
        );
        await this.prisma.gitHubDeployment
          .update({
            where: { id: marker.id },
            data: { status: ok ? 'success' : 'failure' }
          })
          .catch(() => {});
      }
    } catch (e: any) {
      this.logger.warn(
        `[BuildRecovery] Failed to close GitHub check for ${deploymentId}: ${e?.message || e}`
      );
    }
  }

  /**
   * `superseded` is not a failure: something else already owns this
   * deployment's next build, so there is nothing to requeue and nothing to
   * fail. Only `ineligible` means this build has run out of chances.
   */
  private async requeueOrphanedBuild(
    deploymentId: string
  ): Promise<'requeued' | 'superseded' | 'ineligible'> {
    const building = await this.prisma.buildRun.findFirst({
      where: { deploymentId, status: 'building' },
      orderBy: { startedAt: 'desc' }
    });
    // With no run in `building` the newest run is still the record of what
    // this build was meant to do: most often because it was concluded out
    // from under a build that was still starting.
    const source =
      building ??
      (await this.prisma.buildRun.findFirst({
        where: { deploymentId },
        orderBy: { createdAt: 'desc' }
      }));
    if (!source) return 'ineligible';
    if (
      !isRequeueable({
        isBuilding: building !== null,
        workerId: source.workerId,
        heartbeatAt: null,
        triggerType: source.triggerType,
        detail: source.detail
      })
    ) {
      return 'ineligible';
    }

    if (building) {
      // The ids are cleared so the retry's own check run can be attached to
      // this row: attachGitHubContext only writes onto a run whose checkRunId
      // is still null.
      await this.prisma.buildRun.update({
        where: { id: building.id },
        data: {
          status: 'scheduled',
          detail: REQUEUE_DETAIL,
          workerId: null,
          startedAt: null,
          heartbeatAt: null,
          checkRunId: null,
          githubInstallationId: null,
          repoFullName: null
        }
      });
      await this.prisma.deployment.updateMany({
        where: { id: deploymentId, buildStatus: 'building' },
        data: { buildStatus: 'pending' }
      });
    } else {
      // Nothing to reset: the run that owned this build is already concluded.
      // Schedule a fresh attempt carrying the same commit rather than
      // rewriting a row the build history already shows as finished.
      const scheduled = await this.buildQueue.scheduleRetryForConcludedRun(
        deploymentId,
        source,
        REQUEUE_DETAIL
      );
      if (!scheduled) return 'superseded';
    }
    await this.prisma.$executeRaw`
      UPDATE "deployments"
      SET "build_logs" = COALESCE("build_logs", '') || ${`\n[INFO] This build lost track of its build job before one was created; it was requeued automatically.\n`}
      WHERE "id" = ${deploymentId}::uuid
    `.catch(() => {});
    this.buildQueue.kick();
    return 'requeued';
  }

  private async emitPipelineMetrics(deploymentId: string, succeeded: boolean, error?: string) {
    try {
      const [deployment, run] = await Promise.all([
        this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { buildLogs: true, buildStepTimestamps: true, buildType: true }
        }),
        this.prisma.buildRun.findFirst({
          where: { deploymentId },
          orderBy: { createdAt: 'desc' },
          select: { builder: true }
        })
      ]);
      if (!deployment) return;
      recordBuildPipeline({
        outcome: pipelineOutcome(succeeded, error),
        builder: run?.builder ?? 'kubernetes',
        buildType: deployment.buildType ?? 'dockerfile',
        logs: deployment.buildLogs,
        stamps: deployment.buildStepTimestamps as Record<string, unknown> | null
      });
    } catch (err) {
      this.logger.warn(
        `build pipeline metrics failed for ${deploymentId}: ${(err as Error).message}`
      );
    }
  }

  private async markBuildFailed(
    deploymentId: string,
    reason: string,
    cause: RecoveryReason | BuildOutcomeReason = 'internal'
  ) {
    const { count } = await this.prisma.deployment.updateMany({
      where: { id: deploymentId, buildStatus: { not: 'succeeded' } },
      data: { buildStatus: 'failed', buildError: reason }
    });
    if (count === 0) {
      this.logger.warn(
        `[BuildRecovery] Refusing to fail ${deploymentId} ("${reason}") - the build already succeeded`
      );
      recordBuildOutcome({
        outcome: 'failed',
        source: 'recovery',
        reason: 'internal',
        deploymentId,
        suppressed: true,
        detail: reason
      });
      return;
    }
    // Written only to a column and the build log, a build the sweep killed would
    // leave no trace in Datadog: not a log line, not a metric, not a span. Ending
    // someone's build is the loudest thing this service does; it logs and reports
    // like it.
    this.logger.error(`[BuildRecovery] Failed ${deploymentId}: ${reason} (${cause})`);
    recordBuildOutcome({
      outcome: 'failed',
      source: 'recovery',
      reason: RECOVERY_OUTCOME_REASON[cause] ?? 'internal',
      deploymentId,
      detail: reason
    });
    await this.prisma.$executeRaw`
      UPDATE "deployments"
      SET "build_logs" = COALESCE("build_logs", '') || ${`\n[ERROR] ${reason}\n`}
      WHERE "id" = ${deploymentId}::uuid
    `.catch(() => {});
    this.buildQueue.onBuildFinished(deploymentId).catch(() => {});
    void this.closeGitHubCheckForDeployment(deploymentId, false, reason);
  }

  private async markBuildSucceeded(deploymentId: string, logMessage: string) {
    const data = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { buildStepTimestamps: true, stopped: true }
    });
    const timestamps = (data?.buildStepTimestamps as Record<string, any> | null) || {};
    timestamps['complete'] = Date.now();
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        status: data?.stopped ? 'stopped' : 'running',
        buildStatus: 'succeeded',
        buildStep: 'complete',
        buildStepTimestamps: timestamps
      }
    });
    await this.prisma.$executeRaw`
      UPDATE "deployments"
      SET "build_logs" = COALESCE("build_logs", '') || ${`\n${logMessage}\n`}
      WHERE "id" = ${deploymentId}::uuid
    `.catch(() => {});
    this.buildQueue.onBuildFinished(deploymentId).catch(() => {});
    void this.closeGitHubCheckForDeployment(deploymentId, true, logMessage);
  }

  async listDeploymentsSummary(userId: string, orgId?: string) {
    const projectFilter = await this.access.buildProjectAccessFilter(userId, orgId);
    if (!projectFilter) return [];

    const deployments = await this.prisma.deployment.findMany({
      where: { project: projectFilter },
      select: {
        id: true,
        name: true,
        displayName: true,
        icon: true,
        namespace: true,
        status: true,
        buildStatus: true,
        image: true,
        githubRepo: true,
        githubBranch: true,
        updatedAt: true,
        replicas: true,
        stopped: true,
        ingresses: {
          select: {
            id: true,
            host: true,
            path: true,
            tlsSecretName: true,
            entrypoints: true
          }
        },
        services: {
          select: {
            ingresses: {
              select: {
                id: true,
                host: true,
                path: true,
                tlsSecretName: true,
                entrypoints: true
              }
            }
          }
        },
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            organizationId: true
          }
        },
        // Lets the org-wide search resolve a person to their apps. Deliberately
        // no email: that is scrubbed from viewers everywhere else too.
        creator: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            imageUrl: true
          }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    // Statuses come from the pods table the mirror informers maintain, so the
    // home page reflects live cluster state without touching the apiserver.
    const storedPods = await this.prisma.pod.findMany({
      where: { deploymentId: { in: deployments.map((d) => d.id) } },
      select: { deploymentId: true, status: true, restartCount: true }
    });
    const podsByDeployment = new Map<string, { status: string; restartCount: number }[]>();
    for (const pod of storedPods) {
      const bucket = podsByDeployment.get(pod.deploymentId);
      if (bucket) bucket.push(pod);
      else podsByDeployment.set(pod.deploymentId, [pod]);
    }

    const computedStatuses = await Promise.all(
      deployments.map((d) =>
        this.computeDeploymentStatus(d, {
          pods: podsByDeployment.get(d.id) ?? [],
          warnings: []
        })
      )
    );

    // Merge direct ingresses and service-linked ingresses, deduplicating by id
    return deployments.map(({ services, ingresses, namespace: _namespace, ...rest }, i) => {
      const serviceIngresses = services.flatMap((s) => s.ingresses);
      const allIngresses = [...ingresses, ...serviceIngresses];
      const seen = new Set<string>();
      const uniqueIngresses = allIngresses.filter((ing) => {
        if (seen.has(ing.id)) return false;
        seen.add(ing.id);
        return true;
      });
      return {
        ...rest,
        status: computedStatuses[i],
        ingresses: uniqueIngresses.map((ing) => scrubIngress(ing))
      };
    });
  }

  async listRecentBuilds(
    userId: string,
    orgId?: string,
    opts: { scope?: 'mine' | 'all'; activeLimit?: number; recentLimit?: number } = {}
  ) {
    const { scope = 'all', activeLimit = 5, recentLimit = 5 } = opts;
    let projectFilter = await this.access.buildProjectAccessFilter(userId, orgId);
    if (!projectFilter) return { active: [], recent: [] };

    if (scope === 'mine') {
      const memberUserId = (await this.access.resolveMemberUserId(userId)) ?? userId;
      const mineCount = await this.prisma.project.count({
        where: {
          ...(orgId ? { organizationId: orgId } : {}),
          members: { some: { userId: memberUserId } }
        }
      });
      if (mineCount > 0) {
        projectFilter = { AND: [projectFilter, { members: { some: { userId: memberUserId } } }] };
      }
    }

    const [activeBuilds, recentBuilds] = await Promise.all([
      this.prisma.deployment.findMany({
        where: {
          project: projectFilter,
          buildStatus: { in: ['building', 'pending'] }
        },
        select: {
          id: true,
          name: true,
          displayName: true,
          image: true,
          status: true,
          buildStatus: true,
          buildStep: true,
          buildStepTimestamps: true,
          updatedAt: true,
          githubRepo: true,
          githubBranch: true,
          ingresses: { select: INGRESS_URL_SELECT, take: 1 },
          project: { select: { name: true } }
        },
        orderBy: { updatedAt: 'desc' },
        take: activeLimit
      }),
      this.prisma.imageHistory.findMany({
        where: { deployment: { project: projectFilter } },
        select: {
          id: true,
          commitSha: true,
          commitMessage: true,
          branch: true,
          triggerType: true,
          isActive: true,
          buildStartedAt: true,
          buildCompletedAt: true,
          createdAt: true,
          deployment: {
            select: {
              id: true,
              name: true,
              displayName: true,
              image: true,
              buildStatus: true,
              ingresses: { select: INGRESS_URL_SELECT, take: 1 },
              project: { select: { name: true } }
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: recentLimit
      })
    ]);

    return {
      // The elapsed counter runs off `buildStartedAt`; `updatedAt` is only a
      // fallback for builds that predate step timestamps.
      active: activeBuilds.map((d) => ({
        ...d,
        buildStartedAt: buildStartedAtFrom(d.buildStepTimestamps),
        ingresses: d.ingresses.map(scrubIngress)
      })),
      recent: recentBuilds.map((b) =>
        b.deployment
          ? {
              ...b,
              deployment: { ...b.deployment, ingresses: b.deployment.ingresses.map(scrubIngress) }
            }
          : b
      )
    };
  }

  async getProjectDeployments(projectId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    const access = await this.authz.requireProjectView(projectId, user.id);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId }
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const deployments = await this.prisma.deployment.findMany({
      where: { projectId },
      include: {
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        pods: true,
        ingresses: {
          include: {
            service: true
          }
        }
      }
    });

    const mirroredPods = await this.fetchMirroredPods(deployments.map((d) => d.id));
    const podsByDeployment = new Map<string, typeof mirroredPods>();
    for (const pod of mirroredPods) {
      const bucket = podsByDeployment.get(pod.deploymentId);
      if (bucket) bucket.push(pod);
      else podsByDeployment.set(pod.deploymentId, [pod]);
    }

    const deploymentsWithComputedStatus = await Promise.all(
      deployments.map(async (deployment) => {
        const pods = podsByDeployment.get(deployment.id) ?? [];
        const warnings = this.synthesizePodWarnings(pods);

        const computedStatus = await this.computeDeploymentStatus(deployment, {
          pods,
          warnings
        });

        const merged = DeploymentsService.redactSecretEnv({
          ...deployment,
          ingresses: deployment.ingresses.map((ing) => scrubIngress(ing)),
          pods,
          status: computedStatus,
          warnings
        });
        return access.canEdit ? merged : this.scrubDeploymentForViewer(merged as any);
      })
    );

    return deploymentsWithComputedStatus;
  }

  metricsTarget(deploymentId: string) {
    return this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { name: true, namespace: true, memoryRequestBytes: true }
    });
  }

  async getDeployment(deploymentId: string, canEdit = true, userId?: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        environment: {
          select: { id: true, name: true, slug: true, isDefault: true }
        },
        gitConnection: {
          select: { id: true, name: true, provider: true, baseUrl: true, userId: true }
        },
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        volumes: true,
        ingresses: {
          include: {
            service: true
          }
        },
        imageHistory: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            image: true,
            tag: true,
            commitSha: true,
            commitMessage: true,
            commitAuthorName: true,
            commitAuthorUsername: true,
            branch: true,
            buildStartedAt: true,
            buildCompletedAt: true,
            isActive: true,
            createdAt: true,
            triggerType: true,
            triggeredBy: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true
              }
            }
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    const deploymentWithInternalUrls = this.addInternalUrlsToDeployment(deployment);
    const namespace = deployment.namespace;
    const directIngresses: any[] = deploymentWithInternalUrls.ingresses ?? [];
    const existingIds = new Set(directIngresses.map((i: any) => i.id));

    const limitsRestartPending = await this.limitsRestartPending(deployment);
    const [, pods, workload, projectIngresses, rollout, latestVerdict] = await Promise.all([
      userId ? this.authz.requireProjectView(deployment.projectId, userId) : null,
      this.fetchMirroredPods([deploymentId]),
      this.prisma.k8sWorkload.findUnique({ where: { deploymentId } }),
      namespace && deployment.projectId
        ? this.prisma.ingress.findMany({
            where: { projectId: deployment.projectId, id: { notIn: Array.from(existingIds) } },
            include: { service: true }
          })
        : Promise.resolve([] as any[]),
      this.mirroredRollout(deployment),
      this.latestVerdict(deployment.id),
      this.attachPublicStatus(deploymentWithInternalUrls)
    ]);
    const warnings = this.synthesizePodWarnings(pods);
    const totalCpuUsage: number | null = null;
    const totalMemoryUsage: number | null = null;
    const availableReplicas =
      workload?.availableReplicas ??
      pods.filter((pod) => pod.status?.toLowerCase() === 'ready').length;

    if (namespace) {
      const candidateIngresses = [...directIngresses, ...projectIngresses];
      const [mirrored, certificates] = await Promise.all([
        this.prisma.k8sObject.findMany({
          where: {
            kind: 'Ingress',
            namespace,
            name: { in: [...new Set(candidateIngresses.map((i: any) => i.name))] }
          },
          select: { name: true, manifest: true }
        }),
        candidateIngresses.some((ing: any) => ing?.tlsSecretName)
          ? this.prisma.k8sObject.findMany({
              where: { kind: 'Certificate', namespace },
              select: { manifest: true }
            })
          : Promise.resolve([] as { manifest: any }[])
      ]);
      const k8sByName = new Map<string, any>(mirrored.map((m) => [m.name, m.manifest]));

      const serviceNames = new Set((deployment.services ?? []).map((s: any) => s.name));
      const enrich = (ing: any) => {
        const k8sIngress = k8sByName.get(ing.name);
        const rules = k8sIngress?.spec?.rules ?? [];
        const k8sPaths = rules.length > 0 && rules[0].http?.paths ? rules[0].http.paths : [];
        const routes = k8sPaths.length
          ? k8sPaths.map((p: any) => ({
              path: p.path || '/',
              serviceName: p.backend?.service?.name || '',
              servicePort: p.backend?.service?.port?.number || 0
            }))
          : [
              {
                path: ing.path,
                serviceName: ing.service?.name || '',
                servicePort: ing.service?.port || 0
              }
            ];
        return { ingress: scrubIngress({ ...ing, routes }), k8sPaths };
      };

      const directEnriched = directIngresses.map((ing) => enrich(ing).ingress);
      const projectExtras = projectIngresses
        .map((pi: any) => {
          const { ingress, k8sPaths } = enrich(pi);
          const hasRouteForDeployment = k8sPaths.some((p: any) =>
            serviceNames.has(p.backend?.service?.name || '')
          );
          return hasRouteForDeployment ? ingress : null;
        })
        .filter((i): i is any => !!i);

      // Whether the certificate behind each host actually issued. Read here
      // rather than in the UI so a browser certificate error has an explanation
      // next to the domain that caused it. Best-effort and per-host: a cluster
      // without cert-manager reports `unknown` and renders nothing.
      const enrichedIngresses = [...directEnriched, ...projectExtras];
      for (const ing of enrichedIngresses as any[]) {
        if (!ing?.tlsSecretName) continue;
        ing.certificateStatus = certificateStatusFrom(
          certificateForSecret(certificates, ing.tlsSecretName)
        );
      }

      deploymentWithInternalUrls.ingresses = enrichedIngresses;
    }

    const computedStatus = await this.computeDeploymentStatus(deployment, { pods, warnings });

    const result: any = {
      ...deploymentWithInternalUrls,
      pods,
      availableReplicas,
      // What the cluster is actually asked to run, straight off the mirror.
      // `replicas` on the row is intent, and the two legitimately disagree:
      // a stopped deployment keeps its count so it can come back to it, and an
      // external `kubectl scale` is only adopted when nothing is mid-build or
      // mid-apply. Clients that render `replicas` as if it were state end up
      // claiming a pod is running when the Deployment sits at zero, so hand
      // them the observed number and let them say which is which.
      specReplicas: workload?.specReplicas ?? null,
      readyReplicas: workload?.readyReplicas ?? null,
      observedAt: workload?.updatedAt ?? null,
      warnings,
      rollout,
      latestVerdict,
      limitsRestartPending,
      totalCpuUsage,
      totalMemoryUsage,
      status: computedStatus,
      buildStatus: deployment.buildStatus,
      // `imagePullPolicy` is the override (null = automatic); this is what the
      // cluster is actually doing. Clients render this and only send the
      // override back, so nobody has to reimplement the tag rules.
      effectiveImagePullPolicy: resolvePullPolicy(deployment.imagePullPolicy, deployment.image)
    };
    return canEdit ? result : this.scrubDeploymentForViewer(result);
  }

  async mirroredRollout(deployment: { id: string; name: string | null; namespace: string | null }) {
    if (!deployment.name || !deployment.namespace) return null;
    const greenName = greenName_(deployment.name);
    const objects = await this.prisma.k8sObject.findMany({
      where: {
        OR: [
          { kind: 'ReplicaSet', deploymentId: deployment.id },
          {
            kind: 'Deployment',
            namespace: deployment.namespace,
            name: { in: [deployment.name, greenName] }
          }
        ]
      },
      select: { kind: true, name: true, manifest: true }
    });
    const blue = objects.find((o) => o.kind === 'Deployment' && o.name === deployment.name);
    if (!blue) return null;
    const owned = (owner: string) =>
      objects
        .filter((o) => o.kind === 'ReplicaSet')
        .map((o) => o.manifest as k8s.V1ReplicaSet)
        .filter((rs) => rs.metadata?.ownerReferences?.some((ref) => ref.name === owner));
    const summary = summarizeRollout(blue.manifest as k8s.V1Deployment, owned(deployment.name));
    const green = objects.find((o) => o.kind === 'Deployment' && o.name === greenName);
    return green
      ? summarizeBlueGreen(summary, green.manifest as k8s.V1Deployment, owned(greenName))
      : summary;
  }

  async getDeploymentPods(deploymentId: string, userId?: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    // Defense-in-depth: re-assert project-view even though the controller already did.
    if (userId) {
      await this.authz.requireProjectView(deployment.projectId, userId);
    }

    return this.fetchMirroredPods([deploymentId]);
  }

  async getDeploymentPodsLive(deploymentId: string, userId?: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (userId) {
      await this.authz.requireProjectView(deployment.projectId, userId);
    }

    let pods: any[] = [];
    let warnings: any[] = [];
    let availableReplicas = 0;
    let totalCpuUsage: number | null = null;
    let totalMemoryUsage: number | null = null;
    let meteredPods: number | null = null;

    if (deployment.name && deployment.namespace) {
      try {
        const livePods = await this.k8sWorkload.getDeploymentPods(
          deployment.name,
          deployment.namespace
        );
        pods = this.formatLivePods(livePods?.pods);
        warnings = livePods?.warnings || [];
        totalCpuUsage = livePods?.totalCpuUsage ?? null;
        totalMemoryUsage = livePods?.totalMemoryUsage ?? null;
        meteredPods = livePods?.meteredPods ?? null;

        try {
          const k8sDeployment = await this.k8sWorkload.getKubernetesDeployment(
            deployment.name,
            deployment.namespace
          );
          availableReplicas = k8sDeployment?.status?.availableReplicas ?? 0;
        } catch {
          availableReplicas =
            pods?.filter((pod: any) => pod.status?.toLowerCase() === 'ready').length ?? 0;
        }
      } catch (error) {
        console.error(
          `[ProjectsService] Failed to fetch live pods for deployment ${deploymentId}:`,
          error instanceof Error ? error.message : error
        );
        throw error;
      }
    }

    return {
      pods,
      warnings,
      rollout: await this.mirroredRollout(deployment),
      availableReplicas,
      totalCpuUsage,
      totalMemoryUsage,
      meteredPods
    };
  }

  async cancelDeploymentBuild(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'cancel deployments');

    if (deployment.buildStatus !== 'building') {
      throw new BadRequestException("This app can't build right now");
    }

    try {
      console.log(`[Projects] Cancelling build jobs for deployment ${deploymentId}`);
      await this.dockerService.cancelBuildJobsByDeploymentId(deploymentId);
      console.log(`[Projects] Successfully cancelled build jobs for deployment ${deploymentId}`);
    } catch (error) {
      console.error(
        `[Projects] Error cancelling build jobs for deployment ${deploymentId}:`,
        error
      );
    }

    const currentLogs = deployment.buildLogs || '';
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        buildStatus: 'failed',
        buildStep: null,
        buildError: 'Build cancelled by user',
        buildLogs: `${currentLogs}[${Date.now()}] [INFO] Build cancelled by user\n`
      }
    });

    void this.audit.log({
      action: 'deployment.build_cancelled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name
    });

    return {
      success: true,
      deploymentId,
      message: 'Build cancelled successfully'
    };
  }

  async deleteDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    options?: { fromComposeStack?: boolean }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (deployment.composeStackId && !options?.fromComposeStack) {
      throw new BadRequestException(
        'A compose file manages this app. Delete it from its compose stack.'
      );
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'delete deployments');

    // A finished build's job and pod stay around for an hour for its logs, so this
    // can't depend on a build still running.
    if (deployment.buildStatus !== 'none') {
      await this.dockerService
        .cancelBuildJobsByDeploymentId(deploymentId)
        .catch((err) =>
          console.error(`[Projects] Failed to cancel builds for ${deploymentId}:`, err)
        );
    }

    // Fetch all related resources before deleting
    const [ingresses, services, volumes, imageHistoryEntries] = await Promise.all([
      this.prisma.ingress.findMany({ where: { deploymentId } }),
      this.prisma.service.findMany({ where: { deploymentId } }),
      this.prisma.deploymentVolume.findMany({ where: { deploymentId } }),
      this.prisma.imageHistory.findMany({ where: { deploymentId }, select: { image: true } })
    ]);

    await this.teardownDeploymentResources(deployment, { ingresses, services, volumes }, true);

    // Delete the DB record (cascades to pods, services, envVars, ingresses, volumes, imageHistory).
    await this.prisma.deployment.delete({
      where: { id: deploymentId }
    });

    this.notifications
      .purgeScope('deployment', deploymentId)
      .catch((err) =>
        console.error(`[Projects] Failed to purge notification scope for ${deploymentId}:`, err)
      );

    // Delete all associated repositories from Harbor in the background
    if (imageHistoryEntries.length > 0) {
      const imageRefs = imageHistoryEntries.map((entry) => entry.image);
      splitRegistryCleanup(this.prisma, deploymentId, imageRefs, deployment.project.namespace)
        .then(async ({ repositories, tags }) => {
          await this.dockerService.deleteRepositoriesFromRegistry(repositories);
          await this.dockerService.deleteArtifactsFromRegistry(tags);
        })
        .catch((err) => {
          console.error(
            `[Projects] Failed to delete repositories from registry for deployment ${deploymentId}:`,
            err
          );
        });
    }

    void this.audit.log({
      action: 'deployment.deleted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name
    });

    return {
      success: true,
      deploymentId,
      projectId: deployment.projectId
    };
  }

  async deleteDeploymentFromCluster(deploymentId: string, cause: Record<string, unknown>) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: { select: { organizationId: true } } }
    });
    if (!deployment) return null;

    const [ingresses, services, volumes] = await Promise.all([
      this.prisma.ingress.findMany({ where: { deploymentId } }),
      this.prisma.service.findMany({ where: { deploymentId } }),
      this.prisma.deploymentVolume.findMany({ where: { deploymentId } })
    ]);
    await this.teardownDeploymentResources(deployment, { ingresses, services, volumes }, false);

    try {
      await this.prisma.deployment.delete({ where: { id: deploymentId } });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2025') return null;
      throw error;
    }

    this.notifications
      .purgeScope('deployment', deploymentId)
      .catch((err) =>
        console.error(`[Projects] Failed to purge notification scope for ${deploymentId}:`, err)
      );

    const keptVolumes = volumes
      .filter((v) => v.type === 'pvc' && v.pvcName)
      .map((v) => v.pvcName as string);
    void this.audit.log({
      action: 'deployment.deleted',
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: { ...cause, keptVolumes }
    });
    return { deploymentId, keptVolumes };
  }

  private async teardownDeploymentResources(
    deployment: {
      id: string;
      name: string;
      namespace: string;
      buildContextKey: string | null;
      tailscaleExposed: boolean;
    },
    related: {
      ingresses: { name: string; namespace: string }[];
      services: { name: string }[];
      volumes: { type: string; pvcName: string | null }[];
    },
    deleteVolumes: boolean
  ) {
    const { ingresses, services, volumes } = related;
    for (const ingress of ingresses) {
      try {
        await this.k8sNetwork.deleteIngress(ingress.namespace, ingress.name);
      } catch (error) {
        console.error(`Failed to delete ingress ${ingress.name} from Kubernetes:`, error);
      }
    }

    for (const service of services) {
      try {
        await this.k8sNetwork.deleteService(deployment.namespace, service.name);
      } catch (error) {
        console.error(`Failed to delete service ${service.name} from Kubernetes:`, error);
      }
    }

    const claims = volumes.filter((v) => v.type === 'pvc' && v.pvcName).map((v) => v.pvcName!);
    const heldElsewhere =
      deleteVolumes && claims.length > 0
        ? new Set(
            (await this.volumeHolders(deployment.namespace, claims))
              .filter((holder) => holder.deployment.id !== deployment.id)
              .map(volumeClaim)
          )
        : new Set<string>();
    const databaseClusters = deleteVolumes
      ? await this.prisma.database.findMany({
          where: { namespace: deployment.namespace },
          select: { clusterName: true }
        })
      : [];
    const backsDatabase = (claim: string) =>
      databaseClusters.some((db) => db.clusterName && claim.startsWith(`${db.clusterName}-`));
    for (const volume of deleteVolumes ? volumes : []) {
      if (
        volume.type === 'pvc' &&
        volume.pvcName &&
        !heldElsewhere.has(volume.pvcName) &&
        !backsDatabase(volume.pvcName)
      ) {
        try {
          await this.kubernetesService.deletePVC(deployment.namespace, volume.pvcName);
        } catch (error) {
          console.error(`Failed to delete PVC ${volume.pvcName} from Kubernetes:`, error);
        }
      }
    }

    try {
      await this.k8sNetwork.unexposeAllDeploymentPortsPublic(deployment.namespace, deployment.name);
    } catch (error) {
      console.error(`Failed to unexpose public ports for ${deployment.name}:`, error);
    }
    try {
      await this.k8sNetwork.deletePublicDeploymentNetworkPolicy(
        deployment.namespace,
        deployment.name
      );
    } catch (error) {
      console.error(`Failed to delete public NetworkPolicy for ${deployment.name}:`, error);
    }

    // Clean up Tailscale sidecar if exposed
    try {
      await this.tailscaleService.cleanupDeployment(deployment);
    } catch (error) {
      console.error(
        `[Projects] Failed to clean up Tailscale for deployment ${deployment.name}:`,
        error
      );
    }

    await this.k8sWorkload.deleteDeployment(deployment.name, deployment.namespace);

    if (deployment.buildContextKey) {
      this.storage.deleteBuildContext(deployment.buildContextKey).catch(() => {});
    }
  }

  private volumeHolders(namespace: string, claims: string[]) {
    return this.prisma.deploymentVolume.findMany({
      where: {
        type: 'pvc',
        deployment: { namespace },
        OR: [{ pvcName: { in: claims } }, { pvcName: null, name: { in: claims } }]
      },
      select: {
        name: true,
        pvcName: true,
        deployment: { select: { id: true, name: true } }
      }
    });
  }

  private async assertVolumesUnclaimed(
    namespace: string,
    volumes: { name?: string; type?: string; pvcName?: string | null }[] | undefined,
    exceptDeploymentIds: string[] = []
  ) {
    const wanted = (Array.isArray(volumes) ? volumes : [])
      .filter((vol) => vol?.type === 'pvc')
      .map(volumeClaim)
      .filter(Boolean);
    if (wanted.length === 0) return;
    const conflict = findVolumeConflict(
      wanted,
      await this.volumeHolders(namespace, wanted),
      exceptDeploymentIds
    );
    if (conflict) {
      throw new BadRequestException(
        `Volume "${conflict.claim}" is already used by "${conflict.holder}". Two apps can't share a volume, so pick a different name.`
      );
    }
  }

  async assertEnvironmentVolumesUnclaimed(
    projectId: string,
    environmentId: string | null | undefined,
    volumes: { name?: string; type?: string; pvcName?: string | null }[],
    exceptDeploymentIds: string[] = []
  ) {
    const environment = await this.environments.resolveEnvironment(
      projectId,
      environmentId ?? undefined
    );
    await this.assertVolumesUnclaimed(environment.namespace, volumes, exceptDeploymentIds);
  }

  async scaleDeployment(
    deploymentId: string,
    replicas: number,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    options?: { fromComposeStack?: boolean }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    if (!options?.fromComposeStack) this.assertNotComposeManaged(deployment, 'Scale');

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'scale deployments');

    if (replicas < 0 || !Number.isInteger(replicas)) {
      throw new BadRequestException('Replicas must be a non-negative integer');
    }

    const stopped = replicas === 0;
    const desiredReplicas = stopped ? Math.max(1, deployment.replicas) : replicas;
    const currentReplicas = deployment.stopped ? 0 : deployment.replicas;
    const delta = (stopped ? 0 : desiredReplicas) - currentReplicas;
    if (delta > 0) {
      const perPod = await this.quotasService.resolvePodResources(
        deployment.projectId,
        {
          cpuRequestMilli: deployment.cpuRequestMilli ?? null,
          memoryRequestBytes:
            deployment.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null
        },
        deployment.image
      );
      const requested = {
        cpuMilli: perPod.cpuMilli * delta,
        memoryBytes: perPod.memoryBytes * delta
      };
      await this.quotasService.enforceOrgCapForNewPod(deployment.project.organizationId, requested);
      await this.quotasService.enforceProjectCapForNewPod(deployment.projectId, {
        ...requested,
        pods: delta
      });
      await this.quotasService.enforceMemberAllowanceForNewPod(
        deployment.project.organizationId,
        deployment.project.ownerId,
        requested
      );
    }

    if (this.applyPipelineEnabled()) {
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { replicas: desiredReplicas, stopped }
      });
      await this.applyQueue.enqueue({
        dedupeKey: `op:deployment.scale:${deploymentId}`,
        opType: 'deployment.scale',
        deploymentId,
        requestedById: user.id
      });
      // Crossing the replica count in either direction flips whether the
      // budget can exist at all, so it is reconciled on every scale.
      await this.syncDisruptionBudget(deploymentId);
    } else {
      // Only push to K8s if the deployment exists in the cluster.
      const k8sExistsScale = await this.k8sWorkload
        .getKubernetesDeployment(deployment.name, deployment.namespace)
        .then((d) => d !== null);

      if (k8sExistsScale) {
        await this.k8sWorkload.scaleDeployment(
          deployment.name,
          deployment.namespace,
          stopped ? 0 : desiredReplicas
        );
      }

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { replicas: desiredReplicas, stopped }
      });
      await this.syncDisruptionBudget(deploymentId);
    }

    void this.audit.log({
      action: 'deployment.scaled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        replicas: [deployment.replicas, desiredReplicas],
        stopped: [deployment.stopped, stopped]
      }
    });

    return {
      success: true,
      deploymentId,
      projectId: deployment.projectId,
      replicas: desiredReplicas,
      stopped
    };
  }

  async holdPush(
    deploymentId: string,
    push: { sha: string; branch: string; author: string | null; message: string | null }
  ): Promise<PendingPush> {
    const row = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        pendingPush: true,
        name: true,
        projectId: true,
        project: { select: { organizationId: true } }
      }
    });
    const previous = (row?.pendingPush as unknown as PendingPush | null) ?? null;
    const next: PendingPush = {
      ...push,
      at: new Date().toISOString(),
      count: (previous?.count ?? 0) + 1
    };
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { pendingPush: next as object }
    });
    if (row) {
      void this.audit.log({
        action: 'deployment.push_held',
        organizationId: row.project.organizationId,
        projectId: row.projectId,
        deploymentId,
        targetType: 'deployment',
        targetId: deploymentId,
        targetLabel: row.name,
        metadata: { sha: push.sha, branch: push.branch, count: next.count }
      });
    }
    return next;
  }

  async stopDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: { include: { organization: true } } }
    });
    if (!deployment) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    this.assertNotComposeManaged(deployment, 'Stop');
    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'stop deployments');

    if (this.applyPipelineEnabled()) {
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { stopped: true }
      });
      await this.applyQueue.enqueue({
        dedupeKey: `op:deployment.scale:${deploymentId}`,
        opType: 'deployment.scale',
        deploymentId,
        requestedById: user.id
      });
    } else {
      const existing = await this.k8sWorkload.getKubernetesDeployment(
        deployment.name,
        deployment.namespace
      );
      if (existing) {
        await this.k8sWorkload.scaleDeployment(deployment.name, deployment.namespace, 0);
      }
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { stopped: true }
      });
    }
    await this.syncDisruptionBudget(deploymentId);

    void this.audit.log({
      action: 'deployment.stopped',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name
    });

    return { success: true, replicas: deployment.replicas, stopped: true };
  }

  async startDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    opts?: { build?: boolean }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: { include: { organization: true } } }
    });
    if (!deployment) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    this.assertNotComposeManaged(deployment, 'Start');
    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'start deployments');

    const replicas = Math.max(1, deployment.replicas);
    const pending = (deployment.pendingPush as unknown as PendingPush | null) ?? null;
    if (deployment.stopped && (pending || opts?.build) && deployment.githubRepo) {
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { replicas, stopped: false, pendingPush: null }
      });
      void this.audit.log({
        action: 'deployment.started',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: deployment.project.organizationId,
        projectId: deployment.projectId,
        deploymentId,
        targetType: 'deployment',
        targetId: deploymentId,
        targetLabel: deployment.name,
        metadata: { build: true, sha: pending?.sha ?? null }
      });
      if (pending) {
        const result = await this.triggerAutoDeploy(
          deploymentId,
          pending.sha,
          pending.message ?? 'Held push',
          pending.author ?? undefined,
          pending.author ?? undefined
        );
        return { success: true, started: 'building', replicas, stopped: false, build: result };
      }
      const result = await this.rebuildDeployment(deploymentId, clerkId, userData);
      return { success: true, started: 'building', replicas, stopped: false, build: result };
    }
    if (deployment.stopped || deployment.replicas < 1) {
      const perPod = await this.quotasService.resolvePodResources(
        deployment.projectId,
        {
          cpuRequestMilli: deployment.cpuRequestMilli ?? null,
          memoryRequestBytes:
            deployment.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null
        },
        deployment.image
      );
      const requested = {
        cpuMilli: perPod.cpuMilli * replicas,
        memoryBytes: perPod.memoryBytes * replicas
      };
      await this.quotasService.enforceOrgCapForNewPod(deployment.project.organizationId, requested);
      await this.quotasService.enforceProjectCapForNewPod(deployment.projectId, {
        ...requested,
        pods: replicas
      });
      await this.quotasService.enforceMemberAllowanceForNewPod(
        deployment.project.organizationId,
        deployment.project.ownerId,
        requested
      );
    }

    if (this.applyPipelineEnabled()) {
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { replicas, stopped: false }
      });
      await this.applyQueue.enqueue({
        dedupeKey: `op:deployment.scale:${deploymentId}`,
        opType: 'deployment.scale',
        deploymentId,
        requestedById: user.id
      });
    } else {
      const existing = await this.k8sWorkload.getKubernetesDeployment(
        deployment.name,
        deployment.namespace
      );
      if (existing) {
        await this.k8sWorkload.scaleDeployment(deployment.name, deployment.namespace, replicas);
      }
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { replicas, stopped: false }
      });
    }
    await this.syncDisruptionBudget(deploymentId);

    void this.audit.log({
      action: 'deployment.started',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name
    });

    return { success: true, replicas, stopped: false };
  }

  async restartDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'restart deployments');

    if (deployment.stopped) {
      throw new BadRequestException('Start the app before restarting it');
    }

    const desiredReplicas = deployment.replicas || 1;
    const k8sDeploy = await this.k8sWorkload.getKubernetesDeployment(
      deployment.name,
      deployment.namespace
    );
    if (k8sDeploy && k8sDeploy.status.replicas !== desiredReplicas) {
      await this.k8sWorkload.patchDeploymentReplicas(
        deployment.name,
        deployment.namespace,
        desiredReplicas
      );
    }

    const result = await this.k8sWorkload.restartDeployment(
      deployment.name,
      deployment.namespace,
      await this.quotasService.prepareRollout(deployment)
    );

    void this.audit.log({
      action: 'deployment.restarted',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name
    });

    return result;
  }

  async updateDeploymentEnvVars(
    deploymentId: string,
    env: EnvVarWrite[],
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployments');

    const before = new Map((await this.readOwnEnvVars(deployment.id)).map((v) => [v.key, v]));
    const envEntries = applyEnvKeepRules(Array.isArray(env) ? env : [], before);

    // Env keys get interpolated into Dockerfile ARG/ENV directives and shell
    // commands in the builder; a key with a newline or shell metachar would
    // inject arbitrary instructions. Reject anything that isn't a POSIX-style
    // identifier before it reaches the build pipeline.
    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const entry of envEntries) {
      if (!ENV_KEY_RE.test(entry.key)) {
        throw new BadRequestException(`Invalid environment variable key: ${entry.key}`);
      }
    }

    const uniqueEnv = new Map<string, { value: string; secret: boolean }>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, { value: entry.value, secret: entry.secret });
    }

    const envList = Array.from(uniqueEnv.entries()).map(([key, e]) => ({
      key,
      value: e.value,
      secret: e.secret
    }));
    assertEnvSetStorable(envList);

    const resources = await this.resourceBindings.valuesFor(deployment.id);
    this.resolveOrReject(envList, [], resources);

    if (!this.applyPipelineEnabled()) {
      // Only push to K8s if the deployment actually exists in the cluster.
      // If the build hasn't succeeded yet, just persist to DB: the env vars
      // will be applied when the build completes and creates the K8s deployment.
      const k8sExists = await this.k8sWorkload
        .getKubernetesDeployment(deployment.name, deployment.namespace)
        .then((d) => d !== null);

      if (k8sExists) {
        // Resolve ${{shared.KEY}} against the environment's shared vars, then
        // push the resolved values (secrets routed to a k8s Secret) to the pod.
        const sharedVars = await this.loadSharedVarsForDeployment(
          deployment.id,
          deployment.environmentId
        );
        const { resolved } = this.resolveOrReject(envList, sharedVars, resources);
        await this.k8sWorkload.updateDeploymentEnv({
          namespace: deployment.namespace,
          deploymentName: deployment.name,
          env: resolved
        });
      }
    }

    // Compare plaintext against plaintext: a secret is ciphertext at rest, so
    // reading the rows raw would call every secret changed on every save.
    const prevMap = new Map(Array.from(before, ([k, v]) => [k, v.value]));
    const newMap = new Map(envList.map((e) => [e.key, e.value]));
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [k, v] of newMap) {
      if (!prevMap.has(k)) added.push(k);
      else if (prevMap.get(k) !== v) changed.push(k);
    }
    for (const k of prevMap.keys()) if (!newMap.has(k)) removed.push(k);

    const updatedDeployment = await this.prisma.$transaction(async (tx) => {
      await tx.deploymentEnvVar.deleteMany({
        where: {
          deploymentId: deployment.id
        }
      });

      if (envList.length > 0) {
        await tx.deploymentEnvVar.createMany({
          data: envList.map((entry) => ({
            deploymentId: deployment.id,
            key: entry.key,
            value: this.crypto.encryptIfSecret(entry.value, entry.secret),
            secret: entry.secret
          }))
        });
      }

      return tx.deployment.findUnique({
        where: { id: deployment.id },
        include: {
          project: {
            include: {
              organization: true
            }
          },
          pods: true,
          services: {
            include: {
              ports: true
            }
          },
          envVars: true,
          ingresses: {
            include: {
              service: true
            }
          }
        }
      });
    });

    void this.resourceBindings.pruneUnreferenced(deployment.id).catch(() => undefined);

    if (this.applyPipelineEnabled()) {
      await this.applyQueue.enqueue({
        dedupeKey: `op:deployment.updateEnv:${deployment.id}`,
        opType: 'deployment.updateEnv',
        deploymentId: deployment.id,
        requestedById: user.id
      });
    }

    if (added.length || removed.length || changed.length) {
      void this.audit.log({
        action: 'deployment.env.updated',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: deployment.project.organizationId,
        projectId: deployment.projectId,
        deploymentId: deployment.id,
        targetType: 'deployment',
        targetId: deployment.id,
        targetLabel: deployment.name,
        // Keys only, never values.
        metadata: {
          added: added.join(',') || null,
          removed: removed.join(',') || null,
          changed: changed.join(',') || null
        }
      });
    }

    return this.addInternalUrlsToDeployment(updatedDeployment);
  }

  /**
   * Update a deployment's build settings.
   *
   * Every field is optional and only applied when present, so a caller can
   * change one setting without restating the rest. The zero-config commands
   * additionally accept an explicit null, which clears the override and hands
   * the decision back to Railpack's own detection: that is a different
   * intent from "leave unchanged", hence the `in body` checks.
   */
  async updateDeploymentBuildConfig(
    deploymentId: string,
    body: {
      buildFromRoot?: boolean;
      buildWithDepot?: boolean;
      persistentBuildCache?: boolean;
      builderOverride?: 'firecracker' | 'kubernetes' | null;
      buildType?: 'dockerfile' | 'railpack';
      dockerfilePath?: string | null;
      dockerfileTarget?: string | null;
      rootDirectory?: string | null;
      framework?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      outputDirectory?: string | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployments');

    const { buildWithDepot, persistentBuildCache, buildFromRoot } = body;

    if (
      'builderOverride' in body &&
      body.builderOverride !== null &&
      !isBuilderOverride(body.builderOverride)
    ) {
      throw new BadRequestException('builderOverride must be "firecracker", "kubernetes" or null');
    }
    const changesSuperAdminFlags =
      (buildWithDepot !== undefined && buildWithDepot !== (deployment.buildWithDepot ?? false)) ||
      (persistentBuildCache !== undefined &&
        persistentBuildCache !== (deployment.persistentBuildCache ?? false));
    if (changesSuperAdminFlags && !(await this.authz.isUnrestrictedSuperAdmin(user.id))) {
      throw new ForbiddenException(
        'Super builds and persistent build cache are superadmin-only settings'
      );
    }
    if (buildWithDepot === true && !deployment.buildWithDepot && !process.env.DEPOT_TOKEN) {
      throw new BadRequestException(SUPER_BUILDS_UNAVAILABLE);
    }

    // Super builds cannot execute a Railpack plan, so refuse the combination
    // here rather than letting the next build fail inside the builder.
    const nextBuildType = body.buildType ?? deployment.buildType;
    const nextDepot = buildWithDepot ?? deployment.buildWithDepot ?? false;
    if (nextBuildType === 'railpack' && nextDepot) {
      throw new BadRequestException(
        "Super builds don't support automatic (Railpack) builds. Turn off super builds, or use a Dockerfile build."
      );
    }

    const rootDirectory =
      'rootDirectory' in body ? normalizeRootDirectory(body.rootDirectory) : undefined;
    if (
      'rootDirectory' in body &&
      body.rootDirectory &&
      rootDirectory === null &&
      body.rootDirectory.trim() !== ''
    ) {
      throw new BadRequestException(
        'Root directory must be a path inside the repository, without ".." segments.'
      );
    }

    /** Trim, and treat an emptied input as clearing the override. */
    const override = (key: keyof typeof body) =>
      key in body ? { [key]: (body[key] as string | null)?.trim() || null } : {};

    const nextDockerfilePath = override('dockerfilePath').dockerfilePath as
      | string
      | null
      | undefined;
    if (
      nextDockerfilePath &&
      (nextDockerfilePath.length > 500 ||
        nextDockerfilePath.startsWith('/') ||
        nextDockerfilePath.startsWith('\\') ||
        nextDockerfilePath.includes('..') ||
        nextDockerfilePath.includes('\0') ||
        !/^[A-Za-z0-9._/\- ]+$/.test(nextDockerfilePath))
    ) {
      throw new BadRequestException('Invalid Dockerfile path');
    }
    const nextDockerfileTarget = override('dockerfileTarget').dockerfileTarget as
      | string
      | null
      | undefined;
    if (nextDockerfileTarget && !DOCKERFILE_TARGET_RE.test(nextDockerfileTarget)) {
      throw new BadRequestException('Invalid Dockerfile target');
    }

    // The start command means two different things either side of a build-type
    // switch: a Railpack build bakes it into the image, everything else runs
    // it as the container's args, so a value carried across the switch would
    // start behaving differently without anyone touching it. Clear it, the
    // same way the Dockerfile path is cleared below, unless this same request
    // is also setting one.
    const buildTypeSwitched =
      body.buildType !== undefined && body.buildType !== deployment.buildType;
    const clearStartCommand = buildTypeSwitched && !('startCommand' in body);

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        ...(buildFromRoot !== undefined && { buildFromRoot }),
        ...(buildWithDepot !== undefined && { buildWithDepot }),
        ...(persistentBuildCache !== undefined && { persistentBuildCache }),
        ...('builderOverride' in body && { builderOverride: body.builderOverride ?? null }),
        ...(body.buildType !== undefined && { buildType: body.buildType }),
        // A Railpack build ignores the Dockerfile path, so clear a stale one on
        // switch; mirror the cross-nulling the create path already does.
        ...(nextBuildType === 'railpack' ? { dockerfilePath: null } : override('dockerfilePath')),
        // Same reasoning one line up: a Railpack build has no stages to target.
        ...(nextBuildType === 'railpack'
          ? { dockerfileTarget: null }
          : override('dockerfileTarget')),
        ...(rootDirectory !== undefined && { rootDirectory }),
        ...override('framework'),
        ...override('installCommand'),
        ...override('buildCommand'),
        ...(clearStartCommand ? { startCommand: null } : override('startCommand')),
        ...override('outputDirectory')
      }
    });

    // Outside Railpack the start command is a runtime setting, so it takes
    // effect on a rollout rather than waiting for the next build. Patching the
    // args changes the pod template, which rolls a new ReplicaSet on its own.
    const nextStartCommand = clearStartCommand
      ? null
      : 'startCommand' in body
        ? body.startCommand?.trim() || null
        : deployment.startCommand;
    if (
      nextStartCommand !== deployment.startCommand ||
      (buildTypeSwitched && nextBuildType !== 'railpack')
    ) {
      await this.k8sWorkload
        .updateDeploymentStartArgs(
          deployment.name,
          deployment.namespace,
          nextBuildType === 'railpack' ? null : resolveStartArgs(nextStartCommand)
        )
        .catch((error) => {
          // A deployment that has never built has no workload to patch yet;
          // the next build renders the args from the row either way.
          console.warn(
            `[Projects] Start command rollout skipped for ${deploymentId}: ${error.message}`
          );
        });
    }

    const changed = (key: string, before: unknown, after: unknown) =>
      after !== undefined && after !== before ? { [key]: [before, after] } : {};

    void this.audit.log({
      action: 'deployment.build_options.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        ...changed('buildFromRoot', deployment.buildFromRoot, buildFromRoot),
        ...changed('buildWithDepot', deployment.buildWithDepot, buildWithDepot),
        ...changed('persistentBuildCache', deployment.persistentBuildCache, persistentBuildCache),
        ...('builderOverride' in body
          ? changed('builderOverride', deployment.builderOverride, body.builderOverride ?? null)
          : {}),
        ...changed('buildType', deployment.buildType, body.buildType),
        ...changed('dockerfilePath', deployment.dockerfilePath, body.dockerfilePath),
        ...changed('dockerfileTarget', deployment.dockerfileTarget, body.dockerfileTarget),
        ...changed('rootDirectory', deployment.rootDirectory, rootDirectory),
        ...changed('installCommand', deployment.installCommand, body.installCommand),
        ...changed('buildCommand', deployment.buildCommand, body.buildCommand),
        ...changed('startCommand', deployment.startCommand, body.startCommand),
        ...changed('outputDirectory', deployment.outputDirectory, body.outputDirectory)
      }
    });

    return this.getDeployment(deploymentId);
  }

  async renameDeployment(
    deploymentId: string,
    name: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'rename deployments');

    const trimmed = String(name || '').trim();
    if (!trimmed) throw new BadRequestException('Name is required');
    if (trimmed.length > 255) throw new BadRequestException('Name is too long');

    // The internal name is frozen (it is baked into the k8s object names),
    // so a rename only touches displayName. Renaming back to the internal
    // name clears the override.
    const nextDisplayName = trimmed === deployment.name ? null : trimmed;

    if (nextDisplayName) {
      const conflict = await this.prisma.deployment.findFirst({
        where: {
          environmentId: deployment.environmentId,
          id: { not: deploymentId },
          OR: [{ name: nextDisplayName }, { displayName: nextDisplayName }]
        },
        select: { id: true }
      });
      if (conflict) {
        throw new BadRequestException('An app with this name already exists in this environment');
      }
    }

    const previousEffective = deployment.displayName ?? deployment.name;
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { displayName: nextDisplayName }
    });

    void this.audit.log({
      action: 'deployment.renamed',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: trimmed,
      metadata: { displayName: [previousEffective, trimmed] }
    });

    return this.getDeployment(deploymentId);
  }

  async updateDeploymentGitHubRepo(
    deploymentId: string,
    data: {
      repoUrl: string;
      branch: string;
      dockerfilePath?: string;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployments');

    if (!deployment.githubRepo) {
      throw new BadRequestException("This app wasn't created from GitHub");
    }

    let repoUrl = String(data.repoUrl || '').trim();
    if (repoUrl && !repoUrl.startsWith('http')) {
      repoUrl = `https://github.com/${repoUrl}`;
    }
    repoUrl = repoUrl.replace(/\.git$/, '');
    const branch = String(data.branch || '').trim();
    const dockerfilePath = String(data.dockerfilePath ?? deployment.dockerfilePath ?? '').trim();

    if (!repoUrl) {
      throw new BadRequestException('Repository URL is required');
    }

    if (!branch) {
      throw new BadRequestException('Branch is required');
    }

    // Same boundary checks as createDeploymentFromGitHub; DockerService
    // re-validates on clone as defence in depth.
    const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/;
    if (
      branch.length > 200 ||
      branch.startsWith('-') ||
      branch.includes('..') ||
      !GIT_REF_RE.test(branch)
    ) {
      throw new BadRequestException('Invalid branch name');
    }
    if (dockerfilePath) {
      if (
        dockerfilePath.length > 500 ||
        dockerfilePath.startsWith('/') ||
        dockerfilePath.startsWith('\\') ||
        dockerfilePath.includes('..') ||
        dockerfilePath.includes('\0') ||
        !/^[A-Za-z0-9._/\- ]+$/.test(dockerfilePath)
      ) {
        throw new BadRequestException('Invalid Dockerfile path');
      }
    }

    if (deployment.buildType === 'dockerfile' && !dockerfilePath) {
      throw new BadRequestException('Dockerfile path is required for Dockerfile builds');
    }

    // An app from a git provider moves only within that provider's host, and
    // only by the person whose token it clones with. Anything else would let
    // a project editor aim someone else's credential at a repository of
    // their choosing.
    if (deployment.gitConnectionId) {
      if (personalSourceSelectionRefused()) {
        throw new ForbiddenException(PERSONAL_CREDENTIAL_REFUSED);
      }
      const connection = await this.prisma.gitConnection.findUnique({
        where: { id: deployment.gitConnectionId },
        select: { id: true, name: true, baseUrl: true, userId: true }
      });
      if (!connection) {
        throw new BadRequestException(
          'The git provider this app was created from is gone. Create the app again from yours.'
        );
      }
      if (connection.userId !== user.id) {
        throw new ForbiddenException(
          `Only the person who linked ${connection.name} can change this app's repository`
        );
      }
      if (!this.gitConnections.repoPathFor(connection.baseUrl, repoUrl)) {
        throw new BadRequestException(
          `${connection.name} is for ${hostOf(connection.baseUrl)}. Use a repository on that host, or create a new app from another provider.`
        );
      }
      const moved = repoUrl !== deployment.githubRepo;
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          githubRepo: repoUrl,
          githubBranch: branch,
          dockerfilePath: dockerfilePath || null,
          externalRepoId: moved ? null : undefined,
          autoDeployBranch: deployment.autoDeployEnabled
            ? moved
              ? branch
              : deployment.autoDeployBranch
            : null,
          ...(moved
            ? {
                queuedCommitSha: null,
                queuedCommitMessage: null,
                queuedCommitAuthorName: null,
                queuedCommitAuthorUsername: null,
                queuedAt: null
              }
            : {})
        }
      });
      if (moved && deployment.autoDeployEnabled) {
        void this.gitConnections.registerWebhook(connection.id, repoUrl).catch(() => undefined);
      }
      void this.audit.log({
        action: 'deployment.github_repo.updated',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: deployment.project.organizationId,
        projectId: deployment.projectId,
        deploymentId,
        targetType: 'deployment',
        targetId: deploymentId,
        targetLabel: deployment.name,
        metadata: {
          provider: connection.name,
          githubRepo: [deployment.githubRepo, repoUrl],
          githubBranch: [deployment.githubBranch, branch]
        }
      });
      return this.getDeployment(deploymentId);
    }

    const parsed = this.githubService.parseRepoUrl(repoUrl);
    if (!parsed) {
      throw new BadRequestException("Couldn't read the repository URL");
    }
    const canAccess = await this.githubService.verifyUserCanAccessRepo(
      user.id,
      parsed.owner,
      parsed.repo
    );
    if (!canAccess) {
      const isPublic = await this.githubService.isRepoPublic(parsed.owner, parsed.repo);
      if (!isPublic) {
        throw new ForbiddenException(
          personalSourceSelectionRefused()
            ? PERSONAL_CREDENTIAL_REFUSED
            : "You don't have access to this repository on GitHub. Connect your GitHub account or request access."
        );
      }
    }

    const repoInstallation =
      canAccess && (await this.githubService.userMaintainsRepo(user.id, parsed.owner, parsed.repo))
        ? await this.githubService.findInstallationForRepo(parsed.owner, parsed.repo)
        : null;

    const repoChanged = repoUrl !== deployment.githubRepo;
    // Auto-deploy webhooks are matched on githubInstallationId, so it must be
    // re-pinned to the new repo's installation. If the app has no access to
    // the new repo, auto-deploy can't fire and gets disabled.
    const keepAutoDeploy = deployment.autoDeployEnabled && !!repoInstallation;
    let autoDeployBranch: string | null = null;
    if (keepAutoDeploy) {
      autoDeployBranch = repoChanged ? branch : deployment.autoDeployBranch;
    }

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        githubRepo: repoUrl,
        githubBranch: branch,
        dockerfilePath: dockerfilePath || null,
        githubInstallationId: repoInstallation?.installationId ?? null,
        autoDeployEnabled: keepAutoDeploy,
        autoDeployBranch,
        ...(repoChanged || canAccess ? { repoLinkedBy: user.id } : {}),
        ...(repoChanged
          ? {
              githubRepoId: null,
              pendingPush: Prisma.DbNull,
              queuedCommitSha: null,
              queuedCommitMessage: null,
              queuedCommitAuthorName: null,
              queuedCommitAuthorUsername: null,
              queuedAt: null
            }
          : {})
      }
    });

    void this.audit.log({
      action: 'deployment.github_repo.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        githubRepo: [deployment.githubRepo, repoUrl],
        githubBranch: [deployment.githubBranch, branch],
        ...(dockerfilePath !== (deployment.dockerfilePath ?? '')
          ? { dockerfilePath: [deployment.dockerfilePath, dockerfilePath || null] }
          : {}),
        ...(deployment.autoDeployEnabled && !keepAutoDeploy
          ? { autoDeployEnabled: [true, false] }
          : {})
      }
    });

    return this.getDeployment(deploymentId);
  }

  async updateDeploymentHealthCheck(
    deploymentId: string,
    healthCheck: {
      healthCheckEnabled: boolean;
      healthCheckType: string;
      healthCheckPath?: string;
      healthCheckPort?: number;
      healthCheckCommand?: string;
      livenessEnabled: boolean;
      readinessEnabled: boolean;
      startupEnabled: boolean;
      healthCheckInterval: number;
      healthCheckTimeout: number;
      healthCheckRetries: number;
      startupFailureThreshold: number;
      healthCheckOverride?: boolean;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    this.assertNotComposeManaged(deployment, 'Update health checks');

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployments');

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        healthCheckEnabled: healthCheck.healthCheckEnabled,
        healthCheckType: healthCheck.healthCheckType,
        healthCheckPath: healthCheck.healthCheckPath || null,
        healthCheckPort: healthCheck.healthCheckPort || null,
        healthCheckCommand: healthCheck.healthCheckCommand || null,
        livenessEnabled: healthCheck.livenessEnabled,
        readinessEnabled: healthCheck.readinessEnabled,
        startupEnabled: healthCheck.startupEnabled,
        healthCheckInterval: healthCheck.healthCheckInterval,
        healthCheckTimeout: healthCheck.healthCheckTimeout,
        healthCheckRetries: healthCheck.healthCheckRetries,
        startupFailureThreshold: healthCheck.startupFailureThreshold,
        healthCheckOverride: healthCheck.healthCheckOverride ?? false
      }
    });

    // Apply what the deployment resolves to, not what was posted: with the
    // override off, the Dockerfile's HEALTHCHECK is the live config and the
    // saved fields are only what an override would fall back to.
    const resolved = await this.resolveStoredHealthCheck(deploymentId);

    try {
      await this.k8sWorkload.updateDeploymentHealthCheck({
        namespace: deployment.namespace,
        deploymentName: deployment.name,
        enabled: resolved?.enabled ?? false,
        type: resolved?.type ?? healthCheck.healthCheckType,
        path: resolved?.path,
        port: resolved?.port,
        command: resolved?.command,
        execCommand: resolved?.execCommand,
        livenessEnabled: resolved?.livenessEnabled ?? false,
        readinessEnabled: resolved?.readinessEnabled ?? false,
        startupEnabled: resolved?.startupEnabled ?? false,
        interval: resolved?.interval ?? healthCheck.healthCheckInterval,
        timeout: resolved?.timeout ?? healthCheck.healthCheckTimeout,
        retries: resolved?.retries ?? healthCheck.healthCheckRetries,
        startupFailureThreshold:
          resolved?.startupFailureThreshold ?? healthCheck.startupFailureThreshold
      });
    } catch (error) {
      // Log but don't fail - the DB is updated, K8s will sync on next restart/rebuild
      console.error('Failed to apply health check to Kubernetes deployment:', error.message);
    }

    void this.audit.log({
      action: 'deployment.health_check.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        enabled: [deployment.healthCheckEnabled, healthCheck.healthCheckEnabled],
        type: [deployment.healthCheckType, healthCheck.healthCheckType],
        path: [deployment.healthCheckPath, healthCheck.healthCheckPath ?? null],
        override: [deployment.healthCheckOverride, healthCheck.healthCheckOverride ?? false]
      }
    });

    return this.getDeployment(deploymentId);
  }

  // Render path is the source of truth: any full (re)create of the workload
  // must re-apply the stored health-check config, otherwise the probes the
  // save button patched in get wiped on the next rebuild.
  private async loadHealthCheckOptions(
    deploymentId: string
  ): Promise<CreateDeploymentOptions['healthCheck'] | undefined> {
    const resolved = await this.resolveStoredHealthCheck(deploymentId);
    return resolved?.enabled ? resolved : undefined;
  }

  // Same contract as loadHealthCheckOptions: the render path owns the spec, so
  // every full (re)create re-reads the start command rather than trusting that
  // an earlier patch survives. Returns null for a Railpack build, where the
  // command is already baked into the image.
  async listReleases(deploymentId: string, limit: number, canEdit: boolean) {
    return this.releases.list(deploymentId, limit, canEdit);
  }

  async getReleaseVerdict(deploymentId: string, releaseId: string) {
    const row = await this.prisma.release.findFirst({
      where: { id: releaseId, deploymentId },
      select: { id: true, verdict: true, verdictAt: true, settledAt: true, promotedAt: true }
    });
    if (!row) throw new NotFoundException('Release not found');
    return {
      releaseId: row.id,
      verdict: row.verdict ?? null,
      at: row.verdictAt?.toISOString() ?? null,
      settledAt: row.settledAt?.toISOString() ?? null,
      pending: !row.verdict && !!row.promotedAt
    };
  }

  private async latestVerdict(deploymentId: string) {
    const row = await this.prisma.release.findFirst({
      where: { deploymentId, verdictAt: { not: null } },
      orderBy: { verdictAt: 'desc' },
      select: { id: true, imageHistoryId: true, verdict: true, verdictAt: true }
    });
    return row?.verdict
      ? {
          releaseId: row.id,
          imageHistoryId: row.imageHistoryId,
          at: row.verdictAt!.toISOString(),
          ...(row.verdict as object)
        }
      : null;
  }

  // What a rollout of this app is patched with besides the image. Shared by
  // the deploy path, rollback and the blue/green settle sweep so none of them
  // can leave the container with the image's own CMD and no probes.
  async rolloutInputs(deploymentId: string) {
    const [healthCheck, args] = await Promise.all([
      this.resolveStoredHealthCheck(deploymentId),
      this.loadStartArgs(deploymentId)
    ]);
    return { healthCheck, args };
  }

  private async appendBuildLog(deploymentId: string, line: string): Promise<void> {
    await this.prisma
      .$executeRaw`UPDATE "deployments" SET "build_logs" = COALESCE("build_logs", '') || ${`\n${line}`} WHERE "id" = ${deploymentId}::uuid`.catch(
      () => {}
    );
  }

  private async runBlueGreen(
    deploymentId: string,
    name: string,
    namespace: string,
    image: string,
    healthCheck: ResolvedHealthCheck | undefined,
    args: string[] | null,
    resources?: PodSizing
  ): Promise<void> {
    const result = await this.k8sWorkload.deployBlueGreen({
      deploymentName: name,
      namespace,
      image,
      healthCheck,
      args,
      resources,
      log: (line) => {
        this.appendBuildLog(deploymentId, line).catch(() => {});
      }
    });
    if (result.ok === false) {
      const { reason } = result;
      await this.releases.record(deploymentId, {
        image,
        strategy: 'blueGreen',
        status: 'failed',
        reason
      });
      throw new Error(`Deploy failed: ${reason}. The previous release kept serving.`);
    }
    if (!result.settled) {
      await this.appendBuildLog(
        deploymentId,
        'Green is serving; blue follows as soon as it settles'
      );
    }
  }

  private async limitsRestartPending(deployment: any): Promise<boolean> {
    try {
      return await this.quotasService.restartPending(deployment);
    } catch {
      return false;
    }
  }

  private async rolloutSizing(deploymentId: string): Promise<PodSizing | undefined> {
    const row = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { projectId: true, image: true, cpuRequestMilli: true, memoryRequestBytes: true }
    });
    return row ? this.quotasService.prepareRollout(row) : undefined;
  }

  private async loadStartArgs(deploymentId: string): Promise<string[] | null> {
    const row = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { buildType: true, startCommand: true }
    });
    return row ? startArgsFor(row) : null;
  }

  // What the deployment actually probes with: the Dockerfile's HEALTHCHECK
  // when the repo declares one, the stored configuration otherwise. Both the
  // render path and the settings save read it, so the two can never disagree.
  private async resolveStoredHealthCheck(
    deploymentId: string
  ): Promise<ResolvedHealthCheck | undefined> {
    const hc = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        healthCheckEnabled: true,
        healthCheckType: true,
        healthCheckPath: true,
        healthCheckPort: true,
        healthCheckCommand: true,
        livenessEnabled: true,
        readinessEnabled: true,
        startupEnabled: true,
        healthCheckInterval: true,
        healthCheckTimeout: true,
        healthCheckRetries: true,
        startupFailureThreshold: true,
        healthCheckOverride: true,
        dockerfileHealthCheck: true,
        services: { select: { port: true, targetPort: true }, take: 1 }
      }
    });
    if (!hc) return undefined;
    const service = hc.services[0];
    return resolveHealthCheck(hc, service?.targetPort ?? service?.port ?? null);
  }

  async updateDeploymentVolumes(
    deploymentId: string,
    volumes: {
      name: string;
      type: 'pvc' | 'hostPath' | 'emptyDir';
      mountPath: string;
      pvcName?: string;
      storageSize?: string;
      hostPath?: string;
      readOnly?: boolean;
    }[],
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    options?: { fromComposeStack?: boolean }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    if (!options?.fromComposeStack) this.assertNotComposeManaged(deployment, 'Update volumes');

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update deployments');

    if (Array.isArray(volumes) && volumes.some((v) => v && v.type === 'hostPath')) {
      void this.audit.log({
        action: 'deployment.volume.rejected',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: deployment.project.organizationId,
        projectId: deployment.projectId,
        deploymentId,
        targetType: 'deployment',
        targetId: deploymentId,
        targetLabel: deployment.name,
        metadata: { reason: 'hostPath_volume' }
      });
      throw new ForbiddenException("hostPath volumes aren't permitted");
    }

    const volumesList: {
      name: string;
      type: 'pvc' | 'hostPath' | 'emptyDir';
      mountPath: string;
      pvcName?: string | null;
      storageSize?: string | null;
      hostPath?: string | null;
      readOnly?: boolean;
    }[] = Array.isArray(volumes)
      ? volumes
          .filter((vol) => vol && vol.name && vol.mountPath)
          .map((vol) => {
            let volType: 'pvc' | 'hostPath' | 'emptyDir' = 'emptyDir';
            if (vol.type === 'pvc') volType = 'pvc';
            else if (vol.type === 'hostPath') volType = 'hostPath';
            return {
              name: vol.name.trim(),
              type: volType,
              mountPath: vol.mountPath.trim(),
              pvcName: vol.type === 'pvc' ? vol.pvcName?.trim() || vol.name.trim() : null,
              storageSize: vol.type === 'pvc' && vol.storageSize ? vol.storageSize.trim() : null,
              hostPath: vol.type === 'hostPath' && vol.hostPath ? vol.hostPath.trim() : null,
              readOnly: Boolean(vol.readOnly)
            };
          })
          .filter((vol) => {
            if (vol.type === 'pvc' && !vol.pvcName) return false;
            if (vol.type === 'hostPath' && !vol.hostPath) return false;
            return true;
          })
      : [];

    // Validate the values that flow into the PVC manifest and pod spec before
    // touching Kubernetes. The API rejects bad names/quantities with a 422 the
    // client library flattens into an opaque "HTTP request failed", so catching
    // them here is the only way the user gets an actionable message.
    const DNS1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
    for (const vol of volumesList) {
      if (!DNS1123.test(vol.name) || vol.name.length > 63) {
        throw new BadRequestException(
          `Volume name "${vol.name}" must be 1-63 lowercase letters, numbers, or hyphens`
        );
      }
      if (!vol.mountPath.startsWith('/')) {
        throw new BadRequestException(
          `Mount path "${vol.mountPath}" must be an absolute path starting with /`
        );
      }
      if (vol.type === 'pvc') {
        if (!DNS1123.test(vol.pvcName!) || vol.pvcName!.length > 63) {
          throw new BadRequestException(
            `Volume name "${vol.pvcName}" must be 1-63 lowercase letters, numbers, or hyphens`
          );
        }
        if (vol.storageSize) assertVolumeQuantity(vol.storageSize);
      }
    }

    const existingVolumes = await this.prisma.deploymentVolume.findMany({
      where: { deploymentId: deployment.id, type: 'pvc' }
    });
    const existingByClaim = new Map(existingVolumes.map((v) => [v.pvcName ?? v.name, v] as const));
    await this.assertVolumesUnclaimed(
      deployment.namespace,
      volumesList.filter((vol) => !existingByClaim.has(volumeClaim(vol))),
      [deployment.id]
    );
    for (const vol of volumesList) {
      if (vol.type !== 'pvc' || !vol.storageSize) continue;
      const previous = existingByClaim.get(vol.pvcName!);
      if (!previous) continue;
      const floor = [previous.observedCapacity, previous.storageSize].find((size) =>
        storageShrinks(size, vol.storageSize!)
      );
      if (floor) {
        throw new BadRequestException(
          `Storage can only be expanded, never shrunk: "${vol.pvcName}" is ${floor}, requested ${vol.storageSize}`
        );
      }
    }

    // Compute the effective strategy: PVC forces Recreate, otherwise keep
    // whatever the deployment was previously set to. The persisted
    // `deployStrategy` is also auto-reverted to rollingUpdate when the last
    // PVC is removed only if the user had it set explicitly; we conservatively
    // keep the existing value (the k8s patch will apply it).
    const hasPvcVolume = volumesList.some((v) => v.type === 'pvc');
    const effectiveStrategy: 'rollingUpdate' | 'recreate' = hasPvcVolume
      ? 'recreate'
      : (deployment.deployStrategy as 'rollingUpdate' | 'recreate');

    const updatedDeployment = await this.prisma.$transaction(async (tx) => {
      // Persist auto-Recreate when PVC was added, so the UI reflects reality.
      if (hasPvcVolume && deployment.deployStrategy !== 'recreate') {
        await tx.deployment.update({
          where: { id: deployment.id },
          data: { deployStrategy: 'recreate' }
        });
      }

      await tx.deploymentVolume.deleteMany({
        where: {
          deploymentId: deployment.id
        }
      });

      if (volumesList.length > 0) {
        await tx.deploymentVolume.createMany({
          data: volumesList.map((vol) => {
            const previous = vol.type === 'pvc' ? existingByClaim.get(vol.pvcName!) : undefined;
            return {
              deploymentId: deployment.id,
              name: vol.name,
              type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
              mountPath: vol.mountPath,
              pvcName: vol.pvcName,
              storageSize: vol.storageSize,
              hostPath: vol.hostPath,
              readOnly: vol.readOnly,
              observedCapacity: previous?.observedCapacity ?? null,
              phase: previous?.phase ?? null,
              resizeState: previous?.resizeState ?? null,
              resizeMessage: previous?.resizeMessage ?? null,
              observedAt: previous?.observedAt ?? null
            };
          })
        });
      }

      return tx.deployment.findUnique({
        where: { id: deployment.id },
        include: {
          project: {
            include: {
              organization: true
            }
          },
          pods: true,
          services: {
            include: {
              ports: true
            }
          },
          envVars: true,
          volumes: true,
          ingresses: {
            include: {
              service: true
            }
          }
        }
      });
    });

    // Pushed to the cluster only after the database has it, so a build that
    // finishes mid-call renders the new volumes rather than the old ones. If
    // this throws, the caller hears about it and the next rebuild reconciles
    // the cluster to what was stored, which is the right way round: losing the
    // patch is recoverable, losing the record is not.
    if (this.applyPipelineEnabled()) {
      await this.applyQueue.enqueue({
        dedupeKey: `op:deployment.volumes:${deploymentId}`,
        opType: 'deployment.volumes',
        deploymentId,
        requestedById: user.id
      });
    } else {
      const k8sExistsVol = await this.k8sWorkload
        .getKubernetesDeployment(deployment.name, deployment.namespace)
        .then((d) => d !== null);

      if (k8sExistsVol) {
        try {
          await this.k8sWorkload.updateDeploymentVolumes({
            namespace: deployment.namespace,
            deploymentName: deployment.name,
            volumes: volumesList,
            deployStrategy: effectiveStrategy
          });
          await this.prisma.deployment.updateMany({
            where: { id: deploymentId, applyStatus: 'error' },
            data: { applyStatus: 'synced', applyError: null }
          });
        } catch (error) {
          const body = error instanceof HttpException ? error.getResponse() : null;
          const message =
            (typeof body === 'object' && body && 'message' in body
              ? String((body as { message?: unknown }).message)
              : null) ??
            (error as Error)?.message ??
            'Storage update failed';
          await this.prisma.deployment
            .update({
              where: { id: deploymentId },
              data: { applyStatus: 'error', applyError: `Storage: ${message}` }
            })
            .catch(() => {});
          throw error;
        }
      }
    }

    void this.audit.log({
      action: 'deployment.volumes.updated',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        count: volumesList.length,
        names: volumesList.map((v) => v.name).join(',') || null
      }
    });

    return this.addInternalUrlsToDeployment(updatedDeployment);
  }

  async createDeploymentService(
    deploymentId: string,
    data: {
      name: string;
      ports: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        nodePort?: number;
      }[];
      exposePublic?: boolean;
      domain?: string | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        services: {
          include: {
            ports: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'manage services');

    const rawName = String(data.name || '').trim();
    if (!rawName) {
      throw new BadRequestException('Port name is required');
    }

    const normalizedName = formatSlug(rawName);
    if (!normalizedName) {
      throw new BadRequestException('Port name is invalid');
    }

    const existingServiceWithName = await this.prisma.service.findFirst({
      where: {
        name: normalizedName,
        deployment: {
          projectId: deployment.projectId
        }
      }
    });

    if (existingServiceWithName) {
      throw new BadRequestException('A port with this name already exists in this project');
    }
    await assertIngressNameFree(
      this.prisma,
      deployment.namespace,
      normalizedName,
      deployment.projectId
    );

    const portsPayload = this.normalizeServicePortInputs(data.ports, {
      requireAtLeastOne: true
    });

    const domainProvided = Object.hasOwn(data ?? {}, 'domain');
    let normalizedDomain: string | null = null;

    if (domainProvided) {
      const rawDomain =
        data.domain === null || data.domain === undefined
          ? ''
          : String(data.domain).trim().toLowerCase();

      if (!rawDomain) {
        normalizedDomain = null;
      } else if (!/^[a-z0-9.-]+$/.test(rawDomain)) {
        throw new BadRequestException('Domain can only contain letters, numbers, dots, or hyphens');
      } else if (rawDomain.length > 253) {
        throw new BadRequestException('Domain is too long');
      } else {
        normalizedDomain = rawDomain;
      }
    }

    const exposePublic = data.exposePublic === true;
    if (exposePublic) {
      await assertOrgCanExposeNodePort(this.prisma, deployment.project.organizationId);
    }
    const requestedType = exposePublic ? 'NodePort' : 'ClusterIP';
    const serviceType = exposePublic ? ServiceType.external : ServiceType.internal;

    const creationResult = await this.k8sNetwork.createDeploymentService({
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      serviceName: normalizedName,
      type: requestedType,
      ports: portsPayload
    });

    const resolvedPorts =
      creationResult.ports && creationResult.ports.length > 0 ? creationResult.ports : portsPayload;

    const primaryPort = resolvedPorts[0];

    await this.prisma.$transaction(async (tx) => {
      const serviceRecord = await tx.service.create({
        data: {
          deploymentId: deployment.id,
          name: normalizedName,
          type: serviceType,
          port: primaryPort.servicePort,
          targetPort: primaryPort.containerPort,
          protocol: primaryPort.protocol,
          nodePort: primaryPort.nodePort ?? null,
          externalIp: creationResult.externalIp ?? null,
          domain: normalizedDomain
        }
      });

      if (resolvedPorts.length > 0) {
        await tx.servicePort.createMany({
          data: resolvedPorts.map((port) => ({
            serviceId: serviceRecord.id,
            name: port.name,
            port: port.servicePort,
            targetPort: port.containerPort,
            protocol: port.protocol,
            nodePort: port.nodePort ?? null
          }))
        });
      }
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        }
      }
    });

    return this.addInternalUrlsToDeployment(result);
  }

  async updateServiceConfiguration(
    deploymentId: string,
    serviceId: string,
    changes: {
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        nodePort?: number;
      }[];
      domain?: string | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, deploymentId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true
              }
            }
          }
        },
        ports: true
      }
    });

    if (!service) {
      throw new NotFoundException(`Port ${serviceId} not found`);
    }

    await this.authz.requireProjectEdit(service.deployment.project.id, user.id, 'update services');

    const domainProvided = Object.hasOwn(changes ?? {}, 'domain');
    let normalizedDomain: string | null = null;

    if (domainProvided) {
      const rawDomain =
        changes.domain === null || changes.domain === undefined
          ? ''
          : String(changes.domain).trim().toLowerCase();

      if (!rawDomain) {
        normalizedDomain = null;
      } else if (!/^[a-z0-9.-]+$/.test(rawDomain)) {
        throw new BadRequestException('Domain can only contain letters, numbers, dots, or hyphens');
      } else if (rawDomain.length > 253) {
        throw new BadRequestException('Domain is too long');
      } else {
        normalizedDomain = rawDomain;
      }
    }

    let portsPayload:
      | {
          name?: string;
          containerPort?: number;
          servicePort?: number;
          protocol?: string;
          nodePort?: number;
        }[]
      | null = null;

    if (Array.isArray(changes?.ports)) {
      portsPayload = this.normalizeServicePortInputs(changes.ports, {
        requireAtLeastOne: true
      });
    }

    if (!domainProvided && portsPayload === null) {
      throw new BadRequestException('No changes to save');
    }

    let updateResult: {
      type: string;
      ports: {
        name: string;
        containerPort: number;
        servicePort: number;
        protocol: string;
        nodePort?: number;
      }[];
      externalIp: string | null;
    } | null = null;

    if (portsPayload) {
      await this.prisma.service.update({
        where: { id: service.id },
        data: { updatedAt: new Date() }
      });
      updateResult = await this.k8sNetwork.updateServicePorts({
        namespace: service.deployment.namespace,
        deploymentName: service.deployment.name,
        serviceName: service.name,
        ports: portsPayload
      });
    }

    let resolvedPorts;
    if (updateResult) {
      resolvedPorts = updateResult.ports.map((port) => ({
        name: port.name,
        servicePort: port.servicePort,
        containerPort: port.containerPort,
        protocol: port.protocol,
        nodePort: port.nodePort ?? null
      }));
    } else if (service.ports.length > 0) {
      resolvedPorts = service.ports.map((port) => ({
        name: port.name || `${service.name}`,
        servicePort: port.port,
        containerPort: port.targetPort,
        protocol: port.protocol,
        nodePort: port.nodePort ?? null
      }));
    } else {
      resolvedPorts = [
        {
          name: service.name,
          servicePort: service.port,
          containerPort: service.targetPort,
          protocol: service.protocol,
          nodePort: service.nodePort ?? null
        }
      ];
    }

    const primaryPort = resolvedPorts[0] || {
      name: service.name,
      servicePort: service.port,
      containerPort: service.targetPort,
      protocol: service.protocol,
      nodePort: service.nodePort ?? null
    };

    let resolvedType = service.type;
    if (updateResult) {
      resolvedType =
        updateResult.type === 'ClusterIP' ? ServiceType.internal : ServiceType.external;
    }

    const resolvedExternalIp =
      updateResult && Object.hasOwn(updateResult, 'externalIp')
        ? updateResult.externalIp
        : service.externalIp;

    const priorPublic = new Map<
      string,
      { publicEnabled: boolean; publicPort: number | null; targetPort: number; protocol: string }
    >();
    if (portsPayload) {
      for (const p of service.ports) {
        if (p.publicEnabled && p.publicPort) {
          const entry = {
            publicEnabled: true,
            publicPort: p.publicPort,
            targetPort: p.targetPort,
            protocol: p.protocol
          };
          priorPublic.set(publicKey({ port: p.port, protocol: p.protocol }), entry);
          if (p.name) priorPublic.set(publicKey(p), entry);
        }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.ServiceUpdateInput = {};

      if (portsPayload) {
        data.type = resolvedType;
        data.externalIp = resolvedExternalIp ?? null;
        data.port = primaryPort.servicePort;
        data.targetPort = primaryPort.containerPort;
        data.protocol = primaryPort.protocol;
        data.nodePort = primaryPort.nodePort ?? null;
      }

      if (domainProvided) {
        data.domain = normalizedDomain;
      }

      if (Object.keys(data).length > 0) {
        await tx.service.update({
          where: { id: service.id },
          data
        });
      }

      if (portsPayload) {
        await tx.servicePort.deleteMany({
          where: { serviceId: service.id }
        });

        if (resolvedPorts.length > 0) {
          await tx.servicePort.createMany({
            data: resolvedPorts.map((port) => {
              const prior =
                priorPublic.get(
                  publicKey({ name: port.name, port: port.servicePort, protocol: port.protocol })
                ) ??
                priorPublic.get(publicKey({ port: port.servicePort, protocol: port.protocol }));
              return {
                serviceId: service.id,
                name: port.name,
                port: port.servicePort,
                targetPort: port.containerPort,
                protocol: port.protocol,
                nodePort: port.nodePort,
                publicEnabled: prior ? prior.publicEnabled : false,
                publicPort: prior ? prior.publicPort : null
              };
            })
          });
        }
      }
    });

    if (portsPayload && priorPublic.size > 0) {
      const keptKeys = new Set(
        resolvedPorts.map((p) => `${p.servicePort}:${p.protocol.toUpperCase()}`)
      );
      for (const [key, prior] of priorPublic) {
        if (keptKeys.has(key)) {
          if (prior.publicPort) {
            const kept = resolvedPorts.find(
              (p) => `${p.servicePort}:${p.protocol.toUpperCase()}` === key
            );
            if (kept && kept.containerPort !== prior.targetPort) {
              try {
                const org = await this.prisma.organization.findUnique({
                  where: { id: service.deployment.project.organizationId }
                });
                const ip =
                  (org?.databasePublicIp || '').trim() || this.instanceConfig.defaultPublicIp();
                if (ip) {
                  await this.k8sNetwork.exposeDeploymentPortPublic({
                    namespace: service.deployment.namespace,
                    deploymentName: service.deployment.name,
                    loadBalancerIp: ip,
                    publicPort: prior.publicPort,
                    targetPort: kept.containerPort,
                    protocol: prior.protocol
                  });
                }
              } catch (e: any) {
                console.error(
                  `[Deployment/public] Failed to re-expose port on update: ${e?.message}`
                );
              }
            }
          }
        } else if (prior.publicPort) {
          try {
            await this.k8sNetwork.unexposeDeploymentPortPublic({
              namespace: service.deployment.namespace,
              deploymentName: service.deployment.name,
              publicPort: prior.publicPort,
              protocol: prior.protocol
            });
          } catch (e: any) {
            console.error(`[Deployment/public] Failed to unexpose removed port: ${e?.message}`);
          }
        }
      }
      await this.syncPublicDeploymentNetworkPolicy(
        service.deployment.namespace,
        service.deployment.name,
        service.deployment.id
      );
    }

    if (portsPayload) {
      await this.syncIngressesForService(service.id, deploymentId);
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        }
      }
    });
    void this.reapplyEnvForResource('deployment', deploymentId).catch(() => undefined);
    return this.addInternalUrlsToDeployment(result);
  }

  async deleteDeploymentService(
    deploymentId: string,
    serviceId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, deploymentId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true
              }
            },
            services: {
              include: {
                ports: true
              }
            }
          }
        },
        ports: true,
        ingresses: true
      }
    });

    if (!service) {
      throw new NotFoundException(`Port ${serviceId} not found`);
    }

    await this.authz.requireProjectEdit(service.deployment.project.id, user.id, 'update services');

    if (service.ingresses.length > 0) {
      throw new BadRequestException('Remove its domains before you remove this port');
    }

    const otherServices = service.deployment.services.filter((entry) => entry.id !== service.id);

    const remainingPortsInput: {
      name?: string;
      containerPort: number;
      servicePort: number;
      protocol: string;
      nodePort?: number;
    }[] = [];

    for (const entry of otherServices) {
      const servicePorts =
        entry.ports.length > 0
          ? entry.ports.map((port) => ({
              name: port.name || entry.name,
              containerPort: port.targetPort,
              servicePort: port.port,
              protocol: port.protocol,
              nodePort: port.nodePort ?? undefined
            }))
          : [
              {
                name: entry.name,
                containerPort: entry.targetPort,
                servicePort: entry.port,
                protocol: entry.protocol,
                nodePort: entry.nodePort ?? undefined
              }
            ];

      remainingPortsInput.push(...servicePorts);
    }

    for (const p of service.ports) {
      if (p.publicEnabled && p.publicPort) {
        try {
          await this.k8sNetwork.unexposeDeploymentPortPublic({
            namespace: service.deployment.namespace,
            deploymentName: service.deployment.name,
            publicPort: p.publicPort,
            protocol: p.protocol
          });
        } catch (e: any) {
          console.error(
            `[Deployment/public] Failed to unexpose port on service delete: ${e?.message}`
          );
        }
      }
    }

    await this.k8sNetwork.deleteDeploymentService({
      namespace: service.deployment.namespace,
      deploymentName: service.deployment.name,
      serviceName: service.name,
      remainingPorts: remainingPortsInput
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.servicePort.deleteMany({
        where: { serviceId: service.id }
      });

      await tx.service.delete({
        where: { id: service.id }
      });
    });

    await this.syncPublicDeploymentNetworkPolicy(
      service.deployment.namespace,
      service.deployment.name,
      service.deployment.id
    );

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        }
      }
    });
    return this.addInternalUrlsToDeployment(result);
  }

  async updateServiceExposure(
    deploymentId: string,
    serviceId: string,
    exposePublic: boolean,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const service = await this.prisma.service.findFirst({
      where: { id: serviceId, deploymentId },
      include: {
        deployment: {
          include: {
            project: {
              include: {
                organization: true
              }
            }
          }
        },
        ports: true
      }
    });

    if (!service) {
      throw new NotFoundException(`Port ${serviceId} not found`);
    }

    await this.authz.requireProjectEdit(service.deployment.project.id, user.id, 'update services');

    if (exposePublic && service.type !== 'external') {
      await assertOrgCanExposeNodePort(this.prisma, service.deployment.project.organizationId);
    }

    const desiredType = exposePublic ? 'NodePort' : 'ClusterIP';

    const exposureResult = await this.k8sNetwork.updateServiceExposure({
      namespace: service.deployment.namespace,
      serviceName: service.name,
      type: desiredType
    });

    const normalizedPorts =
      Array.isArray(exposureResult.ports) && exposureResult.ports.length > 0
        ? exposureResult.ports.map((port) => ({
            name: port.name,
            servicePort: port.servicePort,
            containerPort: port.containerPort,
            protocol: port.protocol,
            nodePort: port.nodePort !== undefined && port.nodePort !== null ? port.nodePort : null
          }))
        : service.ports.map((port) => ({
            name: port.name || `port-${port.port}`,
            servicePort: port.port,
            containerPort: port.targetPort,
            protocol: port.protocol,
            nodePort: port.nodePort ?? null
          }));

    const primaryPort = normalizedPorts[0] || {
      name: service.name,
      servicePort: service.port,
      containerPort: service.targetPort,
      protocol: service.protocol,
      nodePort: service.nodePort ?? null
    };

    const priorPublic = snapshotPublicPortState(service.ports);

    await this.prisma.$transaction(async (tx) => {
      await tx.service.update({
        where: { id: service.id },
        data: {
          type: exposePublic ? ServiceType.external : ServiceType.internal,
          externalIp: exposureResult.externalIp || null,
          port: primaryPort.servicePort,
          targetPort: primaryPort.containerPort,
          protocol: primaryPort.protocol,
          nodePort: primaryPort.nodePort
        }
      });

      await tx.servicePort.deleteMany({
        where: { serviceId: service.id }
      });

      if (normalizedPorts.length > 0) {
        await tx.servicePort.createMany({
          data: normalizedPorts.map((port) => {
            const prior = priorPublic.get(publicPortKey(port.servicePort, port.protocol));
            return {
              serviceId: service.id,
              name: port.name,
              port: port.servicePort,
              targetPort: port.containerPort,
              protocol: port.protocol,
              nodePort: port.nodePort,
              publicEnabled: prior ? prior.publicEnabled : false,
              publicPort: prior ? prior.publicPort : null
            };
          })
        });
      }
    });

    const keptKeys = new Set(
      normalizedPorts.map((port) => publicPortKey(port.servicePort, port.protocol))
    );
    for (const [key, prior] of priorPublic) {
      if (keptKeys.has(key) || !prior.publicPort) continue;
      try {
        await this.k8sNetwork.unexposeDeploymentPortPublic({
          namespace: service.deployment.namespace,
          deploymentName: service.deployment.name,
          publicPort: prior.publicPort,
          protocol: key.split(':')[1]
        });
      } catch (e: any) {
        console.error(`[Deployment/public] Failed to unexpose dropped port: ${e?.message}`);
      }
    }

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        }
      }
    });

    void this.audit.log({
      action: exposePublic ? 'service.exposure.enabled' : 'service.exposure.disabled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: service.deployment.project.organizationId,
      projectId: service.deployment.projectId,
      deploymentId,
      targetType: 'service',
      targetId: serviceId,
      targetLabel: service.name,
      metadata: { type: [service.type, exposePublic ? 'external' : 'internal'] }
    });

    return this.addInternalUrlsToDeployment(result);
  }

  async enableAutoDeploy(
    deploymentId: string,
    branch: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    paths?: string[]
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'configure auto-deploy');

    if (!deployment.githubRepo) {
      throw new BadRequestException("This app wasn't created from GitHub");
    }

    // A connection-sourced app is matched by its connection on the webhook
    // path, so it needs no GitHub App installation. The hook itself is put on
    // the forge here, best effort; the status endpoint says whether it took.
    let installation: { installationId: bigint } | null = null;
    let relinkedBy: string | null = null;
    let webhook: Awaited<ReturnType<GitConnectionsService['registerWebhook']>> | null = null;
    if (deployment.gitConnectionId) {
      webhook = await this.gitConnections.registerWebhook(
        deployment.gitConnectionId,
        deployment.githubRepo
      );
    }
    if (!deployment.gitConnectionId) {
      const repoInfo = this.githubService.parseRepoUrl(deployment.githubRepo);
      if (!repoInfo) {
        throw new BadRequestException('Invalid GitHub repository URL');
      }
      installation = await this.githubService.findInstallationForRepo(
        repoInfo.owner,
        repoInfo.repo
      );
      if (!installation) {
        throw new BadRequestException(
          this.githubService.autoDeployUnavailableMessage(repoInfo.owner, repoInfo.repo)
        );
      }
      if (deployment.githubInstallationId !== installation.installationId) {
        const maintains = await this.githubService.userMaintainsRepo(
          user.id,
          repoInfo.owner,
          repoInfo.repo
        );
        if (!maintains) {
          throw new ForbiddenException(
            'Auto-deploy needs write access to this repository on GitHub. Connect your GitHub account or request access.'
          );
        }
        relinkedBy = user.id;
      }
    }

    if (!branch || branch.length > 255 || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
      throw new BadRequestException('Invalid branch name');
    }

    const previousBranch = deployment.autoDeployBranch;
    const previouslyEnabled = deployment.autoDeployEnabled;
    const previousPaths = deployment.autoDeployPaths;

    let watchPaths: string[] | undefined;
    if (paths !== undefined) {
      watchPaths = normalizeWatchPaths(paths);
      if (watchPaths.length > MAX_WATCH_PATHS) {
        throw new BadRequestException(`At most ${MAX_WATCH_PATHS} watch paths are allowed`);
      }
      for (const path of watchPaths) {
        const problem = watchPathProblem(path);
        if (problem) {
          throw new BadRequestException(`${problem}: ${path.slice(0, 60)}`);
        }
      }
    }

    // Update the deployment with auto-deploy settings. Also pin the
    // installation id so subsequent webhook deliveries are bound to this
    // specific GitHub App installation (legacy rows whose
    // githubInstallationId is null are picked up here).
    const updated = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        autoDeployEnabled: true,
        autoDeployBranch: branch,
        githubInstallationId: installation?.installationId ?? null,
        ...(relinkedBy ? { repoLinkedBy: relinkedBy } : {}),
        ...(watchPaths !== undefined ? { autoDeployPaths: watchPaths } : {})
      },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        }
      }
    });

    void this.audit.log({
      action: 'deployment.autodeploy.enabled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        repo: deployment.githubRepo,
        branch: [previousBranch ?? null, branch],
        wasEnabled: previouslyEnabled,
        ...(watchPaths !== undefined ? { paths: [previousPaths, watchPaths] } : {})
      }
    });

    const enabledView = this.addInternalUrlsToDeployment(updated);
    return { ...enabledView, webhook };
  }

  async disableAutoDeploy(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'configure auto-deploy');

    const previousBranch = deployment.autoDeployBranch;
    const previouslyEnabled = deployment.autoDeployEnabled;

    const updated = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        autoDeployEnabled: false
      },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        }
      }
    });

    void this.audit.log({
      action: 'deployment.autodeploy.disabled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: {
        repo: deployment.githubRepo,
        branch: [previousBranch ?? null, null],
        wasEnabled: previouslyEnabled
      }
    });

    return this.addInternalUrlsToDeployment(updated);
  }

  async triggerAutoDeploy(
    deploymentId: string,
    commitSha: string,
    commitMessage: string,
    commitAuthorName?: string,
    commitAuthorUsername?: string,
    fromQueueRunId?: string
  ) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        envVars: true,
        volumes: true,
        services: {
          include: {
            ports: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    if (!deployment.githubRepo || !deployment.githubBranch) {
      throw new BadRequestException("This app wasn't created from GitHub");
    }

    if (!fromQueueRunId && deployment.stopped) {
      const held = await this.holdPush(deployment.id, {
        sha: commitSha,
        branch: deployment.autoDeployBranch || deployment.githubBranch,
        author: commitAuthorUsername || commitAuthorName || null,
        message: commitMessage || null
      });
      return { held: true, commitSha, count: held.count };
    }

    if (!fromQueueRunId) {
      await this.reconcileScoreAsCreator(deployment.id, deployment.createdBy);
    }

    if (!fromQueueRunId) {
      const { startNow } = await this.buildQueue.enqueue({
        deploymentId,
        triggerType: 'auto',
        commitSha,
        commitMessage,
        commitAuthorName,
        commitAuthorUsername,
        branch: deployment.autoDeployBranch || deployment.githubBranch
      });
      if (!startNow) {
        console.log(
          `[Projects] Queued auto-deploy for ${deploymentId} (commit ${commitSha?.substring(0, 7)})`
        );
        return { queued: true, commitSha };
      }
    }

    const repoInfo = deployment.gitConnectionId
      ? null
      : this.githubService.parseRepoUrl(deployment.githubRepo);

    // Find GitHub App installation for this repo (uses app token, not user token)
    let installationId: bigint | null = null;
    let checkRunId: number | null = null;
    let installationAccessToken: string | null = null;
    let logUrl: string | null = null;

    if (deployment.gitConnectionId) {
      installationAccessToken = await this.gitConnections.cloneTokenForDeployment(deploymentId);
    }

    if (repoInfo) {
      try {
        const access = await this.githubService.resolveCloneAccess({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          branch: deployment.autoDeployBranch || deployment.githubBranch,
          boundInstallationId: deployment.githubInstallationId,
          linkedBy: deployment.repoLinkedBy ?? deployment.createdBy
        });
        if (access) {
          installationId = access.installationId;
          installationAccessToken = access.token;
          if (deployment.githubInstallationId !== installationId) {
            await this.prisma.deployment.update({
              where: { id: deploymentId },
              data: { githubInstallationId: installationId }
            });
          }

          const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
          const orgSlug = deployment.project?.organization?.slug;
          logUrl = orgSlug
            ? `${frontendUrl}/${orgSlug}/deployments/${deploymentId}/progress`
            : `${frontendUrl}/deployments/${deploymentId}/progress`;

          // Create a GitHub Check Run (appears under "Checks" on the commit, authored by the app)
          const checkRun = await this.githubService.createCheckRun(
            installationId,
            repoInfo.owner,
            repoInfo.repo,
            {
              name: 'Orchard Deployment',
              headSha: commitSha,
              status: 'in_progress',
              detailsUrl: logUrl,
              externalId: deploymentId,
              output: {
                title: 'Building...',
                summary: `Deploying \`${deployment.name}\` from commit \`${commitSha.substring(0, 7)}\``,
                text: `**Commit:** ${commitMessage.split('\n')[0]}\n\n**Branch:** ${deployment.autoDeployBranch || deployment.githubBranch}\n\n---\n\nBuilding...`
              }
            }
          );

          checkRunId = checkRun.id;
          console.log(
            `[Projects] Created GitHub check run ${checkRunId} for deployment ${deploymentId}`
          );
          await this.buildQueue.attachGitHubContext(deploymentId, {
            checkRunId,
            installationId,
            repoFullName: `${repoInfo.owner}/${repoInfo.repo}`
          });

          // Also create a GitHub Deployment (appears under "Deployments" section)
          try {
            const ghDeployment = await this.githubService.createGitHubDeploymentWithApp(
              installationId,
              repoInfo.owner,
              repoInfo.repo,
              commitSha,
              deployment.name,
              `Deploying ${deployment.name} from commit ${commitSha.substring(0, 7)}`
            );

            await this.githubService.updateDeploymentStatusWithApp(
              installationId,
              repoInfo.owner,
              repoInfo.repo,
              ghDeployment.id,
              'in_progress',
              { logUrl, description: 'Building...' }
            );

            await this.prisma.gitHubDeployment.create({
              data: {
                deploymentId,
                githubDeploymentId: BigInt(ghDeployment.id),
                owner: repoInfo.owner,
                repo: repoInfo.repo,
                ref: deployment.autoDeployBranch || deployment.githubBranch,
                commitSha,
                environment: deployment.name,
                status: 'in_progress',
                logUrl
              }
            });

            console.log(
              `[Projects] Created GitHub deployment ${ghDeployment.id} for ${deploymentId}`
            );
          } catch (ghErr) {
            console.error(`[Projects] Failed to create GitHub deployment: ${ghErr.message}`);
          }
        }
      } catch (err) {
        console.error(`[Projects] Failed to create GitHub check run: ${err.message}`);
      }
    }

    // Reset build status to building. Clear any queued commit: this build is
    // starting now, so a commit that was parked for "next build" is being
    // consumed here (or a fresh push is taking priority).
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        buildStatus: 'building',
        buildStepTimestamps: { __start: Date.now() },
        buildLogs: `Auto-deploy triggered by push to ${deployment.autoDeployBranch || deployment.githubBranch}\nCommit: ${commitSha?.substring(0, 7)} - ${commitMessage.split('\n')[0]}\n\n`,
        buildError: null,
        queuedCommitSha: null,
        queuedCommitMessage: null,
        queuedCommitAuthorName: null,
        queuedCommitAuthorUsername: null,
        queuedAt: null
      }
    });

    const imageParts = deployment.image?.split('/') || [];
    const imageNameWithTag =
      imageParts[imageParts.length - 1] || `${deployment.project.namespace}-${deployment.name}`;
    const [imageName] = imageNameWithTag.split(':');

    const uniqueTag = newImageTag();

    const service = deployment.services[0];
    const rawPorts =
      service?.ports.map((port) => ({
        name: port.name,
        containerPort: port.targetPort,
        servicePort: port.port,
        protocol: port.protocol,
        nodePort: port.nodePort || undefined
      })) || [];

    const { resolved: env } = resolveEnvVars(
      deployment.envVars.map((ev) => this.crypto.maybeDecrypt(ev)),
      await this.loadSharedVarsForDeployment(deployment.id, deployment.environmentId),
      await this.resourceBindings.valuesFor(deployment.id)
    );

    const volumes = (deployment.volumes || []).map((vol) => ({
      name: vol.name,
      type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
      mountPath: vol.mountPath,
      pvcName: vol.pvcName || undefined,
      storageSize: vol.storageSize || undefined,
      hostPath: vol.hostPath || undefined,
      readOnly: vol.readOnly
    }));

    // Start build process with GitHub check run info
    this.buildAndDeployAsync(
      deploymentId,
      {
        repoUrl: deployment.githubRepo,
        branch: deployment.autoDeployBranch || deployment.githubBranch,
        dockerfilePath: deployment.dockerfilePath,
        buildFromRoot: deployment.buildFromRoot ?? false,
        buildWithDepot: deployment.buildWithDepot ?? false,
        persistentBuildCache: deployment.persistentBuildCache ?? false,
        buildType: deployment.buildType as 'dockerfile' | 'railpack',
        target: deployment.dockerfileTarget ?? undefined,
        imageName,
        tag: uniqueTag,
        namespace: deployment.namespace,
        name: deployment.name,
        replicas: deployment.replicas,
        rawPorts,
        env,
        exposePublic: service?.type === 'external',
        volumes,
        isRebuild: true,
        commitSha,
        commitMessage: commitMessage.split('\n')[0],
        commitAuthorName,
        commitAuthorUsername,
        // GitHub Check Run info (uses App, not user)
        checkRunId,
        checkLogUrl: logUrl,
        installationId: installationId ? installationId.toString() : null,
        repoInfo,
        triggerType: 'auto'
      },
      installationAccessToken // Use GitHub App installation token for cloning
    ).catch((error) => {
      console.error(`[Projects] Auto-deploy failed for deployment ${deploymentId}:`, error);
    });
  }

  private async assertResourceRequest(
    data: { cpuRequestMilli?: number | null; memoryRequestBytes?: number | null },
    userId?: string
  ) {
    for (const value of [data.cpuRequestMilli, data.memoryRequestBytes]) {
      if (value != null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new BadRequestException('Resource requests must be whole, non-negative numbers');
      }
    }
    if (
      data.cpuRequestMilli === 0 &&
      (data.memoryRequestBytes === 0 || data.memoryRequestBytes == null) &&
      userId &&
      !(await this.authz.isUnrestrictedSuperAdmin(userId))
    ) {
      throw new ForbiddenException('Only a superadmin can run an app without resource limits');
    }
  }

  async listBuildRuns(deploymentId: string, limit = 20) {
    const runs = await this.prisma.buildRun.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      include: { triggeredBy: { select: { username: true, imageUrl: true } } }
    });
    return runs.map((r) => ({
      id: r.id,
      status: r.status,
      triggerType: r.triggerType,
      commitSha: r.commitSha,
      commitMessage: r.commitMessage,
      commitAuthorUsername: r.commitAuthorUsername ?? r.triggeredBy?.username ?? null,
      branch: r.branch,
      detail: r.detail,
      scheduledAt: r.scheduledAt,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      createdAt: r.createdAt
    }));
  }

  async getBuildRunLogs(deploymentId: string, runId: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
      throw new NotFoundException(`Build run ${runId} not found`);
    }
    const run = await this.prisma.buildRun.findFirst({
      where: { id: runId, deploymentId },
      select: { logs: true, status: true }
    });
    if (!run) {
      throw new NotFoundException(`Build run ${runId} not found`);
    }
    if (run.logs !== null) {
      return { logs: run.logs, live: false };
    }
    if (run.status === 'building') {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { buildLogs: true }
      });
      return { logs: deployment?.buildLogs ?? null, live: true };
    }
    return { logs: null, live: false };
  }

  async getAutoDeployStatus(deploymentId: string, clerkId: string) {
    await this.access.assertDeploymentView(deploymentId, clerkId);
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        autoDeployEnabled: true,
        autoDeployBranch: true,
        autoDeployPaths: true,
        githubRepo: true,
        githubBranch: true,
        githubInstallationId: true,
        gitConnection: {
          select: { id: true, name: true, provider: true, baseUrl: true, userId: true }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    // Check if GitHub App has access to this repo
    if (deployment.gitConnection) {
      const me = await this.usersService.findOrCreateByClerkId(clerkId);
      const hookPresent = deployment.githubRepo
        ? await this.gitConnections.webhookPresent(
            deployment.gitConnection.id,
            deployment.githubRepo
          )
        : null;
      const canRegister = deployment.gitConnection.provider !== 'generic';
      let message: string | null = null;
      if (deployment.autoDeployEnabled && hookPresent === false) {
        message = `${deployment.gitConnection.name} has no webhook for this app yet. Turn auto-deploy off and on to add it, or add it by hand.`;
      } else if (deployment.autoDeployEnabled && !canRegister) {
        message = `Add the webhook on ${hostOf(deployment.gitConnection.baseUrl)} by hand; pushes can't reach Orchard until it exists.`;
      }
      return {
        enabled: deployment.autoDeployEnabled,
        branch: deployment.autoDeployBranch || deployment.githubBranch,
        paths: deployment.autoDeployPaths ?? [],
        appInstalled: true,
        linked: true,
        deliverable: deployment.autoDeployEnabled && hookPresent !== false,
        message,
        provider: {
          id: deployment.gitConnection.id,
          name: deployment.gitConnection.name,
          kind: deployment.gitConnection.provider,
          host: hostOf(deployment.gitConnection.baseUrl),
          webhookUrl: this.gitConnections.webhookUrlFor(deployment.gitConnection.id),
          hookPresent,
          canRegister,
          ownedByMe: Boolean(me && me.id === deployment.gitConnection.userId)
        }
      };
    }

    let appInstalled = false;
    if (deployment.githubRepo) {
      const repoInfo = this.githubService.parseRepoUrl(deployment.githubRepo);
      if (repoInfo) {
        try {
          const installation = await this.githubService.findInstallationForRepo(
            repoInfo.owner,
            repoInfo.repo
          );
          appInstalled = !!installation;
        } catch {
          appInstalled = false;
        }
      }
    }

    // Whether a push can actually reach THIS deployment, which is a different
    // question from whether the App can see the repo. The webhook binds a push
    // to the installation pinned on the row, so a row with no installation (or
    // one pointing at an installation that has since been removed or
    // suspended) is silently inert: the App is installed, the repo is right,
    // the branch matches, and nothing ever fires.
    const linked = deployment.githubInstallationId
      ? (await this.prisma.gitHubAppInstallation.count({
          where: { installationId: deployment.githubInstallationId, suspendedAt: null }
        })) > 0
      : false;

    // Two booleans are a puzzle to anything that is not the UI that knows what
    // they mean. `deliverable` is the answer to the only question a caller
    // actually has: will a push to this branch build anything?
    const deliverable = deployment.autoDeployEnabled && appInstalled && linked;
    let message: string | null = null;
    if (deployment.autoDeployEnabled && !appInstalled) {
      const repoInfo = deployment.githubRepo
        ? this.githubService.parseRepoUrl(deployment.githubRepo)
        : null;
      message = repoInfo
        ? this.githubService.autoDeployUnavailableMessage(repoInfo.owner, repoInfo.repo)
        : "The GitHub App isn't installed on this repository, so pushes can't reach Orchard.";
    } else if (deployment.autoDeployEnabled && !linked) {
      message =
        "This app isn't linked to a GitHub App installation, so Orchard drops pushes. " +
        'Turn auto-deploy off and on to link it.';
    }

    return {
      enabled: deployment.autoDeployEnabled,
      branch: deployment.autoDeployBranch || deployment.githubBranch,
      paths: deployment.autoDeployPaths ?? [],
      appInstalled,
      linked,
      deliverable,
      message,
      provider: null
    };
  }

  async getGitHubDeployments(deploymentId: string, clerkId: string) {
    await this.access.assertDeploymentView(deploymentId, clerkId);
    return this.prisma.gitHubDeployment.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
  }

  private async pickFreePublicDeploymentPort(ip: string): Promise<number> {
    const dbPortsRaw = await this.prisma.database.findMany({
      where: { publicIp: ip, publicPort: { not: null } },
      select: { publicPort: true }
    });
    const svcPortsRaw = await this.prisma.servicePort.findMany({
      where: { publicEnabled: true, publicPort: { not: null } },
      select: { publicPort: true }
    });
    const taken = new Set<number>();
    for (const r of dbPortsRaw) if (typeof r.publicPort === 'number') taken.add(r.publicPort);
    for (const r of svcPortsRaw) if (typeof r.publicPort === 'number') taken.add(r.publicPort);

    try {
      const live = await this.k8sNetwork.listInUsePortsOnIp(ip);
      for (const p of live) taken.add(p);
    } catch (e: any) {
      console.error(`[Deployment/public] Failed to list in-use ports on ${ip}: ${e?.message}`);
    }

    const MIN = 30000;
    const MAX = 32767;
    for (let i = 0; i < 200; i++) {
      const port = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
      if (!taken.has(port)) return port;
    }
    throw new BadRequestException("Couldn't find a free public port after 200 attempts");
  }

  private async syncPublicDeploymentNetworkPolicy(
    namespace: string,
    deploymentName: string,
    deploymentId: string
  ) {
    const publicPorts = await this.prisma.servicePort.findMany({
      where: {
        publicEnabled: true,
        service: { deploymentId }
      },
      select: { targetPort: true, protocol: true }
    });
    try {
      await this.k8sNetwork.upsertPublicDeploymentNetworkPolicy(
        namespace,
        deploymentName,
        publicDeploymentPorts(publicPorts)
      );
    } catch (e: any) {
      console.error(`[Deployment/public] Failed to sync NetworkPolicy: ${e?.message}`);
    }
  }

  async enableServicePortPublic(
    deploymentId: string,
    serviceId: string,
    portId: string,
    clerkId: string,
    userData?: any
  ) {
    const { user, port, deployment } = await this.access.assertServicePortEditor(
      deploymentId,
      serviceId,
      portId,
      clerkId,
      userData
    );

    const org = await this.prisma.organization.findUnique({
      where: { id: deployment.project.organizationId }
    });
    const ip = (org?.databasePublicIp || '').trim() || this.instanceConfig.defaultPublicIp();
    if (!ip) {
      if (process.env.INSTALL_INGRESS_MODE === 'tunnel') {
        throw new BadRequestException(
          'A Cloudflare Tunnel carries HTTP only, so an app cannot have a public port on this instance.'
        );
      }
      throw new BadRequestException(
        'No public IP is configured. Set one in organization settings, or ask an instance admin to set an instance-wide default.'
      );
    }

    if (port.publicEnabled && port.publicPort) {
      const host = this.k8sNetwork.publicDeploymentBaseDomain();
      return { enabled: true, host, ip, port: port.publicPort, protocol: port.protocol };
    }

    await assertOrgCanExposePublicPort(this.prisma, deployment.project.organizationId);

    const publicPort = await this.pickFreePublicDeploymentPort(ip);

    await this.k8sNetwork.exposeDeploymentPortPublic({
      namespace: deployment.namespace,
      deploymentName: deployment.name,
      loadBalancerIp: ip,
      publicPort,
      targetPort: port.targetPort,
      protocol: port.protocol
    });

    await this.prisma.servicePort.update({
      where: { id: port.id },
      data: { publicEnabled: true, publicPort }
    });

    await this.syncPublicDeploymentNetworkPolicy(
      deployment.namespace,
      deployment.name,
      deployment.id
    );

    void this.audit.log({
      action: 'service.port.public_enabled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId: deployment.id,
      targetType: 'service_port',
      targetId: port.id,
      targetLabel: `${deployment.name}:${port.targetPort}`,
      metadata: { publicPort, protocol: port.protocol, ip }
    });

    const host = this.k8sNetwork.publicDeploymentBaseDomain();
    return { enabled: true, host, ip, port: publicPort, protocol: port.protocol };
  }

  async disableServicePortPublic(
    deploymentId: string,
    serviceId: string,
    portId: string,
    clerkId: string,
    userData?: any
  ) {
    const { user, port, deployment } = await this.access.assertServicePortEditor(
      deploymentId,
      serviceId,
      portId,
      clerkId,
      userData
    );
    const previousPublicPort = port.publicPort;

    if (port.publicEnabled && port.publicPort) {
      try {
        await this.k8sNetwork.unexposeDeploymentPortPublic({
          namespace: deployment.namespace,
          deploymentName: deployment.name,
          publicPort: port.publicPort,
          protocol: port.protocol
        });
      } catch (e: any) {
        console.error(`[Deployment/public] Failed to delete public Service: ${e?.message}`);
      }
    }

    await this.prisma.servicePort.update({
      where: { id: port.id },
      data: { publicEnabled: false, publicPort: null }
    });

    await this.syncPublicDeploymentNetworkPolicy(
      deployment.namespace,
      deployment.name,
      deployment.id
    );

    void this.audit.log({
      action: 'service.port.public_disabled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId: deployment.id,
      targetType: 'service_port',
      targetId: port.id,
      targetLabel: `${deployment.name}:${port.targetPort}`,
      metadata: { previousPublicPort, protocol: port.protocol }
    });

    return { enabled: false };
  }

  /** Load the shared vars of a deployment's environment (empty if none). */
  async loadSharedVarsForDeployment(
    deploymentId: string,
    environmentId: string | null
  ): Promise<EnvVar[]> {
    if (!environmentId) return [];
    const vars = await this.prisma.environmentSharedVar.findMany({
      where: { environmentId },
      select: { key: true, value: true, secret: true }
    });
    // Secret values are stored encrypted at rest: decrypt before they feed the
    // resolver so plaintext reaches the pod/build.
    return vars.map((v) => this.crypto.maybeDecrypt(v));
  }

  /**
   * A deployment's own variables with secret values back in plaintext. Only
   * things that hand a value to the cluster or the builder may call this: a
   * response reaches a client, and a secret that reaches a client is one that
   * was never write-only in the first place.
   */
  async readOwnEnvVars(
    deploymentId: string
  ): Promise<{ key: string; value: string; secret: boolean }[]> {
    const own = await this.prisma.deploymentEnvVar.findMany({
      where: { deploymentId },
      select: { key: true, value: true, secret: true }
    });
    return own.map((v) => this.crypto.maybeDecrypt(v));
  }

  /**
   * Load a deployment's own env vars + its environment's shared vars, resolve
   * ${{shared.KEY}} references, and return the injectable list. Used by both
   * the runtime (pod env) and build (build args) paths so they never diverge.
   */
  async loadResolvedEnvForDeployment(
    deploymentId: string,
    environmentId: string | null
  ): Promise<{ resolved: EnvVar[]; errors: { key: string; missingRef: string }[] }> {
    const own = await this.readOwnEnvVars(deploymentId);
    const shared = await this.loadSharedVarsForDeployment(deploymentId, environmentId);
    const resources = await this.resourceBindings.valuesFor(deploymentId);
    return resolveEnvVars(own, shared, resources);
  }

  /**
   * A secret value is write-only: it goes into the deployment's Kubernetes
   * Secret and is never handed back, so nobody can read out a key they were
   * only ever meant to set. Applied on the way out rather than on the way in,
   * because the same rows feed the pod spec and the builder in plaintext.
   */
  static redactSecretEnv<
    T extends { envVars?: { value: string | null; secret?: boolean }[] | null }
  >(d: T): T {
    if (!d?.envVars) return d;
    return {
      ...d,
      envVars: d.envVars.map((ev) => (ev.secret ? { ...ev, value: null } : ev))
    };
  }

  scrubDeploymentForViewer<
    T extends {
      envVars?: { key: string; value: string | null }[] | null;
      buildLogs?: string | null;
      buildError?: string | null;
      ingresses?: any[] | null;
    }
  >(d: T): T {
    return {
      ...d,
      envVars: d.envVars ? d.envVars.map((ev) => ({ ...ev, value: null })) : d.envVars,
      ingresses: d.ingresses ? d.ingresses.map((ing) => scrubIngress(ing)) : d.ingresses,
      buildLogs: null,
      buildError: null
    } as T;
  }

  /**
   * Nullify member emails (project + adder) when the requester is a viewer.
   */
  private scrubMembersForViewer<
    M extends {
      user?: { email?: string | null } | null;
      adder?: { email?: string | null } | null;
    }
  >(members: M[] | null | undefined): M[] {
    if (!members) return [] as M[];
    return members.map((m) => ({
      ...m,
      user: m.user ? { ...m.user, email: null } : m.user,
      adder: m.adder ? { ...m.adder, email: null } : m.adder
    }));
  }

  // Assign/clear a deployment's node pool (or superadmin raw override). Persists
  // only; the new placement lands on the next deploy/rebuild since scheduling
  // changes require pod recreation.
  async updateDeploymentPlacement(
    deploymentId: string,
    data: { nodePoolId?: string | null; placementOverride?: unknown },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true }
    });
    if (!deployment) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    await this.authz.requireProjectEdit(
      deployment.project.id,
      user.id,
      'update deployment placement'
    );
    await this.nodesService.assertPoolAssignable({
      nodePoolId: data.nodePoolId,
      placementOverride: data.placementOverride,
      userId: user.id
    });
    const placed = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        nodePoolId: data.nodePoolId ?? null,
        placementOverride: (data.placementOverride ?? Prisma.DbNull) as
          | Prisma.InputJsonValue
          | typeof Prisma.DbNull
      }
    });
    this.auditDeploymentChange(deployment, 'deployment.placement.updated', user.id, {
      nodePoolId: [deployment.nodePoolId ?? null, data.nodePoolId ?? null],
      override: data.placementOverride != null
    });
    return placed;
  }

  async resolvePlacementForProject(projectId: string): Promise<{
    allowedNodes: string[] | null;
    deniedNodes: string[];
  }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true }
    });
    if (!project) return { allowedNodes: null, deniedNodes: [] };
    const placement = await this.nodesService.getPlacementForOrg(project.organizationId);
    return { allowedNodes: placement.allowedNodes, deniedNodes: placement.deniedNodes };
  }

  assertNotComposeManaged(
    deployment: { composeStackId?: string | null } | null | undefined,
    action: string,
    hint?: string
  ) {
    if (deployment?.composeStackId) {
      throw new BadRequestException(
        `A compose file manages this app. ${action} from its compose stack.${hint ? ` ${hint}` : ''}`
      );
    }
  }

  async fetchMirroredPods(deploymentIds: string[]) {
    if (deploymentIds.length === 0) return [];
    const objects = await this.prisma.k8sObject.findMany({
      where: { kind: 'Pod', deploymentId: { in: deploymentIds } },
      select: { deploymentId: true, manifest: true }
    });
    return objects.map((o) => ({
      deploymentId: o.deploymentId as string,
      ...podRecord(o.manifest as any),
      cpuUsage: null,
      memoryUsage: null
    }));
  }

  // Deliberately derived from CURRENT container state, not from k8s Event
  // history: Kubernetes keeps warning events for about an hour after the
  // condition clears, so a pod that briefly failed to schedule would keep the
  // alert banner lit long after it went ready.
  //
  // The event history is not lost, it just belongs somewhere else. Pods carry
  // their real Warning events (k8s-workload.service.ts#getPodEvents) and the
  // Events tab in ObserveTab renders them. Banner is now, Events is history.
  synthesizePodWarnings(pods: { name: string; status: string; containers?: any[] }[]) {
    return pods
      .filter((pod) => pod.status === 'crashing')
      .map((pod) => {
        const reason = pod.containers?.find((c) => c.lastTermination?.reason)?.lastTermination
          ?.reason;
        return {
          podName: pod.name,
          message: reason
            ? `Back-off restarting failed container (${reason})`
            : 'Back-off restarting failed container'
        };
      });
  }

  formatLivePods(pods: any[] = []) {
    return pods.map((pod) => ({
      id: pod.name,
      name: pod.name,
      status: pod.status,
      ip: pod.podIp,
      podIp: pod.podIp,
      nodeName: pod.nodeName,
      revision: pod.revision ?? null,
      restartCount: typeof pod.restartCount === 'number' ? pod.restartCount : 0,
      startTime: pod.createdAt,
      createdAt: pod.createdAt,
      cpuUsage: pod.cpuUsage ?? null,
      memoryUsage: pod.memoryUsage ?? null,
      events: pod.events ?? [],
      ...(pod.facts ?? {}),
      containers:
        pod.facts?.containers ??
        pod.containers?.map((container) => ({
          name: container.name,
          image: container.image,
          ready: container.ready ?? false,
          restartCount: typeof container.restartCount === 'number' ? container.restartCount : 0,
          lastTermination: container.lastTerminationReason
            ? {
                reason: container.lastTerminationReason,
                exitCode: container.lastExitCode ?? null,
                finishedAt: container.lastTerminatedAt ?? null
              }
            : null
        })) ??
        []
    }));
  }

  /**
   * Compute the runtime deployment status from Kubernetes state.
   * Possible values: 'running' | 'restarting' | 'scaling' | 'failed' | 'stopped' | 'unhealthy' | 'pending'
   */
  async computeDeploymentStatus(
    deployment: any,
    prefetched?: { pods: any[]; warnings: any[] }
  ): Promise<string> {
    if (deployment.stopped || deployment.replicas === 0) {
      return 'stopped';
    }

    if (!deployment.name || !deployment.namespace) {
      return deployment.status;
    }

    try {
      let pods: any[];
      let warnings: any[];
      if (prefetched) {
        pods = prefetched.pods ?? [];
        warnings = prefetched.warnings ?? [];
      } else {
        pods = deployment.id ? await this.fetchMirroredPods([deployment.id]) : [];
        warnings = [];
      }

      const readyPods = pods?.filter((pod: any) => pod.status?.toLowerCase() === 'ready') ?? [];
      const allPods = (pods ?? []).filter((pod: any) => pod.status?.toLowerCase() !== 'succeeded');
      // A pod on its way out is not a replica the deployment has. Counting one
      // against the desired count is only right for the couple of seconds a
      // rollout takes; a pod whose node died sits Terminating until the node
      // comes back or is deleted, and every app on that node read "Scaling"
      // for as long as it did while all of its replicas were up and serving.
      const livePods = allPods.filter((pod: any) => pod.status?.toLowerCase() !== 'terminating');
      const desiredReplicas = deployment.replicas || 1;

      if (allPods.length === 0) {
        return 'pending';
      }

      const hasBackOffWarning = warnings.some(
        (warning) =>
          warning.message?.toLowerCase().includes('back-off') ||
          warning.message?.toLowerCase().includes('backoff') ||
          warning.message?.toLowerCase().includes('crashloop')
      );

      const hasCrashingPods = allPods.some((pod: any) => {
        const restartCount = typeof pod.restartCount === 'number' ? pod.restartCount : 0;
        return (
          pod.status?.toLowerCase() === 'crashing' ||
          (restartCount > 5 && pod.status?.toLowerCase() !== 'ready')
        );
      });

      const hasAnyRestarts = allPods.some((pod: any) => {
        const restartCount = typeof pod.restartCount === 'number' ? pod.restartCount : 0;
        return restartCount > 0;
      });

      if (readyPods.length === 0) {
        if (hasBackOffWarning || hasCrashingPods) {
          return 'failed';
        }
        // Pods exist but none ready and no crash loops: starting up or restarting
        return hasAnyRestarts ? 'restarting' : 'pending';
      }

      if (readyPods.length < desiredReplicas) {
        if (hasBackOffWarning || hasCrashingPods) {
          return 'unhealthy';
        }
        // Pods cycling with restarts = rolling restart, otherwise scaling up
        return hasAnyRestarts ? 'restarting' : 'scaling';
      }

      // More live pods than desired = scaling down or rolling restart in progress
      if (livePods.length > desiredReplicas) {
        return hasAnyRestarts ? 'restarting' : 'scaling';
      }

      // All desired replicas are ready
      if (hasBackOffWarning) {
        return 'unhealthy';
      }

      return 'running';
    } catch (error) {
      console.error(
        `[ProjectsService] Failed to compute status for deployment ${deployment.id}:`,
        error instanceof Error ? error.message : error
      );
      return deployment.status;
    }
  }

  publicPortHost(deployment: any): string | null {
    return (
      this.k8sNetwork.publicDeploymentBaseDomain() ||
      (deployment?.project?.organization?.databasePublicIp ?? '').trim() ||
      this.instanceConfig.defaultPublicIp() ||
      null
    );
  }

  async attachPublicStatus(deployment: any): Promise<void> {
    const namespace = deployment?.namespace;
    const name = deployment?.name;
    if (!namespace || !name || !Array.isArray(deployment.services)) return;
    const ports: any[] = deployment.services
      .flatMap((s: any) => s.ports ?? [])
      .filter((p: any) => p.publicEnabled && p.publicPort && p.publicAddress);
    if (ports.length === 0) return;
    const serviceNameOf = (p: any) =>
      this.k8sNetwork.publicDeploymentServiceName(name, p.publicPort, p.protocol ?? 'TCP');
    const statuses = await this.k8sNetwork.publicEndpointStatuses(
      namespace,
      ports.map(serviceNameOf)
    );
    for (const port of ports) {
      port.publicStatus = statuses.get(serviceNameOf(port)) ?? UNKNOWN_PUBLIC_ENDPOINT;
    }
  }

  addInternalUrlsToServices(services: any[], namespace: string, publicHost: string | null = null) {
    if (!Array.isArray(services) || !namespace) {
      return services;
    }

    return services.map((service) => {
      const host = `${service.name}.${namespace}.svc.cluster.local`;
      const ports = service.ports || [];

      // Address the Service's own port, not the container's targetPort: in-cluster
      // traffic hits the Service, which is what forwards to targetPort on the pod.
      // The two are equal for anything created through the UI, but a service
      // built any other way would otherwise be advertised on an unroutable port.
      const portsWithUrls = ports.map((port: any) => ({
        ...port,
        internalUrl: `${host}:${port.port || port.targetPort || service.port || 80}`,
        publicAddress:
          port.publicEnabled && port.publicPort && publicHost
            ? `${publicHost}:${port.publicPort}`
            : null
      }));

      const internalUrls = portsWithUrls.map((p: any) => p.internalUrl);
      const fallback = `${host}:${service.port || 80}`;

      return {
        ...service,
        ports: portsWithUrls.length > 0 ? portsWithUrls : ports,
        internalHost: host,
        internalUrl: internalUrls.length > 0 ? internalUrls[0] : fallback,
        internalUrls: internalUrls.length > 0 ? internalUrls : [fallback]
      };
    });
  }

  addInternalUrlsToDeployment(deployment: any) {
    if (!deployment) {
      return deployment;
    }

    const result = { ...deployment };

    if (result.namespace && result.services && Array.isArray(result.services)) {
      result.services = this.addInternalUrlsToServices(
        result.services,
        result.namespace,
        this.publicPortHost(result)
      );
    }

    if (result.ingresses && Array.isArray(result.ingresses)) {
      result.ingresses = result.ingresses.map((ing: any) => scrubIngress(ing));
    }

    return DeploymentsService.redactSecretEnv(result);
  }

  normalizeServicePortInputs(
    ports?: {
      name?: string;
      containerPort?: number;
      servicePort?: number;
      protocol?: string;
      nodePort?: number;
    }[],
    options: { requireAtLeastOne?: boolean } = {}
  ) {
    const mapped: {
      name?: string;
      containerPort: number;
      servicePort: number;
      protocol: string;
      nodePort?: number;
    }[] = [];

    if (!Array.isArray(ports)) {
      if (options.requireAtLeastOne) {
        throw new BadRequestException('At least one valid port is required');
      }
      return mapped;
    }

    for (const entry of ports) {
      if (!entry) {
        continue;
      }

      const containerPort = Number(entry.containerPort ?? entry.servicePort ?? 0);
      const servicePort = Number(entry.servicePort ?? entry.containerPort ?? 0);

      if (!Number.isInteger(containerPort) || containerPort <= 0) {
        continue;
      }

      if (!Number.isInteger(servicePort) || servicePort <= 0) {
        continue;
      }

      const protocol =
        typeof entry.protocol === 'string' && entry.protocol.trim().length > 0
          ? entry.protocol.trim().toUpperCase()
          : 'TCP';

      const nodePortValue =
        entry.nodePort === undefined || entry.nodePort === null
          ? undefined
          : Number(entry.nodePort);

      const nodePort =
        nodePortValue !== undefined && Number.isInteger(nodePortValue) && nodePortValue > 0
          ? nodePortValue
          : undefined;

      const name =
        typeof entry.name === 'string' && entry.name.trim().length > 0
          ? entry.name.trim()
          : undefined;

      mapped.push({
        name,
        containerPort,
        servicePort,
        protocol,
        nodePort
      });
    }

    if (mapped.length === 0 && options.requireAtLeastOne) {
      throw new BadRequestException('At least one valid port is required');
    }

    return mapped;
  }

  private auditDeploymentChange(
    deployment: { id: string; name: string; projectId: string },
    action: string,
    userId: string | undefined | null,
    metadata: Record<string, AuditMetadataValue>
  ) {
    void this.prisma.project
      .findUnique({ where: { id: deployment.projectId }, select: { organizationId: true } })
      .then((project) =>
        this.audit.log({
          action,
          actorUserId: userId ?? null,
          organizationId: project?.organizationId ?? null,
          projectId: deployment.projectId,
          deploymentId: deployment.id,
          targetType: 'deployment',
          targetId: deployment.id,
          targetLabel: deployment.name,
          metadata
        })
      )
      .catch(() => undefined);
  }

  async updateDeploymentStrategy(deploymentId: string, strategy: DeployStrategy, userId?: string) {
    if (strategy !== 'rollingUpdate' && strategy !== 'recreate' && strategy !== 'blueGreen') {
      throw new BadRequestException('Invalid deploy strategy');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { volumes: true }
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    this.assertNotComposeManaged(deployment, 'Change deploy strategy');

    // Defense-in-depth: re-assert project-edit even though the controller already did.
    if (userId) {
      await this.authz.requireProjectEdit(deployment.projectId, userId, 'change deploy strategy');
    }

    // PVC volumes pin the strategy to Recreate: ReadWriteOnce can't satisfy
    // a rolling cutover.
    const hasPvc = deployment.volumes.some((v) => v.type === 'pvc');
    if (hasPvc && strategy !== 'recreate') {
      throw new BadRequestException(
        'This app has a volume, so it can only use Recreate. Remove the volume to use rolling updates or blue-green.'
      );
    }
    if (Object.keys(storedDevices(deployment.devices)).length > 0 && strategy !== 'recreate') {
      throw new BadRequestException(
        'This app has a device attached, so it can only use Recreate. Detach the device to use rolling updates or blue-green.'
      );
    }

    await this.k8sWorkload.updateDeploymentStrategy(
      deployment.name,
      deployment.namespace,
      strategy
    );

    const updatedStrategy = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { deployStrategy: strategy }
    });
    this.auditDeploymentChange(deployment, 'deployment.strategy.updated', userId, {
      strategy: [deployment.deployStrategy ?? null, strategy]
    });
    return updatedStrategy;
  }

  /**
   * How many pods Kubernetes must keep ready while it drains a node under
   * this app. 0 removes the budget entirely.
   *
   * The value is stored even when it cannot take effect yet (a 1-replica app
   * asking for 1 available pod would block every drain, so no object is
   * written): the setting is the user's intent, and scaling up later is what
   * makes it real. `active` in the response says which of the two happened.
   */
  async updateDeploymentDisruptionBudget(
    deploymentId: string,
    minAvailable: number,
    userId?: string
  ) {
    const parsed = Number(minAvailable);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PDB_MIN_AVAILABLE) {
      throw new BadRequestException(
        `Minimum available pods must be a whole number between 0 and ${MAX_PDB_MIN_AVAILABLE}`
      );
    }

    const deployment = await this.prisma.deployment.findUnique({ where: { id: deploymentId } });
    if (!deployment) throw new NotFoundException('Deployment not found');
    this.assertNotComposeManaged(deployment, 'Change the disruption budget');

    // Defense-in-depth: re-assert project-edit even though the controller already did.
    if (userId) {
      await this.authz.requireProjectEdit(
        deployment.projectId,
        userId,
        'change the disruption budget'
      );
    }

    const updated = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { pdbMinAvailable: parsed }
    });
    this.auditDeploymentChange(deployment, 'deployment.disruption_budget.updated', userId, {
      minAvailable: [deployment.pdbMinAvailable ?? null, parsed]
    });

    // Deliberately not swallowed here: this is the one path where the user is
    // waiting on the answer, so a cluster write that failed should say so.
    if (this.applyPipelineEnabled()) {
      await this.applyQueue.enqueue({
        dedupeKey: `op:deployment.disruptionBudget:${deploymentId}`,
        opType: 'deployment.disruptionBudget',
        deploymentId,
        requestedById: userId
      });
    } else {
      await this.applyDisruptionBudgetToCluster(deploymentId);
    }

    return {
      ...updated,
      pdbActive: disruptionBudgetActive(parsed, updated.replicas)
    };
  }

  // Booleans only. The copy lives in the frontend so wording changes do not
  // need an API deploy, and so this stays honest about what it actually knows.
  //
  // `applicable` and `done` are deliberately separate: a step that does not
  // apply is not the same as one already finished, and the UI wants to render
  // neither.
  async getDeploymentNextSteps(deploymentId: string, userId?: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        image: true,
        projectId: true,
        githubRepo: true,
        autoDeployEnabled: true,
        cpuRequestMilli: true,
        healthCheckEnabled: true,
        healthCheckOverride: true,
        dockerfileHealthCheck: true,
        imagePullPolicy: true,
        composeStackId: true,
        project: { select: { organizationId: true } },
        services: { select: { ports: { select: { id: true } } } },
        ingresses: { select: { host: true } }
      }
    });
    if (!deployment) throw new NotFoundException('Deployment not found');

    if (userId) {
      await this.authz.requireProjectView(deployment.projectId, userId);
    }

    // A rule or a personal setting at any level above this deployment counts:
    // an org-wide "tell me when things break" rule already covers it.
    const scopes: [string, string][] = [
      ['deployment', deployment.id],
      ['project', deployment.projectId],
      ['org', deployment.project.organizationId]
    ];
    const [ruleCount, settingCount] = await Promise.all([
      this.prisma.notificationRule.count({
        where: { enabled: true, OR: scopes.map(([scopeType, scopeId]) => ({ scopeType, scopeId })) }
      }),
      this.prisma.userNotificationSetting.count({
        where: { OR: scopes.map(([scopeType, scopeId]) => ({ scopeType, scopeId })) }
      })
    ]);

    const hasPublicPort = deployment.services.some((s) => s.ports.length > 0);
    const hasCustomDomain = deployment.ingresses.some((i) => !isPlatformGeneratedHost(i.host));
    // Compose owns its services' config, so telling someone to change it here
    // would send them somewhere that rejects the change.
    const editable = !deployment.composeStackId;
    const hasDockerfileHealthCheck =
      !deployment.healthCheckOverride &&
      !!coerceDockerfileHealthCheck(deployment.dockerfileHealthCheck);

    return {
      steps: [
        {
          id: 'auto-deploy',
          applicable: editable && !!deployment.githubRepo,
          done: deployment.autoDeployEnabled
        },
        { id: 'domain', applicable: editable && hasPublicPort, done: hasCustomDomain },
        { id: 'resources', applicable: editable, done: deployment.cpuRequestMilli != null },
        { id: 'notifications', applicable: true, done: ruleCount + settingCount > 0 },
        {
          id: 'health-check',
          applicable: editable,
          // A repo that declares its own HEALTHCHECK has already done this
          // step, and being told to do it again is how a nudge becomes noise.
          done: deployment.healthCheckEnabled || hasDockerfileHealthCheck
        },
        // No pull-policy step: a moving tag defaults to Always, so the only
        // way to be on IfNotPresent is to have chosen it, and nagging someone
        // about a deliberate choice is just noise.
        { id: 'cli', applicable: true, done: false }
      ]
    };
  }

  // `null` clears the override and hands the knob back to the tag-derived
  // default, the same way clearing shared_buffers does on a database.
  async updateDeploymentPullPolicy(
    deploymentId: string,
    policy: 'Always' | 'IfNotPresent' | null,
    userId?: string
  ) {
    if (policy != null && policy !== 'Always' && policy !== 'IfNotPresent') {
      throw new BadRequestException('Invalid image pull policy');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId }
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    this.assertNotComposeManaged(deployment, 'Change the image pull policy');

    // Defense-in-depth: re-assert project-edit even though the controller already did.
    if (userId) {
      await this.authz.requireProjectEdit(deployment.projectId, userId, 'change image pull policy');
    }

    // Unlike :id/image this is allowed on GitHub-built deployments: it changes
    // how the image is fetched, not which image runs, so the next build cannot
    // overwrite it. Only push to k8s if the object exists yet; otherwise the
    // stored value is picked up by createDeployment.
    const effective = resolvePullPolicy(policy, deployment.image);
    const k8sExists = await this.k8sWorkload
      .getKubernetesDeployment(deployment.name, deployment.namespace)
      .then((d) => d !== null);
    if (k8sExists) {
      await this.k8sWorkload.updateDeploymentPullPolicy(
        deployment.name,
        deployment.namespace,
        effective
      );
    }

    const updatedPolicy = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { imagePullPolicy: policy }
    });
    this.auditDeploymentChange(deployment, 'deployment.pull_policy.updated', userId, {
      pullPolicy: [deployment.imagePullPolicy ?? null, policy]
    });
    return updatedPolicy;
  }

  private parseDevices(input: unknown, stored: DeviceRequest = {}): DeviceRequest {
    try {
      return validateDeviceRequest(input, deviceClasses(), stored);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  async updateDeploymentDevices(deploymentId: string, input: unknown, userId?: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId }
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    this.assertNotComposeManaged(deployment, 'Change attached devices');

    if (userId) {
      await this.authz.requireProjectEdit(deployment.projectId, userId, 'change attached devices');
    }

    const devices = this.parseDevices(input, storedDevices(deployment.devices));

    const k8sExists = await this.k8sWorkload
      .getKubernetesDeployment(deployment.name, deployment.namespace)
      .then((d) => d !== null);
    if (k8sExists) {
      await this.k8sWorkload.updateDeploymentDevices(
        deployment.name,
        deployment.namespace,
        devices
      );
    }

    const pinStrategy = Object.keys(devices).length > 0 && deployment.deployStrategy !== 'recreate';
    const updated = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { devices, ...(pinStrategy ? { deployStrategy: 'recreate' as const } : {}) }
    });
    this.auditDeploymentChange(deployment, 'deployment.devices.updated', userId, {
      devices: [storedDevices(deployment.devices), devices]
    });
    if (pinStrategy) {
      this.auditDeploymentChange(deployment, 'deployment.strategy.updated', userId, {
        strategy: [deployment.deployStrategy ?? null, 'recreate']
      });
    }
    return updated;
  }

  async updateDeploymentImage(
    deploymentId: string,
    image: string,
    userId?: string,
    options?: { fromComposeStack?: boolean }
  ) {
    const trimmed = (image ?? '').toString().trim();
    if (!trimmed) {
      throw new BadRequestException("Image can't be empty");
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId }
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    if (!options?.fromComposeStack) this.assertNotComposeManaged(deployment, 'Change the image');

    // Defense-in-depth: re-assert project-edit even though the controller already did.
    if (userId) {
      await this.authz.requireProjectEdit(deployment.projectId, userId, 'change deployment image');
    }
    await assertImageOwnedByProject(
      this.prisma,
      trimmed,
      await this.prisma.project.findUniqueOrThrow({
        where: { id: deployment.projectId },
        select: { id: true, namespace: true }
      })
    );

    // Image-source deployments only: anything tied to a repo is rebuilt from
    // source by the GitHub flow, so a manual image change would just be
    // overwritten by the next build.
    if (deployment.githubRepo) {
      throw new BadRequestException(
        'This app builds from a GitHub repository. Use Redeploy to rebuild it.'
      );
    }

    // updateDeploymentImage patches k8s AND writes deployment.image in Prisma.
    await this.k8sWorkload.updateDeploymentImage(
      deployment.name,
      deployment.namespace,
      trimmed,
      undefined,
      undefined,
      await this.quotasService.prepareRollout(deployment)
    );
    await this.registryCredentials
      .applyToDeployment(deployment.projectId, deployment, trimmed)
      .catch((e: any) => {
        console.warn(
          `[Deployments] pull secret re-apply failed for ${deployment.name}: ${e?.message ?? e}`
        );
      });

    // The pull policy is derived from the tag, so moving from a pinned tag to a
    // moving one has to re-derive it. Only when the user has not pinned it: an
    // explicit choice survives an image change.
    if (deployment.imagePullPolicy == null) {
      const before = resolvePullPolicy(null, deployment.image);
      const after = resolvePullPolicy(null, trimmed);
      if (before !== after) {
        await this.k8sWorkload
          .updateDeploymentPullPolicy(deployment.name, deployment.namespace, after)
          .catch((e: any) => {
            console.warn(
              `[Deployments] pull policy re-derive failed for ${deployment.name}: ${e?.message ?? e}`
            );
          });
      }
    }

    this.auditDeploymentChange(deployment, 'deployment.image.updated', userId, {
      image: [deployment.image ?? null, trimmed]
    });

    return this.prisma.deployment.findUnique({ where: { id: deploymentId } });
  }

  async updateDeploymentResources(
    deploymentId: string,
    data: { cpuRequestMilli: number | null; memoryRequestBytes: number | null },
    userId?: string,
    options?: { fromComposeStack?: boolean }
  ) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: { project: true }
    });
    if (!deployment) throw new NotFoundException('Deployment not found');
    if (!options?.fromComposeStack) {
      this.assertNotComposeManaged(
        deployment,
        'Update resources',
        'Set `deploy.resources.limits` on the service in your compose file, then redeploy the stack to apply it.'
      );
    }

    // Defense-in-depth: re-assert project-edit even though the controller already did.
    if (userId) {
      await this.authz.requireProjectEdit(
        deployment.projectId,
        userId,
        'update deployment resources'
      );
    }

    // Unlimited mode: cpuRequestMilli === 0 means remove all resource constraints.
    const isUnlimited = data.cpuRequestMilli === 0 && data.memoryRequestBytes === 0;
    await this.assertResourceRequest(data, userId);

    // Only push to K8s if the deployment exists in the cluster.
    const k8sExistsRes = await this.k8sWorkload
      .getKubernetesDeployment(deployment.name, deployment.namespace)
      .then((d) => d !== null);

    if (isUnlimited) {
      if (k8sExistsRes) {
        await this.k8sWorkload.removeDeploymentResources(deployment.namespace, deployment.name);
      }
    } else {
      const resolved = await this.quotasService.podSizing(
        deployment.projectId,
        {
          cpuRequestMilli: data.cpuRequestMilli,
          memoryRequestBytes: data.memoryRequestBytes
        },
        deployment.image
      );
      if (resolved.noLimits) await this.quotasService.clearProjectQuota(deployment.projectId);

      // The deployment's current footprint is already counted in org/member
      // usage, so only the increase is additive: charging the full new
      // footprint would double-count the running pods. Previously-unlimited
      // deployments contribute nothing to counted usage, so their whole new
      // footprint is the increase.
      const wasUnlimited =
        deployment.cpuRequestMilli === 0 &&
        (deployment.memoryRequestBytes === null || deployment.memoryRequestBytes === BigInt(0));
      const current = wasUnlimited
        ? { cpuMilli: 0, memoryBytes: 0 }
        : await this.quotasService.resolvePodResources(
            deployment.projectId,
            {
              cpuRequestMilli: deployment.cpuRequestMilli,
              memoryRequestBytes:
                deployment.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null
            },
            deployment.image
          );
      const replicasRes = deployment.replicas || 1;
      const increase = {
        cpuMilli: Math.max(0, (resolved.cpuMilli - current.cpuMilli) * replicasRes),
        memoryBytes: Math.max(0, (resolved.memoryBytes - current.memoryBytes) * replicasRes)
      };

      if (increase.cpuMilli > 0 || increase.memoryBytes > 0) {
        await this.quotasService.enforceOrgCapForNewPod(
          deployment.project.organizationId,
          increase
        );
        await this.quotasService.enforceProjectCapForNewPod(deployment.projectId, {
          ...increase,
          pods: 0
        });
        // Per-user allowance check (charged to project owner).
        await this.quotasService.enforceMemberAllowanceForNewPod(
          deployment.project.organizationId,
          deployment.project.ownerId,
          increase
        );
      }

      if (k8sExistsRes) {
        await this.k8sWorkload.updateDeploymentResources(
          deployment.namespace,
          deployment.name,
          resolved
        );
      }
    }

    const updatedResources = await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        cpuRequestMilli: data.cpuRequestMilli,
        memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null
      }
    });
    this.auditDeploymentChange(deployment, 'deployment.resources.updated', userId, {
      cpuMilli: [deployment.cpuRequestMilli ?? null, data.cpuRequestMilli],
      memoryBytes: [
        deployment.memoryRequestBytes != null ? Number(deployment.memoryRequestBytes) : null,
        data.memoryRequestBytes
      ]
    });
    return updatedResources;
  }

  async createDeployment(
    projectId: string,
    data: {
      name: string;
      image: string;
      port?: number;
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
      }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      exposePublic?: boolean;
      volumes?: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
        storageSize?: string;
        hostPath?: string;
        readOnly?: boolean;
      }[];
      templateInstanceId?: string;
      composeStackId?: string;
      composeServiceName?: string;
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      environmentId?: string;
      nodePoolId?: string | null;
      placementOverride?: unknown;
      imagePullPolicy?: 'Always' | 'IfNotPresent';
      pdbMinAvailable?: number;
      createdByGraft?: string;
      devices?: Record<string, number> | null;
      // Overrides the image's CMD. An image-source deployment never runs a
      // builder, so this is the only way to run `redis-server --appendonly
      // yes` instead of whatever the image starts with.
      startCommand?: string | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: true
      }
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    await this.authz.requireProjectEdit(project.id, user.id, 'create deployments');
    await this.assertResourceRequest(data, user.id);
    await assertOrgCanCreate(this.prisma, project.organizationId, 'deployments');

    // Resolve the target environment (explicit id or the project default).
    // The environment owns the namespace the resource deploys into.
    const environment = await this.environments.resolveEnvironment(project.id, data.environmentId);

    if (Array.isArray(data.volumes) && data.volumes.some((v) => v && v.type === 'hostPath')) {
      throw new ForbiddenException("hostPath volumes aren't permitted");
    }

    const nameInput = String(data.name || '').trim();
    const image = String(data.image || '').trim();
    const replicas =
      data.replicas && Number.isInteger(data.replicas) && data.replicas > 0 ? data.replicas : 1;

    if (!nameInput) {
      throw new BadRequestException('App name is required');
    }

    if (!image) {
      throw new BadRequestException('Image is required');
    }
    await assertImageOwnedByProject(this.prisma, image, project);

    const name = formatSlug(nameInput);

    if (!name) {
      throw new BadRequestException("App name can't be empty");
    }

    await assertIngressNameFree(this.prisma, environment.namespace, name, project.id);

    const existingDeployment = await this.prisma.deployment.findFirst({
      where: { environmentId: environment.id, name }
    });

    if (existingDeployment) {
      throw new BadRequestException('An app with this name already exists in this environment');
    }

    const envEntries = Array.isArray(data.env)
      ? data.env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: entry.key.trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : '',
            secret: defaultSecretFlag(entry.key, (entry as any).secret)
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    const uniqueEnv = new Map<string, { value: string; secret: boolean }>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, { value: entry.value, secret: entry.secret });
    }

    // Stored form keeps the literal ${{shared.KEY}} + secret flag.
    const env = Array.from(uniqueEnv.entries()).map(([key, e]) => ({
      key,
      value: e.value,
      secret: e.secret
    }));
    assertEnvSetStorable(env);

    // Injected form resolves shared references against the environment's shared
    // vars (secrets, own or inherited, route to a k8s Secret downstream).
    const sharedVars = await this.loadSharedVarsForDeployment('', environment.id);
    const { resolved: resolvedEnv } = this.resolveOrReject(env, sharedVars, {});

    const exposePublic = Boolean(data.exposePublic);
    if (exposePublic) await assertOrgCanExposeNodePort(this.prisma, project.organizationId);

    const rawPorts =
      Array.isArray(data.ports) && data.ports.length > 0
        ? data.ports
        : [
            {
              name: 'http',
              containerPort:
                data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : 80,
              servicePort:
                data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : 80,
              protocol: 'TCP'
            }
          ];

    const volumes = Array.isArray(data.volumes) ? data.volumes : [];
    await this.assertVolumesUnclaimed(environment.namespace, volumes);

    // Resolve per-pod resources (explicit override → org default → fallback).
    const podResources = await this.quotasService.podSizing(
      project.id,
      {
        cpuRequestMilli: data.cpuRequestMilli ?? null,
        memoryRequestBytes: data.memoryRequestBytes ?? null
      },
      image
    );

    await this.quotasService.enforceOrgCapForNewPod(project.organizationId, {
      cpuMilli: podResources.cpuMilli * replicas,
      memoryBytes: podResources.memoryBytes * replicas
    });
    await this.quotasService.enforceProjectCapForNewPod(project.id, {
      cpuMilli: podResources.cpuMilli * replicas,
      memoryBytes: podResources.memoryBytes * replicas,
      pods: replicas
    });
    await this.quotasService.enforceMemberAllowanceForNewPod(
      project.organizationId,
      project.ownerId,
      {
        cpuMilli: podResources.cpuMilli * replicas,
        memoryBytes: podResources.memoryBytes * replicas
      }
    );
    // Make sure the namespace ResourceQuota/LimitRange reflect current caps.
    await this.quotasService.applyProjectQuota(project.id).catch((err) => {
      console.error('[Projects] applyProjectQuota failed:', err);
    });

    await this.nodesService.assertPoolAssignable({
      nodePoolId: data.nodePoolId,
      placementOverride: data.placementOverride,
      userId: user.id
    });
    const placement = await this.resolvePlacementForProject(project.id);
    const pool = await this.nodesService.resolvePool(data.nodePoolId ?? null);
    const placementOverride = this.nodesService.toPlacementOverride(data.placementOverride ?? null);
    // PVC volumes force the Recreate update strategy on k8s; mirror that in
    // the DB so the UI shows the truth from the moment the deployment exists.
    const hasPvcOnCreate = (volumes ?? []).some((v) => v.type === 'pvc');
    const initialDevices = this.parseDevices(data.devices);
    const initialStrategy: 'rollingUpdate' | 'recreate' =
      hasPvcOnCreate || Object.keys(initialDevices).length > 0 ? 'recreate' : 'rollingUpdate';
    // Stored as given: null keeps it automatic and re-derives if the image
    // later changes; a value here is the caller pinning it.
    const pullPolicyOverride =
      data.imagePullPolicy === 'Always' || data.imagePullPolicy === 'IfNotPresent'
        ? data.imagePullPolicy
        : null;
    const startCommand = data.startCommand?.trim() || null;
    const startArgs = resolveStartArgs(startCommand);
    // Every app starts out asking for one pod to survive a drain. It only
    // becomes a real budget once the app runs more than one replica.
    const initialPdbMinAvailable =
      data.pdbMinAvailable != null &&
      Number.isInteger(data.pdbMinAvailable) &&
      data.pdbMinAvailable >= 0 &&
      data.pdbMinAvailable <= MAX_PDB_MIN_AVAILABLE
        ? data.pdbMinAvailable
        : 1;
    const deploymentResult = await this.k8sWorkload.createDeployment({
      namespace: environment.namespace,
      name,
      image,
      replicas,
      ports: rawPorts,
      env: resolvedEnv,
      serviceType: exposePublic ? 'NodePort' : 'ClusterIP',
      volumes,
      allowedNodes: placement.allowedNodes,
      deniedNodes: placement.deniedNodes,
      pool,
      placementOverride,
      resources: podResources,
      deployStrategy: initialStrategy,
      imagePullPolicy: resolvePullPolicy(pullPolicyOverride, image),
      imagePullSecrets: await this.registryCredentials.pullSecretsFor(project.id, image),
      pdbMinAvailable: initialPdbMinAvailable,
      devices: initialDevices,
      args: startArgs
    });

    let createdDeployment;
    try {
      createdDeployment = await this.prisma.$transaction(async (tx) => {
        const deployment = await tx.deployment.create({
          data: {
            projectId: project.id,
            createdByGraft: data.createdByGraft ?? null,
            environmentId: environment.id,
            name,
            namespace: environment.namespace,
            image,
            replicas,
            status: 'running',
            createdBy: user.id,
            templateInstanceId: data.templateInstanceId ?? null,
            composeStackId: data.composeStackId ?? null,
            composeServiceName: data.composeServiceName ?? null,
            deployStrategy: initialStrategy,
            imagePullPolicy: pullPolicyOverride,
            pdbMinAvailable: initialPdbMinAvailable,
            devices: initialDevices,
            startCommand,
            nodePoolId: data.nodePoolId ?? null,
            placementOverride: (placementOverride ?? undefined) as
              | Prisma.InputJsonValue
              | undefined,
            cpuRequestMilli: data.cpuRequestMilli ?? null,
            memoryRequestBytes:
              data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null
          }
        });

        if (env.length > 0) {
          await tx.deploymentEnvVar.createMany({
            data: env.map((entry) => ({
              deploymentId: deployment.id,
              key: entry.key,
              value: this.crypto.encryptIfSecret(entry.value, entry.secret),
              secret: entry.secret
            }))
          });
        }

        if (volumes.length > 0) {
          await tx.deploymentVolume.createMany({
            data: volumes.map((vol) => {
              let volType: 'pvc' | 'hostPath' | 'emptyDir' = 'emptyDir';
              if (vol.type === 'pvc') volType = 'pvc';
              else if (vol.type === 'hostPath') volType = 'hostPath';
              return {
                deploymentId: deployment.id,
                name: vol.name.trim(),
                type: volType,
                mountPath: vol.mountPath.trim(),
                pvcName: vol.type === 'pvc' ? vol.pvcName?.trim() || vol.name.trim() : null,
                storageSize: vol.type === 'pvc' && vol.storageSize ? vol.storageSize.trim() : null,
                hostPath: vol.type === 'hostPath' && vol.hostPath ? vol.hostPath.trim() : null,
                readOnly: Boolean(vol.readOnly)
              };
            })
          });
        }

        const normalizedPorts = deploymentResult.ports || [];
        const primaryPort = normalizedPorts[0] || {
          name: 'http',
          containerPort: 80,
          servicePort: 80,
          protocol: 'TCP',
          nodePort: null
        };
        const primaryNodePort =
          primaryPort.nodePort !== undefined && primaryPort.nodePort !== null
            ? primaryPort.nodePort
            : null;

        const serviceType = exposePublic ? ServiceType.external : ServiceType.internal;
        const externalIp = deploymentResult.externalIp || null;

        const service = await tx.service.create({
          data: {
            deploymentId: deployment.id,
            name,
            type: serviceType,
            port: primaryPort.servicePort,
            targetPort: primaryPort.containerPort,
            protocol: primaryPort.protocol,
            externalIp,
            nodePort: primaryNodePort
          }
        });

        if (normalizedPorts.length > 0) {
          await tx.servicePort.createMany({
            data: normalizedPorts.map((portEntry) => ({
              serviceId: service.id,
              name: portEntry.name,
              port: portEntry.servicePort,
              targetPort: portEntry.containerPort,
              protocol: portEntry.protocol,
              nodePort:
                portEntry.nodePort !== undefined && portEntry.nodePort !== null
                  ? portEntry.nodePort
                  : null
            }))
          });
        }

        return tx.deployment.findUnique({
          where: { id: deployment.id },
          include: {
            pods: true,
            services: {
              include: {
                ports: true
              }
            },
            envVars: true,
            volumes: true,
            ingresses: {
              include: {
                service: true
              }
            },
            project: {
              include: {
                organization: true
              }
            }
          }
        });
      });
    } catch (e) {
      try {
        await this.k8sWorkload.deleteDeployment(name, environment.namespace);
      } catch {
        /* ignore */
      }
      try {
        await this.k8sNetwork.deleteService(environment.namespace, name);
      } catch {
        /* ignore */
      }
      throw e;
    }

    if (createdDeployment) {
      void this.audit.log({
        action: 'deployment.created',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: project.organizationId,
        projectId: project.id,
        deploymentId: createdDeployment.id,
        targetType: 'deployment',
        targetId: createdDeployment.id,
        targetLabel: createdDeployment.name,
        metadata: { image, replicas, source: 'image' }
      });
    }

    return this.addInternalUrlsToDeployment(createdDeployment);
  }

  async uploadDeploymentIcon(
    deploymentId: string,
    file: Express.Multer.File,
    storageService: { uploadImage: (file: Express.Multer.File, folder: string) => Promise<string> },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, projectId: true }
    });
    if (!deployment) throw new NotFoundException('App not found');
    await this.authz.requireProjectEdit(deployment.projectId, user.id, 'update app picture');
    const icon = await storageService.uploadImage(file, `app-icons/${deploymentId}`);
    return this.prisma.deployment.update({ where: { id: deploymentId }, data: { icon } });
  }

  async createDeploymentFromGitHub(
    projectId: string,
    data: {
      name: string;
      createdByGraft?: string;
      repoUrl?: string;
      githubRepo?: string;
      gitConnectionId?: string | null;
      externalRepoId?: string | null;
      branch?: string;
      dockerfilePath?: string;
      target?: string;
      tag?: string;
      buildFromRoot?: boolean;
      buildWithDepot?: boolean;
      persistentBuildCache?: boolean;
      buildType?: 'dockerfile' | 'railpack';
      rootDirectory?: string | null;
      framework?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      outputDirectory?: string | null;
      port?: number;
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
      }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      exposePublic?: boolean;
      volumes?: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
        storageSize?: string;
        hostPath?: string;
        readOnly?: boolean;
      }[];
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      composeStackId?: string;
      composeServiceName?: string;
      environmentId?: string;
      autoDeployEnabled?: boolean;
      autoDeployBranch?: string;
      templateInstanceId?: string;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: true
      }
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    await this.authz.requireProjectEdit(project.id, user.id, 'create deployments');
    await this.assertResourceRequest(data, user.id);
    await assertOrgCanCreate(this.prisma, project.organizationId, 'deployments');

    const environment = await this.environments.resolveEnvironment(project.id, data.environmentId);

    if (Array.isArray(data.volumes) && data.volumes.some((v) => v && v.type === 'hostPath')) {
      throw new ForbiddenException("hostPath volumes aren't permitted");
    }
    await this.assertVolumesUnclaimed(environment.namespace, data.volumes);

    if (
      (data.buildWithDepot || data.persistentBuildCache) &&
      !(await this.authz.isUnrestrictedSuperAdmin(user.id))
    ) {
      throw new ForbiddenException(
        'Super builds and persistent build cache are superadmin-only settings'
      );
    }
    if (data.buildWithDepot && !process.env.DEPOT_TOKEN) {
      throw new BadRequestException(SUPER_BUILDS_UNAVAILABLE);
    }

    const nameInput = String(data.name || '').trim();
    const replicas =
      data.replicas && Number.isInteger(data.replicas) && data.replicas > 0 ? data.replicas : 1;
    let repoUrl = String(data.repoUrl || data['githubRepo'] || '').trim();
    // Accept owner/repo shorthand and convert to full URL
    if (repoUrl && !repoUrl.startsWith('http')) {
      repoUrl = `https://github.com/${repoUrl}`;
    }
    repoUrl = repoUrl.replace(/\.git$/, '');
    const branch = String(data.branch || 'main').trim();
    const dockerfilePath = String(data.dockerfilePath || '').trim();
    const tag = data.tag ? String(data.tag).trim() : 'latest';
    const buildType = data.buildType === 'railpack' ? 'railpack' : 'dockerfile';

    // Validate refs and paths at the boundary. The same checks are
    // enforced again inside DockerService.cloneRepository as defence in
    // depth: see isSafeGitRef / isSafeRelativePath there.
    const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/;
    if (
      branch.length > 200 ||
      branch.startsWith('-') ||
      branch.includes('..') ||
      !GIT_REF_RE.test(branch)
    ) {
      throw new BadRequestException('Invalid branch name');
    }
    if (tag.length > 200 || tag.startsWith('-') || tag.includes('..') || !GIT_REF_RE.test(tag)) {
      throw new BadRequestException('Invalid tag');
    }
    if (
      data.autoDeployBranch &&
      (data.autoDeployBranch.length > 255 || !GIT_REF_RE.test(data.autoDeployBranch))
    ) {
      throw new BadRequestException('Invalid auto-deploy branch');
    }
    if (dockerfilePath) {
      if (
        dockerfilePath.length > 500 ||
        dockerfilePath.startsWith('/') ||
        dockerfilePath.startsWith('\\') ||
        dockerfilePath.includes('..') ||
        dockerfilePath.includes('\0') ||
        !/^[A-Za-z0-9._/\- ]+$/.test(dockerfilePath)
      ) {
        throw new BadRequestException('Invalid Dockerfile path');
      }
    }

    if (!nameInput) {
      throw new BadRequestException('App name is required');
    }

    if (!repoUrl) {
      throw new BadRequestException('Repository URL is required');
    }

    if (!branch) {
      throw new BadRequestException('Branch is required');
    }

    // Verify the requesting user can actually access this repo on GitHub.
    const connectionId = String(data.gitConnectionId || '').trim() || null;
    let gitConnection: Awaited<ReturnType<GitConnectionsService['forDeploy']>> | null = null;
    let repoInstallation: { installationId: bigint } | null = null;
    if (connectionId) {
      gitConnection = await this.gitConnections.forDeploy(user.id, connectionId);
      const parsedUrl = parseRepoUrl(repoUrl);
      if (!parsedUrl) throw new BadRequestException('Repository URL must be a plain https:// URL');
      if (parsedUrl.host.toLowerCase() !== hostOf(gitConnection.baseUrl).toLowerCase()) {
        throw new BadRequestException(
          `${gitConnection.name} is for ${hostOf(gitConnection.baseUrl)}, not ${parsedUrl.host}`
        );
      }
    } else {
      const parsed = this.githubService.parseRepoUrl(repoUrl);
      if (!parsed) {
        throw new BadRequestException("Couldn't read the repository URL");
      }
      const canAccess = await this.githubService.verifyUserCanAccessRepo(
        user.id,
        parsed.owner,
        parsed.repo
      );
      if (!canAccess) {
        // If the user can't access via their token, check if the repo is public
        const isPublic = await this.githubService.isRepoPublic(parsed.owner, parsed.repo);
        if (!isPublic) {
          throw new ForbiddenException(
            personalSourceSelectionRefused()
              ? PERSONAL_CREDENTIAL_REFUSED
              : "You don't have access to this repository on GitHub. Connect your GitHub account or request access."
          );
        }
      }

      // Bind the deployment to the specific GitHub App installation that owns
      // the repo. Auto-deploy webhooks will refuse to fire unless the incoming
      // installation id matches this one, preventing impersonation by another
      // installation with a colliding repo full_name.
      // For public repos without the app installed, installationId will be null
      // (auto-deploy won't work, but manual builds can clone without auth).
      repoInstallation =
        canAccess &&
        (await this.githubService.userMaintainsRepo(user.id, parsed.owner, parsed.repo))
          ? await this.githubService.findInstallationForRepo(parsed.owner, parsed.repo)
          : null;

      // Auto-deploy defaults ON when the installation covers the repo, because
      // push webhooks can then actually fire. Honouring a request for it without
      // one is the worst of both: the row says enabled, nothing is bound to an
      // installation, every push is dropped, and the only symptom is a commit that
      // never queues.
      if (data.autoDeployEnabled === true && !repoInstallation) {
        throw new BadRequestException(
          this.githubService.autoDeployUnavailableMessage(parsed.owner, parsed.repo)
        );
      }

      // Dockerfile path is only required for dockerfile builds
    }

    if (buildType === 'dockerfile' && !dockerfilePath) {
      throw new BadRequestException('Dockerfile path is required for Dockerfile builds');
    }

    const name = formatSlug(nameInput);

    if (!name) {
      throw new BadRequestException("App name can't be empty");
    }

    await assertIngressNameFree(this.prisma, environment.namespace, name, project.id);
    await assertRepoNameFree(this.prisma, project.namespace, name, project.id);

    const existingDeployment = await this.prisma.deployment.findFirst({
      where: { environmentId: environment.id, name }
    });

    if (existingDeployment) {
      throw new BadRequestException('An app with this name already exists in this environment');
    }

    const imageName = `${project.namespace}-${name}`;

    const uniqueTag = newImageTag();

    const envEntries = Array.isArray(data.env)
      ? data.env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: entry.key.trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : '',
            secret: defaultSecretFlag(entry.key, (entry as any).secret)
          }))
          .filter((entry) => entry.key.length > 0)
      : [];

    const uniqueEnv = new Map<string, { value: string; secret: boolean }>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, { value: entry.value, secret: entry.secret });
    }

    // Stored form keeps the literal ${{shared.KEY}} + secret flag.
    const env = Array.from(uniqueEnv.entries()).map(([key, e]) => ({
      key,
      value: e.value,
      secret: e.secret
    }));
    assertEnvSetStorable(env);

    // Injected form resolves shared references against the environment's shared
    // vars (secrets, own or inherited, route to a k8s Secret downstream).
    const sharedVars = await this.loadSharedVarsForDeployment('', environment.id);
    const { resolved: resolvedEnv } = this.resolveOrReject(env, sharedVars, {});

    const exposePublic = Boolean(data.exposePublic);
    if (exposePublic) await assertOrgCanExposeNodePort(this.prisma, project.organizationId);

    // Auto-detect port from Dockerfile EXPOSE directive if no port specified
    let detectedPort: number | null = null;
    const hasExplicitPort =
      (data.port && Number.isInteger(data.port) && data.port > 0) ||
      (Array.isArray(data.ports) && data.ports.length > 0);

    if (!hasExplicitPort && repoUrl && dockerfilePath) {
      try {
        const repoInfo = this.githubService.parseRepoUrl(repoUrl);
        if (repoInfo) {
          const userToken = await this.githubService.getValidUserToken(user.id);
          const dockerfileContent = await this.githubService.getFileContent(
            userToken ?? '',
            repoInfo.owner,
            repoInfo.repo,
            dockerfilePath,
            branch
          );
          detectedPort = this.githubService.parseExposedPort(dockerfileContent);
          if (detectedPort) {
            console.log(
              `[Projects] Auto-detected EXPOSE port ${detectedPort} from ${dockerfilePath}`
            );
          }
        }
      } catch (error) {
        console.warn(`[Projects] Failed to auto-detect port from Dockerfile:`, error.message);
      }
    }

    const defaultPort = detectedPort || 80;

    const rawPorts =
      Array.isArray(data.ports) && data.ports.length > 0
        ? data.ports
        : [
            {
              name: 'http',
              containerPort:
                data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : defaultPort,
              servicePort:
                data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : defaultPort,
              protocol: 'TCP'
            }
          ];

    // Create deployment record with buildStatus='building' and status='pending'
    const buildMethodLabel = buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
    const deployment = await this.prisma.deployment.create({
      data: {
        projectId: project.id,
        createdByGraft: data.createdByGraft ?? null,
        environmentId: environment.id,
        name,
        namespace: environment.namespace,
        image: `${this.dockerService.getImagePath(imageName, uniqueTag)}`, // Placeholder, will be updated
        replicas,
        status: 'pending',
        buildStatus: 'building',
        buildType,
        githubRepo: repoUrl,
        githubBranch: branch,
        githubInstallationId: repoInstallation?.installationId ?? null,
        gitConnectionId: gitConnection?.id ?? null,
        externalRepoId: gitConnection ? String(data.externalRepoId || '').trim() || null : null,
        dockerfilePath: buildType === 'dockerfile' ? dockerfilePath : null,
        // Railpack has no notion of stages, so a target can only mean anything
        // alongside a Dockerfile.
        dockerfileTarget: buildType === 'dockerfile' ? safeDockerfileTarget(data.target) : null,
        buildFromRoot: data.buildFromRoot ?? false,
        buildWithDepot: data.buildWithDepot ?? false,
        persistentBuildCache: data.persistentBuildCache ?? false,
        // Only meaningful for Railpack builds; null everywhere means "detect".
        rootDirectory: buildType === 'railpack' ? normalizeRootDirectory(data.rootDirectory) : null,
        framework: data.framework?.trim() || null,
        installCommand: data.installCommand?.trim() || null,
        buildCommand: data.buildCommand?.trim() || null,
        startCommand: data.startCommand?.trim() || null,
        outputDirectory: data.outputDirectory?.trim() || null,
        createdBy: user.id,
        buildLogs: `[INFO] Starting ${buildMethodLabel} build for ${repoUrl}@${branch}\n`,
        buildStepTimestamps: { __start: Date.now() },
        cpuRequestMilli: data.cpuRequestMilli ?? null,
        memoryRequestBytes:
          data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
        composeStackId: data.composeStackId ?? null,
        composeServiceName: data.composeServiceName ?? null,
        templateInstanceId: data.templateInstanceId ?? null,
        autoDeployEnabled: data.autoDeployEnabled ?? repoInstallation != null,
        autoDeployBranch: data.autoDeployBranch ?? null
      }
    });

    if (env.length > 0) {
      await this.prisma.deploymentEnvVar.createMany({
        data: env.map((entry) => ({
          deploymentId: deployment.id,
          key: entry.key,
          value: this.crypto.encryptIfSecret(entry.value, entry.secret),
          secret: entry.secret
        }))
      });
    }

    const volumes = Array.isArray(data.volumes) ? data.volumes : [];
    if (volumes.length > 0) {
      await this.prisma.deploymentVolume.createMany({
        data: volumes.map((vol) => {
          let volType: 'pvc' | 'hostPath' | 'emptyDir' = 'emptyDir';
          if (vol.type === 'pvc') volType = 'pvc';
          else if (vol.type === 'hostPath') volType = 'hostPath';
          return {
            deploymentId: deployment.id,
            name: vol.name.trim(),
            type: volType,
            mountPath: vol.mountPath.trim(),
            pvcName: vol.type === 'pvc' ? vol.pvcName?.trim() || vol.name.trim() : null,
            storageSize: vol.type === 'pvc' && vol.storageSize ? vol.storageSize.trim() : null,
            hostPath: vol.type === 'hostPath' && vol.hostPath ? vol.hostPath.trim() : null,
            readOnly: Boolean(vol.readOnly)
          };
        })
      });
    }

    // Persist ports/service config upfront so they survive build failures.
    // The actual K8s Service is created after a successful build, but the DB
    // records are needed so rebuilds and the UI can read the port config back.
    if (rawPorts.length > 0) {
      const serviceType = exposePublic ? ServiceType.external : ServiceType.internal;
      const primaryPort = rawPorts[0];
      const service = await this.prisma.service.create({
        data: {
          deploymentId: deployment.id,
          name,
          type: serviceType,
          port: primaryPort.servicePort,
          targetPort: primaryPort.containerPort,
          protocol: primaryPort.protocol || 'TCP',
          externalIp: null,
          nodePort: null
        }
      });

      await this.prisma.servicePort.createMany({
        data: rawPorts.map((portEntry) => ({
          serviceId: service.id,
          name: portEntry.name,
          port: portEntry.servicePort,
          targetPort: portEntry.containerPort,
          protocol: portEntry.protocol || 'TCP',
          nodePort: null
        }))
      });
    }

    console.log(`[Projects] Created deployment record ${deployment.id}, starting async build`);

    // A committed score.yaml is applied before the first build so the env
    // and ports it declares are what the build lands with. Failures here are
    // warnings in the log, never a failed create.
    await this.score
      .applyForDeployment(deployment.id, {
        clerkId,
        userId: user.id,
        userData,
        accessToken: null
      })
      .catch((e) => console.warn(`[Score] apply on create failed: ${(e as Error).message}`));

    await this.buildQueue
      .recordActiveBuild({
        deploymentId: deployment.id,
        triggerType: 'initial',
        branch,
        triggeredById: user.id
      })
      .catch((err) =>
        this.logger.warn(`recordActiveBuild failed for ${deployment.id}: ${err?.message ?? err}`)
      );

    void this.audit.log({
      action: 'deployment.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: project.organizationId,
      projectId: project.id,
      deploymentId: deployment.id,
      targetType: 'deployment',
      targetId: deployment.id,
      targetLabel: deployment.name,
      metadata: { source: 'github', repoUrl, branch, buildType }
    });

    // Start build process asynchronously - don't await!
    this.buildAndDeployAsync(
      deployment.id,
      {
        repoUrl,
        branch,
        dockerfilePath,
        target: data.target,
        buildFromRoot: data.buildFromRoot,
        buildWithDepot: data.buildWithDepot,
        persistentBuildCache: data.persistentBuildCache,
        buildType,
        imageName,
        tag: uniqueTag,
        namespace: environment.namespace,
        name,
        replicas,
        rawPorts,
        env: resolvedEnv,
        exposePublic,
        volumes,
        isRebuild: false,
        triggerType: 'manual',
        triggeredById: user.id
      },
      await this.githubCloneToken({
        userId: user.id,
        repoUrl,
        branch,
        boundInstallationId: null,
        linkedBy: user.id
      })
    ).catch((error) => {
      console.error(`[Projects] Async build failed for deployment ${deployment.id}:`, error);
    });

    // Return deployment immediately so frontend can poll for logs
    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        },
        project: {
          include: {
            organization: true
          }
        }
      }
    });
    return this.addInternalUrlsToDeployment(result);
  }

  /**
   * Record-only creation for "orchard up": the deployment exists (name, build
   * config, env, service/port rows) but nothing builds until a context tarball
   * is uploaded. Gated on the private build-context bucket being configured.
   */
  async createDeploymentFromLocal(
    projectId: string,
    data: {
      name: string;
      buildType?: 'dockerfile' | 'railpack';
      dockerfilePath?: string;
      target?: string;
      rootDirectory?: string | null;
      framework?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      outputDirectory?: string | null;
      port?: number;
      ports?: { name?: string; containerPort?: number; servicePort?: number; protocol?: string }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      environmentId?: string;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    await this.instanceConfig.fresh();
    if (!this.storage.buildContextEnabled()) {
      throw new BadRequestException(LOCAL_DEPLOYS_NEED_S3);
    }

    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { organization: true }
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    await this.authz.requireProjectEdit(project.id, user.id, 'create deployments');
    await this.assertResourceRequest(data, user.id);
    await assertOrgCanCreate(this.prisma, project.organizationId, 'deployments');
    const environment = await this.environments.resolveEnvironment(project.id, data.environmentId);

    const nameInput = String(data.name || '').trim();
    if (!nameInput) {
      throw new BadRequestException('App name is required');
    }
    const name = formatSlug(nameInput);
    if (!name) {
      throw new BadRequestException("App name can't be empty");
    }

    const buildType = data.buildType === 'railpack' ? 'railpack' : 'dockerfile';
    const dockerfilePath = String(data.dockerfilePath || '').trim();
    if (buildType === 'dockerfile' && !dockerfilePath) {
      throw new BadRequestException('Dockerfile path is required for Dockerfile builds');
    }
    if (dockerfilePath) {
      if (
        dockerfilePath.length > 500 ||
        dockerfilePath.startsWith('/') ||
        dockerfilePath.startsWith('\\') ||
        dockerfilePath.includes('..') ||
        dockerfilePath.includes('\0') ||
        !/^[A-Za-z0-9._/\- ]+$/.test(dockerfilePath)
      ) {
        throw new BadRequestException('Invalid Dockerfile path');
      }
    }

    await assertIngressNameFree(this.prisma, environment.namespace, name, project.id);
    await assertRepoNameFree(this.prisma, project.namespace, name, project.id);

    const existingDeployment = await this.prisma.deployment.findFirst({
      where: { environmentId: environment.id, name }
    });
    if (existingDeployment) {
      throw new BadRequestException('An app with this name already exists in this environment');
    }

    const replicas =
      data.replicas && Number.isInteger(data.replicas) && data.replicas > 0 ? data.replicas : 1;

    const envEntries = Array.isArray(data.env)
      ? data.env
          .filter((entry) => entry && typeof entry.key === 'string')
          .map((entry) => ({
            key: entry.key.trim(),
            value: entry.value !== undefined && entry.value !== null ? String(entry.value) : '',
            secret: defaultSecretFlag(entry.key, (entry as any).secret)
          }))
          .filter((entry) => entry.key.length > 0)
      : [];
    const uniqueEnv = new Map<string, { value: string; secret: boolean }>();
    for (const entry of envEntries) {
      uniqueEnv.set(entry.key, { value: entry.value, secret: entry.secret });
    }
    const env = Array.from(uniqueEnv.entries()).map(([key, e]) => ({
      key,
      value: e.value,
      secret: e.secret
    }));
    assertEnvSetStorable(env);

    const rawPorts =
      Array.isArray(data.ports) && data.ports.length > 0
        ? data.ports
        : [
            {
              name: 'http',
              containerPort:
                data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : 80,
              servicePort:
                data.port && Number.isInteger(data.port) && data.port > 0 ? data.port : 80,
              protocol: 'TCP'
            }
          ];

    const imageName = `${project.namespace}-${name}`;
    const deployment = await this.prisma.deployment.create({
      data: {
        projectId: project.id,
        environmentId: environment.id,
        name,
        namespace: environment.namespace,
        image: `${this.dockerService.getImagePath(imageName, 'pending')}`,
        replicas,
        status: 'pending',
        buildStatus: 'none',
        buildType,
        dockerfilePath: buildType === 'dockerfile' ? dockerfilePath : null,
        dockerfileTarget: buildType === 'dockerfile' ? safeDockerfileTarget(data.target) : null,
        rootDirectory: buildType === 'railpack' ? normalizeRootDirectory(data.rootDirectory) : null,
        framework: data.framework?.trim() || null,
        installCommand: data.installCommand?.trim() || null,
        buildCommand: data.buildCommand?.trim() || null,
        startCommand: data.startCommand?.trim() || null,
        outputDirectory: data.outputDirectory?.trim() || null,
        createdBy: user.id,
        buildLogs: `[INFO] Created local deployment ${name}; waiting for a build context upload (orchard up)\n`,
        cpuRequestMilli: data.cpuRequestMilli ?? null,
        memoryRequestBytes: data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null
      }
    });

    if (env.length > 0) {
      await this.prisma.deploymentEnvVar.createMany({
        data: env.map((entry) => ({
          deploymentId: deployment.id,
          key: entry.key,
          value: this.crypto.encryptIfSecret(entry.value, entry.secret),
          secret: entry.secret
        }))
      });
    }

    const service = await this.prisma.service.create({
      data: {
        deploymentId: deployment.id,
        name,
        type: ServiceType.internal,
        port: rawPorts[0].servicePort,
        targetPort: rawPorts[0].containerPort,
        protocol: rawPorts[0].protocol || 'TCP',
        externalIp: null,
        nodePort: null
      }
    });
    await this.prisma.servicePort.createMany({
      data: rawPorts.map((portEntry) => ({
        serviceId: service.id,
        name: portEntry.name,
        port: portEntry.servicePort,
        targetPort: portEntry.containerPort,
        protocol: portEntry.protocol || 'TCP',
        nodePort: null
      }))
    });

    void this.audit.log({
      action: 'deployment.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: project.organizationId,
      projectId: project.id,
      deploymentId: deployment.id,
      targetType: 'deployment',
      targetId: deployment.id,
      targetLabel: deployment.name,
      metadata: { source: 'local', buildType }
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        pods: true,
        services: { include: { ports: true } },
        envVars: true,
        ingresses: { include: { service: true } },
        project: { include: { organization: true } }
      }
    });
    return this.addInternalUrlsToDeployment(result);
  }

  /**
   * Store an uploaded build-context tarball in the private bucket and kick
   * off the standard in-cluster build with it. Replaces (and deletes) the
   * previous context so each deployment holds at most one object.
   */
  async uploadBuildContextAndBuild(
    deploymentId: string,
    file: { buffer: Buffer; size: number },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    await this.instanceConfig.fresh();
    if (!this.storage.buildContextEnabled()) {
      throw new BadRequestException(LOCAL_DEPLOYS_NEED_S3);
    }

    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: { include: { organization: true } },
        services: { include: { ports: true } },
        volumes: true
      }
    });
    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(
      deployment.projectId,
      user.id,
      'deploy from a local build context'
    );

    if (deployment.githubRepo) {
      throw new BadRequestException('This app builds from GitHub. Push to the repository instead.');
    }
    if (!file?.buffer?.length) {
      throw new BadRequestException('Build context is empty');
    }
    if (file.size > 100 * 1024 * 1024) {
      throw new BadRequestException('Build context exceeds the 100MB limit');
    }
    if (file.buffer[0] !== 0x1f || file.buffer[1] !== 0x8b) {
      throw new BadRequestException('Build context must be a gzipped tarball');
    }

    const sha = createHash('sha256').update(file.buffer).digest('hex');
    const key = `build-contexts/${deployment.project.organizationId}/${deployment.id}/${randomUUID()}.tar.gz`;
    await this.storage.putBuildContext(key, file.buffer);
    const previousKey = deployment.buildContextKey;

    const uniqueTag = newImageTag();
    const imageName = `${deployment.project.namespace}-${deployment.name}`;
    const buildMethodLabel = deployment.buildType === 'railpack' ? 'Railpack' : 'Dockerfile';

    await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        buildContextKey: key,
        buildContextSha: sha,
        status: 'pending',
        buildStatus: 'building',
        buildError: null,
        buildLogs: `[INFO] Starting ${buildMethodLabel} build from uploaded context (${(file.size / 1024 / 1024).toFixed(1)}MB, sha256 ${sha.slice(0, 12)})\n`,
        buildStepTimestamps: { __start: Date.now() }
      }
    });

    if (previousKey && previousKey !== key) {
      this.storage.deleteBuildContext(previousKey).catch(() => {});
    }

    await this.buildQueue
      .recordActiveBuild({
        deploymentId: deployment.id,
        triggerType: 'manual',
        branch: 'local',
        triggeredById: user.id
      })
      .catch((err) =>
        this.logger.warn(`recordActiveBuild failed for ${deployment.id}: ${err?.message ?? err}`)
      );

    const targetService = deployment.services?.[0];
    const rawPorts = targetService?.ports?.length
      ? targetService.ports.map((p) => ({
          name: p.name ?? undefined,
          containerPort: p.targetPort,
          servicePort: p.port,
          protocol: p.protocol
        }))
      : [{ name: 'http', containerPort: 80, servicePort: 80, protocol: 'TCP' }];

    const storedEnv = await this.readOwnEnvVars(deployment.id);
    const sharedVars = await this.loadSharedVarsForDeployment('', deployment.environmentId);
    const { resolved: resolvedEnv } = resolveEnvVars(
      storedEnv,
      sharedVars,
      await this.resourceBindings.valuesFor(deployment.id)
    );

    const volumes = (deployment.volumes ?? []).map((vol) => ({
      name: vol.name,
      type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
      mountPath: vol.mountPath,
      pvcName: vol.pvcName ?? undefined,
      storageSize: vol.storageSize ?? undefined,
      hostPath: vol.hostPath ?? undefined,
      readOnly: vol.readOnly
    }));

    this.buildAndDeployAsync(
      deployment.id,
      {
        repoUrl: '',
        localContextKey: key,
        branch: 'local',
        dockerfilePath: deployment.dockerfilePath ?? undefined,
        buildType: deployment.buildType as 'dockerfile' | 'railpack',
        target: deployment.dockerfileTarget ?? undefined,
        imageName,
        tag: uniqueTag,
        namespace: deployment.namespace,
        name: deployment.name,
        replicas: deployment.replicas,
        rawPorts,
        env: resolvedEnv,
        exposePublic: targetService?.type === ServiceType.external,
        volumes,
        isRebuild: Boolean(previousKey),
        triggerType: 'manual',
        triggeredById: user.id
      },
      null
    ).catch((error) => {
      console.error(`[Projects] Async local build failed for deployment ${deployment.id}:`, error);
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deployment.id },
      include: {
        pods: true,
        services: { include: { ports: true } },
        envVars: true,
        ingresses: { include: { service: true } },
        project: { include: { organization: true } }
      }
    });
    return this.addInternalUrlsToDeployment(result);
  }

  private async getDeploymentProgressUrl(deploymentId: string): Promise<string> {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { project: { select: { organization: { select: { slug: true } } } } }
    });
    const orgSlug = deployment?.project?.organization?.slug;
    return orgSlug
      ? `${frontendUrl}/${orgSlug}/deployments/${deploymentId}/progress`
      : `${frontendUrl}/deployments/${deploymentId}/progress`;
  }

  /**
   * Give a Railpack deployment a start command when it has none and we know it.
   *
   * Railpack does not fail when it cannot work out how to start an app: it
   * warns, and buildkit bakes `CMD ["/bin/bash"]` into the image
   * (convert.go:65), which exits 0 the moment it starts and then
   * CrashLoopBackOffs without ever writing a log line. The builder passes
   * --error-missing-start so that becomes a build failure instead of a silent
   * one, but failing a build we could have completed is no kind of fix: for
   * the frameworks detection recognises, the answer is already known, and a
   * deployment created before detection knew it should not have to be
   * repaired by hand.
   *
   * The command is written to the deployment rather than passed into this one
   * build, so it lands in the build settings as an ordinary editable value
   * instead of materialising out of nowhere on every build. Every failure here
   * is swallowed: this is an improvement to a build, never a precondition for
   * one.
   */
  private async backfillRailpackStartCommand(
    deploymentId: string,
    repoUrl: string,
    branch: string,
    accessToken: string | null | undefined
  ) {
    if (!accessToken) return;

    try {
      const deployment = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { startCommand: true, outputDirectory: true, rootDirectory: true }
      });
      if (!deployment) return;
      // Already answered, by the user, by detection at create time, or by an
      // earlier backfill.
      if (deployment.startCommand) return;
      // A static site is served by Caddy, which supplies its own start command.
      if (deployment.outputDirectory) return;

      const repo = this.githubService.parseRepoUrl(repoUrl);
      if (!repo) return;

      const apps = await this.githubService.detectRepoApps(
        accessToken,
        repo.owner,
        repo.repo,
        branch
      );
      const app = apps.find((a) => a.dir === (deployment.rootDirectory ?? ''));
      if (!app?.startCommand) return;

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { startCommand: app.startCommand }
      });

      const note = `[${Date.now()}] [WARNING] Railpack can't detect a start command for a ${app.framework} app, so this build uses \`${app.startCommand}\`. Change it in the app's build settings.`;
      await this.prisma.$executeRaw`
        UPDATE "deployments"
        SET "build_logs" = COALESCE("build_logs", '') || ${`${note}\n`}
        WHERE "id" = ${deploymentId}::uuid
      `.catch(() => {});
    } catch (error) {
      console.warn(`[Projects] Start command backfill failed for ${deploymentId}:`, error.message);
    }
  }

  /**
   * Read the repo's `HEALTHCHECK`, if it has one, so the probes follow the
   * Dockerfile instead of a second copy of the same intent kept in Orchard.
   *
   * Re-read on every build rather than once at create time: the instruction
   * lives in the repo, so adding, changing or deleting it is a commit, and the
   * probes have to move with it. A build that succeeds must never fail over
   * this, so every error here leaves the last known answer in place.
   */
  private async detectDockerfileHealthCheck(
    deploymentId: string,
    source: {
      repoUrl: string;
      branch: string;
      dockerfilePath: string;
      target?: string | null;
      accessToken?: string | null;
    } | null
  ) {
    try {
      let detected: ReturnType<typeof parseDockerfileHealthCheck> = null;

      if (source) {
        if (!source.accessToken) return;
        const repo = this.githubService.parseRepoUrl(source.repoUrl);
        if (!repo) return;

        const content = await this.githubService.getFileContent(
          source.accessToken,
          repo.owner,
          repo.repo,
          source.dockerfilePath,
          source.branch
        );
        detected = parseDockerfileHealthCheck(content, source.target);
      }

      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          dockerfileHealthCheck: detected
            ? (detected as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull
        }
      });
    } catch (error) {
      console.warn(
        `[Projects] Dockerfile health check detection failed for ${deploymentId}:`,
        error.message
      );
    }
  }

  /**
   * The volumes a deployment should be running with, read now.
   *
   * The build path is handed a snapshot of these when the build is queued, and
   * a build can run for many minutes. A volume attached while one is in flight
   * would be lost twice over: the deploy step applies the stale snapshot, and
   * every later rebuild only patches the image, so the volume-less pod spec
   * survives until something re-applies the volumes by hand. Anything writing to
   * that mount path in between goes to the node's disk and disappears with the
   * pod.
   */
  private async currentVolumes(deploymentId: string) {
    const rows = await this.prisma.deploymentVolume.findMany({ where: { deploymentId } });
    return rows.map((vol) => ({
      name: vol.name,
      type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
      mountPath: vol.mountPath,
      pvcName: vol.pvcName || undefined,
      storageSize: vol.storageSize || undefined,
      hostPath: vol.hostPath || undefined,
      readOnly: vol.readOnly
    }));
  }

  /**
   * Bring a live Deployment's volumes back in line with the database.
   *
   * Only patches when they actually differ: the patch stamps an annotation
   * that changes the pod template, so calling it unconditionally would add a
   * rollout to every single rebuild.
   */
  private async reconcileVolumes(
    deploymentId: string,
    name: string,
    namespace: string,
    deployStrategy: DeployStrategy
  ): Promise<void> {
    try {
      const desired = await this.currentVolumes(deploymentId);
      const live = await this.k8sWorkload.getDeploymentVolumeSignature(
        name,
        namespace,
        desired.map((volume) => volume.name)
      );
      if (live === null) return;
      if (live === K8sWorkloadService.volumeSignature(desired)) return;

      console.warn(
        `[Deployment/volumes] ${namespace}/${name} drifted from its configured volumes, re-applying`
      );
      await this.k8sWorkload.updateDeploymentVolumes({
        namespace,
        deploymentName: name,
        volumes: desired,
        deployStrategy:
          desired.some((v) => v.type === 'pvc') || deployStrategy === 'recreate'
            ? 'recreate'
            : 'rollingUpdate'
      });
    } catch (e: any) {
      console.error(`[Deployment/volumes] could not reconcile ${namespace}/${name}: ${e?.message}`);
    }
  }

  async buildAndDeployAsync(
    deploymentId: string,
    data: {
      repoUrl: string;
      branch: string;
      dockerfilePath?: string;
      target?: string;
      buildFromRoot?: boolean;
      buildWithDepot?: boolean;
      persistentBuildCache?: boolean;
      buildType?: 'dockerfile' | 'railpack';
      imageName: string;
      tag: string;
      namespace: string;
      name: string;
      replicas: number;
      rawPorts: any[];
      env: any[];
      exposePublic: boolean;
      volumes?: any[];
      isRebuild?: boolean;
      // GitHub Deployments API support (legacy)
      commitSha?: string;
      commitMessage?: string;
      commitAuthorName?: string;
      commitAuthorUsername?: string;
      githubDeploymentId?: number | null;
      githubAccessToken?: string | null;
      repoInfo?: { owner: string; repo: string } | null;
      // GitHub Checks API support (via App)
      checkRunId?: number | null;
      checkLogUrl?: string | null;
      installationId?: string | null;
      // Build trigger info
      triggerType?: string;
      triggeredById?: string;
      // Local-upload builds: R2 key of the uploaded context tarball. A
      // presigned GET is minted just before job creation.
      localContextKey?: string;
    },
    githubAccessToken?: string
  ) {
    console.log(`[Projects] Starting buildAndDeployAsync for deployment ${deploymentId}`);

    // One Datadog APM trace per build (service: orchard-builds): duration,
    // start time, outcome, and user-vs-system failure classification.
    const buildTrace = startBuildTrace({
      deploymentId,
      deploymentName: data.name,
      namespace: data.namespace,
      repoUrl: data.repoUrl,
      branch: data.branch,
      commitSha: data.commitSha,
      buildType: data.buildType,
      triggerType: data.triggerType,
      triggeredById: data.triggeredById,
      isRebuild: data.isRebuild
    });

    try {
      await this.dockerService.cancelBuildJobsByDeploymentId(deploymentId);
    } catch (error) {
      console.warn(`[Projects] Failed to cancel existing build jobs:`, error);
    }

    // Build logs never leave Orchard: check run output only carries the
    // current step and a link. On public repos the check output is visible
    // to everyone, and build logs can leak submodule URLs, file listings,
    // and whatever the build prints.
    let logUpdateInterval: NodeJS.Timeout | null = null;
    let lastStep: string | null = null;

    if (data.checkRunId && data.installationId && data.repoInfo) {
      logUpdateInterval = setInterval(async () => {
        try {
          const currentDeployment = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { buildStep: true }
          });

          const step = currentDeployment?.buildStep ?? null;
          if (step === lastStep) return;
          lastStep = step;

          const stepLabels: Record<string, string> = {
            cloning: 'Scheduling builder...',
            building: 'Building image...',
            pushing: 'Pushing to registry...',
            deploying: 'Deploying to cluster...'
          };
          const stepLabel = stepLabels[step ?? ''] || 'Building...';

          await this.githubService.updateCheckRun(
            BigInt(data.installationId),
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.checkRunId,
            {
              status: 'in_progress',
              output: {
                title: stepLabel,
                summary: `Deploying \`${data.name}\` from commit \`${data.commitSha?.substring(0, 7) || 'unknown'}\``,
                text: data.checkLogUrl
                  ? `[View the full build log in Orchard](${data.checkLogUrl})`
                  : 'Open the app in Orchard to see the full build log.'
              }
            }
          );
        } catch (err) {
          console.error(`[Projects] Failed to update check run step: ${err.message}`);
        }
      }, 10000);
    }

    const cloneToken =
      githubAccessToken ??
      data.githubAccessToken ??
      (data.localContextKey
        ? undefined
        : ((await this.gitConnections.cloneTokenForDeployment(deploymentId)) ?? undefined));

    try {
      const buildTypeLabel = data.buildType === 'railpack' ? 'Railpack' : 'Dockerfile';
      console.log(
        `[Projects] Building image from GitHub using ${buildTypeLabel}: ${data.repoUrl}@${data.branch} -> ${data.imageName}:${data.tag}${data.target ? ` (target: ${data.target})` : ''}`,
        {
          deploymentId,
          dockerfilePath: data.dockerfilePath,
          buildFromRoot: data.buildFromRoot,
          hasAccessToken: !!cloneToken,
          isRebuild: data.isRebuild
        }
      );

      // Before the builder reads the deployment row, not after: docker.service
      // assembles the RAILPACK_* overrides from that row on every trigger
      // (loadBuildEnv), so writing the start command here is all it takes for
      // this build to use it.
      if (data.buildType === 'railpack' && !data.localContextKey) {
        await this.backfillRailpackStartCommand(
          deploymentId,
          data.repoUrl,
          data.branch,
          cloneToken
        );
      }

      // Read before the deploy step, which resolves the probes from the
      // deployment row: an edited HEALTHCHECK lands with the build that
      // carries it, not one build late. A Railpack build has no Dockerfile at
      // all and a local-context build ships one Orchard never sees, so either
      // way anything read from an earlier build is dropped rather than left
      // probing an image that never had the command.
      const readsDockerfile = data.buildType !== 'railpack' && !data.localContextKey;
      await this.detectDockerfileHealthCheck(
        deploymentId,
        readsDockerfile
          ? {
              repoUrl: data.repoUrl,
              branch: data.branch,
              dockerfilePath: data.dockerfilePath || 'Dockerfile',
              target: data.target,
              accessToken: cloneToken
            }
          : null
      );

      const buildStartTime = Date.now();

      let localContextUrl: string | undefined;
      if (data.localContextKey) {
        localContextUrl = await this.storage.signBuildContextGet(data.localContextKey, 15 * 60);
      }

      const builder = data.buildWithDepot
        ? undefined
        : ((await this.buildQueue.currentBuilder(deploymentId).catch(() => null)) ?? undefined);

      const image = await buildTrace.activate(() =>
        this.dockerService.buildAndPushFromGitHub({
          repoUrl: data.repoUrl,
          localContextUrl,
          branch: data.branch,
          dockerfilePath: data.dockerfilePath || 'Dockerfile',
          target: data.target,
          buildFromRoot: data.buildFromRoot,
          buildWithDepot: data.buildWithDepot,
          persistentBuildCache: data.persistentBuildCache,
          buildType: data.buildType,
          imageName: data.imageName,
          tag: data.tag,
          deploymentId,
          accessToken: cloneToken,
          // Scope this build's slice of the shared buildkit-cache PVC to the
          // project namespace. Kata's mount surface ⇒ the build VM only sees
          // this directory and can't reach other tenants' cache entries.
          cacheTenantKey: data.namespace,
          builder
        })
      );

      const buildCompletedAt = new Date();
      const buildDuration = Math.floor((buildCompletedAt.getTime() - buildStartTime) / 1000);
      console.log(
        `[Projects] Built and pushed image: ${image}, ${data.isRebuild ? 'updating' : 'creating'} Kubernetes resources (build took ${buildDuration}s)`
      );

      const [, k8sDeploymentExists] = await Promise.all([
        (async () => {
          const tsData = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { buildStepTimestamps: true }
          });
          const ts = (tsData?.buildStepTimestamps as Record<string, any> | null) || {};
          ts['deploying'] = Date.now();
          await this.prisma.deployment.update({
            where: { id: deploymentId },
            data: { image, buildStep: 'deploying', buildStepTimestamps: ts }
          });
        })(),
        this.k8sWorkload.getKubernetesDeployment(data.name, data.namespace).then((d) => d !== null)
      ]);

      this.prisma.$executeRaw`
        UPDATE "deployments"
        SET "build_logs" = COALESCE("build_logs", '') || '[INFO] Creating Kubernetes deployment...\n'
        WHERE "id" = ${deploymentId}::uuid
      `.catch(() => {});

      const saveImageHistory = () =>
        this.prisma
          .$transaction(async (tx) => {
            await tx.imageHistory.updateMany({
              where: { deploymentId, isActive: true },
              data: { isActive: false }
            });

            const deployment = await tx.deployment.findUnique({
              where: { id: deploymentId },
              select: { buildLogs: true }
            });

            await tx.imageHistory.create({
              data: {
                deploymentId,
                image,
                tag: data.tag,
                commitSha: data.commitSha || null,
                commitMessage: data.commitMessage || null,
                commitAuthorName: data.commitAuthorName || null,
                commitAuthorUsername: data.commitAuthorUsername || null,
                branch: data.branch,
                buildLogs: deployment?.buildLogs || null,
                buildStartedAt: new Date(buildStartTime),
                buildCompletedAt,
                triggerType: data.triggerType || null,
                triggeredById: data.triggeredById || null,
                isActive: true
              }
            });

            const allImages = await tx.imageHistory.findMany({
              where: { deploymentId },
              orderBy: { createdAt: 'desc' },
              select: { id: true }
            });

            if (allImages.length > 10) {
              await tx.imageHistory.deleteMany({
                where: { id: { in: allImages.slice(10).map((img) => img.id) } }
              });
            }
          })
          .then(() => this.registryPrune?.pruneSoon(image))
          .catch((err) => {
            console.error('[Projects] Image history save failed:', err);
          });

      let deploymentResult: any;
      let shouldCreateNew = false;

      const rolloutRow = await this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { deployStrategy: true }
      });
      const rolloutStrategy: DeployStrategy =
        (rolloutRow?.deployStrategy as DeployStrategy | undefined) ?? 'rollingUpdate';

      if (data.isRebuild && k8sDeploymentExists) {
        const healthCheck = await this.resolveStoredHealthCheck(deploymentId);
        const startArgs = await this.loadStartArgs(deploymentId);
        const rolloutResources = await this.rolloutSizing(deploymentId);
        if (rolloutStrategy === 'blueGreen') {
          await this.runBlueGreen(
            deploymentId,
            data.name,
            data.namespace,
            image,
            healthCheck,
            startArgs,
            rolloutResources
          );
        } else {
          await this.k8sWorkload.updateDeploymentImage(
            data.name,
            data.namespace,
            image,
            healthCheck,
            startArgs,
            rolloutResources
          );
        }

        await this.syncReplicasForRebuild(deploymentId, data.name, data.namespace, data.replicas);

        // Image-only rebuild keeps the existing spec, so re-apply the stored
        // env to heal deployments whose pod spec drifted from the config,
        // every removal made before env updates replaced (rather than merged)
        // the container's env list is still sitting on the live object.
        const rebuildDeployment = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { environmentId: true }
        });
        const { resolved: rebuildEnv } = await this.loadResolvedEnvForDeployment(
          deploymentId,
          rebuildDeployment?.environmentId ?? null
        );
        await this.k8sWorkload
          .updateDeploymentEnv({
            namespace: data.namespace,
            deploymentName: data.name,
            env: rebuildEnv
          })
          .catch((err) => {
            console.error('[Projects] re-applying env on rebuild failed:', err.message);
          });

        const existingDeploymentDb = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          include: { services: { include: { ports: true } } }
        });
        deploymentResult = {
          ports: existingDeploymentDb?.services[0]?.ports || [],
          externalIp: existingDeploymentDb?.services[0]?.externalIp || null
        };

        const deploymentRow = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { projectId: true, cpuRequestMilli: true, memoryRequestBytes: true }
        });
        if (deploymentRow) {
          const isUnlimitedDeploy =
            deploymentRow.cpuRequestMilli === 0 &&
            (deploymentRow.memoryRequestBytes === BigInt(0) ||
              deploymentRow.memoryRequestBytes === null);
          if (!isUnlimitedDeploy) {
            this.quotasService.applyProjectQuota(deploymentRow.projectId).catch((err) => {
              console.error('[Projects] applyProjectQuota failed:', err);
            });
          }
        }
      } else {
        const deploymentRow = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: {
            id: true,
            image: true,
            projectId: true,
            replicas: true,
            stopped: true,
            cpuRequestMilli: true,
            memoryRequestBytes: true,
            deployStrategy: true,
            imagePullPolicy: true,
            pdbMinAvailable: true,
            devices: true,
            nodePoolId: true,
            placementOverride: true,
            project: { select: { organizationId: true, ownerId: true } }
          }
        });
        const buildStrategy: DeployStrategy =
          (deploymentRow?.deployStrategy as DeployStrategy | undefined) ?? 'rollingUpdate';
        const buildPullPolicy = resolvePullPolicy(deploymentRow?.imagePullPolicy, image);
        const deployPlacement = deploymentRow
          ? await this.resolvePlacementForProject(deploymentRow.projectId)
          : { allowedNodes: null as string[] | null, deniedNodes: [] as string[] };
        const deployPool = await this.nodesService.resolvePool(deploymentRow?.nodePoolId ?? null);
        const deployOverride = this.nodesService.toPlacementOverride(
          deploymentRow?.placementOverride ?? null
        );

        let rebuildResources: PodSizing | undefined;
        const isUnlimitedDeploy =
          deploymentRow?.cpuRequestMilli === 0 &&
          (deploymentRow?.memoryRequestBytes === BigInt(0) ||
            deploymentRow?.memoryRequestBytes === null);
        if (deploymentRow && !isUnlimitedDeploy) {
          rebuildResources = await this.quotasService.resolvePodResources(
            deploymentRow.projectId,
            {
              cpuRequestMilli: deploymentRow.cpuRequestMilli,
              memoryRequestBytes: deploymentRow.memoryRequestBytes
                ? Number(deploymentRow.memoryRequestBytes)
                : null
            },
            deploymentRow.image
          );
          if (!k8sDeploymentExists && !deploymentRow.stopped) {
            await this.quotasService.enforceOrgCapForNewPod(deploymentRow.project.organizationId, {
              cpuMilli: rebuildResources.cpuMilli * (deploymentRow.replicas || 1),
              memoryBytes: rebuildResources.memoryBytes * (deploymentRow.replicas || 1)
            });
            await this.quotasService.enforceProjectCapForNewPod(
              deploymentRow.projectId,
              {
                cpuMilli: rebuildResources.cpuMilli * (deploymentRow.replicas || 1),
                memoryBytes: rebuildResources.memoryBytes * (deploymentRow.replicas || 1),
                pods: deploymentRow.replicas || 1
              },
              deploymentRow.id
            );
            await this.quotasService.enforceMemberAllowanceForNewPod(
              deploymentRow.project.organizationId,
              deploymentRow.project.ownerId,
              {
                cpuMilli: rebuildResources.cpuMilli * (deploymentRow.replicas || 1),
                memoryBytes: rebuildResources.memoryBytes * (deploymentRow.replicas || 1)
              },
              deploymentRow.id
            );
          }
          await this.quotasService.applyProjectQuota(deploymentRow.projectId).catch((err) => {
            console.error('[Projects] applyProjectQuota failed:', err);
          });
        }
        const rolloutResources = deploymentRow
          ? await this.quotasService.prepareRollout(deploymentRow)
          : undefined;
        rebuildResources = rolloutResources ?? rebuildResources;

        shouldCreateNew = !data.isRebuild || !k8sDeploymentExists;
        if (data.isRebuild && !k8sDeploymentExists) {
          const existingDeploymentDb = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            include: { services: { include: { ports: true } } }
          });
          const hasServices =
            existingDeploymentDb?.services && existingDeploymentDb.services.length > 0;
          if (!hasServices) {
            shouldCreateNew = true;
          }
        }

        // Read now, not from the snapshot taken when the build was queued: a
        // volume attached mid-build has to reach the pod this build creates.
        const desiredVolumes = await this.currentVolumes(deploymentId);

        await this.checkpointBoundDatabases(deploymentId, image, data.triggeredById ?? null);

        if (shouldCreateNew) {
          const healthCheck = await this.loadHealthCheckOptions(deploymentId);
          const startArgs = await this.loadStartArgs(deploymentId);
          deploymentResult = await this.k8sWorkload.createDeployment({
            namespace: data.namespace,
            name: data.name,
            image,
            args: startArgs,
            replicas: deploymentRow?.stopped ? 0 : data.replicas,
            ports: data.rawPorts,
            env: data.env,
            serviceType: data.exposePublic ? 'NodePort' : 'ClusterIP',
            volumes: desiredVolumes,
            allowedNodes: deployPlacement.allowedNodes,
            deniedNodes: deployPlacement.deniedNodes,
            pool: deployPool,
            placementOverride: deployOverride,
            resources: rebuildResources,
            deployStrategy: buildStrategy,
            imagePullPolicy: buildPullPolicy,
            pdbMinAvailable: deploymentRow?.pdbMinAvailable ?? 1,
            devices: storedDevices(deploymentRow?.devices),
            healthCheck
          });
        } else {
          const healthCheck = await this.resolveStoredHealthCheck(deploymentId);
          const startArgs = await this.loadStartArgs(deploymentId);
          if (rolloutStrategy === 'blueGreen') {
            await this.runBlueGreen(
              deploymentId,
              data.name,
              data.namespace,
              image,
              healthCheck,
              startArgs,
              rolloutResources
            );
          } else {
            await this.k8sWorkload.updateDeploymentImage(
              data.name,
              data.namespace,
              image,
              healthCheck,
              startArgs,
              rolloutResources
            );
          }
          // A rebuild patches the image and nothing else, so it is also the
          // only chance to notice the running spec has drifted from what was
          // configured while a build was in flight.
          await this.reconcileVolumes(
            deploymentId,
            data.name,
            data.namespace,
            buildStrategy === 'recreate' ? 'recreate' : 'rollingUpdate'
          );
          const existingDeploymentDb = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            include: { services: { include: { ports: true } } }
          });
          deploymentResult = {
            ports: existingDeploymentDb?.services[0]?.ports || [],
            externalIp: existingDeploymentDb?.services[0]?.externalIp || null
          };
        }
      }

      const stillStopped = await this.prisma.deployment
        .findUnique({ where: { id: deploymentId }, select: { stopped: true } })
        .then((row) => row?.stopped ?? false);
      if (stillStopped) {
        await this.appendBuildLog(deploymentId, 'App is stopped; the new image waits for Start');
      } else if (rolloutStrategy !== 'blueGreen') {
        await this.appendBuildLog(
          deploymentId,
          'Image applied; Kubernetes is rolling the new pods out'
        );
      }

      await saveImageHistory();
      const liveHistory = await this.prisma.imageHistory.findFirst({
        where: { deploymentId, isActive: true },
        orderBy: { createdAt: 'desc' },
        select: { id: true }
      });
      await this.releases.record(deploymentId, {
        image,
        imageHistoryId: liveHistory?.id ?? null,
        strategy: rolloutStrategy,
        status: 'live',
        createdById: data.triggeredById ?? null
      });

      if (!data.isRebuild || shouldCreateNew) {
        // Update service records with K8s-assigned values (nodePort, externalIp)
        // or create them if they don't exist yet.
        await this.prisma.$transaction(async (tx) => {
          const existingDeployment = await tx.deployment.findUnique({
            where: { id: deploymentId },
            include: { services: { include: { ports: true } } }
          });

          const hasServices =
            existingDeployment?.services && existingDeployment.services.length > 0;

          if (hasServices) {
            // Services were created upfront: update with K8s-assigned values
            const normalizedPorts = deploymentResult.ports || [];
            const existingService = existingDeployment!.services[0];
            const primaryPort = normalizedPorts[0];
            const primaryNodePort = primaryPort?.nodePort ?? null;
            const externalIp = deploymentResult.externalIp || null;

            await tx.service.update({
              where: { id: existingService.id },
              data: {
                nodePort: primaryNodePort,
                externalIp
              }
            });

            // Update each port with its K8s-assigned nodePort
            for (const existingPort of existingService.ports) {
              const matchingPort = normalizedPorts.find(
                (p) =>
                  p.containerPort === existingPort.targetPort &&
                  p.protocol === existingPort.protocol
              );
              if (matchingPort?.nodePort) {
                await tx.servicePort.update({
                  where: { id: existingPort.id },
                  data: { nodePort: matchingPort.nodePort }
                });
              }
            }
          } else {
            // No services exist: create them (legacy path for old deployments)
            const normalizedPorts = deploymentResult.ports || [];
            const primaryPort = normalizedPorts[0] || {
              name: 'http',
              containerPort: 80,
              servicePort: 80,
              protocol: 'TCP',
              nodePort: null
            };
            const primaryNodePort =
              primaryPort.nodePort !== undefined && primaryPort.nodePort !== null
                ? primaryPort.nodePort
                : null;

            const serviceType = data.exposePublic ? ServiceType.external : ServiceType.internal;
            const externalIp = deploymentResult.externalIp || null;

            const service = await tx.service.create({
              data: {
                deploymentId,
                name: data.name,
                type: serviceType,
                port: primaryPort.servicePort,
                targetPort: primaryPort.containerPort,
                protocol: primaryPort.protocol,
                externalIp,
                nodePort: primaryNodePort
              }
            });

            if (normalizedPorts.length > 0) {
              await tx.servicePort.createMany({
                data: normalizedPorts.map((portEntry) => ({
                  serviceId: service.id,
                  name: portEntry.name,
                  port: portEntry.servicePort,
                  targetPort: portEntry.containerPort,
                  protocol: portEntry.protocol,
                  nodePort:
                    portEntry.nodePort !== undefined && portEntry.nodePort !== null
                      ? portEntry.nodePort
                      : null
                }))
              });
            }
          }

          const txDeployData = await tx.deployment.findUnique({
            where: { id: deploymentId },
            select: { buildLogs: true, buildStepTimestamps: true }
          });
          const txTimestamps =
            (txDeployData?.buildStepTimestamps as Record<string, number> | null) || {};
          txTimestamps['complete'] = Date.now();
          await tx.deployment.update({
            where: { id: deploymentId },
            data: {
              status: 'running',
              buildStatus: 'succeeded',
              buildStep: 'complete',
              buildLogs: `${txDeployData?.buildLogs || ''}\nDeployment is live.`,
              buildStepTimestamps: txTimestamps
            }
          });
        });
      } else {
        // For rebuilds where deployment already existed, just update the status
        const rebuildData = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { buildLogs: true, buildStepTimestamps: true }
        });
        const rebuildTimestamps =
          (rebuildData?.buildStepTimestamps as Record<string, number> | null) || {};
        rebuildTimestamps['complete'] = Date.now();
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'running',
            buildStatus: 'succeeded',
            buildStep: 'complete',
            buildLogs: `${rebuildData?.buildLogs || ''}\nRebuild complete. Deployment is live.`,
            buildStepTimestamps: rebuildTimestamps
          }
        });
      }

      console.log(`[Projects] Deployment ${deploymentId} completed successfully`);
      void this.emitPipelineMetrics(deploymentId, true);

      this.notifications
        .notifyDeploy(deploymentId, 'succeeded')
        .catch((err) =>
          this.logger.warn(`deploy notification failed for ${deploymentId}: ${err?.message ?? err}`)
        );

      this.buildQueue
        .onBuildFinished(deploymentId)
        .catch((err) =>
          this.logger.warn(`build queue release failed for ${deploymentId}: ${err?.message ?? err}`)
        );

      if (data.githubDeploymentId && data.repoInfo && data.githubAccessToken) {
        try {
          const deploymentWithIngress = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            include: { ingresses: true }
          });
          const environmentUrl = deploymentWithIngress?.ingresses?.[0]?.host
            ? `https://${deploymentWithIngress.ingresses[0].host}`
            : undefined;

          await this.githubService.updateDeploymentStatus(
            data.githubAccessToken,
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.githubDeploymentId,
            'success',
            {
              logUrl: await this.getDeploymentProgressUrl(deploymentId),
              environmentUrl,
              description: 'Deployment successful!'
            }
          );

          await this.prisma.gitHubDeployment.updateMany({
            where: {
              deploymentId,
              githubDeploymentId: BigInt(data.githubDeploymentId)
            },
            data: {
              status: 'success',
              environmentUrl
            }
          });
        } catch (err) {
          console.error(`[Projects] Failed to update GitHub deployment status: ${err.message}`);
        }
      }

      if (logUpdateInterval) {
        clearInterval(logUpdateInterval);
        logUpdateInterval = null;
      }

      if (data.checkRunId && data.installationId && data.repoInfo) {
        try {
          const finalDeployment = await this.prisma.deployment.findUnique({
            where: { id: deploymentId },
            select: { ingresses: { select: { host: true } } }
          });

          const environmentUrl = finalDeployment?.ingresses?.[0]?.host
            ? `https://${finalDeployment.ingresses[0].host}`
            : undefined;

          await this.githubService.updateCheckRun(
            BigInt(data.installationId),
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.checkRunId,
            {
              status: 'completed',
              conclusion: 'success',
              output: {
                title: 'Deployment Successful',
                summary: environmentUrl
                  ? `\`${data.name}\` is live at [${environmentUrl}](${environmentUrl}).`
                  : `\`${data.name}\` deployed successfully.`,
                text: data.checkLogUrl
                  ? `[View the full build log in Orchard](${data.checkLogUrl})`
                  : 'Open the app in Orchard to see the full build log.'
              }
            }
          );

          console.log(`[Projects] Updated GitHub check run ${data.checkRunId} to success`);
        } catch (err) {
          console.error(`[Projects] Failed to update GitHub check run: ${err.message}`);
        }
      }

      if (data.installationId && data.repoInfo) {
        try {
          const ghDeployment = await this.prisma.gitHubDeployment.findFirst({
            where: { deploymentId, status: 'in_progress' },
            orderBy: { createdAt: 'desc' }
          });

          if (ghDeployment) {
            const finalDeploymentData = await this.prisma.deployment.findUnique({
              where: { id: deploymentId },
              include: { ingresses: true }
            });
            const environmentUrl = finalDeploymentData?.ingresses?.[0]?.host
              ? `https://${finalDeploymentData.ingresses[0].host}`
              : undefined;

            await this.githubService.updateDeploymentStatusWithApp(
              BigInt(data.installationId),
              data.repoInfo.owner,
              data.repoInfo.repo,
              Number(ghDeployment.githubDeploymentId),
              'success',
              {
                logUrl: await this.getDeploymentProgressUrl(deploymentId),
                environmentUrl,
                description: 'Deployment successful!'
              }
            );

            await this.prisma.gitHubDeployment.update({
              where: { id: ghDeployment.id },
              data: { status: 'success', environmentUrl }
            });

            console.log(
              `[Projects] Updated GitHub deployment ${ghDeployment.githubDeploymentId} to success`
            );
          }
        } catch (err) {
          console.error(`[Projects] Failed to update GitHub deployment: ${err.message}`);
        }
      }

      buildTrace.finishSuccess({ 'build.image_seconds': buildDuration });
    } catch (error) {
      if (logUpdateInterval) {
        clearInterval(logUpdateInterval);
        logUpdateInterval = null;
      }

      const errorDetails = {
        deploymentId,
        imageName: data.imageName,
        tag: data.tag,
        repoUrl: data.repoUrl,
        branch: data.branch,
        buildType: data.buildType,
        errorMessage: error.message,
        errorType: error.constructor.name,
        errorStack: error.stack,
        statusCode: error.statusCode || error.status,
        response: error.response,
        isRebuild: data.isRebuild
      };

      console.error(`[Projects] Build failed for deployment ${deploymentId}:`, errorDetails);
      void this.emitPipelineMetrics(deploymentId, false, error?.message);

      try {
        const currentDeployment = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { buildLogs: true, buildStep: true, status: true, buildStatus: true }
        });

        buildTrace.finishFailure(error, currentDeployment?.buildStep ?? undefined);

        // Don't overwrite a successful build status from a newer build
        if (currentDeployment?.buildStatus === 'succeeded') {
          console.log(
            `[Projects] Deployment ${deploymentId} already has a succeeded build (likely from a newer build), skipping error status update`
          );
          return;
        }

        const errorLogEntry = `\n❌ Build failed at step '${currentDeployment?.buildStep || 'unknown'}'\nError: ${error.message}\n`;

        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: {
            buildStatus: 'failed',
            buildError: error.message,
            buildLogs: (currentDeployment?.buildLogs || '') + errorLogEntry
          }
        });

        this.buildQueue
          .onBuildFinished(deploymentId)
          .catch((relErr) =>
            this.logger.warn(
              `build queue release failed for ${deploymentId}: ${relErr?.message ?? relErr}`
            )
          );
      } catch (dbErr) {
        buildTrace.finishFailure(error); // no-op if already finished above
        console.error(`[Projects] Failed to update error status in database:`, {
          deploymentId,
          dbError: dbErr.message,
          originalError: error.message
        });
      }

      // Update GitHub deployment status to failure (legacy - user token)
      if (data.githubDeploymentId && data.repoInfo && data.githubAccessToken) {
        try {
          await this.githubService.updateDeploymentStatus(
            data.githubAccessToken,
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.githubDeploymentId,
            'failure',
            {
              logUrl: await this.getDeploymentProgressUrl(deploymentId),
              description: `Build failed: ${error.message?.substring(0, 100)}`
            }
          );

          await this.prisma.gitHubDeployment.updateMany({
            where: {
              deploymentId,
              githubDeploymentId: BigInt(data.githubDeploymentId)
            },
            data: {
              status: 'failure'
            }
          });
        } catch (ghErr) {
          console.error(`[Projects] Failed to update GitHub deployment status: ${ghErr.message}`);
        }
      }

      if (data.installationId && data.repoInfo) {
        try {
          const ghDeployment = await this.prisma.gitHubDeployment.findFirst({
            where: { deploymentId, status: 'in_progress' },
            orderBy: { createdAt: 'desc' }
          });

          if (ghDeployment) {
            await this.githubService.updateDeploymentStatusWithApp(
              BigInt(data.installationId),
              data.repoInfo.owner,
              data.repoInfo.repo,
              Number(ghDeployment.githubDeploymentId),
              'failure',
              {
                logUrl: await this.getDeploymentProgressUrl(deploymentId),
                description: `Build failed: ${error.message?.substring(0, 100)}`
              }
            );

            await this.prisma.gitHubDeployment.update({
              where: { id: ghDeployment.id },
              data: { status: 'failure' }
            });

            console.log(
              `[Projects] Updated GitHub deployment ${ghDeployment.githubDeploymentId} to failure`
            );
          }
        } catch (ghErr) {
          console.error(`[Projects] Failed to update GitHub deployment: ${ghErr.message}`);
        }
      }

      if (data.checkRunId && data.installationId && data.repoInfo) {
        try {
          await this.githubService.updateCheckRun(
            BigInt(data.installationId),
            data.repoInfo.owner,
            data.repoInfo.repo,
            data.checkRunId,
            {
              status: 'completed',
              conclusion: 'failure',
              output: {
                title: 'Deployment Failed',
                summary: `❌ Failed to deploy \`${data.name}\`: ${error.message?.substring(0, 200) || 'Unknown error'}`,
                text: data.checkLogUrl
                  ? `[View the full build log in Orchard](${data.checkLogUrl})`
                  : 'Open the app in Orchard to see the full build log.'
              }
            }
          );

          console.log(`[Projects] Updated GitHub check run ${data.checkRunId} to failure`);
        } catch (ghErr) {
          console.error(`[Projects] Failed to update GitHub check run: ${ghErr.message}`);
        }
      }
    }
  }

  private async checkpointBoundDatabases(
    deploymentId: string,
    image: string,
    userId: string | null
  ) {
    if (!this.checkpoints) return;
    const bound = await this.prisma.resourceBinding.findMany({
      where: { deploymentId, resourceType: 'database' },
      select: { resourceId: true }
    });
    if (bound.length === 0) return;
    const tag = image.split('/').pop()?.slice(0, 80) ?? image.slice(0, 80);
    const work = this.checkpoints
      .create(
        bound.map((b) => b.resourceId),
        {
          kind: 'pre_deploy',
          label: `Before deploying ${tag}`,
          createdBy: userId,
          deploymentId,
          releaseId: image.slice(0, 100)
        }
      )
      .then((res) => {
        const ok = res.checkpoints.filter((c: any) => c.status !== 'failed').length;
        return this.appendBuildLog(
          deploymentId,
          `Checkpointed ${ok} of ${bound.length} bound database${bound.length === 1 ? '' : 's'} before rollout`
        );
      })
      .catch((e) =>
        this.appendBuildLog(
          deploymentId,
          `WARNING: database checkpoint before rollout failed: ${e?.message ?? e}`
        )
      );
    await Promise.race([work, new Promise((r) => setTimeout(r, 15_000).unref?.())]);
  }

  async rebuildFromQueue(deploymentId: string, triggeredById: string | null, runId: string) {
    const user = triggeredById ? await this.usersService.findById(triggeredById) : null;
    if (!user) {
      throw new NotFoundException('Triggering user for queued rebuild not found');
    }
    return this.rebuildDeployment(deploymentId, user.externalAuthId ?? user.id, undefined, runId);
  }

  /**
   * What a caller is told when a rebuild is accepted but cannot start yet.
   *
   * `accepted` is deliberately separate from `started`: the request did
   * something, it just has not produced a build yet, and an agent polling for a
   * new build record needs to know which of those it is looking at.
   */
  private static queuedBuild(runId: string, queue: QueueSnapshot) {
    const reason = queue.blockedByOwnBuild
      ? 'This app is already building. The queued build starts when that one finishes.'
      : queue.blockedByOrgCap
        ? 'This organization is already using its share of the build slots. The queued build starts when one of its builds finishes.'
        : queue.blockedByVmCap
          ? "Other apps in this environment are using all of its builder's slots. The queued build starts when one of them finishes."
          : `All ${queue.limit} build ${queue.limit === 1 ? 'slot is' : 'slots are'} busy on this instance.`;
    return {
      accepted: true,
      started: false,
      status: 'queued' as const,
      runId,
      waiting: queue.waiting,
      running: queue.running,
      slots: queue.limit,
      pool: queue.pool,
      message:
        `${reason} It starts automatically, so don't retry. ` +
        `Poll this deployment's build status, or list_deployment_errors, rather than calling rebuild again.`
    };
  }

  private async githubCloneToken(input: {
    userId: string;
    repoUrl: string | null | undefined;
    branch: string | null | undefined;
    boundInstallationId: bigint | null;
    linkedBy: string | null;
  }): Promise<string | undefined> {
    const repoInfo = input.repoUrl ? this.githubService.parseRepoUrl(input.repoUrl) : null;
    if (repoInfo) {
      try {
        const access = await this.githubService.resolveCloneAccess({
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          branch: input.branch || 'main',
          boundInstallationId: input.boundInstallationId,
          linkedBy: input.linkedBy
        });
        if (access) return access.token;
      } catch (e) {
        console.warn(
          `[Projects] Installation clone token failed for ${repoInfo.owner}/${repoInfo.repo}, using user token: ${(e as Error).message}`
        );
      }
    }
    return (await this.githubService.getValidUserToken(input.userId)) ?? undefined;
  }

  async rebuildDeployment(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    fromQueueRunId?: string
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        },
        envVars: true,
        volumes: true,
        services: {
          include: {
            ports: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'rebuild deployments');

    if (!deployment.githubRepo || !deployment.githubBranch) {
      throw new BadRequestException("This app wasn't created from GitHub");
    }

    // For dockerfile builds, dockerfilePath is required
    if (deployment.buildType === 'dockerfile' && !deployment.dockerfilePath) {
      throw new BadRequestException('This app has no Dockerfile path');
    }

    if (!fromQueueRunId && deployment.stopped) {
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { replicas: Math.max(1, deployment.replicas), stopped: false, pendingPush: null }
      });
    }

    if (!fromQueueRunId) {
      const { startNow, runId, queue } = await this.buildQueue.enqueue({
        deploymentId,
        triggerType: 'manual',
        branch: deployment.githubBranch,
        triggeredById: user.id
      });
      if (!startNow) {
        console.log(`[Projects] Queued manual rebuild for ${deploymentId}`);
        // Returned with the queue state attached. Handing back the unchanged
        // deployment on its own is why a queued rebuild read as a silent no-op
        // to every API client: same build record, same timestamps, no error.
        const queued = await this.getDeployment(deploymentId, true, user.id);
        return { ...queued, build: DeploymentsService.queuedBuild(runId, queue) };
      }
    }

    console.log(`[Projects] Cancelling any existing build jobs for deployment ${deploymentId}`);
    try {
      await this.dockerService.cancelBuildJobsByDeploymentId(deploymentId);
    } catch (error) {
      console.error(`[Projects] Error cancelling existing build jobs:`, error);
    }

    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: {
        buildStatus: 'building',
        buildStep: null,
        buildStepTimestamps: { __start: Date.now() },
        buildLogs: `🔄 Rebuilding deployment from ${deployment.githubRepo}@${deployment.githubBranch}\n`,
        buildError: null
      }
    });

    const imageParts = deployment.image?.split('/') || [];
    const imageNameWithTag =
      imageParts[imageParts.length - 1] || `${deployment.project.namespace}-${deployment.name}`;
    const [imageName] = imageNameWithTag.split(':');

    const uniqueTag = newImageTag();

    const service = deployment.services[0];
    const rawPorts =
      service?.ports.map((port) => ({
        name: port.name,
        containerPort: port.targetPort,
        servicePort: port.port,
        protocol: port.protocol,
        nodePort: port.nodePort || undefined
      })) || [];

    const { resolved: env } = resolveEnvVars(
      deployment.envVars.map((ev) => this.crypto.maybeDecrypt(ev)),
      await this.loadSharedVarsForDeployment(deployment.id, deployment.environmentId),
      await this.resourceBindings.valuesFor(deployment.id)
    );

    const volumes = (deployment.volumes || []).map((vol) => ({
      name: vol.name,
      type: vol.type as 'pvc' | 'hostPath' | 'emptyDir',
      mountPath: vol.mountPath,
      pvcName: vol.pvcName || undefined,
      storageSize: vol.storageSize || undefined,
      hostPath: vol.hostPath || undefined,
      readOnly: vol.readOnly
    }));

    this.buildAndDeployAsync(
      deploymentId,
      {
        repoUrl: deployment.githubRepo,
        branch: deployment.githubBranch,
        dockerfilePath: deployment.dockerfilePath,
        buildFromRoot: deployment.buildFromRoot ?? false,
        buildWithDepot: deployment.buildWithDepot ?? false,
        persistentBuildCache: deployment.persistentBuildCache ?? false,
        buildType: deployment.buildType as 'dockerfile' | 'railpack',
        target: deployment.dockerfileTarget ?? undefined,
        imageName,
        tag: uniqueTag,
        namespace: deployment.namespace,
        name: deployment.name,
        replicas: deployment.replicas,
        rawPorts,
        env,
        exposePublic: service?.type === 'external',
        volumes,
        isRebuild: true,
        triggerType: 'manual',
        triggeredById: user.id
      },
      deployment.gitConnectionId
        ? undefined
        : await this.githubCloneToken({
            userId: user.id,
            repoUrl: deployment.githubRepo,
            branch: deployment.githubBranch,
            boundInstallationId: deployment.githubInstallationId,
            linkedBy: deployment.repoLinkedBy ?? deployment.createdBy
          })
    ).catch((error) => {
      console.error(`[Projects] Rebuild failed for deployment ${deploymentId}:`, error);
    });

    void this.audit.log({
      action: 'deployment.redeployed',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: { repo: deployment.githubRepo, branch: deployment.githubBranch, tag: uniqueTag }
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        },
        project: {
          include: {
            organization: true
          }
        }
      }
    });
    return {
      ...this.addInternalUrlsToDeployment(result),
      build: { accepted: true, started: true, status: 'building' as const }
    };
  }

  async getImageHistory(deploymentId: string, clerkId: string) {
    await this.access.assertDeploymentView(deploymentId, clerkId);
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    return this.prisma.imageHistory.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getImageHistoryLogs(deploymentId: string, imageHistoryId: string, clerkId: string) {
    await this.access.assertDeploymentView(deploymentId, clerkId);
    const entry = await this.prisma.imageHistory.findUnique({
      where: { id: imageHistoryId },
      select: { deploymentId: true, buildLogs: true }
    });

    if (!entry || entry.deploymentId !== deploymentId) {
      throw new NotFoundException(`Image history entry not found`);
    }

    return { logs: entry.buildLogs || '' };
  }

  async rollbackToPrevious(
    deploymentId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    await this.access.assertDeploymentView(deploymentId, clerkId);
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { image: true }
    });
    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    const history = await this.prisma.imageHistory.findMany({
      where: { deploymentId },
      select: { id: true, image: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });
    const target = pickPreviousImage(history, deployment.image);
    if (!target) {
      throw new NotFoundException('No earlier image to roll back to');
    }
    const result = await this.rollbackToImage(deploymentId, target.id, clerkId, userData);
    return { ...result, rolledBackTo: { imageHistoryId: target.id, image: target.image } };
  }

  async rollbackToImage(
    deploymentId: string,
    imageHistoryId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    if (!deployment) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }

    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'rollback deployments');

    const imageHistory = await this.prisma.imageHistory.findUnique({
      where: { id: imageHistoryId }
    });

    if (!imageHistory || imageHistory.deploymentId !== deploymentId) {
      throw new NotFoundException('Image history not found');
    }

    // The probes and start command belong to the app, not the image. A
    // rollback that drops them leaves the older image running the container's
    // own CMD with no readiness gate.
    const { healthCheck, args } = await this.rolloutInputs(deploymentId);
    const rollbackStartedAt = Date.now();
    await this.k8sWorkload.updateDeploymentImage(
      deployment.name,
      deployment.namespace,
      imageHistory.image,
      healthCheck,
      args,
      await this.quotasService.prepareRollout(deployment)
    );
    const verdict = await this.k8sWorkload.waitForRollout(deployment.name, deployment.namespace, {
      sinceMs: rollbackStartedAt,
      timeoutMs: ROLLBACK_GATE_TIMEOUT_MS
    });
    if (verdict.state === 'failed') {
      if (deployment.image && deployment.image !== imageHistory.image) {
        await this.k8sWorkload
          .updateDeploymentImage(
            deployment.name,
            deployment.namespace,
            deployment.image,
            healthCheck,
            args
          )
          .catch(() => {});
      }
      throw new BadRequestException(`Rollback didn't become ready: ${verdict.reason}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.imageHistory.updateMany({
        where: { deploymentId },
        data: { isActive: false }
      });

      await tx.imageHistory.update({
        where: { id: imageHistoryId },
        data: { isActive: true }
      });

      await tx.deployment.update({
        where: { id: deploymentId },
        data: {
          image: imageHistory.image,
          status: 'running'
        }
      });
    });

    await this.releases.markRolledBack(deploymentId, `rolled back to ${imageHistory.image}`);
    await this.releases.record(deploymentId, {
      image: imageHistory.image,
      imageHistoryId: imageHistory.id,
      strategy: (deployment.deployStrategy as DeployStrategy) ?? 'rollingUpdate',
      status: 'live',
      reason: 'rollback',
      createdById: user.id
    });

    const result = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      include: {
        pods: true,
        services: {
          include: {
            ports: true
          }
        },
        envVars: true,
        ingresses: {
          include: {
            service: true
          }
        },
        project: {
          include: {
            organization: true
          }
        }
      }
    });

    void this.audit.log({
      action: 'deployment.rolled_back',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: { image: [deployment.image, imageHistory.image] }
    });

    return this.addInternalUrlsToDeployment(result);
  }
}

function publicKey(p: { name?: string | null; port: number; protocol: string }): string {
  return p.name ? `name:${p.name}` : `${p.port}:${p.protocol.toUpperCase()}`;
}

export interface PendingPush {
  sha: string;
  branch: string;
  author: string | null;
  message: string | null;
  at: string;
  count: number;
}
