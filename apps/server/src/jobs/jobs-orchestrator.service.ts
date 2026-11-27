import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import {
  KubernetesService,
  buildPlacement,
  ResolvedPlacement
} from '../kubernetes/kubernetes.service';
import {
  hardenedSecurityContext,
  tenantPodAnnotations,
  tenantRuntimeClassName
} from '../kubernetes/trusted-images';
import { containerResources, type PodSizing } from '../kubernetes/resource-spec';
import { podLogText } from '../kubernetes/pod-log-text';
import { QuotasService } from '../quotas/quotas.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NodesService } from '../nodes/nodes.service';
import { JobsService, RUN_ACTIVE_STATUSES } from './jobs.service';
import { scriptRuntimeSpec, scriptFileName, ScriptRuntime } from './script-runtimes';
import { decodeStepsSnapshot, encodeStepsSnapshot } from './steps-snapshot';
import {
  ANNOTATION_APPLIED_SCHEDULE,
  appliedScheduleAnnotation,
  cronJobForReplace,
  missingCronJobAction,
  readAppliedSchedule,
  scheduleStateOf
} from './cronjob-drift';
import { engineDisabled } from '../engine/engine-disabled';
import { RegistryCredentialsService } from '../projects/registry-credentials.service';
import { pullSecretsForImage } from '../projects/registry-credentials';
import { pinToBuildArch } from '../docker/build-platform';
import { ResourceBindingsService } from '../projects/resource-bindings.service';
import { resolveEnvVars, EnvVar, ResourceValues } from '../env/env-resolver';
import { assertImageOwnedByProject } from '../projects/image-ownership';

export const JOB_MANAGED_BY = 'orchard-job';
export const LABEL_JOB_ID = 'orchard/job-id';
export const LABEL_PROJECT_ID = 'orchard/project-id';
export const LABEL_RUN_ID = 'orchard/run-id';
export const LABEL_STEP_ORDER = 'orchard/step-order';
export const ANNOTATION_SPEC_HASH = 'orchard/spec-hash';

const SCRIPTS_MOUNT_PATH = '/orchard/scripts';
const STEP_JOB_TTL_SECONDS = 3600;
const MAX_LOG_BYTES = 1024 * 1024;

export interface ResolvedStep {
  stepOrder: number;
  name: string;
  type: 'app' | 'image' | 'script';
  image: string;
  shell?: string | null;
  script?: string | null;
  scriptRuntime?: ScriptRuntime | null;
  scriptFile?: string | null;
  envVars: { key: string; value: string; secret?: boolean }[];
  cpuMilli: number;
  memoryBytes: number;
  noLimits?: PodSizing['noLimits'];
  timeoutSeconds: number;
  retries: number;
}

export interface RunContext {
  jobId: string;
  projectId: string;
  organizationId: string;
  namespace: string;
  // Resolved scheduling for this job's step pods (org allow/deny + node pool +
  // superadmin override). Undefined = no placement constraints.
  placement?: ResolvedPlacement;
  pullSecretRegistries?: string[];
}

const short = (id: string) => id.replace(/-/g, '').slice(0, 8);

export const cronJobNameFor = (jobId: string) => `ojob-${short(jobId)}`;
export const stepJobNameFor = (runId: string, order: number) => `ojr-${short(runId)}-s${order}`;
export const jobScriptsConfigMapName = (jobId: string) => `ojob-${short(jobId)}-scripts`;
export const runScriptsConfigMapName = (runId: string) => `ojr-${short(runId)}-scripts`;
export const jobEnvSecretName = (jobId: string) => `ojob-${short(jobId)}-env`;
export const runEnvSecretName = (runId: string) => `ojr-${short(runId)}-env`;
const stepSecretKey = (stepOrder: number, key: string) => `s${stepOrder}.${key}`;

@Injectable()
export class JobsOrchestratorService {
  private readonly logger = new Logger(JobsOrchestratorService.name);

  private readonly cronJobSyncs = new Map<string, number>();

  private readonly cronJobsMissingSince = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly quotas: QuotasService,
    private readonly notifications: NotificationsService,
    private readonly nodes: NodesService,
    private readonly jobsService: JobsService,
    private readonly crypto: SecretCryptoService,
    private readonly registryCredentials: RegistryCredentialsService,
    private readonly resourceBindings: ResourceBindingsService
  ) {}

  // Resolve a job's step-pod scheduling: org hostname allow/deny + assigned
  // node pool + superadmin raw override, merged into affinity + tolerations.
  private async resolveJobPlacement(
    job: { nodePoolId?: string | null; placementOverride?: unknown },
    organizationId: string
  ): Promise<ResolvedPlacement> {
    const org = await this.nodes.getPlacementForOrg(organizationId);
    const pool = await this.nodes.resolvePool(job.nodePoolId ?? null);
    const override = this.nodes.toPlacementOverride(job.placementOverride ?? null);
    return buildPlacement({
      allowedNodes: org.allowedNodes,
      deniedNodes: org.deniedNodes,
      pool,
      override
    });
  }

  private get kc(): k8s.KubeConfig | null {
    return this.kubernetes.kc;
  }

  private batchApi() {
    this.kubernetes.ensureKubeConfig();
    return this.kc!.makeApiClient(k8s.BatchV1Api);
  }

  private coreApi() {
    this.kubernetes.ensureKubeConfig();
    return this.kc!.makeApiClient(k8s.CoreV1Api);
  }

  async resolveSteps(jobId: string): Promise<ResolvedStep[]> {
    const job = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
        project: { select: { id: true, namespace: true } }
      }
    });
    const resolved: ResolvedStep[] = [];
    for (const step of job.steps) {
      resolved.push(await this.resolveStep(step, job));
    }
    return resolved;
  }

  private async loadSharedVars(environmentId: string | null | undefined): Promise<EnvVar[]> {
    if (!environmentId) return [];
    const vars = await this.prisma.environmentSharedVar.findMany({
      where: { environmentId },
      select: { key: true, value: true, secret: true }
    });
    return vars.map((v) => this.crypto.maybeDecrypt(v));
  }

  private resolveStepEnv(
    step: { stepOrder: number; name: string },
    raw: EnvVar[],
    shared: EnvVar[],
    resources: ResourceValues
  ): EnvVar[] {
    const { resolved, errors } = resolveEnvVars(raw, shared, resources);
    for (const e of errors) {
      this.logger.warn(
        `Step ${step.stepOrder} (${step.name}): ${e.key} references shared.${e.missingRef}, which isn't defined`
      );
    }
    return resolved;
  }

  private async resolveStep(
    step: any,
    job: { environmentId?: string | null; project: { id: string; namespace: string } }
  ): Promise<ResolvedStep> {
    const projectId = job.project.id;
    const shared = await this.loadSharedVars(job.environmentId);
    const resources = await this.quotas.podSizing(projectId, {
      cpuRequestMilli: step.cpuRequestMilli,
      memoryRequestBytes: step.memoryRequestBytes != null ? Number(step.memoryRequestBytes) : null
    });

    const ownEnv = ((step.envVars as EnvVar[]) ?? []).map((e) => this.crypto.maybeDecrypt(e));
    const base = {
      stepOrder: step.stepOrder,
      name: step.name,
      envVars: ownEnv,
      cpuMilli: resources.cpuMilli,
      memoryBytes: resources.memoryBytes,
      ...(resources.noLimits ? { noLimits: resources.noLimits } : {}),
      timeoutSeconds: step.timeoutSeconds,
      retries: step.retries
    };

    if (step.type === 'script') {
      const runtime = step.scriptRuntime as ScriptRuntime;
      const spec = scriptRuntimeSpec(runtime);
      return {
        ...base,
        type: 'script',
        envVars: this.resolveStepEnv(step, ownEnv, shared, {}),
        image: spec.image,
        script: step.script,
        scriptRuntime: runtime,
        scriptFile: scriptFileName(runtime, step.stepOrder)
      };
    }

    if (step.type === 'image') {
      await assertImageOwnedByProject(this.prisma, step.image, job.project);
      return {
        ...base,
        type: 'image',
        envVars: this.resolveStepEnv(step, ownEnv, shared, {}),
        image: step.image,
        shell: (step.command as any)?.shell ?? null
      };
    }

    const deployment = step.deploymentId
      ? await this.prisma.deployment.findUnique({
          where: { id: step.deploymentId },
          select: {
            id: true,
            image: true,
            envVars: { select: { key: true, value: true, secret: true } }
          }
        })
      : null;
    if (!deployment) {
      throw new BadRequestException(
        `Step ${step.stepOrder} (${step.name}): the referenced app no longer exists`
      );
    }
    if (!deployment.image) {
      throw new BadRequestException(
        `Step ${step.stepOrder} (${step.name}): the referenced app has no built image yet`
      );
    }

    // The app's secret values are ciphertext at rest and the job runs them for
    // real, so they come back to plaintext here the same as for a pod.
    const merged = new Map<string, { value: string; secret?: boolean }>();
    for (const e of deployment.envVars) {
      merged.set(e.key, { value: this.crypto.maybeDecrypt(e).value, secret: !!e.secret });
    }
    for (const e of ownEnv) merged.set(e.key, { value: e.value, secret: !!e.secret });

    const bound = await this.resourceBindings.valuesFor(deployment.id);
    return {
      ...base,
      type: 'app',
      image: deployment.image,
      shell: (step.command as any)?.shell ?? null,
      envVars: this.resolveStepEnv(
        step,
        Array.from(merged, ([key, { value, secret }]) => ({ key, value, secret })),
        shared,
        bound
      )
    };
  }

  private buildStepJobManifest(
    ctx: RunContext,
    step: ResolvedStep,
    opts: {
      name?: string;
      runId?: string;
      runNumber?: number;
      scriptsConfigMap?: string;
      envSecret: string;
    }
  ): k8s.V1Job {
    const labels: Record<string, string> = {
      'app.kubernetes.io/managed-by': JOB_MANAGED_BY,
      [LABEL_JOB_ID]: ctx.jobId,
      [LABEL_PROJECT_ID]: ctx.projectId,
      [LABEL_STEP_ORDER]: String(step.stepOrder)
    };
    if (opts.runId) labels[LABEL_RUN_ID] = opts.runId;

    const env: k8s.V1EnvVar[] = [
      { name: 'ORCHARD_JOB_ID', value: ctx.jobId },
      { name: 'ORCHARD_STEP_ORDER', value: String(step.stepOrder) },
      ...(opts.runId ? [{ name: 'ORCHARD_RUN_ID', value: opts.runId }] : []),
      ...(opts.runNumber != null
        ? [{ name: 'ORCHARD_RUN_NUMBER', value: String(opts.runNumber) }]
        : []),
      ...step.envVars.map((e) =>
        e.secret
          ? {
              name: e.key,
              valueFrom: {
                secretKeyRef: { name: opts.envSecret, key: stepSecretKey(step.stepOrder, e.key) }
              }
            }
          : { name: e.key, value: e.value }
      )
    ];

    let command: string[] | undefined;
    const volumeMounts: k8s.V1VolumeMount[] = [];
    const volumes: k8s.V1Volume[] = [];

    if (step.type === 'script') {
      const spec = scriptRuntimeSpec(step.scriptRuntime as ScriptRuntime);
      command = [...spec.interpreter, `${SCRIPTS_MOUNT_PATH}/${step.scriptFile}`];
      volumeMounts.push(
        { name: 'scripts', mountPath: SCRIPTS_MOUNT_PATH, readOnly: true },
        { name: 'workspace', mountPath: '/workspace' }
      );
      volumes.push(
        {
          name: 'scripts',
          configMap: {
            name: opts.scriptsConfigMap ?? jobScriptsConfigMapName(ctx.jobId),
            defaultMode: 0o555
          }
        },
        { name: 'workspace', emptyDir: {} }
      );
    } else if (step.shell) {
      command = ['/bin/sh', '-c', step.shell];
    }

    const pullSecrets = pullSecretsForImage(step.image, ctx.pullSecretRegistries ?? []);

    return {
      metadata: {
        name: opts.name,
        labels
      },
      spec: {
        backoffLimit: step.retries,
        activeDeadlineSeconds: step.timeoutSeconds,
        ttlSecondsAfterFinished: STEP_JOB_TTL_SECONDS,
        template: {
          metadata: { labels, annotations: tenantPodAnnotations() },
          spec: {
            restartPolicy: 'Never',
            automountServiceAccountToken: false,
            runtimeClassName: tenantRuntimeClassName(),
            affinity: pinToBuildArch(ctx.placement?.affinity, step.image),
            tolerations: ctx.placement?.tolerations,
            imagePullSecrets: pullSecrets.length ? pullSecrets : undefined,
            containers: [
              {
                name: 'step',
                image: step.image,
                imagePullPolicy: 'IfNotPresent',
                ...(command ? { command } : {}),
                ...(step.type === 'script' ? { workingDir: '/workspace' } : {}),
                env,
                volumeMounts: volumeMounts.length ? volumeMounts : undefined,
                resources: containerResources(step),
                securityContext: hardenedSecurityContext()
              }
            ],
            volumes: volumes.length ? volumes : undefined
          }
        }
      }
    };
  }

  private buildScriptsConfigMap(
    name: string,
    namespace: string,
    steps: ResolvedStep[],
    labels: Record<string, string>
  ): k8s.V1ConfigMap | null {
    const scriptSteps = steps.filter((s) => s.type === 'script' && s.script && s.scriptFile);
    if (scriptSteps.length === 0) return null;
    return {
      metadata: { name, namespace, labels },
      data: Object.fromEntries(scriptSteps.map((s) => [s.scriptFile!, s.script!]))
    };
  }

  private buildEnvSecret(
    name: string,
    namespace: string,
    steps: ResolvedStep[],
    labels: Record<string, string>
  ): k8s.V1Secret | null {
    const stringData: Record<string, string> = {};
    for (const step of steps) {
      for (const e of step.envVars) {
        if (e.secret) stringData[stepSecretKey(step.stepOrder, e.key)] = e.value;
      }
    }
    if (Object.keys(stringData).length === 0) return null;
    return { metadata: { name, namespace, labels }, type: 'Opaque', stringData };
  }

  isSyncingCronJob(jobId: string): boolean {
    return (this.cronJobSyncs.get(jobId) ?? 0) > 0;
  }

  async syncCronJob(jobId: string, opts: { recreate?: boolean } = {}): Promise<void> {
    this.cronJobSyncs.set(jobId, (this.cronJobSyncs.get(jobId) ?? 0) + 1);
    try {
      await this.writeCronJob(jobId, opts);
    } finally {
      const left = (this.cronJobSyncs.get(jobId) ?? 1) - 1;
      if (left > 0) this.cronJobSyncs.set(jobId, left);
      else this.cronJobSyncs.delete(jobId);
    }
  }

  private async writeCronJob(jobId: string, opts: { recreate?: boolean }): Promise<void> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
        project: { select: { id: true, namespace: true, organizationId: true } }
      }
    });
    if (!job) return;

    const namespace = job.project.namespace;
    const name = cronJobNameFor(job.id);
    const batch = this.batchApi();
    const ctx: RunContext = {
      jobId: job.id,
      projectId: job.project.id,
      organizationId: job.project.organizationId,
      namespace,
      placement: await this.resolveJobPlacement(job, job.project.organizationId),
      pullSecretRegistries: await this.registryCredentials.registriesFor(job.project.id)
    };

    const labels = {
      'app.kubernetes.io/managed-by': JOB_MANAGED_BY,
      [LABEL_JOB_ID]: job.id,
      [LABEL_PROJECT_ID]: job.project.id
    };

    const resolved: ResolvedStep[] = [];
    for (const step of job.steps) {
      resolved.push(await this.resolveStep(step, job));
    }

    await this.syncJobScriptsConfigMap(ctx, resolved, labels);
    await this.syncJobEnvSecret(ctx, resolved, labels);

    if (!job.scheduleCron || job.steps.length === 0) {
      await this.deleteCronJobIfExists(namespace, name);
      if (job.cronJobName) {
        await this.prisma.job.update({ where: { id: job.id }, data: { cronJobName: null } });
      }
      return;
    }

    const firstStep = resolved[0];
    const template = this.buildStepJobManifest(ctx, firstStep, {
      scriptsConfigMap: jobScriptsConfigMapName(job.id),
      envSecret: jobEnvSecretName(job.id)
    });

    const desired: k8s.V1CronJob = {
      metadata: {
        name,
        namespace,
        labels,
        annotations: {}
      },
      spec: {
        schedule: job.scheduleCron,
        ...(job.timeZone ? { timeZone: job.timeZone } : {}),
        suspend: !job.enabled,
        concurrencyPolicy: job.concurrencyPolicy === 'allow' ? 'Allow' : 'Forbid',
        startingDeadlineSeconds: 300,
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          metadata: { labels: template.metadata!.labels },
          spec: template.spec
        }
      }
    };

    const hash = createHash('sha256').update(JSON.stringify(desired)).digest('hex');
    desired.metadata!.annotations![ANNOTATION_SPEC_HASH] = hash;
    const applied = appliedScheduleAnnotation(scheduleStateOf(desired.spec));
    desired.metadata!.annotations![ANNOTATION_APPLIED_SCHEDULE] = applied;

    const live = await this.readCronJob(namespace, name);
    if (live) this.cronJobsMissingSince.delete(job.id);
    if (live && job.removedInClusterAt) return;
    if (!live) {
      const now = Date.now();
      const missingSince = this.cronJobsMissingSince.get(job.id) ?? now;
      const action = missingCronJobAction({
        enabled: job.enabled,
        linked: job.cronJobName === name,
        recreate: opts.recreate ?? false,
        engineWatching: !engineDisabled(),
        missingForMs: now - missingSince
      });
      if (action === 'wait') {
        if (!this.cronJobsMissingSince.has(job.id)) {
          this.cronJobsMissingSince.set(job.id, now);
          this.logger.warn(
            `CronJob ${namespace}/${name} is gone from the cluster; not recreating it while the engine confirms the delete`
          );
        }
        return;
      }
      if (this.cronJobsMissingSince.delete(job.id) && action === 'create') {
        this.logger.warn(
          `CronJob ${namespace}/${name} was missing and job ${job.id} is still enabled; recreating it`
        );
      }
      if (action === 'unlink') {
        await this.prisma.job.update({ where: { id: job.id }, data: { cronJobName: null } });
        return;
      }
      if (action === 'skip') return;
      await batch.createNamespacedCronJob(namespace, desired);
      this.logger.log(`Created CronJob ${namespace}/${name}`);
    } else if (live.metadata?.annotations?.[ANNOTATION_SPEC_HASH] === hash) {
      if (!readAppliedSchedule(live.metadata)) {
        await batch.patchNamespacedCronJob(
          name,
          namespace,
          { metadata: { annotations: { [ANNOTATION_APPLIED_SCHEDULE]: applied } } },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        );
      }
      return;
    } else {
      await batch.replaceNamespacedCronJob(name, namespace, cronJobForReplace(desired, live));
      this.logger.log(`Updated CronJob ${namespace}/${name}`);
    }

    if (job.cronJobName !== name) {
      await this.prisma.job.update({ where: { id: job.id }, data: { cronJobName: name } });
    }
  }

  private async syncJobScriptsConfigMap(
    ctx: RunContext,
    resolved: ResolvedStep[],
    labels: Record<string, string>
  ) {
    const core = this.coreApi();
    const name = jobScriptsConfigMapName(ctx.jobId);
    const desired = this.buildScriptsConfigMap(name, ctx.namespace, resolved, labels);
    if (!desired) {
      await core.deleteNamespacedConfigMap(name, ctx.namespace).catch(() => {});
      return;
    }
    try {
      const existing = await core.readNamespacedConfigMap(name, ctx.namespace);
      desired.metadata!.resourceVersion = existing.body.metadata?.resourceVersion;
      await core.replaceNamespacedConfigMap(name, ctx.namespace, desired);
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.statusCode === 404) {
        await core.createNamespacedConfigMap(ctx.namespace, desired);
      } else {
        throw err;
      }
    }
  }

  private async syncJobEnvSecret(
    ctx: RunContext,
    resolved: ResolvedStep[],
    labels: Record<string, string>
  ) {
    const core = this.coreApi();
    const name = jobEnvSecretName(ctx.jobId);
    const desired = this.buildEnvSecret(name, ctx.namespace, resolved, labels);
    if (!desired) {
      await core.deleteNamespacedSecret(name, ctx.namespace).catch(() => {});
      return;
    }
    try {
      const existing = await core.readNamespacedSecret(name, ctx.namespace);
      desired.metadata!.resourceVersion = existing.body.metadata?.resourceVersion;
      await core.replaceNamespacedSecret(name, ctx.namespace, desired);
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.statusCode === 404) {
        await core.createNamespacedSecret(ctx.namespace, desired);
      } else {
        throw err;
      }
    }
  }

  private async readCronJob(namespace: string, name: string): Promise<k8s.V1CronJob | null> {
    try {
      return (await this.batchApi().readNamespacedCronJob(name, namespace)).body;
    } catch (err: any) {
      if (err?.statusCode === 404 || err?.response?.statusCode === 404) return null;
      throw err;
    }
  }

  private async deleteCronJobIfExists(namespace: string, name: string) {
    try {
      await this.batchApi().deleteNamespacedCronJob(name, namespace);
    } catch (err: any) {
      if (err?.statusCode !== 404 && err?.response?.statusCode !== 404) {
        this.logger.warn(`Failed to delete CronJob ${namespace}/${name}: ${err?.message}`);
      }
    }
  }

  async triggerRun(
    jobId: string,
    opts: { trigger: 'manual' | 'api'; triggeredBy?: string | null; allowConcurrent?: boolean }
  ) {
    const job = await this.prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
        project: { select: { id: true, namespace: true, organizationId: true } }
      }
    });
    if (job.steps.length === 0) {
      throw new BadRequestException('This job has no steps');
    }

    if (job.concurrencyPolicy === 'forbid' && !opts.allowConcurrent) {
      const active = await this.prisma.jobRun.findFirst({
        where: { jobId, status: { in: [...RUN_ACTIVE_STATUSES] } },
        select: { id: true }
      });
      if (active) return null;
    }

    const ctx: RunContext = {
      jobId: job.id,
      projectId: job.project.id,
      organizationId: job.project.organizationId,
      namespace: job.project.namespace,
      placement: await this.resolveJobPlacement(job, job.project.organizationId),
      pullSecretRegistries: await this.registryCredentials.registriesFor(job.project.id)
    };

    const resolved: ResolvedStep[] = [];
    for (const step of job.steps) {
      resolved.push(await this.resolveStep(step, job));
    }

    const run = await this.createRunRecordSafe(job, resolved, {
      trigger: opts.trigger,
      triggeredBy: opts.triggeredBy ?? null,
      status: 'pending'
    });
    if (!run) {
      throw new BadRequestException('Failed to create run record');
    }

    await this.ensureRunScriptsConfigMap(ctx, run.id, resolved);
    await this.ensureRunEnvSecret(ctx, run.id, resolved);
    await this.launchStep(ctx, run.id, 1);

    const fresh = await this.prisma.jobRun.findUniqueOrThrow({
      where: { id: run.id },
      include: {
        triggerer: { select: { id: true, username: true, firstName: true, lastName: true } },
        steps: { orderBy: { stepOrder: 'asc' } }
      }
    });
    this.jobsService.emitRunChanged(ctx.organizationId, ctx.projectId, job.id, fresh);
    return this.jobsService.serializeRun(fresh);
  }

  private async ensureRunScriptsConfigMap(ctx: RunContext, runId: string, steps: ResolvedStep[]) {
    const name = runScriptsConfigMapName(runId);
    const labels = {
      'app.kubernetes.io/managed-by': JOB_MANAGED_BY,
      [LABEL_JOB_ID]: ctx.jobId,
      [LABEL_PROJECT_ID]: ctx.projectId,
      [LABEL_RUN_ID]: runId
    };
    const desired = this.buildScriptsConfigMap(name, ctx.namespace, steps, labels);
    if (!desired) return;
    try {
      await this.coreApi().createNamespacedConfigMap(ctx.namespace, desired);
    } catch (err: any) {
      if (err?.statusCode !== 409 && err?.response?.statusCode !== 409) throw err;
    }
  }

  private async ensureRunEnvSecret(ctx: RunContext, runId: string, steps: ResolvedStep[]) {
    const name = runEnvSecretName(runId);
    const labels = {
      'app.kubernetes.io/managed-by': JOB_MANAGED_BY,
      [LABEL_JOB_ID]: ctx.jobId,
      [LABEL_PROJECT_ID]: ctx.projectId,
      [LABEL_RUN_ID]: runId
    };
    const desired = this.buildEnvSecret(name, ctx.namespace, steps, labels);
    if (!desired) return;
    try {
      await this.coreApi().createNamespacedSecret(ctx.namespace, desired);
    } catch (err: any) {
      if (err?.statusCode !== 409 && err?.response?.statusCode !== 409) throw err;
    }
  }

  async launchStep(ctx: RunContext, runId: string, stepOrder: number): Promise<void> {
    const run = await this.prisma.jobRun.findUniqueOrThrow({
      where: { id: runId },
      select: { id: true, number: true, status: true, stepsSnapshot: true }
    });
    const snapshot = decodeStepsSnapshot<ResolvedStep>(run.stepsSnapshot, this.crypto);
    const step = snapshot.find((s) => s.stepOrder === stepOrder);
    if (!step) {
      await this.finishRun(ctx, runId, 'failed', `Step ${stepOrder} missing from snapshot`);
      return;
    }

    const name = stepJobNameFor(runId, stepOrder);
    const manifest = this.buildStepJobManifest(ctx, step, {
      name,
      runId,
      runNumber: run.number,
      scriptsConfigMap: runScriptsConfigMapName(runId),
      envSecret: runEnvSecretName(runId)
    });

    const now = new Date();
    try {
      const created = await this.batchApi().createNamespacedJob(ctx.namespace, manifest);
      await this.prisma.jobRunStep.update({
        where: { runId_stepOrder: { runId, stepOrder } },
        data: {
          k8sJobName: name,
          k8sJobUid: created.body.metadata?.uid ?? undefined,
          status: 'running',
          startedAt: now
        }
      });
    } catch (err: any) {
      const code = err?.statusCode ?? err?.response?.statusCode;
      if (code === 409) {
        this.logger.warn(`Step job ${name} already exists; treating as launched`);
      } else {
        const message =
          err?.response?.body?.message ||
          err?.body?.message ||
          err?.message ||
          'Failed to create job';
        await this.prisma.jobRunStep.update({
          where: { runId_stepOrder: { runId, stepOrder } },
          data: { status: 'failed', reason: 'CreateFailed', finishedAt: now }
        });
        await this.finishRun(ctx, runId, 'failed', message, stepOrder);
        return;
      }
    }

    await this.prisma.jobRun.updateMany({
      where: { id: runId, status: { in: ['pending', 'running'] } },
      data: {
        status: 'running',
        currentStepOrder: stepOrder,
        ...(stepOrder === 1 ? { startedAt: now } : {})
      }
    });
    const fresh = await this.prisma.jobRun.findUniqueOrThrow({ where: { id: runId } });
    this.jobsService.emitRunChanged(ctx.organizationId, ctx.projectId, ctx.jobId, fresh);
  }

  async materializeCronRun(k8sJob: k8s.V1Job): Promise<void> {
    const uid = k8sJob.metadata?.uid;
    const k8sName = k8sJob.metadata?.name;
    const namespace = k8sJob.metadata?.namespace;
    const jobId = k8sJob.metadata?.labels?.[LABEL_JOB_ID];
    if (!uid || !k8sName || !namespace || !jobId) return;

    const existing = await this.prisma.jobRunStep.findUnique({
      where: { k8sJobUid: uid },
      select: { id: true }
    });
    if (existing) return;

    const job = await this.prisma.job.findUnique({
      where: { id: jobId },
      include: {
        steps: { orderBy: { stepOrder: 'asc' } },
        project: { select: { id: true, namespace: true, organizationId: true } }
      }
    });
    if (!job || job.steps.length === 0) {
      await this.deleteK8sJob(namespace, k8sName);
      return;
    }

    const ctx: RunContext = {
      jobId: job.id,
      projectId: job.project.id,
      organizationId: job.project.organizationId,
      namespace: job.project.namespace,
      placement: await this.resolveJobPlacement(job, job.project.organizationId),
      pullSecretRegistries: await this.registryCredentials.registriesFor(job.project.id)
    };

    const scheduledForRaw =
      k8sJob.metadata?.annotations?.['batch.kubernetes.io/cronjob-scheduled-timestamp'];
    const scheduledFor = scheduledForRaw ? new Date(scheduledForRaw) : null;

    if (job.concurrencyPolicy === 'forbid') {
      const active = await this.prisma.jobRun.findFirst({
        where: { jobId, status: { in: [...RUN_ACTIVE_STATUSES] } },
        select: { id: true }
      });
      if (active) {
        await this.deleteK8sJob(namespace, k8sName);
        const skipped = await this.createRunRecordSafe(job, [], {
          trigger: 'cron',
          triggeredBy: null,
          status: 'skipped',
          scheduledFor,
          finishedAt: new Date(),
          errorMessage: 'Skipped: a previous run was still in progress'
        });
        if (skipped) {
          this.jobsService.emitRunChanged(ctx.organizationId, ctx.projectId, job.id, skipped);
        }
        return;
      }
    }

    let resolved: ResolvedStep[];
    try {
      resolved = [];
      for (const step of job.steps) {
        resolved.push(await this.resolveStep(step, job));
      }
    } catch (err: any) {
      await this.deleteK8sJob(namespace, k8sName);
      const failed = await this.createRunRecordSafe(job, [], {
        trigger: 'cron',
        triggeredBy: null,
        status: 'failed',
        scheduledFor,
        finishedAt: new Date(),
        errorMessage: err?.message || 'Failed to resolve job steps'
      });
      if (failed) {
        this.jobsService.emitRunChanged(ctx.organizationId, ctx.projectId, job.id, failed);
        await this.notifications.notifyJobRun(failed.id, 'failed').catch(() => {});
      }
      return;
    }

    // Step 1 actually ran from the synced CronJob template, which may lag the
    // DB by up to a sweep interval; record what truly executed.
    const liveContainer = k8sJob.spec?.template?.spec?.containers?.[0];
    if (liveContainer?.image) {
      resolved[0] = { ...resolved[0], image: liveContainer.image };
      const cmd = liveContainer.command;
      if (cmd && cmd[0] === '/bin/sh' && cmd[1] === '-c' && typeof cmd[2] === 'string') {
        resolved[0].shell = cmd[2];
      }
    }

    const startedAt = k8sJob.status?.startTime ? new Date(k8sJob.status.startTime) : new Date();
    const run = await this.createRunRecordSafe(job, resolved, {
      trigger: 'cron',
      triggeredBy: null,
      status: 'running',
      scheduledFor,
      startedAt
    });
    if (!run) return;

    try {
      await this.prisma.jobRunStep.update({
        where: { runId_stepOrder: { runId: run.id, stepOrder: resolved[0].stepOrder } },
        data: {
          k8sJobName: k8sName,
          k8sJobUid: uid,
          status: 'running',
          startedAt
        }
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        await this.prisma.jobRun.delete({ where: { id: run.id } }).catch(() => {});
        return;
      }
      throw err;
    }

    await this.prisma.jobRun.update({
      where: { id: run.id },
      data: { currentStepOrder: resolved[0].stepOrder }
    });

    await this.ensureRunScriptsConfigMap(ctx, run.id, resolved).catch((err) =>
      this.logger.warn(`run scripts configmap failed for ${run.id}: ${err?.message}`)
    );
    await this.ensureRunEnvSecret(ctx, run.id, resolved).catch((err) =>
      this.logger.warn(`run env secret failed for ${run.id}: ${err?.message}`)
    );

    try {
      await this.batchApi().patchNamespacedJob(
        k8sName,
        namespace,
        { metadata: { labels: { [LABEL_RUN_ID]: run.id } } },
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } } as any
      );
    } catch (err: any) {
      this.logger.warn(`Failed to label cron job ${k8sName} with run id: ${err?.message}`);
    }

    const fresh = await this.prisma.jobRun.findUniqueOrThrow({ where: { id: run.id } });
    this.jobsService.emitRunChanged(ctx.organizationId, ctx.projectId, job.id, fresh);
  }

  private async createRunRecordSafe(
    job: any,
    resolved: ResolvedStep[],
    opts: {
      trigger: string;
      triggeredBy: string | null;
      status: string;
      scheduledFor?: Date | null;
      startedAt?: Date | null;
      finishedAt?: Date | null;
      errorMessage?: string | null;
    }
  ) {
    try {
      const bumped = await this.prisma.job.update({
        where: { id: job.id },
        data: { runCounter: { increment: 1 } },
        select: { runCounter: true }
      });
      const snapshot = encodeStepsSnapshot(resolved, this.crypto).map((s) => ({
        ...s,
        memoryBytes: Number(s.memoryBytes)
      }));
      return await this.prisma.jobRun.create({
        data: {
          jobId: job.id,
          number: bumped.runCounter,
          trigger: opts.trigger,
          triggeredBy: opts.triggeredBy,
          status: opts.status,
          stepsSnapshot: snapshot as any,
          scheduledFor: opts.scheduledFor ?? null,
          startedAt: opts.startedAt ?? null,
          finishedAt: opts.finishedAt ?? null,
          errorMessage: opts.errorMessage ?? null,
          steps: {
            create: resolved.map((s) => ({
              stepOrder: s.stepOrder,
              name: s.name,
              type: s.type,
              resolvedImage: s.image,
              command: s.shell ? { shell: s.shell } : undefined,
              status:
                opts.status === 'running' && s.stepOrder === resolved[0]?.stepOrder
                  ? 'running'
                  : 'pending'
            }))
          }
        }
      });
    } catch (err: any) {
      this.logger.warn(`createRunRecord failed for job ${job.id}: ${err?.message}`);
      return null;
    }
  }

  async deleteK8sJob(namespace: string, name: string): Promise<void> {
    await this.batchApi()
      .deleteNamespacedJob(
        name,
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        'Background'
      )
      .catch(() => {});
  }

  async handleStepTerminal(
    ctx: RunContext,
    runId: string,
    stepOrder: number,
    outcome: { succeeded: boolean; reason?: string | null },
    k8sJob?: k8s.V1Job
  ): Promise<void> {
    const jobName = stepJobNameFor(runId, stepOrder);
    const { logs, truncated, exitCode } = await this.captureStepLogs(
      ctx.namespace,
      k8sJob?.metadata?.name ?? jobName
    );

    let stepStatus = 'failed';
    if (outcome.succeeded) stepStatus = 'succeeded';
    else if (outcome.reason === 'DeadlineExceeded') stepStatus = 'timed_out';

    const claimed = await this.prisma.jobRunStep.updateMany({
      where: { runId, stepOrder, status: { in: ['pending', 'running'] } },
      data: {
        status: stepStatus,
        reason: outcome.reason ?? null,
        exitCode,
        logs,
        logsTruncated: truncated,
        finishedAt: new Date()
      }
    });
    if (claimed.count === 0) return;

    const run = await this.prisma.jobRun.findUnique({
      where: { id: runId },
      select: { id: true, number: true, status: true, stepsSnapshot: true }
    });
    if (!run || !RUN_ACTIVE_STATUSES.includes(run.status as any)) return;

    const snapshot = run.stepsSnapshot as unknown as ResolvedStep[];
    const isLast = !snapshot.some((s) => s.stepOrder > stepOrder);

    if (!outcome.succeeded) {
      await this.prisma.jobRunStep.updateMany({
        where: { runId, stepOrder: { gt: stepOrder }, status: 'pending' },
        data: { status: 'skipped' }
      });
      const runStatus = stepStatus === 'timed_out' ? 'timed_out' : 'failed';
      await this.finishRun(
        ctx,
        runId,
        runStatus,
        outcome.reason ? `Step ${stepOrder} failed: ${outcome.reason}` : `Step ${stepOrder} failed`,
        stepOrder
      );
      return;
    }

    if (isLast) {
      await this.finishRun(ctx, runId, 'succeeded', null);
      return;
    }

    const next = snapshot
      .filter((s) => s.stepOrder > stepOrder)
      .sort((a, b) => a.stepOrder - b.stepOrder)[0];
    await this.launchStep(ctx, runId, next.stepOrder);
  }

  async finishRun(
    ctx: RunContext,
    runId: string,
    status: 'succeeded' | 'failed' | 'canceled' | 'timed_out',
    errorMessage: string | null,
    failedStepOrder?: number
  ): Promise<void> {
    const claimed = await this.prisma.jobRun.updateMany({
      where: { id: runId, status: { in: ['pending', 'running'] } },
      data: {
        status,
        errorMessage,
        finishedAt: new Date(),
        currentStepOrder: failedStepOrder ?? null
      }
    });
    if (claimed.count === 0) return;

    const run = await this.prisma.jobRun.findUniqueOrThrow({ where: { id: runId } });
    this.jobsService.emitRunChanged(ctx.organizationId, ctx.projectId, ctx.jobId, run);

    if (status === 'succeeded' || status === 'failed' || status === 'timed_out') {
      const notifyStatus = status === 'succeeded' ? 'succeeded' : 'failed';
      await this.notifications
        .notifyJobRun(runId, notifyStatus)
        .catch((err) => this.logger.warn(`notifyJobRun failed: ${err?.message}`));
    }
  }

  async captureStepLogs(
    namespace: string,
    jobName: string
  ): Promise<{ logs: string | null; truncated: boolean; exitCode: number | null }> {
    try {
      const core = this.coreApi();
      const pods = await core.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `job-name=${jobName}`
      );
      const items = pods.body.items ?? [];
      if (items.length === 0) return { logs: null, truncated: false, exitCode: null };

      items.sort((a, b) => {
        const ta = a.metadata?.creationTimestamp
          ? new Date(a.metadata.creationTimestamp).getTime()
          : 0;
        const tb = b.metadata?.creationTimestamp
          ? new Date(b.metadata.creationTimestamp).getTime()
          : 0;
        return ta - tb;
      });

      let combined = '';
      let exitCode: number | null = null;
      for (const pod of items) {
        const podName = pod.metadata?.name;
        if (!podName) continue;
        const term =
          pod.status?.containerStatuses?.[0]?.state?.terminated ??
          pod.status?.containerStatuses?.[0]?.lastState?.terminated;
        if (term?.exitCode != null) exitCode = term.exitCode;
        try {
          const res = await core.readNamespacedPodLog(
            podName,
            namespace,
            'step',
            undefined,
            undefined,
            MAX_LOG_BYTES
          );
          const text = podLogText(res.body);
          if (items.length > 1) {
            combined += `${combined ? '\n' : ''}--- attempt ${podName} ---\n${text}`;
          } else {
            combined = text;
          }
        } catch {
          // pod may be gone or logs unavailable; keep what we have
        }
      }

      let truncated = false;
      if (combined.length > MAX_LOG_BYTES) {
        combined = combined.slice(combined.length - MAX_LOG_BYTES);
        truncated = true;
      }
      return { logs: combined || null, truncated, exitCode };
    } catch (err: any) {
      this.logger.warn(`Failed to capture logs for ${namespace}/${jobName}: ${err?.message}`);
      return { logs: null, truncated: false, exitCode: null };
    }
  }

  async fetchLiveStepLogs(namespace: string, jobName: string): Promise<string | null> {
    const core = this.coreApi();
    const pods = await core.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `job-name=${jobName}`
    );
    const items = pods.body.items ?? [];
    if (items.length === 0) return null;
    items.sort((a, b) => {
      const ta = a.metadata?.creationTimestamp
        ? new Date(a.metadata.creationTimestamp).getTime()
        : 0;
      const tb = b.metadata?.creationTimestamp
        ? new Date(b.metadata.creationTimestamp).getTime()
        : 0;
      return tb - ta;
    });
    const pod = items[0];
    if (!pod.metadata?.name) return null;
    try {
      const res = await core.readNamespacedPodLog(
        pod.metadata.name,
        namespace,
        'step',
        undefined,
        undefined,
        MAX_LOG_BYTES
      );
      return podLogText(res.body);
    } catch {
      return null;
    }
  }

  async cancelRun(runId: string) {
    const run = await this.prisma.jobRun.findUniqueOrThrow({
      where: { id: runId },
      include: {
        job: {
          include: {
            project: { select: { id: true, namespace: true, organizationId: true } }
          }
        },
        steps: { orderBy: { stepOrder: 'asc' } }
      }
    });
    const ctx: RunContext = {
      jobId: run.jobId,
      projectId: run.job.project.id,
      organizationId: run.job.project.organizationId,
      namespace: run.job.project.namespace,
      placement: await this.resolveJobPlacement(run.job, run.job.project.organizationId)
    };

    if (!RUN_ACTIVE_STATUSES.includes(run.status as any)) {
      return this.jobsService.getRunDetail(runId);
    }

    const claimed = await this.prisma.jobRun.updateMany({
      where: { id: runId, status: { in: ['pending', 'running'] } },
      data: { status: 'canceled', finishedAt: new Date() }
    });
    if (claimed.count > 0) {
      const batch = this.batchApi();
      for (const step of run.steps) {
        if (step.status === 'running' && step.k8sJobName) {
          await batch
            .deleteNamespacedJob(
              step.k8sJobName,
              ctx.namespace,
              undefined,
              undefined,
              undefined,
              undefined,
              'Background'
            )
            .catch(() => {});
          await this.prisma.jobRunStep.update({
            where: { id: step.id },
            data: { status: 'canceled', finishedAt: new Date() }
          });
        }
      }
      await this.prisma.jobRunStep.updateMany({
        where: { runId, status: 'pending' },
        data: { status: 'skipped' }
      });
      const fresh = await this.prisma.jobRun.findUniqueOrThrow({ where: { id: runId } });
      this.jobsService.emitRunChanged(ctx.organizationId, ctx.projectId, ctx.jobId, fresh);
    }
    return this.jobsService.getRunDetail(runId);
  }

  async teardownJob(job: {
    id: string;
    project: { namespace: string; organizationId: string; id: string };
  }): Promise<void> {
    const namespace = job.project.namespace;
    const batch = this.batchApi();
    const core = this.coreApi();

    await this.deleteCronJobIfExists(namespace, cronJobNameFor(job.id));

    try {
      const jobs = await batch.listNamespacedJob(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `${LABEL_JOB_ID}=${job.id}`
      );
      for (const item of jobs.body.items ?? []) {
        if (!item.metadata?.name) continue;
        await batch
          .deleteNamespacedJob(
            item.metadata.name,
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            'Background'
          )
          .catch(() => {});
      }
    } catch (err: any) {
      this.logger.warn(`Failed to list jobs for teardown of ${job.id}: ${err?.message}`);
    }

    try {
      const cms = await core.listNamespacedConfigMap(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `${LABEL_JOB_ID}=${job.id}`
      );
      for (const cm of cms.body.items ?? []) {
        if (!cm.metadata?.name) continue;
        await core.deleteNamespacedConfigMap(cm.metadata.name, namespace).catch(() => {});
      }
    } catch {
      // best-effort
    }

    const secrets = await core
      .listNamespacedSecret(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `${LABEL_JOB_ID}=${job.id}`
      )
      .catch(() => null);
    for (const secret of secrets?.body.items ?? []) {
      if (!secret.metadata?.name) continue;
      await core.deleteNamespacedSecret(secret.metadata.name, namespace).catch(() => {});
    }
  }
}
