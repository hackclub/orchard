import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  OnApplicationBootstrap
} from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { computePodStatus } from '../engine/pod-status';
import {
  buildCnpgLiveStatus,
  clusterSnapshot,
  withRecoveryFallback,
  type RecoveryFallback,
  type ClusterSnapshot,
  type DbStats,
  type MirroredDbPod
} from './cnpg-status';
import { PassThrough } from 'stream';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService, ResolvedPlacement } from './kubernetes.service';
import { parseMemory } from './quantity';
import { podLogText } from './pod-log-text';
import { containerResources, databaseSizing, type PodSizing } from './resource-spec';
import { deriveDbTuning, walSlotKeepSize } from './db-tuning';
import { appliedSharedBuffers, clusterRestartPatch, sharedBuffersStamp } from './cnpg-spec-sync';
import { optionalDomain } from '../env/platform-domains';
import { syncTlsSecret, TLS_SOURCE_RV_LABEL } from './tls-secret-sync';
import {
  caBundleForIssuedSecret,
  clusterUsesPublicDbTls,
  publicDbCertificate,
  publicDbClusterCertificates,
  publicDbTlsNames
} from './public-db-tls';
import {
  laggingDataVolumes,
  repairedCaBundle,
  walArchivePatchFor,
  tuningPatchFor,
  backupOomLooping,
  walCapPatchFor,
  pdbEnabledFor,
  primaryLeaseSpecFor,
  pdbPatchFor,
  WAL_ARCHIVE_MAX_PARALLEL
} from './cnpg-defaults';
import { dbStatsCommand, parseDbStatsOutput, SampledDbStats } from './db-stats';
import { ModuleRef } from '@nestjs/core';
import { LeaseService } from '../coordination/lease.service';
import { LeaderElectionService } from '../events/leader-election.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * All Postgres flows: legacy single-pod Postgres (exec into shared cluster
 * pod), container-mode Postgres with pgBackRest, and CNPG operator-managed
 * clusters with backups, scheduled backups, public TLS reflection, and
 * MetalLB exposure. Owns the postgresql.cnpg.io CRD interactions.
 *
 * Shares the kubeconfig + a couple of generic helpers (createPVC) with the
 * core KubernetesService via injection: `this.kc`, `this.ensureKubeConfig()`
 * and `this.createPVC()` are delegated below.
 */
import { parseKubeletSummary, VolumeUsage } from './volume-stats';
import { WRITE_GUARD_ANNOTATION } from './cnpg-status';
import { stuckReplicas, type StuckReplica } from './cnpg-stuck-replicas';
import {
  DATABASE_PLATFORM_POLICY,
  cnpgOperatorPolicy,
  databasePlatformPolicy
} from './security-policies';
import { resolvePostgresImage } from './postgres-images';
import {
  BARMAN_GROUP,
  BARMAN_VERSION,
  backupMethodSpec,
  clusterArchivesWithPlugin,
  OBJECT_STORE_PLURAL,
  objectStoreBody,
  objectStoreName,
  archivingOffPatch,
  pluginsWithArchiver,
  walArchiverPlugin,
  type BackupMethod,
  failedRecoveryJob,
  recoveryFailureMessage
} from './cnpg-recovery';
import { assertValidPodName } from './pod-name';
import { hostnameStyle, opaqueDatabaseLabel } from '../projects/generated-host';

export function cnpgScheduleName(clusterName: string): string {
  return `${clusterName}-schedule`.substring(0, 63);
}

export function normalizeBackupEndpointURL(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

@Injectable()
export class K8sCnpgService implements OnApplicationBootstrap {
  private readonly logger = new Logger(K8sCnpgService.name);

  // The operator reaches every instance's manager API (:8000) for status
  // probes and lifecycle management. Tenant namespaces default-deny ingress,
  // so each one carries an explicit allow for the operator; without it the
  // operator goes blind ("Instance Status Extraction Error") and any pod
  // disturbance becomes a restart it cannot manage (2026-07-20 incident).
  private readonly CNPG_OPERATOR_NAMESPACE = process.env.CNPG_OPERATOR_NAMESPACE || 'postgresql';

  private defaultsTimer?: ReturnType<typeof setInterval>;
  private replicasTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService,
    private readonly moduleRef: ModuleRef
  ) {}

  async onApplicationBootstrap() {
    void this.backfillOperatorIngressPolicies();
    setTimeout(() => this.reconcileClusterDefaults().catch(() => {}), 90_000).unref?.();
    this.defaultsTimer = setInterval(
      () => this.reconcileClusterDefaults().catch(() => {}),
      6 * 60 * 60_000
    );
    this.defaultsTimer.unref?.();
    setTimeout(() => this.clearStuckReplicas().catch(() => {}), 120_000).unref?.();
    this.replicasTimer = setInterval(() => this.clearStuckReplicas().catch(() => {}), 5 * 60_000);
    this.replicasTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.defaultsTimer) clearInterval(this.defaultsTimer);
    if (this.replicasTimer) clearInterval(this.replicasTimer);
  }

  async clearStuckReplicas(): Promise<StuckReplica[] | null> {
    if (!this.kc || !this.canRunClusterWide()) return null;
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
    const rows = await this.prisma.database.findMany({
      where: { mode: 'cnpg', namespace: { not: null }, clusterName: { not: null } },
      select: { namespace: true, clusterName: true }
    });
    const ignore404 = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e: any) {
        if (e?.response?.statusCode !== 404) throw e;
      }
    };
    const cleared: StuckReplica[] = [];
    for (const row of rows) {
      const ns = row.namespace!;
      const name = row.clusterName!;
      const selector = `cnpg.io/cluster=${name}`;
      try {
        const [{ body: cluster }, { body: pvcs }, { body: jobs }, { body: pods }] =
          await Promise.all([
            customApi.getNamespacedCustomObject(
              this.CNPG_GROUP,
              this.CNPG_VERSION,
              ns,
              this.CNPG_PLURAL,
              name
            ),
            coreApi.listNamespacedPersistentVolumeClaim(
              ns,
              undefined,
              undefined,
              undefined,
              undefined,
              selector
            ),
            batchApi.listNamespacedJob(ns, undefined, undefined, undefined, undefined, selector),
            coreApi.listNamespacedPod(ns, undefined, undefined, undefined, undefined, selector)
          ]);
        const stuck = stuckReplicas({
          cluster: cluster as any,
          pvcs: (pvcs.items ?? []) as any[],
          jobs: (jobs.items ?? []) as any[],
          pods: (pods.items ?? []) as any[],
          now: Date.now()
        });
        for (const replica of stuck) {
          this.logger.warn(
            `clearing stuck replica ${ns}/${replica.instance} (${replica.reason}): jobs ${replica.jobs.join(',') || '-'}, volumes ${replica.pvcs.join(',')}`
          );
          for (const job of replica.jobs) {
            await ignore404(
              batchApi.deleteNamespacedJob(
                job,
                ns,
                undefined,
                undefined,
                undefined,
                undefined,
                'Background'
              )
            );
          }
          for (const pvc of replica.pvcs) {
            await ignore404(coreApi.deleteNamespacedPersistentVolumeClaim(pvc, ns));
          }
          cleared.push(replica);
        }
      } catch (e: any) {
        if (e?.response?.statusCode === 404) continue;
        this.logger.warn(`stuck replica check for ${ns}/${name} skipped: ${e?.message || e}`);
      }
    }
    return cleared;
  }

  canRunClusterWide(): boolean {
    try {
      const lease = this.moduleRef.get(LeaseService, { strict: false });
      const leader = this.moduleRef.get(LeaderElectionService, { strict: false });
      return !!lease?.canCoordinate && !!leader?.isLeader();
    } catch {
      return false;
    }
  }

  async reconcileClusterDefaults(): Promise<{
    walCapped: number;
    archiveParallel: number;
    retuned: number;
    volumesResized: number;
    tlsSynced: number;
    caRepaired: number;
    disruptionBudgets: number;
    failed: number;
  } | null> {
    if (!this.kc || !this.canRunClusterWide()) return null;
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const rows = await this.prisma.database.findMany({
      where: { mode: 'cnpg', namespace: { not: null }, clusterName: { not: null } },
      select: {
        namespace: true,
        clusterName: true,
        pgParameters: true,
        backupCompression: true,
        publicEnabled: true
      }
    });
    let walCapped = 0;
    let archiveParallel = 0;
    let retuned = 0;
    let volumesResized = 0;
    let tlsSynced = 0;
    let caRepaired = 0;
    let disruptionBudgets = 0;
    let failed = 0;
    const namespaces = new Set<string>();
    const clusterNamespaces = new Set<string>();
    const unreadNamespaces = new Set<string>();
    for (const row of rows) {
      const ns = row.namespace!;
      const name = row.clusterName!;
      try {
        const { body } = await customApi.getNamespacedCustomObject(
          this.CNPG_GROUP,
          this.CNPG_VERSION,
          ns,
          this.CNPG_PLURAL,
          name
        );
        const cluster = body as any;
        clusterNamespaces.add(ns);
        let onWildcard =
          cluster.spec?.certificates?.serverCASecret === this.PUBLIC_TLS_LOCAL_SECRET;
        if (this.publicTlsPerDatabase() && row.publicEnabled) {
          try {
            if (await this.ensureDatabaseTls(ns, name, cluster)) {
              onWildcard = false;
              tlsSynced += 1;
            }
          } catch (e: any) {
            failed += 1;
            this.logger.warn(
              `per-database certificate for ${ns}/${name} not applied: ${e?.message || e}`
            );
          }
        }
        if (onWildcard) namespaces.add(ns);
        const synced = await this.syncDataVolumes(ns, name, cluster);
        volumesResized += synced.resized.length;
        failed += synced.failed.length;
        const capPatch = walCapPatchFor(cluster);
        const archivePatch = walArchivePatchFor(cluster);
        const pods = await this.listInstancePods(coreApi, ns, name).catch((e: any) => {
          this.logger.warn(`instance pods of ${ns}/${name} unreadable: ${e?.message || e}`);
          return [];
        });
        const oomLooping = backupOomLooping(cluster, pods);
        const tuningPatch = tuningPatchFor(cluster, row, { backupOomLooping: oomLooping });
        const stamp = sharedBuffersStamp(cluster, tuningPatch);
        const pdbPatch = pdbPatchFor(cluster);
        if (!capPatch && !archivePatch && !tuningPatch && !stamp && !pdbPatch) continue;
        const spec: any = tuningPatch ? structuredClone(tuningPatch) : {};
        if (pdbPatch) spec.enablePDB = pdbPatch.enablePDB;
        if (capPatch) {
          spec.postgresql = { parameters: { ...(spec.postgresql?.parameters ?? {}), ...capPatch } };
        }
        if (archivePatch) {
          spec.backup = {
            barmanObjectStore: { ...(spec.backup?.barmanObjectStore ?? {}), wal: archivePatch }
          };
        }
        await customApi.patchNamespacedCustomObject(
          this.CNPG_GROUP,
          this.CNPG_VERSION,
          ns,
          this.CNPG_PLURAL,
          name,
          { ...(stamp ? { metadata: { annotations: stamp } } : {}), spec },
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        );
        if (capPatch) walCapped += 1;
        if (archivePatch) archiveParallel += 1;
        if (tuningPatch) retuned += 1;
        if (pdbPatch) disruptionBudgets += 1;
        const raisedTo = (tuningPatch?.resources as any)?.limits?.memory as string | undefined;
        if (oomLooping && raisedTo) {
          await this.recordBackupMemoryRaise(
            ns,
            name,
            String(cluster.spec?.resources?.limits?.memory ?? ''),
            raisedTo
          );
        }
      } catch (e: any) {
        if (e?.response?.statusCode === 404) continue;
        unreadNamespaces.add(ns);
        failed += 1;
        this.logger.warn(`cluster defaults for ${ns}/${name} not applied: ${e?.message || e}`);
      }
    }
    if (this.publicTlsPerDatabase()) {
      for (const ns of clusterNamespaces) {
        if (namespaces.has(ns) || unreadNamespaces.has(ns)) continue;
        try {
          await this.removeWildcardCopy(ns);
        } catch (e: any) {
          failed += 1;
          this.logger.warn(`shared db certificate in ${ns} not removed: ${e?.message || e}`);
        }
      }
    }
    for (const ns of namespaces) {
      try {
        if (await this.syncPublicTlsSecret(ns)) tlsSynced += 1;
      } catch (e: any) {
        failed += 1;
        this.logger.warn(`public db certificate in ${ns} not refreshed: ${e?.message || e}`);
      }
      try {
        const { body: secret } = await coreApi.readNamespacedSecret(
          this.PUBLIC_TLS_LOCAL_SECRET,
          ns
        );
        const repaired = repairedCaBundle(
          (secret.data ?? {}) as { 'ca.crt'?: string; 'tls.crt'?: string }
        );
        if (!repaired) continue;
        await coreApi.patchNamespacedSecret(
          this.PUBLIC_TLS_LOCAL_SECRET,
          ns,
          { data: { 'ca.crt': repaired } },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        );
        caRepaired += 1;
      } catch (e: any) {
        if (e?.response?.statusCode === 404) continue;
        failed += 1;
        this.logger.warn(`server ca bundle in ${ns} not repaired: ${e?.message || e}`);
      }
    }
    if (
      walCapped ||
      archiveParallel ||
      retuned ||
      volumesResized ||
      tlsSynced ||
      caRepaired ||
      disruptionBudgets ||
      failed
    ) {
      this.logger.log(
        `cnpg defaults reconciled: ${walCapped} clusters capped, ${archiveParallel} archives parallelised, ${retuned} retuned, ${volumesResized} volumes resized, ${tlsSynced} public certificates refreshed, ${caRepaired} ca bundles completed, ${disruptionBudgets} disruption budgets matched to instances, ${failed} failed`
      );
    }
    return {
      walCapped,
      archiveParallel,
      retuned,
      volumesResized,
      tlsSynced,
      caRepaired,
      disruptionBudgets,
      failed
    };
  }

  // CNPG only pushes spec.storage.size down to the PVCs while it has a healthy
  // primary to reconcile against. A cluster that is crashlooping on a full disk
  // or hibernated never gets its bigger volume, which is the one moment it needs
  // it, so the request goes straight to the PVC. Longhorn grows it online and the
  // operator's own reconcile is a no-op once the sizes agree.
  async syncDataVolumes(
    namespace: string,
    clusterName: string,
    cluster?: any
  ): Promise<{ resized: string[]; failed: string[] }> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    let spec = cluster;
    if (!spec) {
      const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
      const { body } = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_PLURAL,
        clusterName
      );
      spec = body;
    }
    const size = String(spec?.spec?.storage?.size ?? '').trim();
    const resized: string[] = [];
    const failed: string[] = [];
    if (!size) return { resized, failed };
    const { body: list } = await coreApi.listNamespacedPersistentVolumeClaim(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `cnpg.io/cluster=${clusterName}`
    );
    for (const pvcName of laggingDataVolumes(spec, (list.items ?? []) as any[])) {
      try {
        await coreApi.patchNamespacedPersistentVolumeClaim(
          pvcName,
          namespace,
          { spec: { resources: { requests: { storage: size } } } },
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        );
        resized.push(pvcName);
      } catch (e: any) {
        failed.push(pvcName);
        this.logger.warn(
          `volume ${namespace}/${pvcName} not resized to ${size}: ${e?.body?.message || e?.message || e}`
        );
      }
    }
    return { resized, failed };
  }

  async ensureCnpgOperatorIngress(namespace: string): Promise<void> {
    this.ensureKubeConfig();
    if (!(await this.kubernetes.isCiliumAvailable())) return;
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const policy = cnpgOperatorPolicy(namespace, this.CNPG_OPERATOR_NAMESPACE);
    try {
      await customApi.createNamespacedCustomObject(
        'cilium.io',
        'v2',
        namespace,
        'ciliumnetworkpolicies',
        policy
      );
    } catch (e: any) {
      if (e.response?.statusCode !== 409) throw e;
    }
  }

  async ensureDatabasePlatformPolicy(namespace: string): Promise<void> {
    this.ensureKubeConfig();
    const networking = this.kc!.makeApiClient(k8s.NetworkingV1Api);
    const withoutCilium = !(await this.kubernetes.isCiliumAvailable());
    const body = databasePlatformPolicy(namespace, {
      apiserver: withoutCilium ? await this.kubernetes.apiserverEndpoints() : null,
      operatorNamespace: withoutCilium ? this.CNPG_OPERATOR_NAMESPACE : null
    });
    try {
      await networking.createNamespacedNetworkPolicy(namespace, body);
    } catch (e: any) {
      if (e?.response?.statusCode !== 409) throw e;
      await networking.replaceNamespacedNetworkPolicy(DATABASE_PLATFORM_POLICY, namespace, body);
    }
  }

  private async backfillOperatorIngressPolicies(): Promise<void> {
    try {
      this.ensureKubeConfig();
    } catch {
      return;
    }
    try {
      // Target only namespaces this server provisioned clusters into (from
      // its own database), never "any namespace with a cnpg cluster": a
      // cluster-wide sweep stamped the platform's own namespace and the
      // first policy selecting orchard-db's endpoints flipped them to
      // default-deny, cutting the server off from its database
      // (2026-07-20 incident, second half).
      // The platform's own database is deliberately NOT in this set even
      // when it is a cnpg cluster: its namespace belongs to the installer,
      // so its network policies must live there
      // declaratively. Stamping it from app code depends on an out-of-band
      // allow existing and breaks installs whose platform db has none.
      const rows = await this.prisma.database.findMany({
        where: { mode: 'cnpg', namespace: { not: null } },
        select: { namespace: true },
        distinct: ['namespace']
      });
      const namespaces = new Set<string>(rows.map((r) => r.namespace).filter(Boolean) as string[]);
      for (const ns of namespaces) {
        try {
          await this.ensureCnpgOperatorIngress(ns);
        } catch (e: any) {
          this.logger.warn(`allow-cnpg-operator backfill failed for ${ns}: ${e?.message || e}`);
        }
      }
      if (namespaces.size > 0) {
        this.logger.log(`allow-cnpg-operator ensured in ${namespaces.size} namespaces`);
      }
    } catch (e: any) {
      this.logger.warn(`allow-cnpg-operator backfill skipped: ${e?.message || e}`);
    }
  }

  // Size/connection stats cost a pod exec (a websocket roundtrip through
  // the apiserver), which dominated database page loads at 4-9s. Cache them
  // briefly so only the first view pays, and refetches render instantly.
  private readonly dbStatsCache = new Map<
    string,
    { size?: string; connections?: number; at: number }
  >();

  private readonly DB_STATS_TTL_MS = 20_000;

  private get kc(): k8s.KubeConfig | null {
    return this.kubernetes.kc;
  }

  private ensureKubeConfig() {
    this.kubernetes.ensureKubeConfig();
  }

  private createPVC(namespace: string, name: string, storageSize = '1Gi') {
    return this.kubernetes.createPVC(namespace, name, storageSize);
  }

  async updateCnpgClusterResources(namespace: string, clusterName: string, resources: PodSizing) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const sized = resources.noLimits
      ? databaseSizing(
          resources,
          (await this.readCluster(namespace, clusterName))?.spec?.postgresql?.parameters
            ?.shared_buffers
        )
      : resources;
    const patch = [
      {
        op: 'replace',
        path: '/spec/resources',
        value: containerResources(sized)
      }
    ];
    try {
      await customApi.patchNamespacedCustomObject(
        'postgresql.cnpg.io',
        'v1',
        namespace,
        'clusters',
        clusterName,
        patch,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/json-patch+json' } }
      );
    } catch (err: any) {
      // If /spec/resources doesn't exist yet, use "add" op instead.
      if (err?.response?.body?.message?.includes('not found')) {
        const addPatch = [{ ...patch[0], op: 'add' }];
        await customApi.patchNamespacedCustomObject(
          'postgresql.cnpg.io',
          'v1',
          namespace,
          'clusters',
          clusterName,
          addPatch,
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/json-patch+json' } }
        );
      } else {
        throw err;
      }
    }

    // CNPG performs a rolling update on resource changes only when the cluster has
    // a healthy primary: a single-instance cluster stuck in CrashLoopBackOff (the
    // exact case where users tend to bump resources) won't get rolled. Force-delete
    // the cluster's pods so the operator recreates them with the new spec.
    try {
      const { body: podList } = await coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `cnpg.io/cluster=${clusterName}`
      );
      for (const pod of podList.items || []) {
        const name = pod.metadata?.name;
        if (!name) continue;
        try {
          await coreApi.deleteNamespacedPod(name, namespace);
        } catch {
          /* ignore: operator may already be recreating it */
        }
      }
    } catch {
      /* ignore: pod listing/deletion is best-effort */
    }
  }

  /**
   * The three services CNPG publishes for every cluster.
   *
   * `-rw` always points at the current primary and is the only one that accepts
   * writes; `-ro` load-balances across the standbys only (and has no endpoints
   * at all on a single-instance cluster); `-r` load-balances across every
   * instance including the primary, so it is the safe read endpoint at any size.
   */
  clusterEndpoints(namespace: string, clusterName: string) {
    const suffix = `${namespace}.svc.cluster.local`;
    return {
      rw: `${clusterName}-rw.${suffix}`,
      ro: `${clusterName}-ro.${suffix}`,
      r: `${clusterName}-r.${suffix}`
    };
  }

  /**
   * Set the cluster's instance count (1 primary + N-1 hot standbys).
   *
   * Deliberately does NOT force-delete pods the way updateCnpgClusterResources
   * does: the operator grows the cluster by cloning the primary into a fresh
   * PVC and shrinks it by retiring the highest-numbered standby, and deleting
   * pods underneath that would abort a join or trigger a needless failover.
   */
  async updateCnpgClusterInstances(namespace: string, clusterName: string, instances: number) {
    this.ensureKubeConfig();
    if (!this.kc) return;
    const desired = Math.max(1, Math.trunc(instances));
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      {
        spec: {
          instances: desired,
          enablePDB: pdbEnabledFor(desired),
          ...primaryLeaseSpecFor(desired)
        }
      },
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  async expandCnpgClusterStorage(
    namespace: string,
    clusterName: string,
    newSize: string
  ): Promise<{
    previousSize: string;
    archivingFailure: string | null;
    resizedVolumes: string[];
    failedVolumes: string[];
  }> {
    this.ensureKubeConfig();
    if (!this.kc) {
      throw new ServiceUnavailableException('Kubernetes API not available');
    }
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const cluster: any = await customApi.getNamespacedCustomObject(
      'postgresql.cnpg.io',
      'v1',
      namespace,
      'clusters',
      clusterName
    );
    const previousSize = String(cluster.body?.spec?.storage?.size || '').trim();
    if (!previousSize) {
      throw new BadRequestException('Cluster has no storage size configured');
    }
    const parameters: Record<string, string> = cluster.body?.spec?.postgresql?.parameters ?? {};

    const conditions: any[] = Array.isArray(cluster.body?.status?.conditions)
      ? cluster.body.status.conditions
      : [];
    const archiving = conditions.find((c) => c?.type === 'ContinuousArchiving');
    const archivingFailure =
      archiving && archiving.status === 'False'
        ? String(archiving.message || archiving.reason || 'WAL archiving is failing')
        : null;

    const previousBytes = parseMemory(previousSize);
    const newBytes = parseMemory(newSize);
    if (!newBytes) {
      throw new BadRequestException(`Invalid storage size: ${newSize}`);
    }
    if (newBytes < previousBytes) {
      throw new BadRequestException(
        `Storage can only be expanded, never shrunk: requested ${newSize}, current size is ${previousSize}`
      );
    }

    if (newBytes > previousBytes) {
      const ops: any[] = [{ op: 'replace', path: '/spec/storage/size', value: newSize }];
      if (parameters.max_slot_wal_keep_size === walSlotKeepSize(previousSize)) {
        ops.push({
          op: 'add',
          path: '/spec/postgresql/parameters/max_slot_wal_keep_size',
          value: walSlotKeepSize(newSize)
        });
      }
      await customApi.patchNamespacedCustomObject(
        'postgresql.cnpg.io',
        'v1',
        namespace,
        'clusters',
        clusterName,
        ops,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/json-patch+json' } }
      );
      cluster.body.spec.storage.size = newSize;
    }

    const volumes = await this.syncDataVolumes(namespace, clusterName, cluster.body);

    return {
      previousSize,
      archivingFailure,
      resizedVolumes: volumes.resized,
      failedVolumes: volumes.failed
    };
  }

  private readonly CNPG_NAMESPACE = 'postgresql';

  private readonly CNPG_POD = 'postgresql-cluster-1';

  private readonly CNPG_CONTAINER = 'postgres';

  private async execPsql(sql: string): Promise<string> {
    if (!this.kc) {
      throw new ServiceUnavailableException('Kubeconfig not loaded');
    }

    const exec = new k8s.Exec(this.kc);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    // Find the primary pod dynamically
    let podName = this.CNPG_POD;
    try {
      const { body: podList } = await coreApi.listNamespacedPod(
        this.CNPG_NAMESPACE,
        undefined,
        undefined,
        undefined,
        undefined,
        'cnpg.io/instanceRole=primary'
      );
      if (podList.items.length > 0) {
        podName = podList.items[0].metadata!.name!;
      }
    } catch {
      // Fall back to default pod name
    }

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];

      const stdout = new PassThrough();
      const stderr = new PassThrough();

      stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

      exec
        .exec(
          this.CNPG_NAMESPACE,
          podName,
          this.CNPG_CONTAINER,
          ['psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-c', sql],
          stdout,
          stderr,
          null,
          false,
          (status) => {
            const output = Buffer.concat(chunks).toString('utf-8').trim();
            const errOutput = Buffer.concat(errChunks).toString('utf-8').trim();

            if (status.status === 'Success') {
              resolve(output);
            } else {
              reject(
                new BadRequestException(
                  `Postgres command failed: ${errOutput || status.message || 'Unknown error'}`
                )
              );
            }
          }
        )
        .catch(reject);
    });
  }

  async setSharedRolePassword(dbUser: string, password: string): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbUser)) {
      throw new BadRequestException('Invalid database user');
    }
    await this.execPsql(`ALTER ROLE "${dbUser}" WITH PASSWORD '${password.replace(/'/g, "''")}';`);
  }

  async createPostgresDatabase(dbName: string, dbUser: string, dbPassword: string): Promise<void> {
    // Defense-in-depth: identifiers are produced via formatSlug, but reject anything
    // that isn't a safe lowercase pg identifier before it ever lands in interpolated SQL.
    const SAFE_PG_IDENT = /^[a-z][a-z0-9_]{0,62}$/;
    if (!SAFE_PG_IDENT.test(dbUser)) throw new Error(`Refusing unsafe pg identifier: ${dbUser}`);
    if (!SAFE_PG_IDENT.test(dbName)) throw new Error(`Refusing unsafe pg identifier: ${dbName}`);

    console.log(`[K8s/PG] Creating database "${dbName}" with user "${dbUser}"`);

    // NOTE: passwords are generated via crypto random hex upstream, so they cannot contain
    // a single quote; the .replace below is still applied as belt-and-braces.
    await this.execPsql(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${dbUser}') THEN CREATE ROLE "${dbUser}" LOGIN PASSWORD '${dbPassword.replace(/'/g, "''")}'; END IF; END $$;`
    );

    // Can't use IF NOT EXISTS in DO block for CREATE DATABASE, so check first
    const exists = await this.execPsql(`SELECT 1 FROM pg_database WHERE datname = '${dbName}';`);

    if (!exists) {
      await this.execPsql(`CREATE DATABASE "${dbName}" OWNER "${dbUser}";`);
    } else {
      throw new BadRequestException(`Database "${dbName}" already exists`);
    }

    await this.execPsql(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}";`);

    console.log(`[K8s/PG] Database "${dbName}" created successfully`);
  }

  async deletePostgresDatabase(dbName: string, dbUser: string): Promise<void> {
    // Defense-in-depth: same identifier whitelist as createPostgresDatabase.
    const SAFE_PG_IDENT = /^[a-z][a-z0-9_]{0,62}$/;
    if (!SAFE_PG_IDENT.test(dbUser)) throw new Error(`Refusing unsafe pg identifier: ${dbUser}`);
    if (!SAFE_PG_IDENT.test(dbName)) throw new Error(`Refusing unsafe pg identifier: ${dbName}`);

    console.log(`[K8s/PG] Deleting database "${dbName}" and user "${dbUser}"`);

    // Terminate existing connections
    await this.execPsql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`
    );

    // Drop database and role
    const dbExists = await this.execPsql(`SELECT 1 FROM pg_database WHERE datname = '${dbName}';`);
    if (dbExists) {
      await this.execPsql(`DROP DATABASE "${dbName}";`);
    }

    const roleExists = await this.execPsql(`SELECT 1 FROM pg_roles WHERE rolname = '${dbUser}';`);
    if (roleExists) {
      await this.execPsql(`DROP ROLE "${dbUser}";`);
    }

    console.log(`[K8s/PG] Database "${dbName}" and user "${dbUser}" deleted`);
  }

  async getPostgresDatabaseStatus(
    dbName: string
  ): Promise<{ exists: boolean; size?: string; connections?: number }> {
    const SAFE_PG_IDENT = /^[a-z][a-z0-9_]{0,62}$/;
    if (!SAFE_PG_IDENT.test(dbName)) throw new Error(`Refusing unsafe pg identifier: ${dbName}`);
    try {
      const sizeResult = await this.execPsql(
        `SELECT pg_size_pretty(pg_database_size('${dbName}'));`
      );
      const connResult = await this.execPsql(
        `SELECT count(*) FROM pg_stat_activity WHERE datname = '${dbName}';`
      );
      return {
        exists: true,
        size: sizeResult || '0 bytes',
        connections: parseInt(connResult, 10) || 0
      };
    } catch {
      return { exists: false };
    }
  }

  private pgBackRestStanza(dbName: string): string {
    return dbName.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  private buildPgBackRestConf(opts: {
    stanza: string;
    r2Endpoint: string;
    r2Bucket: string;
    r2Region: string;
  }): string {
    const host = opts.r2Endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return [
      '[global]',
      'repo1-type=s3',
      `repo1-s3-bucket=${opts.r2Bucket}`,
      `repo1-s3-endpoint=${host}`,
      `repo1-s3-region=${opts.r2Region || 'auto'}`,
      'repo1-s3-uri-style=path',
      `repo1-path=/pgbackrest/${opts.stanza}`,
      'repo1-retention-full=7',
      'repo1-cipher-type=none',
      'process-max=2',
      'log-level-console=info',
      'start-fast=y',
      '',
      `[${opts.stanza}]`,
      'pg1-path=/var/lib/postgresql/data/pgdata',
      'pg1-port=5432',
      'pg1-user=postgres',
      ''
    ].join('\n');
  }

  async createPostgresContainer(options: {
    namespace: string;
    name: string;
    dbName: string;
    dbUser: string;
    dbPassword: string;
    storageSize?: string;
    r2?: {
      endpoint: string;
      bucket: string;
      region?: string;
      accessKey: string;
      secretKey: string;
    };
    resources?: PodSizing;
  }): Promise<{ host: string; port: number }> {
    this.ensureKubeConfig();

    const ns = String(options.namespace || '').trim();
    const name = String(options.name || '').trim();
    if (!ns) throw new BadRequestException('Namespace is required');
    if (!name) throw new BadRequestException('Name is required');

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

    const stanza = this.pgBackRestStanza(options.dbName);
    const labels = {
      'app.kubernetes.io/name': name,
      'app.kubernetes.io/component': 'postgres',
      'app.kubernetes.io/managed-by': 'orchard'
    };
    const selectorLabels = { 'app.kubernetes.io/name': name };

    const secretName = `${name}-pg`;
    const secretData: Record<string, string> = {
      POSTGRES_DB: Buffer.from(options.dbName).toString('base64'),
      POSTGRES_USER: Buffer.from(options.dbUser).toString('base64'),
      POSTGRES_PASSWORD: Buffer.from(options.dbPassword).toString('base64')
    };
    if (options.r2) {
      secretData['R2_ENDPOINT'] = Buffer.from(options.r2.endpoint).toString('base64');
      secretData['R2_BUCKET'] = Buffer.from(options.r2.bucket).toString('base64');
      secretData['R2_REGION'] = Buffer.from(options.r2.region || 'auto').toString('base64');
      secretData['R2_ACCESS_KEY'] = Buffer.from(options.r2.accessKey).toString('base64');
      secretData['R2_SECRET_KEY'] = Buffer.from(options.r2.secretKey).toString('base64');
    }

    try {
      await coreApi.readNamespacedSecret(secretName, ns);
      await coreApi.replaceNamespacedSecret(secretName, ns, {
        metadata: { name: secretName, namespace: ns, labels },
        type: 'Opaque',
        data: secretData
      });
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedSecret(ns, {
          metadata: { name: secretName, namespace: ns, labels },
          type: 'Opaque',
          data: secretData
        });
      } else {
        throw e;
      }
    }

    const pgbackrestConf = options.r2
      ? this.buildPgBackRestConf({
          stanza,
          r2Endpoint: options.r2.endpoint,
          r2Bucket: options.r2.bucket,
          r2Region: options.r2.region || 'auto'
        })
      : '';

    const cmName = `${name}-pgbackrest`;
    const cmData = {
      'pgbackrest.conf': pgbackrestConf,
      'postgresql.auto.conf.snippet': [
        "archive_mode = 'on'",
        `archive_command = 'pgbackrest --stanza=${stanza} archive-push %p'`,
        'archive_timeout = 60',
        'max_wal_senders = 3',
        'wal_level = replica',
        ''
      ].join('\n'),
      'init.sh': [
        '#!/bin/sh',
        'set -e',
        'mkdir -p /var/lib/postgresql/data/pgdata',
        'if [ -f /var/lib/postgresql/data/pgdata/postgresql.conf ]; then',
        "  grep -q 'archive_mode' /var/lib/postgresql/data/pgdata/postgresql.conf || cat /etc/pgbackrest-config/postgresql.auto.conf.snippet >> /var/lib/postgresql/data/pgdata/postgresql.conf",
        'fi',
        ''
      ].join('\n')
    };

    try {
      await coreApi.readNamespacedConfigMap(cmName, ns);
      await coreApi.replaceNamespacedConfigMap(cmName, ns, {
        metadata: { name: cmName, namespace: ns, labels },
        data: cmData
      });
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedConfigMap(ns, {
          metadata: { name: cmName, namespace: ns, labels },
          data: cmData
        });
      } else {
        throw e;
      }
    }

    const dataPvc = `${name}-data`;
    await this.createPVC(ns, dataPvc, options.storageSize || '1Gi');

    const envFromSecret: k8s.V1EnvVar[] = [
      {
        name: 'POSTGRES_DB',
        valueFrom: { secretKeyRef: { name: secretName, key: 'POSTGRES_DB' } }
      },
      {
        name: 'POSTGRES_USER',
        valueFrom: { secretKeyRef: { name: secretName, key: 'POSTGRES_USER' } }
      },
      {
        name: 'POSTGRES_PASSWORD',
        valueFrom: { secretKeyRef: { name: secretName, key: 'POSTGRES_PASSWORD' } }
      },
      { name: 'PGDATA', value: '/var/lib/postgresql/data/pgdata' }
    ];

    const pgbackrestEnv: k8s.V1EnvVar[] = options.r2
      ? [
          {
            name: 'PGBACKREST_REPO1_S3_KEY',
            valueFrom: { secretKeyRef: { name: secretName, key: 'R2_ACCESS_KEY' } }
          },
          {
            name: 'PGBACKREST_REPO1_S3_KEY_SECRET',
            valueFrom: { secretKeyRef: { name: secretName, key: 'R2_SECRET_KEY' } }
          }
        ]
      : [];

    const postgresContainer: k8s.V1Container = {
      name: 'postgres',
      image: 'postgres:17',
      imagePullPolicy: 'IfNotPresent',
      ports: [{ name: 'postgres', containerPort: 5432, protocol: 'TCP' }],
      env: [...envFromSecret, ...(options.r2 ? pgbackrestEnv : [])],
      args: options.r2
        ? [
            'postgres',
            '-c',
            'archive_mode=on',
            '-c',
            `archive_command=/opt/pgbackrest/pgbackrest --stanza=${stanza} --config=/etc/pgbackrest/pgbackrest.conf archive-push %p`,
            '-c',
            'archive_timeout=60',
            '-c',
            'max_wal_senders=3',
            '-c',
            'wal_level=replica'
          ]
        : undefined,
      volumeMounts: [
        { name: 'data', mountPath: '/var/lib/postgresql/data' },
        { name: 'pgbackrest-config', mountPath: '/etc/pgbackrest-config' },
        { name: 'pgbackrest-conf', mountPath: '/etc/pgbackrest' },
        ...(options.r2 ? [{ name: 'pgbackrest-bin', mountPath: '/opt/pgbackrest' }] : [])
      ],
      readinessProbe: {
        exec: { command: ['pg_isready', '-U', options.dbUser, '-d', options.dbName] },
        periodSeconds: 10,
        timeoutSeconds: 5,
        failureThreshold: 6
      },
      livenessProbe: {
        exec: { command: ['pg_isready', '-U', options.dbUser, '-d', options.dbName] },
        periodSeconds: 30,
        timeoutSeconds: 5,
        failureThreshold: 6
      }
    };

    if (options.resources) {
      postgresContainer.resources = containerResources(options.resources);
    }

    const pgbackrestContainer: k8s.V1Container = {
      name: 'pgbackrest',
      image: 'woblerr/pgbackrest:2.56.0-alpine',
      imagePullPolicy: 'IfNotPresent',
      command: [
        '/bin/sh',
        '-c',
        'cp /etc/pgbackrest-config/pgbackrest.conf /etc/pgbackrest/pgbackrest.conf 2>/dev/null || true; sleep infinity'
      ],
      env: [...envFromSecret, ...pgbackrestEnv],
      volumeMounts: [
        { name: 'data', mountPath: '/var/lib/postgresql/data' },
        { name: 'pgbackrest-config', mountPath: '/etc/pgbackrest-config' },
        { name: 'pgbackrest-conf', mountPath: '/etc/pgbackrest' }
      ]
    };

    const volumes: k8s.V1Volume[] = [
      { name: 'data', persistentVolumeClaim: { claimName: dataPvc } },
      { name: 'pgbackrest-config', configMap: { name: cmName, defaultMode: 0o755 } },
      { name: 'pgbackrest-conf', emptyDir: {} },
      ...(options.r2 ? [{ name: 'pgbackrest-bin', emptyDir: {} }] : [])
    ];

    const initContainers: k8s.V1Container[] = options.r2
      ? [
          {
            name: 'pgbackrest-install',
            image: 'postgres:17',
            imagePullPolicy: 'IfNotPresent',
            command: [
              '/bin/bash',
              '-c',
              [
                'set -e',
                'if [ -x /shared/pgbackrest ]; then echo "pgbackrest already installed"; exit 0; fi',
                'echo "Installing pgbackrest into /shared..."',
                'export DEBIAN_FRONTEND=noninteractive',
                'apt-get update -qq',
                'apt-get install -y --no-install-recommends pgbackrest',
                'cp "$(command -v pgbackrest)" /shared/pgbackrest',
                'chmod 0755 /shared/pgbackrest',
                'echo "done"'
              ].join(' && ')
            ],
            volumeMounts: [{ name: 'pgbackrest-bin', mountPath: '/shared' }]
          }
        ]
      : [];

    const deploymentBody: k8s.V1Deployment = {
      metadata: { name, namespace: ns, labels },
      spec: {
        replicas: 1,
        strategy: { type: 'Recreate' },
        selector: { matchLabels: selectorLabels },
        template: {
          metadata: { labels },
          spec: {
            initContainers: initContainers.length ? initContainers : undefined,
            containers: options.r2 ? [postgresContainer, pgbackrestContainer] : [postgresContainer],
            volumes
          }
        }
      }
    };

    try {
      await appsApi.readNamespacedDeployment(name, ns);
      await appsApi.replaceNamespacedDeployment(name, ns, deploymentBody);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await appsApi.createNamespacedDeployment(ns, deploymentBody);
      } else {
        throw e;
      }
    }

    const serviceBody: k8s.V1Service = {
      metadata: { name, namespace: ns, labels },
      spec: {
        type: 'ClusterIP',
        selector: selectorLabels,
        ports: [{ name: 'postgres', port: 5432, targetPort: 5432, protocol: 'TCP' }]
      }
    };
    try {
      await coreApi.readNamespacedService(name, ns);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedService(ns, serviceBody);
      } else {
        throw e;
      }
    }

    return { host: `${name}.${ns}.svc.cluster.local`, port: 5432 };
  }

  async deletePostgresContainer(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();
    const ns = String(namespace || '').trim();
    const n = String(name || '').trim();
    if (!ns || !n) return;

    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);

    const ignore404 = async (p: Promise<any>) => {
      try {
        await p;
      } catch (e: any) {
        if (e.response?.statusCode !== 404) throw e;
      }
    };

    await ignore404(appsApi.deleteNamespacedDeployment(n, ns));
    await ignore404(coreApi.deleteNamespacedService(n, ns));
    await ignore404(coreApi.deleteNamespacedSecret(`${n}-pg`, ns));
    await ignore404(coreApi.deleteNamespacedConfigMap(`${n}-pgbackrest`, ns));
    await ignore404(coreApi.deleteNamespacedPersistentVolumeClaim(`${n}-data`, ns));
    // Legacy repo PVC from earlier versions; safe to ignore if it doesn't exist.
    await ignore404(coreApi.deleteNamespacedPersistentVolumeClaim(`${n}-pgbackrest`, ns));
  }

  // Public wrapper so other modules (e.g. the MCP exec tool, the deployments
  // controller) can run a one-shot command in a pod without going through the
  // websocket terminal gateway. Returns stdout/stderr/success: no streaming.
  async runExec(
    namespace: string,
    pod: string,
    cmd: string[],
    container?: string
  ): Promise<{ stdout: string; stderr: string; success: boolean; container: string }> {
    assertValidPodName(pod);
    this.ensureKubeConfig();

    let targetContainer = container?.trim() || '';
    if (!targetContainer) {
      // Default to the first container in the pod spec; the pod terminal
      // gateway uses the same convention.
      try {
        const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
        const podSpec = await coreApi.readNamespacedPod(pod, namespace);
        targetContainer = podSpec.body.spec?.containers?.[0]?.name || '';
      } catch (error) {
        throw new NotFoundException({
          error: 'Pod not found',
          message: `Could not resolve pod ${pod} in ${namespace}: ${error.message}`
        });
      }
    }
    if (!targetContainer) {
      throw new BadRequestException('Pod has no containers to exec into');
    }

    const result = await this.execInPod(namespace, pod, targetContainer, cmd);
    return { ...result, container: targetContainer };
  }

  private async execInPod(
    namespace: string,
    pod: string,
    container: string,
    cmd: string[]
  ): Promise<{ stdout: string; stderr: string; success: boolean }> {
    this.ensureKubeConfig();
    const exec = new k8s.Exec(this.kc);
    console.log(`[K8s/exec] ns=${namespace} pod=${pod} container=${container}`);
    return new Promise((resolve) => {
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on('data', (c: Buffer) => outChunks.push(c));
      stderr.on('data', (c: Buffer) => errChunks.push(c));
      exec
        .exec(namespace, pod, container, cmd, stdout, stderr, null, false, (status) => {
          const stdoutStr = Buffer.concat(outChunks).toString('utf-8');
          const stderrStr = Buffer.concat(errChunks).toString('utf-8');
          const success = status.status === 'Success';
          console.log(
            `[K8s/exec] result ns=${namespace} pod=${pod} container=${container} success=${success}`
          );
          if (!success) console.log(`[K8s/exec] status: ${JSON.stringify(status)}`);
          resolve({ stdout: stdoutStr, stderr: stderrStr, success });
        })
        .catch((err: any) => {
          const msg = err?.message || String(err);
          console.error(
            `[K8s/exec] FAILED ns=${namespace} pod=${pod} container=${container}: ${msg}`
          );
          if (err?.body) console.error(`[K8s/exec] body:`, err.body);
          resolve({
            stdout: '',
            stderr: `exec error: ${msg}`,
            success: false
          });
        });
    });
  }

  private async findPostgresPod(namespace: string, name: string): Promise<string> {
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `app.kubernetes.io/name=${name}`
    );
    const pod = body.items.find((p) => p.status?.phase === 'Running') || body.items[0];
    if (!pod?.metadata?.name) throw new NotFoundException(`No pod found for database ${name}`);
    return pod.metadata.name;
  }

  async initPgBackRestStanza(namespace: string, name: string, dbName: string): Promise<void> {
    const pod = await this.findPostgresPod(namespace, name);
    const stanza = this.pgBackRestStanza(dbName);
    await this.execInPod(namespace, pod, 'pgbackrest', [
      'pgbackrest',
      `--stanza=${stanza}`,
      'stanza-create'
    ]);
  }

  async runPostgresBackup(
    namespace: string,
    name: string,
    dbName: string,
    type: 'full' | 'diff' | 'incr' = 'full'
  ): Promise<{ success: boolean; output: string }> {
    const pod = await this.findPostgresPod(namespace, name);
    const stanza = this.pgBackRestStanza(dbName);
    console.log(`[PG/backup] Starting ${type} backup stanza=${stanza} pod=${pod}`);

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body: podBody } = await coreApi.readNamespacedPod(pod, namespace);
    const containers = (podBody.spec?.containers || []).map((c) => c.name);
    console.log(`[PG/backup] pod containers: ${containers.join(', ')}`);
    if (!containers.includes('pgbackrest')) {
      const msg = `Pod ${pod} has no "pgbackrest" sidecar container (found: ${containers.join(', ')}). This database was likely created before backup storage was set up. Recreate or restart it to get the sidecar.`;
      console.error(`[PG/backup] ${msg}`);
      return { success: false, output: msg };
    }

    const stanzaResult = await this.execInPod(namespace, pod, 'pgbackrest', [
      'pgbackrest',
      `--stanza=${stanza}`,
      'stanza-create'
    ]);
    console.log(`[PG/backup] stanza-create success=${stanzaResult.success}`);

    const result = await this.execInPod(namespace, pod, 'pgbackrest', [
      'pgbackrest',
      `--stanza=${stanza}`,
      `--type=${type}`,
      'backup'
    ]);
    console.log(`[PG/backup] backup success=${result.success}`);
    return { success: result.success, output: result.stdout + result.stderr || 'no output' };
  }

  async listPostgresBackups(namespace: string, name: string, dbName: string): Promise<any[]> {
    const pod = await this.findPostgresPod(namespace, name);
    const stanza = this.pgBackRestStanza(dbName);
    const result = await this.execInPod(namespace, pod, 'pgbackrest', [
      'pgbackrest',
      `--stanza=${stanza}`,
      '--output=json',
      'info'
    ]);
    if (!result.success) return [];
    try {
      const parsed = JSON.parse(result.stdout);
      return Array.isArray(parsed) && parsed[0]?.backup ? parsed[0].backup : [];
    } catch {
      return [];
    }
  }

  async restorePostgresBackup(
    namespace: string,
    name: string,
    dbName: string,
    backupLabel?: string
  ): Promise<{ success: boolean; output: string }> {
    await this.findPostgresPod(namespace, name);
    const stanza = this.pgBackRestStanza(dbName);
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);

    await appsApi.patchNamespacedDeploymentScale(
      name,
      namespace,
      { spec: { replicas: 0 } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );

    await new Promise((r) => {
      setTimeout(r, 5000);
    });

    await appsApi.patchNamespacedDeploymentScale(
      name,
      namespace,
      { spec: { replicas: 1 } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );

    let newPod = '';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => {
        setTimeout(r, 3000);
      });
      try {
        newPod = await this.findPostgresPod(namespace, name);
        break;
      } catch {}
    }
    if (!newPod)
      throw new ServiceUnavailableException("Postgres pod didn't come back up for restore");

    const args = ['pgbackrest', `--stanza=${stanza}`, '--delta'];
    if (backupLabel) args.push(`--set=${backupLabel}`);
    args.push('restore');
    const result = await this.execInPod(namespace, newPod, 'pgbackrest', args);
    return { success: result.success, output: result.stdout + result.stderr };
  }

  async getPostgresContainerStatus(
    namespace: string,
    name: string,
    dbName?: string,
    dbUser?: string
  ): Promise<{
    exists: boolean;
    ready?: boolean;
    phase?: string;
    replicas?: number;
    readyReplicas?: number;
    size?: string;
    connections?: number;
    restartCount?: number;
    message?: string;
  }> {
    this.ensureKubeConfig();
    const appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      const { body: dep } = await appsApi.readNamespacedDeployment(name, namespace);
      const replicas = dep.spec?.replicas ?? 0;
      const readyReplicas = dep.status?.readyReplicas ?? 0;
      const ready = readyReplicas > 0;

      let phase: string | undefined;
      let restartCount = 0;
      let message: string | undefined;
      try {
        const { body: podList } = await coreApi.listNamespacedPod(
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `app.kubernetes.io/name=${name}`
        );
        const pod = podList.items[0];
        if (pod) {
          phase = pod.status?.phase;
          const container = pod.status?.containerStatuses?.find((c) => c.name === 'postgres');
          if (container) {
            restartCount = container.restartCount || 0;
            if (container.state?.waiting) {
              message = container.state.waiting.reason;
              if (container.state.waiting.message) phase = 'Waiting';
            } else if (container.state?.terminated) {
              message = container.state.terminated.reason;
            }
          }
        } else {
          phase = 'Pending';
          message = 'No pod found';
        }
      } catch {}

      let size: string | undefined;
      let connections: number | undefined;
      if (ready && dbName && dbUser) {
        try {
          const cacheKey = `${namespace}/${name}`;
          const cached = this.dbStatsCache.get(cacheKey);
          if (cached && Date.now() - cached.at < this.DB_STATS_TTL_MS) {
            size = cached.size;
            connections = cached.connections;
          } else {
            const pod = await this.findPostgresPod(namespace, name);
            // psql does not expand `-v` variables inside `-c` commands, so the
            // name is inlined behind a strict character allowlist instead.
            // dbName is slug-constructed ([a-z0-9_]); anything else means the
            // row is corrupt and stats are skipped rather than risk injection.
            const safeDb = dbName.replace(/[^a-zA-Z0-9_]/g, '');
            if (safeDb !== dbName) throw new Error('unexpected characters in dbName');
            const r = await this.execInPod(namespace, pod, 'postgres', [
              'psql',
              '-U',
              dbUser,
              '-d',
              dbName,
              '-t',
              '-A',
              '-c',
              `SELECT pg_size_pretty(pg_database_size('${safeDb}')) || '|' || (SELECT count(*) FROM pg_stat_activity WHERE datname = '${safeDb}');`
            ]);
            const [sizeRaw, connRaw] = r.stdout.trim().split('|');
            size = sizeRaw || undefined;
            connections = parseInt(connRaw, 10) || 0;
            this.dbStatsCache.set(cacheKey, { size, connections, at: Date.now() });
          }
        } catch {}
      }

      return {
        exists: true,
        ready,
        phase,
        replicas,
        readyReplicas,
        size,
        connections,
        restartCount,
        message
      };
    } catch {
      return { exists: false };
    }
  }

  private readonly CNPG_GROUP = 'postgresql.cnpg.io';

  private readonly CNPG_VERSION = 'v1';

  private readonly CNPG_PLURAL = 'clusters';

  private readonly CNPG_BACKUP_PLURAL = 'backups';

  private readonly CNPG_SCHEDULED_BACKUP_PLURAL = 'scheduledbackups';

  private async listInstancePods(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    clusterName: string
  ): Promise<k8s.V1Pod[]> {
    const { body } = await coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `cnpg.io/cluster=${clusterName}`
    );
    return body.items || [];
  }

  private async recordBackupMemoryRaise(
    namespace: string,
    clusterName: string,
    from: string,
    to: string
  ): Promise<void> {
    this.logger.warn(
      `raised ${namespace}/${clusterName} from ${from} to ${to}: backups kept OOMKilling it`
    );
    await this.prisma.database
      .updateMany({
        where: { namespace, clusterName },
        data: { memoryRequestBytes: BigInt(parseMemory(to)) }
      })
      .catch((e) =>
        this.logger.warn(`memory raise not recorded on ${clusterName}: ${e?.message || e}`)
      );
    const notifications = this.moduleRef.get(NotificationsService, { strict: false });
    await notifications
      ?.notifyDbMemoryRaised(namespace, clusterName, from, to)
      .catch((e: any) =>
        this.logger.warn(`memory raise notice for ${clusterName} failed: ${e?.message || e}`)
      );
  }

  private async readClusterSpec(
    customApi: k8s.CustomObjectsApi,
    namespace: string,
    clusterName: string
  ): Promise<{ affinity?: any; primaryUpdateStrategy?: string } | null> {
    try {
      const res: any = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_PLURAL,
        clusterName
      );
      return (res?.body ?? res)?.spec ?? null;
    } catch (e: any) {
      if (e?.response?.statusCode === 404) return null;
      throw e;
    }
  }

  private buildAppSecretName(clusterName: string): string {
    return `${clusterName}-app`;
  }

  async createCnpgCluster(options: {
    namespace: string;
    clusterName: string;
    dbName: string;
    dbUser: string;
    dbPassword: string;
    storageSize?: string;
    parameters?: Record<string, string>;
    sharedPreloadLibraries?: string[];
    imageName?: string;
    r2?: {
      endpoint: string;
      bucket: string;
      region?: string;
      accessKey: string;
      secretKey: string;
    };
    resources?: { cpuMilli: number; memoryBytes: number };
    // null/undefined = derive from the memory limit. 'gzip' | 'none' = the user's call.
    backupCompression?: string | null;
    instances?: number;
    placement?: ResolvedPlacement;
    backupServerName?: string;
    useBarmanPlugin?: boolean;
    importFrom?: {
      host: string;
      hostAddr?: string;
      port?: number;
      user: string;
      password: string;
      database: string;
      sslMode?: string;
    };
  }): Promise<{ host: string; port: number }> {
    this.ensureKubeConfig();
    await this.ensureCnpgOperatorIngress(String(options.namespace || '').trim()).catch((e) => {
      this.logger.warn(`allow-cnpg-operator ensure failed: ${e?.message || e}`);
    });
    await this.ensureDatabasePlatformPolicy(String(options.namespace || '').trim()).catch((e) => {
      this.logger.warn(`${DATABASE_PLATFORM_POLICY} ensure failed: ${e?.message || e}`);
    });
    const ns = options.namespace.trim();
    const name = options.clusterName.trim();
    if (!ns || !name) throw new BadRequestException('namespace and clusterName required');

    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const labels = {
      'app.kubernetes.io/name': name,
      'app.kubernetes.io/component': 'postgres',
      'app.kubernetes.io/managed-by': 'orchard'
    };

    // App-user credential secret: referenced by the Cluster for initdb bootstrap.
    const appSecretName = this.buildAppSecretName(name);
    const appSecretData = {
      username: Buffer.from(options.dbUser).toString('base64'),
      password: Buffer.from(options.dbPassword).toString('base64')
    };
    await this.upsertSecret(
      coreApi,
      ns,
      appSecretName,
      'kubernetes.io/basic-auth',
      appSecretData,
      labels
    );

    // R2 credentials secret (if backups configured).
    let r2SecretName: string | undefined;
    if (options.r2) {
      r2SecretName = `${name}-r2`;
      const r2SecretData = {
        ACCESS_KEY_ID: Buffer.from(options.r2.accessKey).toString('base64'),
        ACCESS_SECRET_KEY: Buffer.from(options.r2.secretKey).toString('base64')
      };
      await this.upsertSecret(coreApi, ns, r2SecretName, 'Opaque', r2SecretData, labels);
    }

    // Derived from the memory limit, but only where the user hasn't set the knob
    // themselves: `options.parameters` still spreads last and wins outright.
    const tuning = deriveDbTuning({
      memoryLimitBytes: options.resources?.memoryBytes,
      overrides: {
        sharedBuffers: options.parameters?.shared_buffers,
        backupCompression: options.backupCompression
      }
    });

    const clusterSpec: any = {
      instances: Math.max(1, Math.trunc(options.instances || 1)),
      enablePDB: pdbEnabledFor(options.instances),
      ...(pdbEnabledFor(options.instances) ? {} : primaryLeaseSpecFor(options.instances)),
      imageName: options.imageName || resolvePostgresImage(17, null),
      primaryUpdateStrategy: 'unsupervised',
      storage: {
        size: options.storageSize || '1Gi',
        storageClass: process.env.K8S_STORAGE_CLASS || undefined
      },
      bootstrap: {
        initdb: {
          database: options.dbName,
          owner: options.dbUser,
          secret: { name: appSecretName }
        }
      },
      postgresql: {
        parameters: {
          max_connections: '100',
          shared_buffers: tuning.sharedBuffers,
          max_slot_wal_keep_size: walSlotKeepSize(options.storageSize),
          ...options.parameters
        },
        ...(options.sharedPreloadLibraries && options.sharedPreloadLibraries.length > 0
          ? { shared_preload_libraries: options.sharedPreloadLibraries }
          : {})
      },
      enableSuperuserAccess: false
    };

    if (options.resources) {
      clusterSpec.resources = containerResources(
        databaseSizing(options.resources, tuning.sharedBuffers)
      );
    }

    if (options.importFrom) {
      const importSecretName = `${name}-import-source`;
      await this.upsertSecret(
        coreApi,
        ns,
        importSecretName,
        'Opaque',
        {
          password: Buffer.from(options.importFrom.password).toString('base64')
        },
        labels
      );

      const sourceName = 'import-source';
      const sslMode = options.importFrom.sslMode || 'prefer';
      const verifiesServerCert = sslMode === 'verify-ca' || sslMode === 'verify-full';
      const connectionParameters: Record<string, string> = {
        host: options.importFrom.host,
        port: String(options.importFrom.port || 5432),
        user: options.importFrom.user,
        dbname: options.importFrom.database,
        sslmode: sslMode
      };
      if (options.importFrom.hostAddr) {
        connectionParameters.hostaddr = options.importFrom.hostAddr;
      }
      if (verifiesServerCert) {
        connectionParameters.sslrootcert = 'system';
      }
      clusterSpec.externalClusters = [
        {
          name: sourceName,
          connectionParameters,
          password: { name: importSecretName, key: 'password' }
        }
      ];
      clusterSpec.bootstrap.initdb.import = {
        type: 'microservice',
        databases: [options.importFrom.database],
        source: { externalCluster: sourceName },
        // pg_restore never runs ANALYZE, so without this the planner has zero
        // statistics until autoanalyze catches up and every query misplans.
        postImportApplicationSQL: ['ANALYZE']
      };
    }

    if (options.r2 && r2SecretName) {
      const serverName = options.backupServerName || name;
      if (options.useBarmanPlugin) {
        const store = objectStoreName(name);
        await this.upsertObjectStore(
          ns,
          objectStoreBody(
            ns,
            store,
            {
              destinationPath: `s3://${options.r2.bucket}/${ns}/${name}`,
              endpointURL: normalizeBackupEndpointURL(options.r2.endpoint),
              secretName: r2SecretName
            },
            { walMaxParallel: WAL_ARCHIVE_MAX_PARALLEL, dataCompression: 'gzip', labels }
          )
        );
        clusterSpec.plugins = [walArchiverPlugin(store, serverName)];
      } else {
        clusterSpec.backup = this.buildBackupSpec(
          ns,
          name,
          options.r2,
          r2SecretName,
          tuning.dataCompression,
          serverName
        );
      }
    }

    // CNPG places its instance pods; feed the resolved placement into
    // spec.affinity (standard nodeAffinity + tolerations) so DB pods honor node
    // pools / taints the same way app and job pods do.
    const cnpgAffinity: any = {};
    if (options.placement?.affinity?.nodeAffinity) {
      cnpgAffinity.nodeAffinity = options.placement.affinity.nodeAffinity;
    }
    if (options.placement?.tolerations?.length) {
      cnpgAffinity.tolerations = options.placement.tolerations;
    }
    if (Object.keys(cnpgAffinity).length > 0) {
      clusterSpec.affinity = cnpgAffinity;
    }

    const clusterBody: any = {
      apiVersion: `${this.CNPG_GROUP}/${this.CNPG_VERSION}`,
      kind: 'Cluster',
      metadata: {
        name,
        namespace: ns,
        labels,
        annotations: appliedSharedBuffers(clusterSpec.postgresql?.parameters?.shared_buffers)
      },
      spec: clusterSpec
    };

    try {
      await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        ns,
        this.CNPG_PLURAL,
        name
      );
      await customApi.replaceNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        ns,
        this.CNPG_PLURAL,
        name,
        clusterBody
      );
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await customApi.createNamespacedCustomObject(
          this.CNPG_GROUP,
          this.CNPG_VERSION,
          ns,
          this.CNPG_PLURAL,
          clusterBody
        );
      } else {
        throw e;
      }
    }

    // Service name is <cluster>-rw (read/write primary). DNS takes a few seconds.
    return { host: `${name}-rw.${ns}.svc.cluster.local`, port: 5432 };
  }

  private async upsertSecret(
    coreApi: k8s.CoreV1Api,
    namespace: string,
    name: string,
    type: string,
    data: Record<string, string>,
    labels: Record<string, string>
  ) {
    const body: k8s.V1Secret = {
      metadata: { name, namespace, labels },
      type,
      data
    };
    try {
      await coreApi.readNamespacedSecret(name, namespace);
      await coreApi.replaceNamespacedSecret(name, namespace, body);
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await coreApi.createNamespacedSecret(namespace, body);
      } else {
        throw e;
      }
    }
  }

  async deleteCnpgCluster(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const ns = namespace.trim();
    const name = clusterName.trim();
    if (!ns || !name) return;

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const ignore404 = async (p: Promise<any>) => {
      try {
        await p;
      } catch (e: any) {
        if (e.response?.statusCode !== 404) throw e;
      }
    };

    await ignore404(
      customApi.deleteNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        ns,
        this.CNPG_PLURAL,
        name
      )
    );
    await ignore404(coreApi.deleteNamespacedSecret(this.buildAppSecretName(name), ns));
    await ignore404(coreApi.deleteNamespacedSecret(`${name}-r2`, ns));
    await ignore404(coreApi.deleteNamespacedSecret(`${name}-import-source`, ns));
  }

  async getCnpgClusterStatus(
    namespace: string,
    clusterName: string,
    _dbName?: string,
    mirroredPods?: MirroredDbPod[] | null,
    mirrored?: { cluster: ClusterSnapshot | null; stats: DbStats } | null,
    recovery?: RecoveryFallback | null
  ): Promise<any> {
    const stats: DbStats = mirrored?.stats ?? { sizeBytes: null, connections: null, statsAt: null };
    if (mirrored?.cluster && mirroredPods && mirroredPods.length > 0) {
      return buildCnpgLiveStatus(
        withRecoveryFallback(mirrored.cluster, recovery),
        mirroredPods,
        stats
      );
    }
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      const { body } = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_PLURAL,
        clusterName
      );
      const cluster = withRecoveryFallback(clusterSnapshot(body), recovery);
      let pods: MirroredDbPod[] = mirroredPods ?? [];
      if (pods.length === 0) {
        try {
          const { body: podList } = await coreApi.listNamespacedPod(
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            `cnpg.io/cluster=${clusterName}`
          );
          pods = (podList.items || [])
            .map((pod) => livePodToMirrored(pod))
            .filter((p): p is MirroredDbPod => p !== null);
        } catch {
          /* pod listing is best-effort */
        }
      }
      return buildCnpgLiveStatus(cluster, pods, stats);
    } catch (e: any) {
      if (e.response?.statusCode === 404) return { exists: false };
      throw e;
    }
  }

  async sampleDatabaseStats(
    namespace: string,
    pod: string,
    dbName: string,
    opts: { measureDataDir?: boolean } = {}
  ): Promise<SampledDbStats | null> {
    const safeDb = dbName.replace(/[^a-zA-Z0-9_]/g, '');
    if (safeDb !== dbName) return null;
    const r = await this.execInPod(namespace, pod, 'postgres', dbStatsCommand(safeDb, opts));
    if (!r.success) return null;
    return parseDbStatsOutput(r.stdout);
  }

  // Detailed provisioning view for the CNPG cluster: PVC, instance pod, optional
  // import job pod, conditions, and recent warning events. Used by the database
  // page to show a step-by-step "provisioning" experience while the cluster is
  // coming up, and to surface migration errors that otherwise only appear via
  // `kubectl logs`.
  async getCnpgProvisioningStatus(
    namespace: string,
    clusterName: string,
    opts?: { fetchImportLogs?: boolean }
  ): Promise<any> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    let cluster: any = null;
    try {
      const { body } = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_PLURAL,
        clusterName
      );
      cluster = body;
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }

    const hasImport = !!cluster?.spec?.bootstrap?.initdb?.import;
    const phase: string | undefined = cluster?.status?.phase;
    const readyInstances: number = cluster?.status?.readyInstances || 0;
    const instances: number = cluster?.status?.instances || cluster?.spec?.instances || 1;
    const ready = readyInstances >= instances && readyInstances > 0;

    let pods: any[] = [];
    try {
      const { body: podList } = await coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `cnpg.io/cluster=${clusterName}`
      );
      pods = podList.items || [];
    } catch {
      /* ignore */
    }

    const importPod = pods.find((p) => {
      const labels = p.metadata?.labels || {};
      return (
        labels['cnpg.io/jobRole'] === 'import' ||
        labels['cnpg.io/jobRole'] === 'full-recovery' ||
        /-import-\d+$/.test(p.metadata?.name || '')
      );
    });
    const instancePod =
      pods.find((p) => {
        const labels = p.metadata?.labels || {};
        return (
          labels['cnpg.io/instanceRole'] === 'primary' ||
          labels['cnpg.io/instanceRole'] === 'replica' ||
          labels['role'] === 'primary' ||
          /-\d+$/.test(p.metadata?.name || '')
        );
      }) || pods.find((p) => p !== importPod);

    // PVC: CNPG provisions `<cluster>-1` for the first instance.
    let pvc: { exists: boolean; bound: boolean; phase?: string } = { exists: false, bound: false };
    try {
      const { body } = await coreApi.readNamespacedPersistentVolumeClaim(
        `${clusterName}-1`,
        namespace
      );
      pvc = { exists: true, bound: body.status?.phase === 'Bound', phase: body.status?.phase };
    } catch (e: any) {
      if (e.response?.statusCode !== 404) {
        // Surface non-404 errors as "exists unknown" rather than crashing
      }
    }

    const containerStatuses = (instancePod?.status?.containerStatuses || []) as any[];
    const waiting = containerStatuses.map((c) => c.state?.waiting).find((w) => w?.reason);
    const podScheduled = !!instancePod?.spec?.nodeName;
    const podRunning = instancePod?.status?.phase === 'Running';
    const podReady = containerStatuses.length > 0 && containerStatuses.every((c) => c.ready);

    // Events scoped to this cluster's objects. Warnings surface things like
    // FailedScheduling, FailedAttachVolume, BackOff, FailedSync, etc.
    let events: any[] = [];
    try {
      const { body: ev } = await coreApi.listNamespacedEvent(namespace);
      events = (ev.items || [])
        .filter((e: any) => {
          const inv = e.involvedObject || {};
          const name = inv.name || '';
          if (inv.kind === 'Cluster' && name === clusterName) return true;
          if (name === clusterName || name.startsWith(`${clusterName}-`)) return true;
          return false;
        })
        .map((e: any) => ({
          type: e.type,
          reason: e.reason,
          message: e.message,
          kind: e.involvedObject?.kind,
          name: e.involvedObject?.name,
          count: e.count || 1,
          firstTimestamp: e.firstTimestamp,
          lastTimestamp: e.lastTimestamp || e.eventTime || e.firstTimestamp
        }))
        .sort((a: any, b: any) => {
          const tA = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0;
          const tB = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0;
          return tA - tB;
        });
    } catch {
      /* ignore */
    }

    let importStatus: 'pending' | 'running' | 'completed' | 'failed' | undefined;
    let importLogs: string | undefined;
    let importError: string | undefined;
    if (hasImport) {
      if (importPod) {
        const ipPhase = importPod.status?.phase;
        if (ipPhase === 'Succeeded') importStatus = 'completed';
        else if (ipPhase === 'Failed') importStatus = 'failed';
        else if (ipPhase === 'Running') importStatus = 'running';
        else importStatus = 'pending';

        // Mark failed if any container is in a CrashLoopBackOff / Error state
        const ipContainers = (importPod.status?.containerStatuses || []) as any[];
        const crashy = ipContainers.find(
          (c) => c.state?.waiting?.reason && /Err|BackOff|Failed/.test(c.state.waiting.reason)
        );
        if (crashy) importStatus = 'failed';

        const oomKilled = ipContainers.find((c) => {
          const reason = c.state?.terminated?.reason ?? c.lastState?.terminated?.reason;
          return reason === 'OOMKilled';
        });
        if (oomKilled) {
          importStatus = 'failed';
          importError =
            'The import ran out of memory while restoring data. Recreate the database with more memory, or contact an admin if this keeps happening.';
        } else if (importStatus === 'failed') {
          const reason =
            crashy?.state?.waiting?.reason ??
            ipContainers.find((c) => c.state?.terminated || c.lastState?.terminated)?.state
              ?.terminated?.reason;
          if (reason)
            importError = `The import pod failed (${reason}). Check the migration logs below.`;
        }

        if (opts?.fetchImportLogs && importPod.metadata?.name) {
          try {
            const { body } = await coreApi.readNamespacedPodLog(
              importPod.metadata.name,
              namespace,
              undefined,
              false,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              500
            );
            importLogs = podLogText(body);
          } catch {
            /* ignore */
          }
        }
      } else if (ready) {
        importStatus = 'completed';
      } else {
        importStatus = 'pending';
      }
    }

    return {
      exists: !!cluster,
      phase,
      ready,
      readyInstances,
      instances,
      hasImport,
      importError,
      pvc,
      instancePod: instancePod
        ? {
            name: instancePod.metadata?.name,
            phase: instancePod.status?.phase,
            scheduled: podScheduled,
            running: podRunning,
            ready: podReady,
            waiting: waiting ? { reason: waiting.reason, message: waiting.message } : null,
            nodeName: instancePod.spec?.nodeName || null
          }
        : null,
      importPod: importPod
        ? {
            name: importPod.metadata?.name,
            phase: importPod.status?.phase,
            status: importStatus
          }
        : null,
      importStatus,
      importLogs,
      conditions: cluster?.status?.conditions || [],
      events
    };
  }

  async findCnpgPrimaryPod(namespace: string, clusterName: string): Promise<string> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `cnpg.io/cluster=${clusterName},cnpg.io/instanceRole=primary`
    );
    const pod = body.items[0];
    if (!pod?.metadata?.name) {
      // Fallback: any pod belonging to the cluster.
      const { body: fb } = await coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `cnpg.io/cluster=${clusterName}`
      );
      if (!fb.items[0]?.metadata?.name) {
        throw new NotFoundException(`No CNPG pod for cluster ${clusterName}`);
      }
      return fb.items[0].metadata.name;
    }
    return pod.metadata.name;
  }

  async createCnpgBackup(
    namespace: string,
    clusterName: string,
    backupName: string
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const method = await this.backupMethodOf(customApi, namespace, clusterName);
    const body = {
      apiVersion: `${this.CNPG_GROUP}/${this.CNPG_VERSION}`,
      kind: 'Backup',
      metadata: {
        name: backupName,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'cnpg.io/cluster': clusterName
        }
      },
      spec: { cluster: { name: clusterName }, ...backupMethodSpec(method) }
    };
    await customApi.createNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_BACKUP_PLURAL,
      body
    );
  }

  private async backupMethodOf(
    customApi: k8s.CustomObjectsApi,
    namespace: string,
    clusterName: string
  ): Promise<BackupMethod> {
    const spec = (await this.readClusterSpec(customApi, namespace, clusterName)) as any;
    return clusterArchivesWithPlugin(spec) ? 'plugin' : 'barman';
  }

  private pluginProbe: { at: number; installed: boolean } | null = null;

  async barmanPluginInstalled(): Promise<boolean> {
    if (this.pluginProbe && Date.now() - this.pluginProbe.at < 5 * 60_000) {
      return this.pluginProbe.installed;
    }
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.listClusterCustomObject(
        BARMAN_GROUP,
        BARMAN_VERSION,
        OBJECT_STORE_PLURAL,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1
      );
      this.pluginProbe = { at: Date.now(), installed: true };
    } catch (e: any) {
      if (e?.response?.statusCode !== 404) throw e;
      this.pluginProbe = { at: Date.now(), installed: false };
    }
    return this.pluginProbe.installed;
  }

  async usePluginForNewClusters(): Promise<boolean> {
    if (process.env.CNPG_BARMAN_PLUGIN !== 'on') return false;
    return this.barmanPluginInstalled().catch(() => false);
  }

  async recoveryJobFailure(namespace: string, clusterName: string): Promise<string | null> {
    this.ensureKubeConfig();
    const batchApi = this.kc.makeApiClient(k8s.BatchV1Api);
    const { body } = await batchApi.listNamespacedJob(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `cnpg.io/cluster=${clusterName},cnpg.io/jobRole=full-recovery`
    );
    const job = failedRecoveryJob(body.items ?? []);
    if (!job) return null;
    return recoveryFailureMessage(await this.jobLogTail(namespace, job).catch(() => ''));
  }

  private async jobLogTail(namespace: string, job: string): Promise<string> {
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.listNamespacedPod(
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `job-name=${job}`
    );
    const pod = (body.items ?? []).sort(
      (a, b) =>
        new Date(b.metadata?.creationTimestamp ?? 0).getTime() -
        new Date(a.metadata?.creationTimestamp ?? 0).getTime()
    )[0];
    if (!pod?.metadata?.name) return '';
    const containers = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])];
    const logs = await Promise.all(
      containers.map((container) =>
        coreApi
          .readNamespacedPodLog(
            pod.metadata!.name!,
            namespace,
            container.name,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            40
          )
          .then((res) => podLogText(res.body))
          .catch(() => '')
      )
    );
    return logs.join('\n');
  }

  async primaryLogTail(namespace: string, clusterName: string, lines = 80): Promise<string> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const pod = await this.findCnpgPrimaryPod(namespace, clusterName);
    const { body } = await coreApi.readNamespacedPodLog(
      pod,
      namespace,
      'postgres',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      Math.max(1, Math.min(lines, 500))
    );
    return podLogText(body);
  }

  async namespaceMemoryHeadroom(namespace: string): Promise<number | null> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.listNamespacedResourceQuota(namespace);
    let headroom: number | null = null;
    for (const q of body.items ?? []) {
      const hard = q.status?.hard?.['limits.memory'] ?? q.spec?.hard?.['limits.memory'];
      if (!hard) continue;
      const used = q.status?.used?.['limits.memory'] ?? '0';
      const free = parseMemory(String(hard)) - parseMemory(String(used));
      headroom = headroom === null ? free : Math.min(headroom, free);
    }
    return headroom;
  }

  async migrateClusterToPlugin(
    namespace: string,
    clusterName: string
  ): Promise<{ serverName: string; objectStore: string } | null> {
    const cluster = await this.readCluster(namespace, clusterName);
    if (!cluster) return null;
    if (clusterArchivesWithPlugin(cluster.spec)) {
      const archiver = cluster.spec.plugins.find((p: any) => p?.isWALArchiver);
      return {
        serverName: archiver?.parameters?.serverName || clusterName,
        objectStore: archiver?.parameters?.barmanObjectName || objectStoreName(clusterName)
      };
    }
    const store = cluster.spec?.backup?.barmanObjectStore;
    if (!store) return null;
    const serverName = store.serverName || clusterName;
    const name = objectStoreName(clusterName);
    await this.upsertObjectStore(namespace, {
      apiVersion: `${BARMAN_GROUP}/${BARMAN_VERSION}`,
      kind: 'ObjectStore',
      metadata: {
        name,
        namespace,
        labels: { 'app.kubernetes.io/managed-by': 'orchard', 'cnpg.io/cluster': clusterName }
      },
      spec: {
        ...objectStoreBody(
          namespace,
          name,
          {
            destinationPath: store.destinationPath,
            endpointURL: store.endpointURL,
            secretName: store.s3Credentials?.accessKeyId?.name || this.r2SecretName(clusterName)
          },
          {
            walMaxParallel: store.wal?.maxParallel || WAL_ARCHIVE_MAX_PARALLEL,
            dataCompression: 'gzip'
          }
        ).spec,
        retentionPolicy: cluster.spec?.backup?.retentionPolicy || '30d'
      }
    });
    await this.patchCluster(namespace, clusterName, {
      spec: { backup: null, plugins: [walArchiverPlugin(name, serverName)] }
    });
    return { serverName, objectStore: name };
  }

  async upsertObjectStore(namespace: string, body: any): Promise<void> {
    await this.upsertCustom(BARMAN_GROUP, BARMAN_VERSION, OBJECT_STORE_PLURAL, namespace, body);
  }

  async deleteObjectStore(namespace: string, name: string): Promise<void> {
    await this.deleteCustom(BARMAN_GROUP, BARMAN_VERSION, OBJECT_STORE_PLURAL, namespace, name);
  }

  async upsertPooler(namespace: string, body: any): Promise<void> {
    await this.upsertCustom(this.CNPG_GROUP, this.CNPG_VERSION, 'poolers', namespace, body);
  }

  async deletePooler(namespace: string, name: string): Promise<void> {
    await this.deleteCustom(this.CNPG_GROUP, this.CNPG_VERSION, 'poolers', namespace, name);
  }

  async getPooler(namespace: string, name: string): Promise<any | null> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      const { body } = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        'poolers',
        name
      );
      return body;
    } catch (e: any) {
      if (e?.response?.statusCode === 404) return null;
      throw e;
    }
  }

  async createClusterFromSpec(
    namespace: string,
    name: string,
    spec: any,
    labels: Record<string, string>
  ): Promise<void> {
    this.ensureKubeConfig();
    await this.ensureCnpgOperatorIngress(namespace).catch((e) => {
      this.logger.warn(`allow-cnpg-operator ensure failed: ${e?.message || e}`);
    });
    await this.ensureDatabasePlatformPolicy(namespace).catch((e) => {
      this.logger.warn(`${DATABASE_PLATFORM_POLICY} ensure failed: ${e?.message || e}`);
    });
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.createNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      {
        apiVersion: `${this.CNPG_GROUP}/${this.CNPG_VERSION}`,
        kind: 'Cluster',
        metadata: {
          name,
          namespace,
          labels: { 'app.kubernetes.io/managed-by': 'orchard', ...labels },
          annotations: appliedSharedBuffers(spec.postgresql?.parameters?.shared_buffers)
        },
        spec
      }
    );
  }

  async readCluster(namespace: string, name: string): Promise<any | null> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      const { body } = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_PLURAL,
        name
      );
      return body;
    } catch (e: any) {
      if (e?.response?.statusCode === 404) return null;
      throw e;
    }
  }

  async patchCluster(namespace: string, name: string, patch: any): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      name,
      patch,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  async writeSecret(
    namespace: string,
    name: string,
    data: Record<string, string>,
    type = 'Opaque'
  ): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const encoded = Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString('base64')])
    );
    await this.upsertSecret(coreApi, namespace, name, type, encoded, {
      'app.kubernetes.io/managed-by': 'orchard'
    });
  }

  async copySecret(
    fromNamespace: string,
    name: string,
    toNamespace: string,
    toName: string
  ): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.readNamespacedSecret(name, fromNamespace);
    await this.upsertSecret(
      coreApi,
      toNamespace,
      toName,
      body.type || 'Opaque',
      (body.data ?? {}) as Record<string, string>,
      { 'app.kubernetes.io/managed-by': 'orchard' }
    );
  }

  async deleteSecret(namespace: string, name: string): Promise<void> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    try {
      await coreApi.deleteNamespacedSecret(name, namespace);
    } catch (e: any) {
      if (e?.response?.statusCode !== 404) throw e;
    }
  }

  private async upsertCustom(
    group: string,
    version: string,
    plural: string,
    namespace: string,
    body: any
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const name = body.metadata.name;
    try {
      const { body: existing } = await customApi.getNamespacedCustomObject(
        group,
        version,
        namespace,
        plural,
        name
      );
      await customApi.replaceNamespacedCustomObject(group, version, namespace, plural, name, {
        ...body,
        metadata: { ...body.metadata, resourceVersion: (existing as any).metadata?.resourceVersion }
      });
    } catch (e: any) {
      if (e?.response?.statusCode !== 404) throw e;
      await customApi.createNamespacedCustomObject(group, version, namespace, plural, body);
    }
  }

  private async deleteCustom(
    group: string,
    version: string,
    plural: string,
    namespace: string,
    name: string
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.deleteNamespacedCustomObject(group, version, namespace, plural, name);
    } catch (e: any) {
      if (e?.response?.statusCode !== 404) throw e;
    }
  }

  async deleteManualBackups(namespace: string, clusterName: string): Promise<void> {
    const backups = await this.listCnpgBackups(namespace, clusterName);
    for (const b of backups) {
      if (b.metadata?.labels?.['cnpg.io/scheduled-backup']) continue;
      if (b.metadata?.ownerReferences?.length) continue;
      await this.deleteCnpgBackup(namespace, b.metadata.name);
    }
  }

  async getCnpgBackup(namespace: string, backupName: string): Promise<any> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      const { body } = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_BACKUP_PLURAL,
        backupName
      );
      return body;
    } catch (e: any) {
      if (e.response?.statusCode === 404) return null;
      throw e;
    }
  }

  async listCnpgBackups(namespace: string, clusterName: string): Promise<any[]> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const { body } = await customApi.listNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_BACKUP_PLURAL
    );
    const items: any[] = (body as any).items || [];
    return items.filter((b) => b.spec?.cluster?.name === clusterName);
  }

  async listAllCnpgBackups(): Promise<any[]> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const { body } = await customApi.listClusterCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      this.CNPG_BACKUP_PLURAL
    );
    return (body as any).items || [];
  }

  async listAllCnpgClusters(): Promise<any[]> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const { body } = await customApi.listClusterCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      this.CNPG_PLURAL
    );
    return (body as any).items || [];
  }

  async listAllScheduledBackups(): Promise<any[]> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const { body } = await customApi.listClusterCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      this.CNPG_SCHEDULED_BACKUP_PLURAL
    );
    return (body as any).items || [];
  }

  async cnpgClusterExists(namespace: string, clusterName: string): Promise<boolean> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    return (await this.readClusterSpec(customApi, namespace, clusterName)) !== null;
  }

  async deleteCnpgBackup(namespace: string, backupName: string): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.deleteNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_BACKUP_PLURAL,
        backupName
      );
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  async updateCnpgParameters(
    namespace: string,
    clusterName: string,
    parameters: Record<string, string | null>,
    sharedPreloadLibraries?: string[]
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const patch: any = {
      metadata: { annotations: appliedSharedBuffers(parameters.shared_buffers) },
      spec: {
        postgresql: {
          parameters,
          ...(sharedPreloadLibraries !== undefined
            ? { shared_preload_libraries: sharedPreloadLibraries }
            : {})
        }
      }
    };
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      patch,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  // Push the memory-derived tuning onto a live cluster. Called after a memory
  // change so a database that just got more room actually gets to use it: without
  // this a user who bumps memory to escape an OOM keeps the same shared_buffers
  // and gets none of the benefit they paid for.
  //
  // shared_buffers is always written explicitly rather than deleted: the patch
  // below is a JSON merge patch, so omitting the key leaves the old value in
  // place. Writing the derived value is what makes "clear the override" behave
  // like a reset.
  async applyCnpgDerivedTuning(
    namespace: string,
    clusterName: string,
    tuning: { sharedBuffers: string; dataCompression: 'gzip' | null }
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    const patch: any = {
      metadata: { annotations: appliedSharedBuffers(tuning.sharedBuffers) },
      spec: {
        postgresql: { parameters: { shared_buffers: tuning.sharedBuffers } }
      }
    };

    // Only touch the backup block when there is one; writing into
    // spec.backup.barmanObjectStore on a cluster provisioned before its org had
    // backup storage would leave a half-built object CNPG rejects. `null` is a
    // merge-patch delete, which is how compression gets turned back off.
    const live: any = await this.readClusterSpec(customApi, namespace, clusterName).catch(
      () => null
    );
    if (live?.backup?.barmanObjectStore) {
      patch.spec.backup = {
        barmanObjectStore: {
          data: tuning.dataCompression ? { compression: tuning.dataCompression } : null
        }
      };
    }

    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      patch,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  /**
   * Rotate the application role's password. The role is altered directly so
   * the change is immediate, and the bootstrap secret is rewritten so the
   * operator agrees with the database from then on.
   */
  async setCnpgAppPassword(
    namespace: string,
    clusterName: string,
    dbName: string,
    dbUser: string,
    password: string
  ): Promise<void> {
    this.ensureKubeConfig();
    const ns = namespace.trim();
    const name = clusterName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbUser)) {
      throw new BadRequestException('Invalid database user');
    }
    const escaped = password.replace(/'/g, "''");
    const result = await this.runPsqlInCnpg(
      ns,
      name,
      dbName,
      `ALTER ROLE "${dbUser}" WITH PASSWORD '${escaped}'`
    );
    if (!result.success) {
      throw new Error(`ALTER ROLE failed: ${result.stderr || result.stdout}`);
    }
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    await this.upsertSecret(
      coreApi,
      ns,
      this.buildAppSecretName(name),
      'kubernetes.io/basic-auth',
      {
        username: Buffer.from(dbUser).toString('base64'),
        password: Buffer.from(password).toString('base64')
      },
      {
        'app.kubernetes.io/name': name,
        'app.kubernetes.io/component': 'postgres',
        'app.kubernetes.io/managed-by': 'orchard'
      }
    );
  }

  async runPsqlInCnpg(
    namespace: string,
    clusterName: string,
    dbName: string,
    sql: string,
    options: { tuplesOnly?: boolean; catalogOnly?: boolean } = {}
  ): Promise<{ stdout: string; stderr: string; success: boolean }> {
    const pod = await this.findCnpgPrimaryPod(namespace, clusterName);
    const args = [
      ...(options.catalogOnly ? ['env', 'PGOPTIONS=-c search_path=pg_catalog,pg_temp'] : []),
      'psql',
      '-U',
      'postgres',
      '-d',
      dbName,
      '-v',
      'ON_ERROR_STOP=1'
    ];
    if (options.tuplesOnly) args.push('-t', '-A');
    args.push('-c', sql);
    return this.execInPod(namespace, pod, 'postgres', args);
  }

  async listCnpgExtensions(
    namespace: string,
    clusterName: string,
    dbName: string
  ): Promise<
    {
      name: string;
      installed: boolean;
      version?: string;
      defaultVersion?: string;
      comment?: string;
    }[]
  > {
    const pod = await this.findCnpgPrimaryPod(namespace, clusterName);
    const r = await this.execInPod(namespace, pod, 'postgres', [
      'psql',
      '-U',
      'postgres',
      '-d',
      dbName,
      '-t',
      '-A',
      '-F',
      '|',
      '-c',
      `SELECT a.name, COALESCE(i.extversion, '') AS installed_version, a.default_version, COALESCE(a.comment, '') FROM pg_available_extensions a LEFT JOIN pg_extension i ON a.name = i.extname ORDER BY a.name;`
    ]);
    if (!r.success) return [];
    const out: {
      name: string;
      installed: boolean;
      version?: string;
      defaultVersion?: string;
      comment?: string;
    }[] = [];
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [name, installed, defaultVersion, comment] = line.split('|');
      out.push({
        name,
        installed: Boolean(installed),
        version: installed || undefined,
        defaultVersion,
        comment
      });
    }
    return out;
  }

  async installCnpgExtension(
    namespace: string,
    clusterName: string,
    dbName: string,
    extName: string
  ): Promise<{ success: boolean; output: string }> {
    const safe = extName.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) return { success: false, output: 'Invalid extension name' };
    const r = await this.runPsqlInCnpg(
      namespace,
      clusterName,
      dbName,
      `CREATE EXTENSION IF NOT EXISTS "${safe}" CASCADE;`
    );
    return { success: r.success, output: r.stdout + r.stderr };
  }

  // Per-query statistics from pg_stat_statements. The SQL is a fixed
  // string on purpose: nothing user-controlled is ever interpolated, the
  // read stays inside the tenant's own dedicated instance over the same
  // exec channel the size/connection stats use, and sorting/filtering
  // happen client-side on the capped result.
  async getQueryStats(
    namespace: string,
    clusterName: string,
    dbName: string
  ): Promise<{ installed: boolean; reason?: string; queries: unknown[] }> {
    const sql = `SELECT coalesce(json_agg(t), '[]'::json) FROM (
      SELECT queryid::text AS id,
             left(query, 300) AS query,
             calls,
             round(total_exec_time::numeric, 2) AS total_ms,
             round(mean_exec_time::numeric, 3) AS mean_ms,
             round(max_exec_time::numeric, 2) AS max_ms,
             rows,
             shared_blks_hit AS blks_hit,
             shared_blks_read AS blks_read
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY total_exec_time DESC
      LIMIT 100
    ) t;`;
    const r = await this.runPsqlInCnpg(namespace, clusterName, dbName, sql, { tuplesOnly: true });
    if (!r.success) {
      const out = (r.stdout + r.stderr).toLowerCase();
      if (out.includes('does not exist') || out.includes('shared_preload_libraries')) {
        return { installed: false, reason: 'extension_missing', queries: [] };
      }
      if (
        out.includes('the database system is shutting down') ||
        out.includes('the database system is starting up') ||
        out.includes('the database system is in recovery mode') ||
        out.includes('could not connect to server') ||
        out.includes('connection refused')
      ) {
        throw new ServiceUnavailableException(
          'The database is restarting. Query statistics are unavailable right now.'
        );
      }
      throw new Error(`query stats failed: ${r.stderr || r.stdout}`);
    }
    try {
      const parsed = JSON.parse(r.stdout.trim() || '[]');
      return { installed: true, queries: Array.isArray(parsed) ? parsed : [] };
    } catch {
      return { installed: true, queries: [] };
    }
  }

  async resetQueryStats(
    namespace: string,
    clusterName: string,
    dbName: string
  ): Promise<{ success: boolean; output: string }> {
    const r = await this.runPsqlInCnpg(
      namespace,
      clusterName,
      dbName,
      'SELECT pg_stat_statements_reset();'
    );
    return { success: r.success, output: r.stdout + r.stderr };
  }

  async annotateCnpgCluster(
    namespace: string,
    clusterName: string,
    annotations: Record<string, string>
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      { metadata: { annotations } },
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  async setCnpgWriteGuard(namespace: string, clusterName: string, on: boolean): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      {
        metadata: { annotations: { [WRITE_GUARD_ANNOTATION]: on ? 'storage' : null } },
        spec: { postgresql: { parameters: { default_transaction_read_only: on ? 'on' : null } } }
      },
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  // Declarative hibernation: the operator scales the cluster to zero and
  // keeps the PVCs. Turning it off boots the same data back up.
  async setCnpgHibernation(namespace: string, clusterName: string, on: boolean): Promise<void> {
    await this.annotateCnpgCluster(namespace, clusterName, {
      'cnpg.io/hibernation': on ? 'on' : 'off'
    });
  }

  // Same trigger the kubectl-cnpg restart plugin uses: bumping the
  // restartedAt annotation makes the operator do a supervised rolling
  // restart of the instances.
  async rolloutRestartCnpgCluster(namespace: string, clusterName: string): Promise<void> {
    await this.annotateCnpgCluster(namespace, clusterName, {
      'cnpg.io/restartedAt': new Date().toISOString()
    });
  }

  async restartCnpgClusterApplying(
    namespace: string,
    clusterName: string,
    size: PodSizing,
    tuning: { sharedBuffers: string; dataCompression: 'gzip' | null } | null
  ): Promise<void> {
    const cluster = await this.readCluster(namespace, clusterName);
    if (!cluster) throw new NotFoundException(`Database cluster ${clusterName} not found`);
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      clusterRestartPatch(cluster, size, tuning),
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  private scheduledBackupName(clusterName: string): string {
    return cnpgScheduleName(clusterName);
  }

  private r2SecretName(clusterName: string): string {
    return `${clusterName}-r2`;
  }

  private buildBackupSpec(
    namespace: string,
    clusterName: string,
    r2: { endpoint: string; bucket: string },
    r2SecretName: string,
    dataCompression: 'gzip' | null = 'gzip',
    serverName?: string
  ): any {
    // Preserve the scheme from the configured endpoint: when r2-proxy is
    // enabled the endpoint is http:// (plaintext, in-cluster); when going
    // direct to R2 it's https://. Stripping then re-prefixing https broke
    // the proxy path.
    const endpointURL = normalizeBackupEndpointURL(r2.endpoint);
    return {
      barmanObjectStore: {
        destinationPath: `s3://${r2.bucket}/${namespace}/${clusterName}`,
        endpointURL,
        ...(serverName && serverName !== clusterName ? { serverName } : {}),
        s3Credentials: {
          accessKeyId: { name: r2SecretName, key: 'ACCESS_KEY_ID' },
          secretAccessKey: { name: r2SecretName, key: 'ACCESS_SECRET_KEY' }
        },
        // WAL compression is unconditional: barman gzips one 16MB segment at a
        // time, which fits in any budget. The base backup streams the whole
        // PGDATA through gzip inside the postgres container's own cgroup, so on
        // small instances that's the thing that OOMKills the database.
        wal: { compression: 'gzip', maxParallel: WAL_ARCHIVE_MAX_PARALLEL },
        ...(dataCompression ? { data: { compression: dataCompression } } : {})
      },
      retentionPolicy: '30d'
    };
  }

  // Continuous WAL archiving. A cluster provisioned before its org had backup
  // storage has no `spec.backup` at all, and CNPG rejects a ScheduledBackup or
  // Backup against such a cluster, so every backup entry point turns this on
  // first rather than handing the user a validation error.
  async isCnpgBackupConfigured(namespace: string, clusterName: string): Promise<boolean> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const cluster: any = await customApi.getNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName
    );
    if (cluster?.body?.spec?.backup?.barmanObjectStore) return true;
    return clusterArchivesWithPlugin(cluster?.body?.spec);
  }

  private async archiveStoreOf(
    customApi: k8s.CustomObjectsApi,
    namespace: string,
    cluster: any
  ): Promise<any | null> {
    const inTree = cluster?.spec?.backup?.barmanObjectStore;
    if (inTree) return inTree;
    if (!clusterArchivesWithPlugin(cluster?.spec)) return null;
    const archiver = cluster.spec.plugins.find((p: any) => p?.isWALArchiver);
    const name = archiver?.parameters?.barmanObjectName;
    if (!name) return null;
    try {
      const { body } = await customApi.getNamespacedCustomObject(
        BARMAN_GROUP,
        BARMAN_VERSION,
        namespace,
        OBJECT_STORE_PLURAL,
        name
      );
      return (body as any)?.spec?.configuration ?? null;
    } catch (e: any) {
      if (e?.response?.statusCode === 404) return null;
      throw e;
    }
  }

  async listVolumeUsage(): Promise<{ usage: Map<string, VolumeUsage>; nodesFailed: number }> {
    this.ensureKubeConfig();
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const { body } = await coreApi.listNode();
    const usage = new Map<string, VolumeUsage>();
    let nodesFailed = 0;
    for (const node of body.items) {
      const name = node.metadata?.name;
      if (!name) continue;
      try {
        const res: any = await coreApi.connectGetNodeProxyWithPath(name, 'stats/summary');
        const raw = res?.body;
        const summary = typeof raw === 'string' ? JSON.parse(raw) : raw;
        for (const [key, value] of parseKubeletSummary(summary)) usage.set(key, value);
      } catch (e: any) {
        nodesFailed += 1;
        this.logger.warn(`volume stats for node ${name} unavailable: ${e?.message ?? e}`);
      }
    }
    return { usage, nodesFailed };
  }

  async getCnpgBackupState(
    namespace: string,
    clusterName: string
  ): Promise<{
    configured: boolean;
    endpointURL: string | null;
    destinationPath: string | null;
    secretAccessKeyId: string | null;
  }> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const cluster: any = await customApi.getNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName
    );
    const store = await this.archiveStoreOf(customApi, namespace, cluster?.body);
    if (!store) {
      return {
        configured: false,
        endpointURL: null,
        destinationPath: null,
        secretAccessKeyId: null
      };
    }
    const secretName: string =
      store.s3Credentials?.accessKeyId?.name || this.r2SecretName(clusterName);
    const secretKey: string = store.s3Credentials?.accessKeyId?.key || 'ACCESS_KEY_ID';
    let secretAccessKeyId: string | null = null;
    try {
      const { body } = await coreApi.readNamespacedSecret(secretName, namespace);
      const raw = body.data?.[secretKey];
      secretAccessKeyId = raw ? Buffer.from(raw, 'base64').toString('utf8') : null;
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
    return {
      configured: true,
      endpointURL: store.endpointURL ?? null,
      destinationPath: store.destinationPath ?? null,
      secretAccessKeyId
    };
  }

  async enableCnpgBackup(
    namespace: string,
    clusterName: string,
    r2: { endpoint: string; bucket: string; accessKey: string; secretKey: string }
  ): Promise<BackupMethod> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const secretName = this.r2SecretName(clusterName);
    await this.upsertSecret(
      coreApi,
      namespace,
      secretName,
      'Opaque',
      {
        ACCESS_KEY_ID: Buffer.from(r2.accessKey).toString('base64'),
        ACCESS_SECRET_KEY: Buffer.from(r2.secretKey).toString('base64')
      },
      {
        'app.kubernetes.io/managed-by': 'orchard',
        'cnpg.io/cluster': clusterName
      }
    );
    const clusterSpec = (await this.readClusterSpec(customApi, namespace, clusterName)) as any;
    const archivesWithPlugin = clusterArchivesWithPlugin(clusterSpec);
    if (
      archivesWithPlugin ||
      (!clusterSpec?.backup?.barmanObjectStore && (await this.usePluginForNewClusters()))
    ) {
      const archiver = archivesWithPlugin
        ? clusterSpec.plugins.find((p: any) => p?.isWALArchiver)
        : null;
      const store = archiver?.parameters?.barmanObjectName || objectStoreName(clusterName);
      await this.upsertObjectStore(
        namespace,
        objectStoreBody(
          namespace,
          store,
          {
            destinationPath: `s3://${r2.bucket}/${namespace}/${clusterName}`,
            endpointURL: normalizeBackupEndpointURL(r2.endpoint),
            secretName
          },
          {
            walMaxParallel: WAL_ARCHIVE_MAX_PARALLEL,
            dataCompression: 'gzip',
            labels: { 'app.kubernetes.io/managed-by': 'orchard', 'cnpg.io/cluster': clusterName }
          }
        )
      );
      if (!archivesWithPlugin) {
        await this.patchCluster(namespace, clusterName, {
          spec: { plugins: pluginsWithArchiver(clusterSpec, store, clusterName) }
        });
      }
      return 'plugin';
    }
    const dataCompression = await this.backupDataCompression(namespace, clusterName);
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      {
        spec: {
          backup: this.buildBackupSpec(namespace, clusterName, r2, secretName, dataCompression)
        }
      },
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    return 'barman';
  }

  private async backupDataCompression(
    namespace: string,
    clusterName: string
  ): Promise<'gzip' | null> {
    const { body } = await this.kc
      .makeApiClient(k8s.CustomObjectsApi)
      .getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_PLURAL,
        clusterName
      );
    const cluster = body as any;
    const store = cluster?.spec?.backup?.barmanObjectStore;
    if (store) return store.data?.compression === 'gzip' ? 'gzip' : null;
    const row = await this.prisma.database.findFirst({
      where: { namespace, clusterName },
      select: { backupCompression: true }
    });
    return deriveDbTuning({
      memoryLimitBytes: parseMemory(String(cluster?.spec?.resources?.limits?.memory ?? '')),
      overrides: { backupCompression: row?.backupCompression }
    }).dataCompression;
  }

  async disableCnpgBackup(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const clusterSpec = await this.readClusterSpec(customApi, namespace, clusterName);
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      { spec: archivingOffPatch(clusterSpec) },
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  async hasCnpgCluster(namespace: string, clusterName: string): Promise<boolean> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_PLURAL,
        clusterName
      );
      return true;
    } catch (e: any) {
      if (e.response?.statusCode === 404) return false;
      throw e;
    }
  }

  async patchClusterImage(
    namespace: string,
    clusterName: string,
    imageName: string,
    annotations: Record<string, string> = {}
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      {
        ...(Object.keys(annotations).length ? { metadata: { annotations } } : {}),
        spec: { imageName }
      },
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  async probeClusterCollation(namespace: string, cluster: any): Promise<'c' | 'other' | null> {
    const pod = cluster?.status?.currentPrimary;
    if (typeof pod !== 'string' || !pod) return null;
    const r = await this.execInPod(namespace, pod, 'postgres', [
      'psql',
      '-U',
      'postgres',
      '-tAc',
      "select count(*) from pg_database d where datallowconn and (datcollate <> 'C' or datctype <> 'C' or coalesce(to_jsonb(d)->>'datlocprovider', 'c') <> 'c')"
    ]);
    if (!r.success) return null;
    const n = Number(r.stdout.trim());
    if (!Number.isFinite(n)) return null;
    return n === 0 ? 'c' : 'other';
  }

  async getScheduledBackupSchedule(namespace: string, clusterName: string): Promise<string | null> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      const res: any = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_SCHEDULED_BACKUP_PLURAL,
        this.scheduledBackupName(clusterName)
      );
      const schedule = (res?.body ?? res)?.spec?.schedule;
      return typeof schedule === 'string' ? schedule : null;
    } catch (e: any) {
      if (e.response?.statusCode === 404) return null;
      throw e;
    }
  }

  async hasScheduledBackup(namespace: string, clusterName: string): Promise<boolean> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_SCHEDULED_BACKUP_PLURAL,
        this.scheduledBackupName(clusterName)
      );
      return true;
    } catch (e: any) {
      if (e.response?.statusCode === 404) return false;
      throw e;
    }
  }

  // `immediate` anchors retention: barman can only expire WAL that sits behind
  // a base backup, so a cluster that archives without one grows forever.
  // CNPG only honours the flag on a schedule that has never run, so passing it
  // on an update is a no-op rather than a surprise extra backup.
  async upsertScheduledBackup(
    namespace: string,
    clusterName: string,
    cronSchedule: string,
    opts: { immediate?: boolean } = {}
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const name = this.scheduledBackupName(clusterName);
    const body = {
      apiVersion: `${this.CNPG_GROUP}/${this.CNPG_VERSION}`,
      kind: 'ScheduledBackup',
      metadata: {
        name,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'cnpg.io/cluster': clusterName
        }
      },
      spec: {
        schedule: cronSchedule,
        backupOwnerReference: 'self',
        immediate: opts.immediate === true,
        cluster: { name: clusterName },
        ...backupMethodSpec(await this.backupMethodOf(customApi, namespace, clusterName))
      }
    };

    try {
      const { body: existing } = await customApi.getNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_SCHEDULED_BACKUP_PLURAL,
        name
      );
      (body.metadata as any).resourceVersion = (existing as any).metadata?.resourceVersion;
      if ((existing as any).spec?.suspend === true) (body.spec as any).suspend = true;
      await customApi.replaceNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_SCHEDULED_BACKUP_PLURAL,
        name,
        body
      );
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        await customApi.createNamespacedCustomObject(
          this.CNPG_GROUP,
          this.CNPG_VERSION,
          namespace,
          this.CNPG_SCHEDULED_BACKUP_PLURAL,
          body
        );
      } else {
        throw e;
      }
    }
  }

  async setScheduledBackupSuspended(
    namespace: string,
    clusterName: string,
    suspended: boolean
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.patchNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_SCHEDULED_BACKUP_PLURAL,
        this.scheduledBackupName(clusterName),
        { spec: { suspend: suspended } },
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/merge-patch+json' } }
      );
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  async deleteScheduledBackup(
    namespace: string,
    clusterName: string,
    opts: { keepBackups?: boolean } = {}
  ): Promise<void> {
    await this.deleteScheduledBackupNamed(namespace, this.scheduledBackupName(clusterName), opts);
  }

  async deleteScheduledBackupNamed(
    namespace: string,
    name: string,
    opts: { keepBackups?: boolean } = {}
  ): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    try {
      await customApi.deleteNamespacedCustomObject(
        this.CNPG_GROUP,
        this.CNPG_VERSION,
        namespace,
        this.CNPG_SCHEDULED_BACKUP_PLURAL,
        name,
        undefined,
        undefined,
        opts.keepBackups ? 'Orphan' : undefined
      );
    } catch (e: any) {
      if (e.response?.statusCode !== 404) throw e;
    }
  }

  private readonly PUBLIC_TLS_SOURCE_NAMESPACE =
    process.env.PUBLIC_DB_TLS_SOURCE_NAMESPACE || 'network';

  private readonly PUBLIC_TLS_SOURCE_SECRET =
    process.env.PUBLIC_DB_TLS_SOURCE_SECRET || 'wildcard-db-orchard-my-tls';

  private readonly PUBLIC_TLS_BASE_DOMAIN = optionalDomain(process.env.PUBLIC_DB_DOMAIN);

  private readonly PUBLIC_TLS_LOCAL_SECRET =
    process.env.PUBLIC_DB_TLS_LOCAL_SECRET || 'wildcard-db-tls';

  private readonly PUBLIC_TLS_MODE =
    process.env.PUBLIC_DB_TLS_MODE === 'per-database' ? 'per-database' : 'wildcard';

  private readonly PUBLIC_TLS_ISSUER_NAME = (process.env.PUBLIC_DB_TLS_ISSUER_NAME || '').trim();

  private readonly PUBLIC_TLS_ISSUER_KIND =
    (process.env.PUBLIC_DB_TLS_ISSUER_KIND || '').trim() || 'ClusterIssuer';

  private readonly PUBLIC_TLS_LEGACY_HOSTNAMES =
    process.env.PUBLIC_DB_TLS_LEGACY_HOSTNAMES === 'true';

  publicTlsBaseDomain(): string {
    return this.PUBLIC_TLS_BASE_DOMAIN;
  }

  // The label is namespace-qualified because bare cluster names are only
  // unique within a namespace: two orgs with identically named databases
  // would otherwise mint the same public hostname under the wildcard cert.
  // Namespaces are unique cluster-wide, so this label is too. Long
  // combinations fall back to a hash suffix to stay inside the 63-char
  // DNS label limit without reintroducing collisions.
  publicTlsHostname(namespace: string, clusterName: string): string {
    if (!this.PUBLIC_TLS_BASE_DOMAIN) return '';
    if (this.publicTlsPerDatabase() && hostnameStyle() === 'opaque') {
      return `${opaqueDatabaseLabel(namespace, clusterName)}.${this.PUBLIC_TLS_BASE_DOMAIN}`;
    }
    return this.readablePublicTlsHostname(namespace, clusterName);
  }

  private readablePublicTlsHostname(namespace: string, clusterName: string): string {
    const label = `${namespace}-${clusterName}`;
    const safe =
      label.length <= 63
        ? label
        : `${label.slice(0, 54)}-${createHash('sha256').update(label).digest('hex').slice(0, 8)}`;
    return `${safe}.${this.PUBLIC_TLS_BASE_DOMAIN}`;
  }

  // Hostname format that predates namespace qualification. Kept in the TLS
  // SANs so connection strings issued before the change keep verifying.
  legacyPublicTlsHostname(clusterName: string): string {
    if (!this.PUBLIC_TLS_BASE_DOMAIN) return '';
    return `${clusterName}.${this.PUBLIC_TLS_BASE_DOMAIN}`;
  }

  /**
   * Copy the wildcard Let's Encrypt Secret from the cert-manager namespace into
   * the project namespace so the CNPG cluster can mount it. Returns true if the
   * secret was updated (or created).
   */
  async syncPublicTlsSecret(targetNamespace: string): Promise<boolean> {
    this.ensureKubeConfig();
    if (this.publicTlsPerDatabase() && !(await this.namespaceHasWildcardCluster(targetNamespace))) {
      return false;
    }
    return syncTlsSecret(
      this.kc.makeApiClient(k8s.CoreV1Api),
      { namespace: this.PUBLIC_TLS_SOURCE_NAMESPACE, name: this.PUBLIC_TLS_SOURCE_SECRET },
      { namespace: targetNamespace, name: this.PUBLIC_TLS_LOCAL_SECRET }
    );
  }

  publicTlsPerDatabase(): boolean {
    return this.PUBLIC_TLS_MODE === 'per-database' && !!this.PUBLIC_TLS_ISSUER_NAME;
  }

  private async namespaceHasWildcardCluster(namespace: string): Promise<boolean> {
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const { body } = await customApi.listNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL
    );
    const items = ((body as any)?.items ?? []) as any[];
    return items.some(
      (c) => c?.spec?.certificates?.serverCASecret === this.PUBLIC_TLS_LOCAL_SECRET
    );
  }

  private async removeWildcardCopy(namespace: string): Promise<void> {
    const coreApi = this.kc!.makeApiClient(k8s.CoreV1Api);
    try {
      const { body } = await coreApi.readNamespacedSecret(this.PUBLIC_TLS_LOCAL_SECRET, namespace);
      if (!body.metadata?.labels?.[TLS_SOURCE_RV_LABEL]) return;
      await coreApi.deleteNamespacedSecret(this.PUBLIC_TLS_LOCAL_SECRET, namespace);
    } catch (e: any) {
      if (e?.response?.statusCode !== 404) throw e;
    }
  }

  async ensureDatabaseTls(namespace: string, clusterName: string, cluster?: any): Promise<boolean> {
    this.ensureKubeConfig();
    const hostname = this.publicTlsHostname(namespace, clusterName);
    if (!hostname) return false;
    const hostnames = [hostname];
    const legacy = this.legacyPublicTlsHostname(clusterName);
    if (this.PUBLIC_TLS_LEGACY_HOSTNAMES && legacy) hostnames.push(legacy);

    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const names = publicDbTlsNames(clusterName);
    const previous = this.readablePublicTlsHostname(namespace, clusterName);
    if (previous && previous !== hostname) {
      try {
        const { body: existingCert } = await customApi.getNamespacedCustomObject(
          'cert-manager.io',
          'v1',
          namespace,
          'certificates',
          names.certificate
        );
        if (((existingCert as any).spec?.dnsNames ?? []).includes(previous)) {
          hostnames.push(previous);
        }
      } catch (e: any) {
        if (e?.response?.statusCode !== 404) throw e;
      }
    }
    const desired = publicDbCertificate({
      namespace,
      clusterName,
      hostnames,
      issuer: { name: this.PUBLIC_TLS_ISSUER_NAME, kind: this.PUBLIC_TLS_ISSUER_KIND }
    });
    try {
      const { body: current } = await customApi.getNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        namespace,
        'certificates',
        names.certificate
      );
      const same =
        JSON.stringify((current as any).spec?.dnsNames) === JSON.stringify(hostnames) &&
        (current as any).spec?.issuerRef?.name === this.PUBLIC_TLS_ISSUER_NAME &&
        (current as any).spec?.issuerRef?.kind === this.PUBLIC_TLS_ISSUER_KIND;
      if (!same) {
        await customApi.patchNamespacedCustomObject(
          'cert-manager.io',
          'v1',
          namespace,
          'certificates',
          names.certificate,
          { spec: desired.spec },
          undefined,
          undefined,
          undefined,
          { headers: { 'Content-Type': 'application/merge-patch+json' } }
        );
      }
    } catch (e: any) {
      if (e?.response?.statusCode !== 404) throw e;
      await customApi.createNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        namespace,
        'certificates',
        desired
      );
    }

    let issued: k8s.V1Secret;
    try {
      issued = (await coreApi.readNamespacedSecret(names.secret, namespace)).body;
    } catch (e: any) {
      if (e?.response?.statusCode === 404) return false;
      throw e;
    }
    if (!issued.data?.['tls.crt'] || !issued.data?.['tls.key']) return false;
    const ca = caBundleForIssuedSecret(issued.data as { 'ca.crt'?: string; 'tls.crt'?: string });
    if (!ca) return false;

    const caBody: k8s.V1Secret = {
      metadata: {
        name: names.ca,
        namespace,
        labels: { 'app.kubernetes.io/managed-by': 'orchard', 'cnpg.io/cluster': clusterName }
      },
      type: 'Opaque',
      data: { 'ca.crt': ca }
    };
    try {
      const { body: existing } = await coreApi.readNamespacedSecret(names.ca, namespace);
      if (existing.data?.['ca.crt'] !== ca) {
        await coreApi.replaceNamespacedSecret(names.ca, namespace, caBody);
      }
    } catch (e: any) {
      if (e?.response?.statusCode !== 404) throw e;
      await coreApi.createNamespacedSecret(namespace, caBody);
    }

    if (cluster && clusterUsesPublicDbTls(cluster, clusterName)) return false;
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      { spec: { certificates: publicDbClusterCertificates(clusterName) } },
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    return true;
  }

  private async removeDatabaseTls(namespace: string, clusterName: string): Promise<void> {
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    const coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    const names = publicDbTlsNames(clusterName);
    await customApi
      .deleteNamespacedCustomObject(
        'cert-manager.io',
        'v1',
        namespace,
        'certificates',
        names.certificate
      )
      .catch(() => {});
    await coreApi.deleteNamespacedSecret(names.secret, namespace).catch(() => {});
    await coreApi.deleteNamespacedSecret(names.ca, namespace).catch(() => {});
  }

  async patchCnpgClusterTls(
    namespace: string,
    clusterName: string,
    _altDnsNames: string[] = []
  ): Promise<void> {
    this.ensureKubeConfig();
    if (this.publicTlsPerDatabase()) {
      await this.ensureDatabaseTls(namespace, clusterName);
      return;
    }
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    // serverTLSSecret must be signed by serverCASecret. Our sync populates ca.crt with the
    // issuing intermediate (extracted from tls.crt), which satisfies CNPG's verification.
    // Clients still verify using their OS root store since the intermediate chains to ISRG.
    const patch = {
      spec: {
        certificates: {
          serverTLSSecret: this.PUBLIC_TLS_LOCAL_SECRET,
          serverCASecret: this.PUBLIC_TLS_LOCAL_SECRET,
          serverAltDNSNames: null
        }
      }
    };
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      patch,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
  }

  async clearCnpgClusterTls(namespace: string, clusterName: string): Promise<void> {
    this.ensureKubeConfig();
    const customApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    // Merge-patch with null removes the keys, causing CNPG to regenerate its self-signed certs.
    const patch = {
      spec: {
        certificates: {
          serverTLSSecret: null,
          serverCASecret: null,
          serverAltDNSNames: null
        }
      }
    };
    await customApi.patchNamespacedCustomObject(
      this.CNPG_GROUP,
      this.CNPG_VERSION,
      namespace,
      this.CNPG_PLURAL,
      clusterName,
      patch,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );
    await this.removeDatabaseTls(namespace, clusterName);
  }

  async uninstallCnpgExtension(
    namespace: string,
    clusterName: string,
    dbName: string,
    extName: string
  ): Promise<{ success: boolean; output: string }> {
    const safe = extName.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) return { success: false, output: 'Invalid extension name' };
    const r = await this.runPsqlInCnpg(
      namespace,
      clusterName,
      dbName,
      `DROP EXTENSION IF EXISTS "${safe}" CASCADE;`
    );
    return { success: r.success, output: r.stdout + r.stderr };
  }
}

function livePodToMirrored(pod: k8s.V1Pod): MirroredDbPod | null {
  const container = pod.status?.containerStatuses?.find((c) => c.name === 'postgres');
  if (!container) return null;
  const term = (container as any).lastState?.terminated ?? container.state?.terminated;
  const runningSince = container.state?.running?.startedAt;
  return {
    status: computePodStatus(pod),
    restartCount: container.restartCount || 0,
    ready: !!container.ready,
    lastTerminationReason: term?.reason ?? null,
    lastExitCode: term?.exitCode ?? null,
    lastTerminatedAt: term?.finishedAt ? new Date(term.finishedAt) : null,
    updatedAt: new Date(),
    runningSince: runningSince ? new Date(runningSince) : null,
    waitingReason: container.state?.waiting?.reason ?? null
  };
}
