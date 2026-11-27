import { RequestsService } from '../logs/requests.service';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  Observable,
  Subject,
  defer,
  merge,
  of,
  from,
  interval,
  map,
  filter,
  concatMap,
  mergeMap,
  takeWhile,
  bufferTime,
  finalize
} from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { OrgEventsService } from '../events/org-events.service';
import { k8sErrorMessage } from '../kubernetes/k8s-error';
import { deploymentPodRegex } from '../metrics/pod-selector';
import { volumeKey } from '../kubernetes/volume-stats';
import { buildPhases } from './build-phases';
import {
  STATUS_CLASSES,
  configuredAdapter,
  guessedAdapter,
  ingressQueries,
  type IngressQueries,
  type IngressTarget,
  type StatusClass
} from '../metrics/ingress';
import {
  VictoriaMetricsService,
  escapeLabel,
  type SeriesPoint
} from '../metrics/victoria-metrics.service';
import { SignalPresenceService } from '../metrics/signal-presence.service';
import { hasContainerSignal, httpFlavors } from '../metrics/signal-presence';

interface BuildLogMessage {
  id?: string;
  data:
    | { offset: number; chunk: string; reset?: boolean }
    | { done: true; status: string; step?: string | null }
    | { type: 'heartbeat'; ts: number };
}

interface RuntimeLogLine {
  pod: string;
  ts: string;
  line: string;
}

interface RuntimeLogMessage {
  id?: string;
  data:
    | { lines: RuntimeLogLine[] }
    | { pod: string; gone: true }
    | { done: true; status: string }
    | { type: 'heartbeat'; ts: number };
}

export type { SeriesPoint };

export interface HttpRoute {
  id: string;
  label: string;
  service: string;
  requestRate: number;
  errorRate: number;
  errorPercent: number;
  latencyMs: number | null;
}

export interface HttpMetricsSeries {
  source: string | null;
  requestRate: SeriesPoint[];
  errorRate: SeriesPoint[];
  latencyAvg: SeriesPoint[];
  latencyMax: SeriesPoint[];
  latency: { p50: SeriesPoint[]; p95: SeriesPoint[]; p99: SeriesPoint[] } | null;
  latencySource?: 'ingress' | 'access-logs' | null;
  statusRates: Record<StatusClass, SeriesPoint[]>;
  routes: HttpRoute[];
  routesSource?: 'ingress' | 'access-logs';
}

function emptyHttpMetrics(source: string | null): HttpMetricsSeries {
  return {
    source,
    requestRate: [],
    errorRate: [],
    latencyAvg: [],
    latencyMax: [],
    latency: null,
    statusRates: { '2xx': [], '3xx': [], '4xx': [], '5xx': [] },
    routes: []
  };
}

export interface LogEntry {
  timestamp?: string;
  level?: string;
  message: string;
  // Every content line of the logical entry (header + folded continuation
  // lines: stack frames, object dumps). Length 1 for an ordinary single-line
  // log. The frontend renders lines[0] as the header and the rest as
  // expandable detail.
  lines: string[];
  raw: string;
  metadata?: Record<string, any>;
}

export interface DetectedRuntime {
  language: string;
  framework: string | null;
  version: string | null;
  confidence: 'high' | 'medium' | 'low';
  detectedFrom: 'build_logs' | 'image' | 'env_vars' | 'dockerfile';
}

export interface ErrorGroup {
  fingerprint: string;
  type: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  samples: {
    timestamp?: string;
    message: string;
    stackTrace?: string;
  }[];
  trend: 'rising' | 'stable' | 'falling';
}

const PROTECTION_PROXY_SERVICE = 'orchard-protection-proxy';

export interface Capabilities {
  logs: boolean;
  containerMetrics: boolean;
  httpMetrics: boolean;
  accessLogs: boolean;
  httpMetricsShared: boolean;
  customMetrics: boolean;
  traces: boolean;
  runtime: DetectedRuntime | null;
}

export interface DeploymentOverview {
  uptime: string;
  podCount: number;
  restarts: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  httpRequestRate: number | null;
  httpErrorRate: number | null;
  httpAvgLatency: number | null;
}

@Injectable()
export class ObservabilityService {
  private readonly logger = new Logger(ObservabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly orgEvents: OrgEventsService,
    private readonly vm: VictoriaMetricsService,
    private readonly requests: RequestsService,
    private readonly presence: SignalPresenceService
  ) {}

  /**
   * Offset-addressed live tail of a deployment's build logs. The DB column is
   * the source of truth; build.changed bus events (plus a slow safety poll)
   * only trigger delta reads, so no log payload ever rides the event bus. The
   * SSE id is the character offset after each chunk, which makes Last-Event-ID
   * reconnects resume exactly. The stream closes itself after emitting a
   * terminal `{done}` event once the build settles.
   */
  streamBuildLogs(deploymentId: string, fromOffset: number): Observable<BuildLogMessage> {
    let offset = Math.max(0, fromOffset);

    const readDelta = async (): Promise<BuildLogMessage[]> => {
      const rows = await this.prisma.$queryRaw<
        {
          chunk: string | null;
          total: number | null;
          build_status: string;
          build_step: string | null;
        }[]
      >`
        SELECT substring(build_logs from ${offset + 1}::int) AS chunk,
               length(build_logs) AS total,
               build_status,
               build_step
        FROM deployments
        WHERE id = ${deploymentId}::uuid
      `;
      const row = rows[0];
      if (!row) {
        return [{ data: { done: true, status: 'deleted' } }];
      }

      const events: BuildLogMessage[] = [];
      const total = Number(row.total ?? 0);
      if (total > offset && row.chunk) {
        offset = total;
        events.push({ id: String(offset), data: { offset, chunk: row.chunk } });
      } else if (total < offset) {
        // The log column shrank: a new build replaced it. Restart the tail
        // from zero and re-read immediately so the fresh logs follow the
        // reset marker in the same batch.
        offset = 0;
        const fresh = await readDelta();
        return [{ id: '0', data: { offset: 0, chunk: '', reset: true } }, ...fresh];
      }

      const active = ['building', 'pending', 'queued', 'scheduled'].includes(row.build_status);
      if (!active) {
        events.push({
          data: { done: true, status: row.build_status, step: row.build_step }
        });
      }
      return events;
    };

    const triggers$ = merge(
      of(0),
      this.orgEvents.forDeployment('build.changed', deploymentId),
      interval(5000)
    );

    const logs$ = triggers$.pipe(
      concatMap(() => from(readDelta())),
      mergeMap((events) => from(events))
    );

    const heartbeat$ = interval(25_000).pipe(
      map(() => ({ data: { type: 'heartbeat', ts: Date.now() } }) as BuildLogMessage)
    );

    return merge(logs$, heartbeat$).pipe(takeWhile((ev) => !(ev.data as any)?.done, true));
  }

  /**
   * Live runtime log tail: one k8s follow=true stream per pod, fanned into a
   * single SSE flow with 100ms batching. Pod churn is reconciled from the
   * informer-maintained Pod mirror every 10s (new pods attach, gone pods emit
   * a marker). Per-pod streams that end (container restart, rotation) reopen
   * from the last seen timestamp. The SSE id is the newest line timestamp, so
   * Last-Event-ID reconnects resume via sinceTime (k8s second granularity can
   * duplicate a boundary line; clients dedupe by exact (pod, ts, line)).
   * The controller caps streams per user+deployment to bound API-server
   * connections.
   */
  streamRuntimeLogs(
    deploymentId: string,
    tailLines: number,
    sinceTime?: string
  ): Observable<RuntimeLogMessage> {
    return defer(() => {
      const lines$ = new Subject<RuntimeLogLine>();
      const meta$ = new Subject<RuntimeLogMessage>();
      const aborts = new Map<string, () => void>();
      let closed = false;
      let started = false;
      let namespace = '';
      let lastTs = sinceTime ?? '';
      let reconcileTimer: ReturnType<typeof setInterval> | undefined;

      const attach = (podName: string, since?: string, container?: string) => {
        if (closed || aborts.has(podName)) return;
        const abort = this.k8sWorkload.followPodLogStream(
          podName,
          namespace,
          container,
          since ? { sinceTime: since } : { tailLines },
          (raw) => {
            const sp = raw.indexOf(' ');
            const ts = sp > 0 ? raw.slice(0, sp) : '';
            const line = sp > 0 ? raw.slice(sp + 1) : raw;
            if (ts > lastTs) lastTs = ts;
            lines$.next({ pod: podName, ts, line });
          },
          (err) => {
            const wasActive = aborts.delete(podName);
            if (!wasActive || closed) return;
            const status = (err as any)?.response?.statusCode;
            const msg = String(err?.message ?? '');
            if (!container && status === 400 && /container/i.test(msg)) {
              this.k8sWorkload
                .getPodContainers(podName, namespace)
                .then((containers) => {
                  if (!closed && containers.length > 0) {
                    attach(podName, since, containers[0]);
                  }
                })
                .catch(() => {});
              return;
            }
            setTimeout(() => {
              if (!closed) attach(podName, lastTs || undefined, container);
            }, 1000);
          }
        );
        aborts.set(podName, abort);
      };

      const reconcile = async () => {
        const pods = await this.prisma.pod.findMany({
          where: { deploymentId },
          select: { name: true }
        });
        const names = new Set(pods.map((p) => p.name));
        for (const name of names) {
          if (!aborts.has(name)) {
            attach(name, started ? lastTs || undefined : sinceTime);
          }
        }
        started = true;
        for (const [name, abort] of aborts) {
          if (!names.has(name)) {
            aborts.delete(name);
            abort();
            meta$.next({ data: { pod: name, gone: true } });
          }
        }
      };

      (async () => {
        const dep = await this.prisma.deployment.findUnique({
          where: { id: deploymentId },
          select: { namespace: true }
        });
        if (!dep) {
          meta$.next({ data: { done: true, status: 'deleted' } });
          return;
        }
        namespace = dep.namespace;
        await reconcile();
        reconcileTimer = setInterval(() => {
          reconcile().catch(() => {});
        }, 10_000);
      })().catch((err) => {
        this.logger.warn(`runtime log stream init failed for ${deploymentId}: ${err?.message}`);
        meta$.next({ data: { done: true, status: 'error' } });
      });

      const batched$ = lines$.pipe(
        bufferTime(100),
        filter((batch) => batch.length > 0),
        map((batch): RuntimeLogMessage => ({
          id: batch[batch.length - 1].ts || undefined,
          data: { lines: batch }
        }))
      );
      const heartbeat$ = interval(25_000).pipe(
        map(() => ({ data: { type: 'heartbeat', ts: Date.now() } }) as RuntimeLogMessage)
      );

      return merge(batched$, meta$, heartbeat$).pipe(
        takeWhile((ev) => !(ev.data as any)?.done, true),
        finalize(() => {
          closed = true;
          if (reconcileTimer) clearInterval(reconcileTimer);
          for (const [, abort] of aborts) abort();
          aborts.clear();
        })
      );
    });
  }

  async getCapabilities(deploymentId: string): Promise<Capabilities> {
    const [ingressCount, runtime, httpMetricsShared, recorded] = await Promise.all([
      this.prisma.ingress.count({ where: { deploymentId } }),
      this.detectRuntime(deploymentId).catch(() => null),
      this.protectedNeighbours(deploymentId),
      this.recordedSignals(deploymentId)
    ]);

    return {
      logs: true,
      containerMetrics: recorded.container,
      httpMetrics: ingressCount > 0 && recorded.http,
      accessLogs: ingressCount > 0 && recorded.access,
      httpMetricsShared,
      customMetrics: false,
      traces: false,
      runtime
    };
  }

  private async recordedSignals(
    deploymentId: string
  ): Promise<{ container: boolean; http: boolean; access: boolean }> {
    const [deployment, resolved, access, presence] = await Promise.all([
      this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { namespace: true }
      }),
      this.ingressTarget(deploymentId).catch(() => null),
      this.requests.recorded(deploymentId),
      this.presence.current().catch(() => null)
    ]);
    if (!presence) return { container: false, http: false, access };
    return {
      container: hasContainerSignal(presence, deployment?.namespace ?? null),
      http: resolved ? httpFlavors(presence, resolved.target).length > 0 : false,
      access
    };
  }

  private async protectedNeighbours(deploymentId: string): Promise<boolean> {
    const own = await this.prisma.ingress.findFirst({
      where: {
        deploymentId,
        OR: [{ protectionMode: { not: 'none' } }, { redirectTarget: { not: null } }]
      },
      select: { namespace: true }
    });
    if (!own) return false;
    const others = await this.prisma.ingress.count({
      where: {
        namespace: own.namespace,
        deploymentId: { not: deploymentId },
        OR: [{ protectionMode: { not: 'none' } }, { redirectTarget: { not: null } }]
      }
    });
    return others > 0;
  }

  async getHttpMetrics(
    deploymentId: string,
    startMs: number,
    endMs: number,
    stepMs: number
  ): Promise<HttpMetricsSeries> {
    const resolved = await this.ingressTarget(deploymentId);
    if (!resolved) return emptyHttpMetrics(null);
    const flavor = await this.flavorFor(resolved.target);
    const queries = ingressQueries(flavor, resolved.target);
    if (!queries) return emptyHttpMetrics(null);

    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);
    const stepSec = Math.max(1, Math.round(stepMs / 1000));
    const w = `${Math.max(60, stepSec * 2)}s`;
    const range = (q: string) => this.vm.queryRange(q, startSec, endSec, stepSec);
    const quantile = (q: number) => {
      const promql = queries.latencyQuantileMs(q, w);
      return promql ? range(promql) : Promise.resolve([]);
    };

    const [requestRate, errorRate, latencyAvg, latencyMax, p50, p95, p99, routes, ...classes] =
      await Promise.all([
        range(queries.requestRate(w)),
        range(queries.errorPercent(w)),
        range(queries.latencyAvgMs(w)),
        range(queries.latencyMaxMs(w)),
        quantile(0.5),
        quantile(0.95),
        quantile(0.99),
        this.routesFor(queries, resolved.hosts, endSec - startSec),
        ...STATUS_CLASSES.map((cls) => range(queries.statusRate(cls, w)))
      ]);

    const [logged, loggedLatency] = this.requests.available
      ? await Promise.all([
          this.requests.routes(deploymentId, startMs, endMs).catch(() => []),
          queries.percentiles
            ? Promise.resolve(null)
            : this.requests.latency(deploymentId, startMs, endMs, stepMs).catch(() => null)
        ])
      : [[], null];
    const fromLogs = loggedLatency && loggedLatency.p95.length > 0 ? loggedLatency : null;

    return {
      source: flavor,
      requestRate,
      errorRate,
      latencyAvg,
      latencyMax,
      latency: queries.percentiles ? { p50, p95, p99 } : fromLogs,
      latencySource: queries.percentiles ? 'ingress' : fromLogs ? 'access-logs' : null,
      statusRates: Object.fromEntries(STATUS_CLASSES.map((cls, i) => [cls, classes[i]])) as Record<
        StatusClass,
        SeriesPoint[]
      >,
      routes: logged.length ? logged : routes,
      routesSource: logged.length ? 'access-logs' : 'ingress'
    };
  }

  async getPodHealth(deploymentId: string, startMs: number, endMs: number, stepMs: number) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { name: true, namespace: true }
    });
    if (!deployment?.namespace)
      return { available: false, restarts: [], waiting: [], notReady: [] };
    const sel = `namespace="${escapeLabel(deployment.namespace)}",pod=~"${deploymentPodRegex(deployment.name)}"`;
    const startSec = Math.floor(startMs / 1000);
    const endSec = Math.floor(endMs / 1000);
    const stepSec = Math.max(30, Math.round(stepMs / 1000));
    const w = `${stepSec}s`;
    const present = await this.vm.queryInstant(
      `count(last_over_time(kube_pod_status_ready{${sel}}[${Math.max(3600, endSec - startSec)}s]))`
    );
    if (!present) return { available: false, restarts: [], waiting: [], notReady: [] };
    const [byReason, total, waiting, notReady] = await Promise.all([
      this.vm.queryRangeGrouped(
        `sum by (reason) (increase(kube_pod_container_status_restarts_total{${sel}}[${w}]) * on (namespace, pod, container) group_left (reason) max by (namespace, pod, container, reason) (kube_pod_container_status_last_terminated_reason{${sel}}))`,
        startSec,
        endSec,
        stepSec,
        'reason'
      ),
      this.vm.queryRange(
        `sum(increase(kube_pod_container_status_restarts_total{${sel}}[${w}]))`,
        startSec,
        endSec,
        stepSec
      ),
      this.vm.queryRangeGrouped(
        `sum by (reason) (max_over_time(kube_pod_container_status_waiting_reason{${sel}}[${w}]))`,
        startSec,
        endSec,
        stepSec,
        'reason'
      ),
      this.vm.queryRange(
        `sum(max_over_time(kube_pod_status_ready{${sel},condition="false"}[${w}]))`,
        startSec,
        endSec,
        stepSec
      )
    ]);
    return {
      available: true,
      restarts: byReason.length
        ? byReason
        : total.length
          ? [{ key: 'restart', points: total }]
          : [],
      waiting,
      notReady
    };
  }

  async getVolumes(deploymentId: string) {
    const [deployment, volumes, pods] = await Promise.all([
      this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { namespace: true }
      }),
      this.prisma.deploymentVolume.findMany({
        where: { deploymentId, type: 'pvc' },
        select: {
          name: true,
          pvcName: true,
          mountPath: true,
          storageSize: true,
          observedCapacity: true
        }
      }),
      this.prisma.pod.findMany({ where: { deploymentId }, select: { nodeName: true } })
    ]);
    if (!deployment?.namespace || volumes.length === 0) return { volumes: [] };
    const nodes = pods.map((p) => p.nodeName).filter((n): n is string => !!n);
    const usage = nodes.length ? await this.k8sWorkload.volumeUsageOnNodes(nodes) : new Map();
    return {
      volumes: volumes.map((v) => {
        const claim = v.pvcName?.trim() || v.name;
        const u = usage.get(volumeKey(deployment.namespace!, claim));
        return {
          name: v.name,
          claim,
          mountPath: v.mountPath,
          requested: v.storageSize ?? v.observedCapacity ?? null,
          usedBytes: u?.usedBytes ?? null,
          capacityBytes: u?.capacityBytes ?? null,
          availableBytes: u?.availableBytes ?? null
        };
      })
    };
  }

  async getBuildHistory(deploymentId: string, limit = 30) {
    const runs = await this.prisma.buildRun.findMany({
      where: { deploymentId, status: { in: ['succeeded', 'failed', 'building'] } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
      select: {
        id: true,
        status: true,
        builder: true,
        triggerType: true,
        commitSha: true,
        commitMessage: true,
        scheduledAt: true,
        startedAt: true,
        finishedAt: true,
        stepTimestamps: true
      }
    });
    return {
      builds: runs.map((r) => ({
        id: r.id,
        status: r.status,
        builder: r.builder,
        trigger: r.triggerType,
        commitSha: r.commitSha,
        title: r.commitMessage?.split('\n')[0] ?? null,
        scheduledAt: r.scheduledAt.toISOString(),
        startedAt: r.startedAt?.toISOString() ?? null,
        finishedAt: r.finishedAt?.toISOString() ?? null,
        queueMs: r.startedAt ? Math.max(0, r.startedAt.getTime() - r.scheduledAt.getTime()) : null,
        durationMs:
          r.startedAt && r.finishedAt
            ? Math.max(0, r.finishedAt.getTime() - r.startedAt.getTime())
            : null,
        phases: buildPhases(r.stepTimestamps)
      }))
    };
  }

  async getStructuredLogs(
    deploymentId: string,
    tailLines = 200,
    level?: string,
    search?: string
  ): Promise<{ entries: LogEntry[] }> {
    const deployment = await this.prisma.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
      select: { name: true, namespace: true }
    });

    const pods = await this.prisma.pod.findMany({
      where: { deploymentId },
      select: { name: true }
    });

    const allEntries: LogEntry[] = [];

    for (const pod of pods) {
      try {
        let result;
        try {
          result = await this.k8sWorkload.getPodLogs(
            pod.name,
            deployment.namespace,
            undefined,
            tailLines
          );
        } catch (firstErr: any) {
          const resp =
            typeof firstErr?.getResponse === 'function'
              ? firstErr.getResponse()
              : firstErr?.response;
          const containers: string[] | undefined = resp?.availableContainers;
          if (containers?.length) {
            result = await this.k8sWorkload.getPodLogs(
              pod.name,
              deployment.namespace,
              containers[0],
              tailLines
            );
          } else {
            throw firstErr;
          }
        }
        const lines = (result.logs || '').split('\n').filter(Boolean);
        // Group within a pod's stream so multi-line entries (stack traces,
        // object dumps) stay together and keep their original order.
        allEntries.push(...groupLines(lines));
      } catch (err) {
        this.logger.warn(`failed to fetch logs for pod ${pod.name}: ${k8sErrorMessage(err)}`);
      }
    }

    let filtered = allEntries;

    if (level) {
      const upper = level.toUpperCase();
      filtered = filtered.filter((e) => e.level?.toUpperCase() === upper);
    }

    if (search) {
      const lower = search.toLowerCase();
      filtered = filtered.filter((e) => e.raw.toLowerCase().includes(lower));
    }

    return { entries: filtered };
  }

  async getOverview(deploymentId: string): Promise<DeploymentOverview> {
    const deployment = await this.prisma.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
      select: {
        name: true,
        namespace: true,
        createdAt: true,
        cpuRequestMilli: true,
        memoryRequestBytes: true,
        replicas: true
      }
    });

    const pods = await this.prisma.pod.findMany({
      where: { deploymentId },
      select: { restartCount: true, status: true }
    });

    const activePods = pods.filter((p) => {
      const s = p.status?.toLowerCase();
      return s !== 'succeeded' && s !== 'failed';
    });
    const restarts = pods.reduce((sum, p) => sum + p.restartCount, 0);

    const ns = escapeLabel(deployment.namespace);
    const podRe = deploymentPodRegex(deployment.name);

    const [cpuMilli, memBytes] = await Promise.all([
      this.vm.queryInstant(
        `sum(rate(container_cpu_usage_seconds_total{namespace="${ns}",pod=~"${podRe}",container="",image=""}[60s])) * 1000`
      ),
      this.vm.queryInstant(
        `sum(container_memory_working_set_bytes{namespace="${ns}",pod=~"${podRe}",container="",image=""})`
      )
    ]);

    const totalCpuRequest = (deployment.cpuRequestMilli ?? 0) * (deployment.replicas ?? 1);
    const totalMemRequest =
      (deployment.memoryRequestBytes ? Number(deployment.memoryRequestBytes) : 0) *
      (deployment.replicas ?? 1);

    const cpuPercent =
      totalCpuRequest > 0 && cpuMilli !== null ? (cpuMilli / totalCpuRequest) * 100 : null;
    const memoryPercent =
      totalMemRequest > 0 && memBytes !== null ? (memBytes / totalMemRequest) * 100 : null;

    let httpRequestRate: number | null = null;
    let httpErrorRate: number | null = null;
    let httpAvgLatency: number | null = null;

    const ingress = await this.ingressFor(deploymentId);
    if (ingress) {
      const w = '60s';
      [httpRequestRate, httpErrorRate, httpAvgLatency] = await Promise.all([
        this.vm.queryInstant(ingress.requestRate(w)),
        this.vm.queryInstant(ingress.errorPercent(w)),
        this.vm.queryInstant(ingress.latencyAvgMs(w))
      ]);
    }

    return {
      uptime: deployment.createdAt.toISOString(),
      podCount: activePods.length,
      restarts,
      cpuPercent,
      memoryPercent,
      httpRequestRate,
      httpErrorRate,
      httpAvgLatency
    };
  }

  async detectRuntime(deploymentId: string): Promise<DetectedRuntime> {
    const deployment = await this.prisma.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
      select: {
        buildType: true,
        buildLogs: true,
        image: true,
        dockerfilePath: true,
        envVars: { select: { key: true, value: true } }
      }
    });

    const fromBuildLogs = detectFromBuildLogs(deployment.buildLogs);
    if (fromBuildLogs) return fromBuildLogs;

    const fromEnv = detectFromEnvVars(deployment.envVars);
    if (fromEnv) return fromEnv;

    const fromImage = detectFromImage(deployment.image);
    if (fromImage) return fromImage;

    const fromDockerfile = detectFromDockerfilePath(deployment.dockerfilePath);
    if (fromDockerfile) return fromDockerfile;

    return {
      language: 'unknown',
      framework: null,
      version: null,
      confidence: 'low',
      detectedFrom: 'build_logs'
    };
  }

  async getErrors(
    deploymentId: string,
    timeWindowMinutes = 60,
    stored?: LogEntry[] | null
  ): Promise<{ errors: ErrorGroup[] }> {
    const tailLines = Math.min(20000, timeWindowMinutes * 50);
    const { entries } = stored?.length
      ? { entries: stored }
      : await this.getStructuredLogs(deploymentId, tailLines);

    const cutoff = new Date(Date.now() - timeWindowMinutes * 60 * 1000);
    const windowEntries = entries.filter((e) => {
      if (!e.timestamp) return true;
      try {
        return new Date(e.timestamp) >= cutoff;
      } catch {
        return true;
      }
    });

    const errorEntries: {
      timestamp?: string;
      type: string;
      message: string;
      stackTrace?: string;
    }[] = [];

    for (const entry of windowEntries) {
      const isError =
        entry.level === 'ERROR' || entry.level === 'FATAL' || hasStackTraceStart(entry.raw);

      if (!isError) continue;

      const { type, message: errMsg } = extractErrorInfo(entry.message);

      // Grouped entries already carry their stack/object-dump as the
      // continuation lines after the header (entry.raw is the cleaned text).
      const cleanLines = entry.raw.split('\n');
      const stackLines = cleanLines.slice(1).filter((l) => isStackFrame(l) || /^\s/.test(l));
      const stackTrace = stackLines.length > 0 ? stackLines.join('\n') : undefined;

      errorEntries.push({
        timestamp: entry.timestamp,
        type,
        message: errMsg,
        stackTrace
      });
    }

    const groups = new Map<
      string,
      {
        type: string;
        message: string;
        entries: { timestamp?: string; message: string; stackTrace?: string }[];
      }
    >();

    for (const err of errorEntries) {
      const normalized = normalizeErrorMessage(err.message);
      const fp = createHash('sha256')
        .update(`${err.type}:${normalized}`)
        .digest('hex')
        .slice(0, 16);

      let group = groups.get(fp);
      if (!group) {
        group = { type: err.type, message: err.message, entries: [] };
        groups.set(fp, group);
      }
      group.entries.push({
        timestamp: err.timestamp,
        message: err.message,
        stackTrace: err.stackTrace
      });
    }

    const errors: ErrorGroup[] = [];

    for (const [fingerprint, group] of groups) {
      const sorted = group.entries.sort((a, b) => {
        if (!a.timestamp || !b.timestamp) return 0;
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      });

      const firstSeen = sorted[0]?.timestamp ?? new Date().toISOString();
      const lastSeen = sorted[sorted.length - 1]?.timestamp ?? new Date().toISOString();
      const samples = sorted.slice(-3);

      const mid = Math.floor(sorted.length / 2);
      const firstHalf = mid > 0 ? mid : sorted.length;
      const secondHalf = sorted.length - firstHalf;
      let trend: 'rising' | 'stable' | 'falling' = 'stable';
      if (firstHalf > 0 && secondHalf > 0) {
        const ratio = secondHalf / firstHalf;
        if (ratio > 1.3) trend = 'rising';
        else if (ratio < 0.7) trend = 'falling';
      }

      errors.push({
        fingerprint,
        type: group.type,
        message: group.message,
        count: sorted.length,
        firstSeen,
        lastSeen,
        samples,
        trend
      });
    }

    errors.sort((a, b) => b.count - a.count);

    return { errors };
  }

  private async ingressTarget(
    deploymentId: string
  ): Promise<{ target: IngressTarget; hosts: Map<string, string[]> } | null> {
    const [deployment, services, ingresses] = await Promise.all([
      this.prisma.deployment.findUnique({
        where: { id: deploymentId },
        select: { namespace: true }
      }),
      this.prisma.service.findMany({
        where: { deploymentId },
        select: { name: true }
      }),
      this.prisma.ingress.findMany({
        where: { deploymentId },
        select: {
          host: true,
          path: true,
          protectionMode: true,
          redirectTarget: true,
          service: { select: { name: true } }
        }
      })
    ]);

    if (!deployment?.namespace) return null;

    const names = new Set<string>();
    const hosts = new Map<string, string[]>();
    for (const s of services) names.add(s.name);
    for (const i of ingresses) {
      const svc =
        i.protectionMode !== 'none' || i.redirectTarget
          ? PROTECTION_PROXY_SERVICE
          : i.service?.name;
      if (i.service?.name) names.add(i.service.name);
      if (!svc) continue;
      const label = `${i.host}${i.path && i.path !== '/' ? i.path : ''}`;
      hosts.set(svc, [...(hosts.get(svc) ?? []), label]);
    }
    if (ingresses.some((i) => i.protectionMode !== 'none' || i.redirectTarget)) {
      names.add(PROTECTION_PROXY_SERVICE);
    }
    if (names.size === 0) return null;
    return { target: { namespace: deployment.namespace, services: [...names] }, hosts };
  }

  private async flavorFor(target: IngressTarget): Promise<string> {
    const configured = configuredAdapter();
    if (configured) return configured.id;
    const presence = await this.presence.current().catch(() => null);
    const found = presence ? httpFlavors(presence, target)[0] : undefined;
    return found ?? guessedAdapter().id;
  }

  async ingressFor(deploymentId: string): Promise<IngressQueries | null> {
    const resolved = await this.ingressTarget(deploymentId);
    if (!resolved) return null;
    return ingressQueries(await this.flavorFor(resolved.target), resolved.target);
  }

  private async routesFor(
    queries: IngressQueries,
    hosts: Map<string, string[]>,
    windowSec: number
  ): Promise<HttpRoute[]> {
    const w = `${Math.max(60, Math.round(windowSec))}s`;
    const [requests, errors, latency] = await Promise.all([
      this.vm.queryInstantGrouped(queries.routeRequests(w), queries.routeLabel),
      this.vm.queryInstantGrouped(queries.routeErrors(w), queries.routeLabel),
      this.vm.queryInstantGrouped(queries.routeLatencyMs(w), queries.routeLabel)
    ]);
    const routes = new Map<string, HttpRoute>();
    for (const [raw, rate] of requests) {
      const service = queries.routeService(raw) ?? raw;
      const prev = routes.get(service);
      const errorRate = errors.get(raw) ?? 0;
      const latencyMs = latency.get(raw) ?? null;
      routes.set(service, {
        id: service,
        label: (hosts.get(service) ?? []).join(', ') || service,
        service,
        requestRate: (prev?.requestRate ?? 0) + rate,
        errorRate: (prev?.errorRate ?? 0) + errorRate,
        errorPercent: 0,
        latencyMs: latencyMs ?? prev?.latencyMs ?? null
      });
    }
    return [...routes.values()]
      .map((r) => ({
        ...r,
        errorPercent: r.requestRate > 0 ? (100 * r.errorRate) / r.requestRate : 0
      }))
      .sort((a, b) => b.requestRate - a.requestRate);
  }
}

// Kubernetes prefixes every line with an RFC3339Nano timestamp + space when
// logs are requested with timestamps=true.
const K8S_TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/s;
// ANSI SGR/color escape sequences (\x1b[..m) and other CSI codes.
// oxlint-disable-next-line no-control-regex
const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;
const INLINE_LEVEL_RE = /^\[?(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\]?\b/i;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// `raw` keeps the original line (k8s timestamp + ANSI) so the frontend can
// render it in colour through ansiToHtml; `clean` is timestamp/ANSI-stripped
// and drives grouping, level detection, and search.
interface RawLine {
  ts?: string;
  tsMs: number;
  raw: string;
  clean: string;
}

function splitLine(raw: string): RawLine {
  const m = K8S_TS_RE.exec(raw);
  if (m) {
    const ms = Date.parse(m[1]);
    return { ts: m[1], tsMs: Number.isNaN(ms) ? NaN : ms, raw, clean: stripAnsi(m[2]) };
  }
  return { ts: undefined, tsMs: NaN, raw, clean: stripAnsi(raw) };
}

// A line continues the open entry when it's an indented/stack/brace fragment,
// or, within the same flush window, a top-level `key: value` annotation
// (e.g. `params:`, `cause:`, `H3Error:`). This folds a console.error's stack
// and object dump into one logical entry instead of one row per physical line.
function isContinuation(line: RawLine, groupStartMs: number): boolean {
  const c = line.clean;
  if (c === '') return false;
  if (/^\s/.test(c)) return true;
  if (/^(at\s|\.{3}\s*\d+\s+more\b|Caused by:|goroutine\s|File ")/.test(c)) return true;
  if (/^[}\])]/.test(c)) return true;
  const closeBy =
    Number.isNaN(line.tsMs) || Number.isNaN(groupStartMs)
      ? false
      : Math.abs(line.tsMs - groupStartMs) <= 5;
  if (closeBy && /^[\w.$#-]+:\s/.test(c)) return true;
  return false;
}

export function groupLines(rawLines: string[]): LogEntry[] {
  const entries: LogEntry[] = [];
  let group: { header: RawLine; lines: RawLine[] } | null = null;

  const flush = () => {
    if (!group) return;
    entries.push(buildEntry(group.header, group.lines));
    group = null;
  };

  for (const raw of rawLines) {
    const line = splitLine(raw);
    if (group && group.lines.length < 500 && isContinuation(line, group.header.tsMs)) {
      group.lines.push(line);
    } else {
      flush();
      group = { header: line, lines: [line] };
    }
  }
  flush();
  return entries;
}

const RESERVED_METADATA_KEYS = new Set([
  'pod',
  'container',
  'namespace',
  'level',
  'deployment',
  'node',
  'source'
]);

function buildEntry(header: RawLine, lines: RawLine[]): LogEntry {
  // Single-line JSON log: surface its own level/message/timestamp.
  if (lines.length === 1) {
    const trimmed = header.clean.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && typeof obj === 'object') {
          const level = obj.level ?? obj.severity ?? obj.lvl ?? obj.log_level;
          const message = obj.msg ?? obj.message ?? obj.text ?? trimmed;
          const timestamp = obj.timestamp ?? obj.time ?? obj.ts ?? obj['@timestamp'] ?? header.ts;
          const {
            level: _l,
            severity: _s,
            lvl: _v,
            log_level: _ll,
            msg: _m,
            message: _ms,
            text: _t,
            timestamp: _ts,
            time: _ti,
            ts: _tss,
            '@timestamp': _at,
            ...tenantMetadata
          } = obj;
          const metadata: Record<string, any> = {};
          for (const [k, v] of Object.entries(tenantMetadata)) {
            if (!RESERVED_METADATA_KEYS.has(k)) metadata[k] = v;
          }
          // The line shown, searched and exported keeps the other fields, so an
          // error's details aren't reduced to its message. pid/hostname ride on
          // every pino line and say nothing.
          const { pid: _p, hostname: _h, ...fields } = metadata;
          const text =
            Object.keys(fields).length > 0
              ? `${String(message)} ${JSON.stringify(fields)}`
              : String(message);
          return {
            timestamp: timestamp != null ? String(timestamp) : undefined,
            level: level != null ? normalizeLevel(String(level)) : undefined,
            message: String(message),
            lines: [text],
            raw: text,
            metadata: Object.keys(metadata).length > 0 ? metadata : undefined
          };
        }
      } catch {}
    }
  }

  const cleanLines = lines.map((l) => l.clean);
  return {
    timestamp: header.ts,
    level: detectLevel(header.clean, cleanLines),
    message: header.clean,
    // Original ts+ANSI lines for colourised rendering on the client.
    lines: lines.map((l) => l.raw),
    // Cleaned text for client-side search.
    raw: cleanLines.join('\n')
  };
}

function detectLevel(header: string, lines: string[]): string | undefined {
  const m = INLINE_LEVEL_RE.exec(header.trim());
  if (m) return normalizeLevel(m[1]);
  if (
    lines.some((l) => hasStackTraceStart(l)) ||
    /\b(error|exception|unhandled|fatal|panic|failed)\b/i.test(header)
  ) {
    return 'ERROR';
  }
  if (/\bwarn(ing)?\b/i.test(header)) return 'WARN';
  return undefined;
}

// pino writes its levels as numbers.
const NUMERIC_LEVELS: Record<string, string> = {
  '10': 'TRACE',
  '20': 'DEBUG',
  '30': 'INFO',
  '40': 'WARN',
  '50': 'ERROR',
  '60': 'FATAL'
};

function normalizeLevel(s: string): string {
  if (NUMERIC_LEVELS[s]) return NUMERIC_LEVELS[s];
  const upper = s.toUpperCase();
  if (upper === 'WARNING') return 'WARN';
  return upper;
}

const LANGUAGE_PATTERNS: { re: RegExp; language: string; framework?: string }[] = [
  { re: /\bdetected[:\s]+next\.?js\b/i, language: 'node', framework: 'nextjs' },
  { re: /\bdetected[:\s]+nuxt\b/i, language: 'node', framework: 'nuxt' },
  { re: /\bdetected[:\s]+remix\b/i, language: 'node', framework: 'remix' },
  { re: /\bdetected[:\s]+astro\b/i, language: 'node', framework: 'astro' },
  { re: /\bdetected[:\s]+sveltekit\b/i, language: 'node', framework: 'sveltekit' },
  { re: /\bdetected[:\s]+express\b/i, language: 'node', framework: 'express' },
  { re: /\bdetected[:\s]+fastify\b/i, language: 'node', framework: 'fastify' },
  { re: /\bdetected[:\s]+django\b/i, language: 'python', framework: 'django' },
  { re: /\bdetected[:\s]+flask\b/i, language: 'python', framework: 'flask' },
  { re: /\bdetected[:\s]+fast\s?api\b/i, language: 'python', framework: 'fastapi' },
  { re: /\bdetected[:\s]+rails\b/i, language: 'ruby', framework: 'rails' },
  { re: /\bdetected[:\s]+gin\b/i, language: 'go', framework: 'gin' },
  { re: /\bdetected[:\s]+echo\b/i, language: 'go', framework: 'echo' },
  { re: /\bdetected[:\s]+fiber\b/i, language: 'go', framework: 'fiber' },
  { re: /\bdetected[:\s]+spring\b/i, language: 'java', framework: 'spring' },
  { re: /\bdetected[:\s]+laravel\b/i, language: 'php', framework: 'laravel' },
  { re: /\bdetected[:\s]+phoenix\b/i, language: 'elixir', framework: 'phoenix' },
  { re: /\bdetected[:\s]+node\.?js\b/i, language: 'node' },
  { re: /\bdetected[:\s]+python\b/i, language: 'python' },
  { re: /\bdetected[:\s]+go(?:lang)?\b/i, language: 'go' },
  { re: /\bdetected[:\s]+ruby\b/i, language: 'ruby' },
  { re: /\bdetected[:\s]+java\b/i, language: 'java' },
  { re: /\bdetected[:\s]+\.?net\b/i, language: 'dotnet' },
  { re: /\bdetected[:\s]+rust\b/i, language: 'rust' },
  { re: /\bdetected[:\s]+php\b/i, language: 'php' },
  { re: /\bdetected[:\s]+elixir\b/i, language: 'elixir' }
];

const INSTALL_PATTERNS: { re: RegExp; language: string }[] = [
  { re: /installing dependencies with (npm|yarn|pnpm)\b/i, language: 'node' },
  { re: /installing dependencies with pip\b/i, language: 'python' },
  { re: /installing dependencies with bundler\b/i, language: 'ruby' },
  { re: /installing dependencies with cargo\b/i, language: 'rust' },
  { re: /installing dependencies with composer\b/i, language: 'php' },
  { re: /installing dependencies with mix\b/i, language: 'elixir' },
  { re: /\bgo build\b/i, language: 'go' },
  { re: /\bmaven\b|\bgradle\b/i, language: 'java' },
  { re: /\bdotnet\s+(build|restore)\b/i, language: 'dotnet' }
];

const VERSION_RE = /(\d+\.\d+(?:\.\d+)?)/;

function detectFromBuildLogs(buildLogs: string | null): DetectedRuntime | null {
  if (!buildLogs) return null;

  const lines = buildLogs.split('\n');
  for (const line of lines) {
    for (const pat of LANGUAGE_PATTERNS) {
      if (pat.re.test(line)) {
        const versionMatch = VERSION_RE.exec(line);
        return {
          language: pat.language,
          framework: pat.framework ?? null,
          version: versionMatch?.[1] ?? null,
          confidence: 'high',
          detectedFrom: 'build_logs'
        };
      }
    }
  }

  for (const line of lines) {
    for (const pat of INSTALL_PATTERNS) {
      if (pat.re.test(line)) {
        const versionMatch = VERSION_RE.exec(line);
        return {
          language: pat.language,
          framework: null,
          version: versionMatch?.[1] ?? null,
          confidence: 'medium',
          detectedFrom: 'build_logs'
        };
      }
    }
  }

  return detectFromDockerBuildLogs(buildLogs);
}

const DOCKER_FROM_RE =
  /(?:^|\s)FROM\s+(?:docker\.io\/library\/)?(?:mcr\.microsoft\.com\/dotnet\/(?:aspnet|sdk|runtime)[:@]|([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)[:@])/i;

// Step ids are BuildKit's plain-output counter or the digest-derived hex id
// the rawjson transcoder assigns; both prefix the same `[stage] FROM …` line.
const BUILDKIT_FROM_RE =
  /^#(?:[0-9a-f]{8}|\d+)\s+\[.*\]\s+FROM\s+(?:docker\.io\/library\/)?(?:mcr\.microsoft\.com\/dotnet\/(?:aspnet|sdk|runtime)[:@]|([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*)[:@])/i;

const FROM_IMAGE_MAP: { re: RegExp; language: string }[] = [
  { re: /^node(?=[:\-@])/, language: 'node' },
  { re: /^python(?=[:\-@])/, language: 'python' },
  { re: /^golang(?=[:\-@])/, language: 'go' },
  { re: /^ruby(?=[:\-@])/, language: 'ruby' },
  { re: /^openjdk(?=[:\-@])/, language: 'java' },
  { re: /^eclipse-temurin(?=[:\-@])/, language: 'java' },
  { re: /^amazoncorretto(?=[:\-@])/, language: 'java' },
  { re: /^rust(?=[:\-@])/, language: 'rust' },
  { re: /^php(?=[:\-@])/, language: 'php' },
  { re: /^elixir(?=[:\-@])/, language: 'elixir' },
  { re: /^nginx(?=[:\-@])/, language: 'node' },
  { re: /^httpd(?=[:\-@])/, language: 'node' }
];

const DOCKER_FRAMEWORK_PATTERNS: Record<string, { re: RegExp; framework: string }[]> = {
  node: [
    { re: /\bnext\s+build\b|\bnext\s+start\b|\bNEXT_/i, framework: 'nextjs' },
    { re: /\bnuxt\s+build\b|\bnuxt\s+start\b/i, framework: 'nuxt' },
    { re: /\bremix\s+build\b|\bremix-serve\b/i, framework: 'remix' },
    { re: /\bastro\s+build\b/i, framework: 'astro' },
    { re: /\bsvelte-kit\b|@sveltejs\b/i, framework: 'sveltekit' },
    { re: /\bfastify\b/i, framework: 'fastify' },
    { re: /\bexpress\b/i, framework: 'express' }
  ],
  python: [
    { re: /\bdjango\b|\bmanage\.py\b|\bgunicorn\b.*\bwsgi\b/i, framework: 'django' },
    { re: /\bfastapi\b|\buvicorn\b/i, framework: 'fastapi' },
    { re: /\bflask\b/i, framework: 'flask' }
  ],
  ruby: [{ re: /\brails\b|\brake\b|\bpuma\b/i, framework: 'rails' }],
  go: [
    { re: /\bgin-gonic\b/i, framework: 'gin' },
    { re: /\blabstack\/echo\b/i, framework: 'echo' },
    { re: /\bgofiber\/fiber\b/i, framework: 'fiber' }
  ],
  java: [{ re: /\bspring\b/i, framework: 'spring' }],
  php: [{ re: /\blaravel\b|\bartisan\b/i, framework: 'laravel' }]
};

const DOCKER_COPY_LANGUAGE: { re: RegExp; language: string }[] = [
  {
    re: /\bCOPY\b.*\b(?:package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)\b/i,
    language: 'node'
  },
  { re: /\bCOPY\b.*\b(?:requirements\.txt|Pipfile|pyproject\.toml)\b/i, language: 'python' },
  { re: /\bCOPY\b.*\b(?:go\.mod|go\.sum)\b/i, language: 'go' },
  { re: /\bCOPY\b.*\bGemfile\b/i, language: 'ruby' },
  { re: /\bCOPY\b.*\b(?:Cargo\.toml|Cargo\.lock)\b/i, language: 'rust' },
  { re: /\bCOPY\b.*\bcomposer\.json\b/i, language: 'php' },
  { re: /\bCOPY\b.*\bmix\.exs\b/i, language: 'elixir' },
  { re: /\bCOPY\b.*\b(?:pom\.xml|build\.gradle)\b/i, language: 'java' },
  { re: /\bCOPY\b.*\b(?:\.csproj|\.sln)\b/i, language: 'dotnet' }
];

const DOCKER_RUN_LANGUAGE: { re: RegExp; language: string }[] = [
  { re: /\bRUN\b.*\b(?:npm\s+install|yarn\s|pnpm\s+install)\b/i, language: 'node' },
  { re: /\bRUN\b.*\b(?:pip3?\s+install|poetry\s+install)\b/i, language: 'python' },
  { re: /\bRUN\b.*\b(?:go\s+build|go\s+mod\s+download)\b/i, language: 'go' },
  { re: /\bRUN\b.*\bbundle\s+install\b/i, language: 'ruby' },
  { re: /\bRUN\b.*\bcargo\s+build\b/i, language: 'rust' },
  { re: /\bRUN\b.*\bcomposer\s+install\b/i, language: 'php' },
  { re: /\bRUN\b.*\bmix\s+deps\.get\b/i, language: 'elixir' },
  { re: /\bRUN\b.*\b(?:mvn\b|gradle\b|\.\/gradlew\b)/i, language: 'java' },
  { re: /\bRUN\b.*\bdotnet\s+(?:restore|build)\b/i, language: 'dotnet' }
];

const FROM_VERSION_RE = /[:@](\d+(?:\.\d+(?:\.\d+)?)?)(?=-[a-zA-Z]|@|$)/;

function extractFromImageVersion(fromSegment: string): string | null {
  const match = FROM_VERSION_RE.exec(fromSegment);
  return match?.[1] ?? null;
}

function detectFromDockerBuildLogs(buildLogs: string): DetectedRuntime | null {
  const lines = buildLogs.split('\n');

  let language: string | null = null;
  let version: string | null = null;
  let isStaticServer = false;

  for (const line of lines) {
    let imageName: string | null = null;
    let rawFromSegment: string | null = null;

    const bkMatch = BUILDKIT_FROM_RE.exec(line);
    if (bkMatch) {
      const afterFrom = line.slice(line.search(/FROM\s+/i));
      rawFromSegment = afterFrom.replace(/^FROM\s+/i, '').split(/\s/)[0];
      const cleaned = rawFromSegment
        .replace(/^docker\.io\/library\//, '')
        .replace(/^mcr\.microsoft\.com\/dotnet\/(?:aspnet|sdk|runtime)/, '');
      imageName = bkMatch[1] ?? cleaned;
    } else {
      const classicMatch = DOCKER_FROM_RE.exec(line);
      if (classicMatch) {
        const afterFrom = line.slice(line.search(/FROM\s+/i));
        rawFromSegment = afterFrom.replace(/^FROM\s+/i, '').split(/\s/)[0];
        const cleaned = rawFromSegment
          .replace(/^docker\.io\/library\//, '')
          .replace(/^mcr\.microsoft\.com\/dotnet\/(?:aspnet|sdk|runtime)/, '');
        imageName = classicMatch[1] ?? cleaned;
      }
    }

    if (!imageName || !rawFromSegment) continue;

    if (/mcr\.microsoft\.com\/dotnet\//i.test(rawFromSegment)) {
      language = 'dotnet';
      version = extractFromImageVersion(rawFromSegment);
      break;
    }

    for (const pat of FROM_IMAGE_MAP) {
      if (pat.re.test(imageName)) {
        language = pat.language;
        isStaticServer = /^(?:nginx|httpd)(?=[:\-@])/.test(imageName);
        version = extractFromImageVersion(rawFromSegment);
        break;
      }
    }

    if (language) break;
  }

  if (!language) {
    for (const line of lines) {
      for (const pat of DOCKER_COPY_LANGUAGE) {
        if (pat.re.test(line)) {
          language = pat.language;
          break;
        }
      }
      if (language) break;
    }
  }

  if (!language) {
    for (const line of lines) {
      for (const pat of DOCKER_RUN_LANGUAGE) {
        if (pat.re.test(line)) {
          language = pat.language;
          break;
        }
      }
      if (language) break;
    }
  }

  if (!language) return null;

  if (isStaticServer) {
    return {
      language: 'node',
      framework: null,
      version: null,
      confidence: 'medium',
      detectedFrom: 'build_logs'
    };
  }

  let framework: string | null = null;
  const frameworkPatterns = DOCKER_FRAMEWORK_PATTERNS[language];
  if (frameworkPatterns) {
    for (const line of lines) {
      for (const pat of frameworkPatterns) {
        if (pat.re.test(line)) {
          framework = pat.framework;
          break;
        }
      }
      if (framework) break;
    }
  }

  return {
    language,
    framework,
    version,
    confidence: framework ? 'high' : 'medium',
    detectedFrom: 'build_logs'
  };
}

const ENV_RULES: {
  test: (key: string) => boolean;
  language: string;
  framework?: string;
}[] = [
  { test: (k) => k.startsWith('NEXT_PUBLIC_'), language: 'node', framework: 'nextjs' },
  { test: (k) => k.startsWith('NUXT_'), language: 'node', framework: 'nuxt' },
  { test: (k) => k === 'DJANGO_SETTINGS_MODULE', language: 'python', framework: 'django' },
  { test: (k) => k === 'FLASK_APP', language: 'python', framework: 'flask' },
  { test: (k) => k === 'RAILS_ENV', language: 'ruby', framework: 'rails' },
  { test: (k) => k === 'RACK_ENV', language: 'ruby' },
  { test: (k) => k === 'GIN_MODE', language: 'go', framework: 'gin' },
  { test: (k) => k === 'GOPATH', language: 'go' },
  { test: (k) => k === 'MIX_ENV', language: 'elixir' },
  { test: (k) => k.startsWith('ASPNETCORE_'), language: 'dotnet' },
  { test: (k) => k === 'NODE_ENV', language: 'node' }
];

function detectFromEnvVars(envVars: { key: string; value: string }[]): DetectedRuntime | null {
  for (const env of envVars) {
    for (const rule of ENV_RULES) {
      if (rule.test(env.key)) {
        return {
          language: rule.language,
          framework: rule.framework ?? null,
          version: null,
          confidence: rule.framework ? 'medium' : 'low',
          detectedFrom: 'env_vars'
        };
      }
    }
  }
  return null;
}

const IMAGE_PATTERNS: { re: RegExp; language: string }[] = [
  { re: /\bnode[:-]/, language: 'node' },
  { re: /\bpython[:-]/, language: 'python' },
  { re: /\bgolang[:-]/, language: 'go' },
  { re: /\bruby[:-]/, language: 'ruby' },
  { re: /\bopenjdk[:-]/, language: 'java' },
  { re: /\bjava[:-]/, language: 'java' },
  { re: /\bdotnet[:-]/, language: 'dotnet' },
  { re: /\baspnet[:-]/, language: 'dotnet' },
  { re: /\brust[:-]/, language: 'rust' },
  { re: /\bphp[:-]/, language: 'php' },
  { re: /\belixir[:-]/, language: 'elixir' }
];

function detectFromImage(image: string | null): DetectedRuntime | null {
  if (!image) return null;

  const lower = image.toLowerCase();
  for (const pat of IMAGE_PATTERNS) {
    if (pat.re.test(lower)) {
      const versionMatch = VERSION_RE.exec(image);
      return {
        language: pat.language,
        framework: null,
        version: versionMatch?.[1] ?? null,
        confidence: 'medium',
        detectedFrom: 'image'
      };
    }
  }

  const lastSegment = lower.split('/').pop() ?? lower;
  for (const pat of IMAGE_PATTERNS) {
    if (pat.re.test(lastSegment)) {
      const versionMatch = VERSION_RE.exec(image);
      return {
        language: pat.language,
        framework: null,
        version: versionMatch?.[1] ?? null,
        confidence: 'low',
        detectedFrom: 'image'
      };
    }
  }

  return null;
}

const DOCKERFILE_PATH_PATTERNS: { re: RegExp; language: string }[] = [
  { re: /\.node/i, language: 'node' },
  { re: /\.python/i, language: 'python' },
  { re: /\.go/i, language: 'go' },
  { re: /\.ruby/i, language: 'ruby' },
  { re: /\.java/i, language: 'java' },
  { re: /\.dotnet/i, language: 'dotnet' },
  { re: /\.rust/i, language: 'rust' },
  { re: /\.php/i, language: 'php' },
  { re: /\.elixir/i, language: 'elixir' }
];

function detectFromDockerfilePath(path: string | null): DetectedRuntime | null {
  if (!path) return null;

  for (const pat of DOCKERFILE_PATH_PATTERNS) {
    if (pat.re.test(path)) {
      return {
        language: pat.language,
        framework: null,
        version: null,
        confidence: 'low',
        detectedFrom: 'dockerfile'
      };
    }
  }
  return null;
}

function hasStackTraceStart(line: string): boolean {
  return (
    /Traceback \(most recent call last\):/i.test(line) ||
    /\bCaused by:/i.test(line) ||
    /^goroutine \d+/m.test(line)
  );
}

const STACK_FRAME_RE =
  /^\s+at\s|^\tat\s|^\s+File\s"|^Traceback\s|^Caused by:|^\s+\.{3}\s\d+\smore|^goroutine\s\d+|^\t\/.+\.go:\d+|^\t\/.+\.rb:\d+:in\s|^---\sEnd of\s/;

function isStackFrame(raw: string): boolean {
  return STACK_FRAME_RE.test(raw.trim());
}

const ERROR_TYPE_RE = /^(?:(\w+(?:\.\w+)*(?:Error|Exception|Fault|Panic))\s*[:-]\s*)(.*)/;

function extractErrorInfo(msg: string): { type: string; message: string } {
  const match = ERROR_TYPE_RE.exec(msg.trim());
  if (match) {
    return { type: match[1], message: match[2] || match[1] };
  }
  return { type: 'Error', message: msg.trim() };
}

function normalizeErrorMessage(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*/g, '<timestamp>')
    .replace(/\b\d+\b/g, '<n>');
}
