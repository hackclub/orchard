import {
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException
} from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { podLogText } from '../kubernetes/pod-log-text';
import { BUILDER_NAMESPACE } from './builder-namespace';
import {
  BUILD_CACHE_SETTINGS_KEY,
  BuildCacheSettings,
  CachePruneResult,
  CacheUsage,
  PruneMode,
  applyBuildCachePatch,
  cachePruneScript,
  cacheUsageScript,
  defaultBuildCacheSettings,
  parseCachePrune,
  parseCacheUsage,
  parseStoredBuildCacheSettings,
  tenantOfSubPath
} from './build-cache-settings';

const REFRESH_MS = 60_000;
const USAGE_TIMEOUT_MS = 3 * 60_000;
const PRUNE_TIMEOUT_MS = 15 * 60_000;

export interface BuildCacheView {
  available: boolean;
  pvcName: string | null;
  pvcSize: string | null;
  settings: BuildCacheSettings;
  defaults: BuildCacheSettings;
  idleMinutes: number;
}

@Injectable()
export class BuildCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BuildCacheService.name);

  private readonly defaults = defaultBuildCacheSettings();

  private settings: BuildCacheSettings = this.defaults;

  private readonly pvcName = process.env.BUILDKIT_LOCAL_CACHE_PVC || null;

  private readonly localCacheEnabled = process.env.BUILDKIT_LOCAL_CACHE_ENABLED === 'true';

  private readonly idleMinutes = Number(process.env.BUILDKIT_CACHE_IDLE_MINUTES || 60);

  private refreshTimer?: ReturnType<typeof setInterval>;

  private busy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetes: KubernetesService
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  current(): BuildCacheSettings {
    return this.settings;
  }

  available(): boolean {
    return this.localCacheEnabled && !!this.pvcName && !!this.kubernetes.kc;
  }

  async view(): Promise<BuildCacheView> {
    await this.refresh();
    return {
      available: this.available(),
      pvcName: this.pvcName,
      pvcSize: await this.pvcSize(),
      settings: this.settings,
      defaults: this.defaults,
      idleMinutes: this.idleMinutes
    };
  }

  async update(body: unknown): Promise<BuildCacheView> {
    const next = applyBuildCachePatch(this.settings, body);
    const value = JSON.stringify(next);
    await this.prisma.instanceSetting.upsert({
      where: { key: BUILD_CACHE_SETTINGS_KEY },
      create: { key: BUILD_CACHE_SETTINGS_KEY, value },
      update: { value }
    });
    this.settings = next;
    return this.view();
  }

  async usage(): Promise<CacheUsage> {
    const log = await this.runMaintenance('usage', cacheUsageScript(), USAGE_TIMEOUT_MS);
    return parseCacheUsage(log);
  }

  async prune(mode: PruneMode): Promise<CachePruneResult> {
    const keep = await this.tenantsInUse();
    const log = await this.runMaintenance(
      'prune',
      cachePruneScript({ mode, idleMinutes: this.idleMinutes, keep }),
      PRUNE_TIMEOUT_MS
    );
    const result = parseCachePrune(log);
    this.logger.log(
      `build cache prune (${mode}) freed ${result.freedBytes} bytes, removed ${result.removed.length}, skipped ${result.skipped.length}`
    );
    return result;
  }

  private async refresh(): Promise<void> {
    try {
      const row = await this.prisma.instanceSetting.findUnique({
        where: { key: BUILD_CACHE_SETTINGS_KEY }
      });
      this.settings = parseStoredBuildCacheSettings(row?.value ?? null, this.defaults);
    } catch (err) {
      this.logger.warn(`could not read build cache settings: ${(err as Error).message}`);
    }
  }

  private async pvcSize(): Promise<string | null> {
    if (!this.available()) return null;
    try {
      const core = this.kubernetes.kc!.makeApiClient(k8s.CoreV1Api);
      const { body } = await core.readNamespacedPersistentVolumeClaim(
        this.pvcName!,
        BUILDER_NAMESPACE
      );
      return body.spec?.resources?.requests?.storage ?? body.status?.capacity?.storage ?? null;
    } catch {
      return null;
    }
  }

  private async tenantsInUse(): Promise<string[]> {
    const core = this.kubernetes.kc!.makeApiClient(k8s.CoreV1Api);
    const { body } = await core.listNamespacedPod(BUILDER_NAMESPACE);
    const tenants = new Set<string>();
    for (const pod of body.items) {
      const phase = pod.status?.phase;
      if (phase === 'Succeeded' || phase === 'Failed') continue;
      const cacheVolumes = new Set(
        (pod.spec?.volumes ?? [])
          .filter((v) => v.persistentVolumeClaim?.claimName === this.pvcName)
          .map((v) => v.name)
      );
      for (const container of [
        ...(pod.spec?.initContainers ?? []),
        ...(pod.spec?.containers ?? [])
      ]) {
        for (const mount of container.volumeMounts ?? []) {
          if (!cacheVolumes.has(mount.name)) continue;
          const tenant = tenantOfSubPath(mount.subPath);
          if (tenant) tenants.add(tenant);
        }
      }
    }
    return [...tenants];
  }

  private async runMaintenance(op: string, script: string, timeoutMs: number): Promise<string> {
    if (!this.available()) {
      throw new ServiceUnavailableException('This instance has no shared build cache');
    }
    if (this.busy) {
      throw new ConflictException('A build cache task is already running');
    }
    this.busy = true;
    const core = this.kubernetes.kc!.makeApiClient(k8s.CoreV1Api);
    const name = `build-cache-${op}-${randomBytes(3).toString('hex')}`;
    const pod: k8s.V1Pod = {
      metadata: {
        name,
        namespace: BUILDER_NAMESPACE,
        labels: {
          'app.kubernetes.io/managed-by': 'orchard',
          'orchard.my/build-cache-task': op
        }
      },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        tolerations: [{ key: 'orchard-builder', operator: 'Exists', effect: 'NoSchedule' }],
        containers: [
          {
            name: 'task',
            image: 'alpine:latest',
            command: ['/bin/sh', '-c'],
            args: [script],
            volumeMounts: [{ name: 'cache', mountPath: '/cache' }],
            resources: {
              requests: { cpu: '20m', memory: '32Mi' },
              limits: { cpu: '500m', memory: '128Mi' }
            }
          }
        ],
        volumes: [{ name: 'cache', persistentVolumeClaim: { claimName: this.pvcName! } }]
      }
    };
    try {
      await core.createNamespacedPod(BUILDER_NAMESPACE, pod);
      const phase = await this.waitForPod(core, name, timeoutMs);
      const { body: log } = await core.readNamespacedPodLog(name, BUILDER_NAMESPACE, 'task');
      const logText = podLogText(log);
      if (phase !== 'Succeeded') {
        throw new ServiceUnavailableException(
          `The build cache task did not finish (${phase}). ${logText.slice(-300)}`
        );
      }
      return logText;
    } finally {
      this.busy = false;
      await core.deleteNamespacedPod(name, BUILDER_NAMESPACE).catch(() => {});
    }
  }

  private async waitForPod(core: k8s.CoreV1Api, name: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { body } = await core.readNamespacedPod(name, BUILDER_NAMESPACE);
      const phase = body.status?.phase ?? 'Pending';
      if (phase === 'Succeeded' || phase === 'Failed') return phase;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return 'timed out';
  }
}
