import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsService } from '../../analytics/analytics.service';
import { FirecrackerClient } from './fc-client';
import {
  InstanceSettingsService,
  type FastBuilderRouting
} from '../../instance-settings/instance-settings.service';

export type BuilderKind = 'kubernetes' | 'depot' | 'firecracker';

export const BUILDER_KINDS: readonly BuilderKind[] = ['kubernetes', 'depot', 'firecracker'];

export const BUILDER_OVERRIDES = ['firecracker', 'kubernetes'] as const;

export type BuilderOverride = (typeof BUILDER_OVERRIDES)[number];

export const FIRECRACKER_FLAG = 'firecracker-builder';

export function isBuilderOverride(value: unknown): value is BuilderOverride {
  return typeof value === 'string' && (BUILDER_OVERRIDES as readonly string[]).includes(value);
}

export function isBuilderKind(value: unknown): value is BuilderKind {
  return typeof value === 'string' && (BUILDER_KINDS as readonly string[]).includes(value);
}

export function decideBuilder(input: {
  buildWithDepot: boolean;
  override: string | null;
  firecrackerAvailable: boolean;
  routing?: FastBuilderRouting;
  flag: () => Promise<boolean>;
}): Promise<BuilderKind> | BuilderKind {
  const routing = input.routing ?? 'flag';
  if (input.buildWithDepot) return 'depot';
  if (!input.firecrackerAvailable || input.override === 'kubernetes') return 'kubernetes';
  if (routing === 'off') return 'kubernetes';
  if (input.override === 'firecracker') return 'firecracker';
  if (routing === 'all') return 'firecracker';
  if (routing === 'per_app') return 'kubernetes';
  return input.flag().then(
    (on) => (on ? 'firecracker' : 'kubernetes'),
    () => 'kubernetes'
  );
}

export function builderPoolOf(
  run: { builder: string | null },
  buildWithDepot: boolean
): BuilderKind {
  if (isBuilderKind(run.builder)) return run.builder;
  return buildWithDepot ? 'depot' : 'kubernetes';
}

const FLAG_TIMEOUT_MS = 2_000;
const ROUTING_TTL_MS = 5_000;

@Injectable()
export class BuildBackendRouter {
  private readonly logger = new Logger(BuildBackendRouter.name);
  private routingCache: { value: FastBuilderRouting; at: number } | null = null;

  constructor(
    private readonly analytics: AnalyticsService,
    private readonly firecracker: FirecrackerClient,
    private readonly settings: InstanceSettingsService
  ) {}

  async pick(deployment: {
    buildWithDepot: boolean;
    builderOverride: string | null;
    projectId: string;
    projectSlug?: string | null;
    organizationId: string;
    organizationSlug?: string | null;
  }): Promise<BuilderKind> {
    const firecrackerAvailable = this.firecracker.enabled;
    return decideBuilder({
      buildWithDepot: deployment.buildWithDepot,
      override: deployment.builderOverride,
      firecrackerAvailable,
      routing:
        deployment.buildWithDepot || !firecrackerAvailable ? undefined : await this.routing(),
      flag: () => this.flag(deployment)
    });
  }

  private async routing(): Promise<FastBuilderRouting> {
    const cached = this.routingCache;
    if (cached && Date.now() - cached.at < ROUTING_TTL_MS) return cached.value;
    try {
      const { value } = await this.settings.getFastBuilderRoutingState();
      this.routingCache = { value, at: Date.now() };
      return value;
    } catch (error) {
      this.logger.warn(`fast builder routing read failed: ${(error as Error).message}`);
      return cached?.value ?? 'flag';
    }
  }

  private async flag(deployment: {
    projectId: string;
    projectSlug?: string | null;
    organizationId: string;
    organizationSlug?: string | null;
  }): Promise<boolean> {
    const evaluation = this.analytics.isFeatureEnabled(
      FIRECRACKER_FLAG,
      `project:${deployment.projectId}`,
      {
        groups: { organization: deployment.organizationId },
        personProperties: {
          project_id: deployment.projectId,
          project_slug: deployment.projectSlug ?? '',
          org_id: deployment.organizationId,
          org_slug: deployment.organizationSlug ?? ''
        }
      }
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), FLAG_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([evaluation, timeout]);
    } catch (error) {
      this.logger.warn(`${FIRECRACKER_FLAG} evaluation failed: ${(error as Error).message}`);
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
