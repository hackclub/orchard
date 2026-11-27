import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { liveDeviceQuantities, sameDevices, storedDevices } from '../../kubernetes/devices';
import * as k8s from '@kubernetes/client-node';
import { PrismaService } from '../../prisma/prisma.service';
import { KubernetesService } from '../../kubernetes/kubernetes.service';
import { DeploymentsService } from '../../projects/deployments.service';
import { ENV_HASH_ANNOTATION, envHash, envObservationKey } from '../../kubernetes/env-patch';
import { OrgEventsService } from '../../events/org-events.service';
import {
  cpuLimitMilliFromResources,
  memoryLimitBytesFromResources
} from '../../kubernetes/quantity';
import { runsWithoutLimitsOnPurpose } from '../../kubernetes/resource-spec';
import { resolvePullPolicy } from '../../kubernetes/trusted-images';
import { disruptionBudgetActive, readMinAvailable } from '../../kubernetes/disruption-budget';
import { ApplyQueueService } from '../../apply/apply-queue.service';
import { AuditService } from '../../audit/audit.service';
import { EngineEventType, EngineRefs } from '../core/informer';
import { rowMayBePending } from './row-pending';

export const K8S_DELETED_REASON = 'resource deleted in k8s';

const POSITIVE_TTL_MS = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 30 * 1000;
const EMIT_COALESCE_MS = 500;
const CONFIRM_AFTER_MS = 90 * 1000;
const ENV_SETTLE_MS = 2 * 60 * 1000;
const CREATION_GRACE_MS = 2 * 60 * 1000;
const REMOVAL_WINDOW_MS = 10 * 60 * 1000;
const MAX_REMOVALS_PER_WINDOW = 5;

type LiveState = 'present' | 'absent' | 'unknown';

export class RemovalPending extends Error {}

interface Ctx {
  deploymentId: string;
  orgId: string;
  projectId: string;
}

interface PendingEmit {
  ctx: Ctx;
  payload: unknown;
  timer: ReturnType<typeof setTimeout>;
}

@Injectable()
export class WorkloadConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(WorkloadConsumer.name);

  private readonly ctxCache = new Map<string, { ctx: Ctx | null; exp: number }>();

  private readonly lastEmit = new Map<string, number>();

  private readonly pending = new Map<string, PendingEmit>();

  private readonly absentSince = new Map<string, number>();

  private removals: number[] = [];

  protected confirmAfterMs = CONFIRM_AFTER_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly orgEvents: OrgEventsService,
    private readonly applyQueue: ApplyQueueService,
    private readonly audit: AuditService,
    private readonly kubernetes: KubernetesService,
    private readonly moduleRef: ModuleRef
  ) {}

  onModuleDestroy() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  async mapRefs(dep: k8s.V1Deployment): Promise<EngineRefs> {
    const ctx = await this.resolveCtx(dep);
    return ctx ? { deploymentId: ctx.deploymentId, projectId: ctx.projectId } : {};
  }

  // A ReplicaSet belongs to the app named by its pod template; blue/green
  // copies carry `orchard.my/app`, so the green side's sets land on the app
  // too. Mirroring them is what lets the overview tell old pods from new
  // without asking the apiserver.
  async mapReplicaSetRefs(rs: k8s.V1ReplicaSet): Promise<EngineRefs> {
    const ctx = await this.resolveReplicaSet(rs);
    return ctx ? { deploymentId: ctx.deploymentId, projectId: ctx.projectId } : {};
  }

  async onReplicaSetEvent(_type: EngineEventType, rs: k8s.V1ReplicaSet): Promise<void> {
    const ctx = await this.resolveReplicaSet(rs);
    if (!ctx) return;
    this.scheduleEmit(ctx, { rollout: true });
    await this.markSettled(ctx.deploymentId);
  }

  private async markSettled(deploymentId: string): Promise<void> {
    const release = await this.prisma.release.findFirst({
      where: { deploymentId, status: 'live', settledAt: null, promotedAt: { not: null } },
      orderBy: { promotedAt: 'desc' },
      select: { id: true, image: true }
    });
    if (!release) return;
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, name: true, namespace: true }
    });
    if (!deployment) return;
    const deployments = this.moduleRef.get(DeploymentsService, { strict: false });
    const rollout = await deployments.mirroredRollout(deployment);
    if (rollout?.state !== 'stable') return;
    const current = rollout.revisions.find((r) => r.hash === rollout.currentRevision);
    if (current?.image && current.image !== release.image) return;
    await this.prisma.release.updateMany({
      where: { id: release.id, settledAt: null },
      data: { settledAt: new Date() }
    });
  }

  private resolveReplicaSet(rs: k8s.V1ReplicaSet): Promise<Ctx | null> {
    const labels = rs.metadata?.labels;
    const app = labels?.['orchard.my/app'] ?? labels?.['app.kubernetes.io/name'];
    if (!app) return Promise.resolve(null);
    return this.resolveCtx({
      metadata: {
        namespace: rs.metadata?.namespace,
        name: app,
        creationTimestamp: rs.metadata?.creationTimestamp
      }
    });
  }

  // A PodDisruptionBudget carries the deployment's name, so it resolves
  // through the same lookup.
  async mapPdbRefs(pdb: k8s.V1PodDisruptionBudget): Promise<EngineRefs> {
    const ctx = await this.resolveCtx(pdb);
    return ctx ? { deploymentId: ctx.deploymentId, projectId: ctx.projectId } : {};
  }

  /**
   * Kubernetes is truth for the budget too: a `kubectl edit` of minAvailable
   * lands back in the deployments row.
   *
   * A delete is deliberately NOT adopted as 0. Orchard deletes the object
   * itself whenever the budget cannot be satisfied (scaling to one replica,
   * say), and treating that as intent would erase the setting the user picked
   * and never restore it on the way back up.
   */
  async onPdbEvent(type: EngineEventType, pdb: k8s.V1PodDisruptionBudget): Promise<void> {
    if (type === 'delete') return;
    const ctx = await this.resolveCtx(pdb);
    if (!ctx) return;

    const observed = readMinAvailable(pdb.spec);
    if (observed == null) return;

    const row = await this.prisma.deployment.findUnique({
      where: { id: ctx.deploymentId },
      select: { pdbMinAvailable: true }
    });
    if (!row || row.pdbMinAvailable === observed) return;

    const pendingApply = await this.prisma.k8sApplyItem.count({
      where: { deploymentId: ctx.deploymentId, status: { in: ['pending', 'applying'] } }
    });
    if (pendingApply > 0) return;

    await this.prisma.deployment.update({
      where: { id: ctx.deploymentId },
      data: { pdbMinAvailable: observed }
    });
    this.logger.log(
      `adopted external disruption budget for ${ctx.deploymentId}: minAvailable=${observed}`
    );

    // A budget edited by hand can ask for more pods than the app runs, which
    // leaves zero allowed disruptions and stalls any drain that touches it.
    // The value is kept as the user's intent; the object itself is queued for
    // removal until the replica count can satisfy it again.
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: ctx.deploymentId },
      select: { replicas: true }
    });
    if (deployment && !disruptionBudgetActive(observed, deployment.replicas)) {
      await this.queueBudgetReconcile(ctx.deploymentId);
    }
  }

  private async queueBudgetReconcile(deploymentId: string): Promise<void> {
    await this.applyQueue.enqueue({
      dedupeKey: `op:deployment.disruptionBudget:${deploymentId}`,
      opType: 'deployment.disruptionBudget',
      deploymentId
    });
  }

  async onEvent(type: EngineEventType, dep: k8s.V1Deployment): Promise<void> {
    const ctx = await this.resolveCtx(dep);
    if (!ctx) return;

    // Failures are left to propagate. The informer holds this object's
    // derived_version back when they do and re-derives it on the next pass;
    // catching here would report the replica counts as written when they were
    // not, and the row would sit wrong until the deployment happened to change.
    if (type === 'delete') {
      const removed = await this.prisma.k8sWorkload.deleteMany({
        where: { deploymentId: ctx.deploymentId }
      });
      if (removed.count > 0) this.scheduleEmit(ctx, { workload: null, deleted: true });
      await this.confirmRemoval(ctx, dep);
      return;
    }
    this.absentSince.delete(ctx.deploymentId);

    const specReplicas = dep.spec?.replicas ?? null;
    const data = {
      specReplicas,
      readyReplicas: dep.status?.readyReplicas ?? 0,
      availableReplicas: dep.status?.availableReplicas ?? 0,
      updatedReplicas: dep.status?.updatedReplicas ?? 0,
      observedImage: dep.spec?.template?.spec?.containers?.[0]?.image ?? null,
      conditions: (dep.status?.conditions ?? []) as object[]
    };

    const existing = await this.prisma.k8sWorkload.findUnique({
      where: { deploymentId: ctx.deploymentId }
    });
    await this.prisma.k8sWorkload.upsert({
      where: { deploymentId: ctx.deploymentId },
      create: { deploymentId: ctx.deploymentId, ...data },
      update: data
    });

    const changed =
      !existing ||
      existing.specReplicas !== data.specReplicas ||
      existing.readyReplicas !== data.readyReplicas ||
      existing.availableReplicas !== data.availableReplicas ||
      existing.updatedReplicas !== data.updatedReplicas ||
      existing.observedImage !== data.observedImage;
    if (changed) {
      this.scheduleEmit(ctx, { workload: data });
    }

    await this.markSettled(ctx.deploymentId);

    // Last, because it is the only part of this handler allowed to defer. The
    // mirrored row and the event above are correct either way and clients read
    // them; adoption is the slower question of whether Kubernetes has out-voted
    // the stored intent, and it is fine for that to land a pass later.
    await this.adoptWorkloadSpec(ctx.deploymentId, dep);
  }

  // Kubernetes is truth: unambiguous spec fields edited outside Orchard
  // (kubectl scale / set image / resources patch) are adopted into the
  // deployments row. Env is deliberately excluded: Orchard env carries
  // ${{shared.*}} references and encrypted secrets that a raw k8s env list
  // cannot round-trip.
  private async adoptWorkloadSpec(deploymentId: string, dep: k8s.V1Deployment): Promise<void> {
    const row = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        replicas: true,
        stopped: true,
        image: true,
        cpuRequestMilli: true,
        memoryRequestBytes: true,
        deployStrategy: true,
        imagePullPolicy: true,
        devices: true,
        buildStatus: true,
        name: true,
        envObservedHash: true
      }
    });
    if (!row) return;

    // A build or a queued apply is about to rewrite the object, so the spec in
    // hand is not evidence of anything. Thrown rather than returned: the
    // informer only marks an object derived when the handler succeeds, so this
    // leaves it `underived` and runs again on the repair pass. Returning
    // quietly instead drops the adoption for good: the Deployment does not
    // change again, so the next list sees a matching derived_version and skips
    // it. That is how a deployment scaled to zero outside Orchard kept
    // reporting one replica for eleven days.
    if (row.buildStatus === 'building') {
      throw new Error(`adoption deferred for ${deploymentId}: build in flight`);
    }
    const pendingApply = await this.prisma.k8sApplyItem.count({
      where: { deploymentId, status: { in: ['pending', 'applying'] } }
    });
    if (pendingApply > 0) {
      throw new Error(
        `adoption deferred for ${deploymentId}: ${pendingApply} apply item(s) queued`
      );
    }

    const changes: Record<string, unknown> = {};
    const adopted: string[] = [];

    const specReplicas = dep.spec?.replicas;
    if (specReplicas === 0 && !row.stopped) {
      changes.stopped = true;
      adopted.push('stopped=true');
    } else if (specReplicas != null && specReplicas > 0) {
      if (row.stopped) {
        changes.stopped = false;
        adopted.push('stopped=false');
      }
      if (specReplicas !== row.replicas) {
        changes.replicas = specReplicas;
        adopted.push(`replicas=${specReplicas}`);
      }
    }

    const container = dep.spec?.template?.spec?.containers?.[0];
    const image = container?.image;
    if (image && row.image && image !== row.image) {
      changes.image = image;
      adopted.push(`image=${image}`);
    }

    // Requests are not a size the user picked when Orchard removed the limits
    // on purpose. Reading them back would pin the small no-limits requests and
    // hand them back as real limits the day limits are turned on again.
    if (!runsWithoutLimitsOnPurpose(dep.metadata?.annotations, container?.resources)) {
      const cpuMilli = cpuLimitMilliFromResources(container?.resources);
      if (cpuMilli > 0 && cpuMilli !== row.cpuRequestMilli) {
        changes.cpuRequestMilli = cpuMilli;
        adopted.push(`cpu=${cpuMilli}m`);
      }
      const memoryBytes = memoryLimitBytesFromResources(container?.resources);
      if (
        memoryBytes > 0 &&
        (row.memoryRequestBytes == null || BigInt(memoryBytes) !== row.memoryRequestBytes)
      ) {
        changes.memoryRequestBytes = BigInt(memoryBytes);
        adopted.push(`memory=${memoryBytes}`);
      }
    }

    // Blue/green is orchestrated above Kubernetes: the blue object legitimately
    // carries RollingUpdate, so reading it back would demote the setting.
    const strategy = dep.spec?.strategy?.type === 'Recreate' ? 'recreate' : 'rollingUpdate';
    if (
      dep.spec?.strategy?.type &&
      row.deployStrategy !== 'blueGreen' &&
      strategy !== row.deployStrategy
    ) {
      changes.deployStrategy = strategy;
      adopted.push(`strategy=${strategy}`);
    }

    // Guarded rather than adopted blindly: k8s also allows `Never`, which is not
    // in our enum and would fail the write for every other field in this batch.
    //
    // Compared against the EFFECTIVE policy, not the stored column. A null
    // column means "derive from the tag", and the live object legitimately
    // carries that derived value: adopting it would silently convert every
    // automatic deployment into a pinned one.
    const pullPolicy = container?.imagePullPolicy;
    if (
      (pullPolicy === 'Always' || pullPolicy === 'IfNotPresent') &&
      pullPolicy !== resolvePullPolicy(row.imagePullPolicy, (changes.image as string) ?? row.image)
    ) {
      changes.imagePullPolicy = pullPolicy;
      adopted.push(`pullPolicy=${pullPolicy}`);
    }

    const appContainer = row.name
      ? dep.spec?.template?.spec?.containers?.find((c) => c.name === row.name)
      : undefined;
    if (appContainer) {
      const liveDevices = storedDevices(liveDeviceQuantities(appContainer.resources));
      if (!sameDevices(liveDevices, storedDevices(row.devices))) {
        changes.devices = liveDevices;
        adopted.push(`devices=${JSON.stringify(liveDevices)}`);
      }
    }

    await this.adoptEnv(deploymentId, row.name, row.envObservedHash, dep);

    if (Object.keys(changes).length === 0) return;
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: changes
    });
    this.logger.log(`adopted external spec for ${deploymentId}: ${adopted.join(', ')}`);

    // Whether a disruption budget may exist at all is a function of the
    // replica count, so a `kubectl scale` past it has to be answered. Without
    // this, scaling 3 -> 2 under a minAvailable of 2 leaves a budget behind
    // that allows no disruptions and blocks every drain on those pods.
    if (changes.replicas != null || changes.stopped != null) {
      await this.queueBudgetReconcile(deploymentId);
    }
  }

  private async adoptEnv(
    deploymentId: string,
    name: string,
    observedHash: string | null,
    dep: k8s.V1Deployment
  ): Promise<void> {
    const written = dep.metadata?.annotations?.[ENV_HASH_ANNOTATION];
    if (!written) return;
    const containers = dep.spec?.template?.spec?.containers ?? [];
    const container = containers.find((c) => c.name === name) ?? containers[0];
    if (!container) return;
    const live = container.env ?? [];
    const liveHash = envHash(live);
    const observation = envObservationKey(written, liveHash);
    if (liveHash === written || observation === observedHash) return;

    const recent = await this.prisma.deploymentEnvVar.count({
      where: { deploymentId, updatedAt: { gt: new Date(Date.now() - ENV_SETTLE_MS) } }
    });
    if (recent > 0) {
      throw new Error(
        `env adoption deferred for ${deploymentId}: env changed in Orchard moments ago`
      );
    }

    const deployments = this.moduleRef.get(DeploymentsService, { strict: false });
    const plan = await deployments.adoptClusterEnv(deploymentId, live, observation);
    if (!plan) return;
    if (plan.upserts.length > 0 || plan.removals.length > 0 || plan.conflicts.length > 0) {
      this.logger.log(
        `adopted external env for ${deploymentId}: ${plan.upserts.length} set, ${plan.removals.length} removed, ${plan.conflicts.length} in conflict`
      );
    }
  }

  private async confirmRemoval(ctx: Ctx, dep: k8s.V1Deployment): Promise<void> {
    const namespace = dep.metadata?.namespace ?? '';
    const name = dep.metadata?.name ?? '';
    const row = await this.prisma.deployment.findUnique({
      where: { id: ctx.deploymentId },
      select: { name: true, namespace: true, buildStatus: true }
    });
    if (!row || row.name !== name || row.namespace !== namespace) {
      this.absentSince.delete(ctx.deploymentId);
      return;
    }

    const created = dep.metadata?.creationTimestamp
      ? new Date(dep.metadata.creationTimestamp).getTime()
      : 0;
    const deletedAt = dep.metadata?.deletionTimestamp
      ? new Date(dep.metadata.deletionTimestamp).getTime()
      : Date.now();
    const neverServed =
      row.buildStatus === 'failed' &&
      !(dep.status?.availableReplicas ?? 0) &&
      !(dep.status?.readyReplicas ?? 0);
    if ((created && deletedAt - created < CREATION_GRACE_MS) || neverServed) {
      this.absentSince.delete(ctx.deploymentId);
      this.logger.log(
        `deployment ${namespace}/${name} was removed right after it was created; treating it as an Orchard rollback, not a delete`
      );
      return;
    }

    if (row.buildStatus === 'building') {
      this.absentSince.delete(ctx.deploymentId);
      throw new RemovalPending(`removal of ${namespace}/${name} deferred: build in flight`);
    }
    const pendingApply = await this.prisma.k8sApplyItem.count({
      where: { deploymentId: ctx.deploymentId, status: { in: ['pending', 'applying'] } }
    });
    if (pendingApply > 0) {
      this.absentSince.delete(ctx.deploymentId);
      throw new RemovalPending(`removal of ${namespace}/${name} deferred: apply queued`);
    }

    const namespaceState = await this.liveNamespace(namespace);
    if (namespaceState !== 'present') {
      this.absentSince.delete(ctx.deploymentId);
      if (namespaceState === 'unknown') {
        throw new RemovalPending(`removal of ${namespace}/${name} deferred: namespace unreadable`);
      }
      return;
    }

    const state = await this.liveDeployment(namespace, name);
    if (state === 'present') {
      if (this.absentSince.has(ctx.deploymentId)) {
        this.logger.warn(
          `deployment ${namespace}/${name} looked deleted but the apiserver still has it; false alarm, nothing removed`
        );
      }
      this.absentSince.delete(ctx.deploymentId);
      return;
    }
    if (state === 'unknown') {
      throw new RemovalPending(
        `removal of ${namespace}/${name} deferred: the apiserver could not confirm the delete`
      );
    }

    const now = Date.now();
    const first = this.absentSince.get(ctx.deploymentId);
    if (first === undefined) {
      this.absentSince.set(ctx.deploymentId, now);
      this.logger.warn(
        `deployment ${namespace}/${name} is gone from the cluster; Orchard deployment ${ctx.deploymentId} will be removed if it is still gone in ${Math.round(this.confirmAfterMs / 1000)}s`
      );
      throw new RemovalPending(`removal of ${namespace}/${name} awaiting confirmation`);
    }
    if (now - first < this.confirmAfterMs) {
      throw new RemovalPending(`removal of ${namespace}/${name} awaiting confirmation`);
    }

    this.removals = this.removals.filter((at) => now - at < REMOVAL_WINDOW_MS);
    if (this.removals.length >= MAX_REMOVALS_PER_WINDOW) {
      this.logger.error(
        `${this.removals.length} deployments were removed after cluster deletes in the last ${REMOVAL_WINDOW_MS / 60000} minutes; holding ${namespace}/${name} back. That is not what a manual delete looks like. It is retried once the window passes.`
      );
      throw new RemovalPending(`removal of ${namespace}/${name} held by the breaker`);
    }

    this.absentSince.delete(ctx.deploymentId);
    this.removals.push(now);
    this.logger.warn(
      `deployment ${namespace}/${name} confirmed deleted in the cluster; removing Orchard deployment ${ctx.deploymentId}`
    );
    const deployments = this.moduleRef.get(DeploymentsService, { strict: false });
    await deployments.deleteDeploymentFromCluster(ctx.deploymentId, {
      reason: K8S_DELETED_REASON,
      source: 'engine.workloads',
      namespace,
      firstAbsentAt: new Date(first).toISOString(),
      confirmedAbsentAt: new Date(now).toISOString()
    });
    this.ctxCache.delete(`${namespace}/${name}`);
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'deployment.changed',
      id: ctx.deploymentId,
      projectId: ctx.projectId,
      payload: { removed: true, reason: K8S_DELETED_REASON }
    });
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'project.changed',
      id: ctx.projectId,
      projectId: ctx.projectId
    });
  }

  protected async liveDeployment(namespace: string, name: string): Promise<LiveState> {
    return this.liveRead(() =>
      this.kubernetes.kc!.makeApiClient(k8s.AppsV1Api).readNamespacedDeployment(name, namespace)
    );
  }

  protected async liveNamespace(namespace: string): Promise<LiveState> {
    try {
      this.kubernetes.ensureKubeConfig();
      const { body } = await this.kubernetes
        .kc!.makeApiClient(k8s.CoreV1Api)
        .readNamespace(namespace);
      if (body?.status?.phase === 'Terminating' || body?.metadata?.deletionTimestamp) {
        return 'absent';
      }
      return 'present';
    } catch (err: any) {
      const code = err?.response?.statusCode ?? err?.statusCode;
      return code === 404 ? 'absent' : 'unknown';
    }
  }

  private async liveRead(read: () => Promise<unknown>): Promise<LiveState> {
    try {
      this.kubernetes.ensureKubeConfig();
      await read();
      return 'present';
    } catch (err: any) {
      const code = err?.response?.statusCode ?? err?.statusCode;
      if (code === 404) return 'absent';
      this.logger.warn(
        `could not read from the apiserver (${code ?? 'no status'}): ${err?.message ?? err}`
      );
      return 'unknown';
    }
  }

  private scheduleEmit(ctx: Ctx, payload: unknown) {
    const key = ctx.deploymentId;
    const now = Date.now();
    const last = this.lastEmit.get(key) ?? 0;

    if (now - last >= EMIT_COALESCE_MS) {
      this.lastEmit.set(key, now);
      this.emit(ctx, payload);
      return;
    }

    const existing = this.pending.get(key);
    if (existing) {
      existing.payload = payload;
      return;
    }
    const delay = EMIT_COALESCE_MS - (now - last);
    const timer = setTimeout(() => {
      const p = this.pending.get(key);
      this.pending.delete(key);
      this.lastEmit.set(key, Date.now());
      if (p) this.emit(p.ctx, p.payload);
    }, delay);
    this.pending.set(key, { ctx, payload, timer });
  }

  private emit(ctx: Ctx, payload: unknown) {
    this.orgEvents.emit({
      organizationId: ctx.orgId,
      type: 'deployment.changed',
      id: ctx.deploymentId,
      projectId: ctx.projectId,
      payload
    });
  }

  private async resolveCtx(obj: { metadata?: k8s.V1ObjectMeta }): Promise<Ctx | null> {
    const ns = obj.metadata?.namespace;
    const name = obj.metadata?.name;
    if (!ns || !name) return null;
    const key = `${ns}/${name}`;
    const cached = this.ctxCache.get(key);
    if (cached && cached.exp > Date.now()) return cached.ctx;

    // A lookup that throws is left to propagate: `null` means "no such
    // deployment", which callers store as an answer, and a database blip must
    // not be mistaken for one. Nothing is cached on that path either.
    const row = await this.prisma.deployment.findFirst({
      where: { namespace: ns, name },
      select: {
        id: true,
        projectId: true,
        project: { select: { organizationId: true } }
      }
    });
    const ctx: Ctx | null = row
      ? { deploymentId: row.id, orgId: row.project.organizationId, projectId: row.projectId }
      : null;

    if (ctx || !rowMayBePending(obj.metadata?.creationTimestamp)) {
      this.ctxCache.set(key, { ctx, exp: Date.now() + (ctx ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
    }
    return ctx;
  }
}
