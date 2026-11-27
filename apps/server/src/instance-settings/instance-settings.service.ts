import { ConflictException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { tenantBackupTarget } from '../instance-config/object-storage';
import { signupMode } from '../auth/signup-mode';
import {
  envNewOrgDefaults,
  newOrgCapsData,
  parseNewOrgDefaults,
  type NewOrgCaps,
  type NewOrgDefaults
} from '../quotas/org-limits';

export const USERSPACE_NODE_SCHEDULING_KEY = 'userspace_node_scheduling';
const USERSPACE_NODE_SCHEDULING_ENV = 'USERSPACE_NODE_SCHEDULING';

export const MCP_ENABLED_KEY = 'mcp_enabled';
const MCP_ENABLED_ENV = 'MCP_ENABLED';

export const CUSTOM_DOMAIN_VERIFICATION_KEY = 'custom_domain_verification';
export const CUSTOM_DOMAIN_VERIFICATION_ENV = 'CUSTOM_DOMAIN_VERIFICATION';
export const SSO_ENFORCED_KEY = 'sso_enforced';
export const SSO_ENFORCED_ENV = 'SSO_ENFORCED';

export const PUBLIC_IP_SHARING_KEY = 'public_ip_sharing';
export const PUBLIC_IP_SHARING_ENV = 'PUBLIC_IP_SHARING';

export const IDP_AUTO_CREATE_ORGS_KEY = 'idp_auto_create_orgs';
export const IDP_AUTO_CREATE_ORGS_ENV = 'IDP_AUTO_CREATE_ORGS';
export const IDP_SUPERADMIN_PROVIDER_KEY = 'idp_superadmin_provider_id';
export const IDP_SUPERADMIN_GROUP_KEY = 'idp_superadmin_group';

export const NEW_ORG_DEFAULTS_KEY = 'new_org_defaults';

export const POSTGRES_AUTO_UPDATE_KEY = 'postgres_auto_update';
export const POSTGRES_AUTO_UPDATE_ENV = 'POSTGRES_AUTO_UPDATE';

export const IMAGE_SCANNER_KEY = 'image_scanner';
export const IMAGE_SCANNER_ENV = 'IMAGE_SCANNER';
export const IMAGE_SCANNERS = ['off', 'harbor', 'trivy'] as const;
export type ImageScannerChoice = (typeof IMAGE_SCANNERS)[number];

export const RESOURCE_LIMITS_KEY = 'resource_limits';
export const RESOURCE_LIMITS_ENV = 'INSTANCE_RESOURCE_LIMITS';
export const RESOURCE_LIMITS_CHOICE_ENV = 'INSTANCE_RESOURCE_LIMITS_CHOICE';
export const RESOURCE_LIMITS_CHOICE_APPLIED_KEY = 'resource_limits_choice_applied';
export const RESOURCE_LIMITS_MODES = ['on', 'off'] as const;
export type ResourceLimitsMode = (typeof RESOURCE_LIMITS_MODES)[number];

export function parseResourceLimits(raw: string | null | undefined): ResourceLimitsMode | null {
  const v = (raw ?? '').trim().toLowerCase();
  return (RESOURCE_LIMITS_MODES as readonly string[]).includes(v)
    ? (v as ResourceLimitsMode)
    : null;
}

export const FAST_BUILDER_ROUTING_KEY = 'fast_builder_routing';
export const FAST_BUILDER_ROUTING_ENV = 'FAST_BUILDER_ROUTING_DEFAULT';
export const FAST_BUILDER_ROUTINGS = ['all', 'per_app', 'off', 'flag'] as const;
export type FastBuilderRouting = (typeof FAST_BUILDER_ROUTINGS)[number];

export function parseFastBuilderRouting(raw: string | null | undefined): FastBuilderRouting | null {
  const v = (raw ?? '').trim().toLowerCase().replace(/-/g, '_');
  return (FAST_BUILDER_ROUTINGS as readonly string[]).includes(v)
    ? (v as FastBuilderRouting)
    : null;
}

export interface FastBuilderRoutingState {
  value: FastBuilderRouting;
  dbValue: FastBuilderRouting | null;
  fallback: FastBuilderRouting;
}

export interface ChoiceState<T extends string> {
  value: T;
  dbValue: T | null;
  envOverride: T | null;
}

export function parseImageScanner(raw: string | null | undefined): ImageScannerChoice | null {
  const v = (raw ?? '').trim().toLowerCase();
  return (IMAGE_SCANNERS as readonly string[]).includes(v) ? (v as ImageScannerChoice) : null;
}

export const DATABASE_TOGGLES = {
  ddlCheckpoints: { key: 'db_ddl_checkpoints', env: 'DB_DDL_CHECKPOINTS', fallback: true },
  restoreDrills: { key: 'db_restore_drills', env: 'DB_RESTORE_DRILLS', fallback: false },
  pluginMigration: {
    key: 'db_barman_plugin_migration',
    env: 'CNPG_BARMAN_PLUGIN_MIGRATE',
    fallback: false
  },
  poolerByDefault: { key: 'db_pooler_by_default', env: 'DB_POOLER_BY_DEFAULT', fallback: true }
} as const;

export type DatabaseToggle = keyof typeof DATABASE_TOGGLES;

export interface ToggleState {
  enabled: boolean;
  dbValue: boolean;
  envOverride: boolean | null;
  unavailable?: string;
}

export const BACKUP_DEPENDENT_TOGGLES: readonly DatabaseToggle[] = [
  'ddlCheckpoints',
  'restoreDrills'
];

export const NO_BACKUP_STORAGE =
  'Needs backup storage. Set a backup bucket for the instance or an organization first.';

export function markBackupDependent(
  toggles: Record<DatabaseToggle, ToggleState>,
  backupsAvailable: boolean
): Record<DatabaseToggle, ToggleState> {
  if (backupsAvailable) return toggles;
  const out = { ...toggles };
  for (const key of BACKUP_DEPENDENT_TOGGLES)
    out[key] = { ...out[key], unavailable: NO_BACKUP_STORAGE };
  return out;
}

@Injectable()
export class InstanceSettingsService implements OnModuleInit {
  private readonly logger = new Logger(InstanceSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.settleResourceLimits().catch((err) => {
      this.logger.warn(`resource limits choice not stored: ${err?.message ?? err}`);
    });
  }

  async settleResourceLimits(): Promise<void> {
    const pinned = parseResourceLimits(process.env[RESOURCE_LIMITS_ENV]);
    const stored = await this.getRaw(RESOURCE_LIMITS_KEY);
    if (pinned) {
      if (stored !== pinned) await this.set(RESOURCE_LIMITS_KEY, pinned);
      return;
    }
    const choice = parseResourceLimits(process.env[RESOURCE_LIMITS_CHOICE_ENV]);
    if (!choice) return;
    if ((await this.getRaw(RESOURCE_LIMITS_CHOICE_APPLIED_KEY)) === choice) return;
    await this.set(RESOURCE_LIMITS_KEY, choice);
    await this.set(RESOURCE_LIMITS_CHOICE_APPLIED_KEY, choice);
  }

  private async getRaw(key: string): Promise<string | null> {
    const row = await this.prisma.instanceSetting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  get(key: string): Promise<string | null> {
    return this.getRaw(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.prisma.instanceSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value }
    });
  }

  async createIfAbsent(key: string, value: string): Promise<boolean> {
    try {
      await this.prisma.instanceSetting.create({ data: { key, value } });
      return true;
    } catch (e: any) {
      if (e?.code === 'P2002') return false;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    await this.prisma.instanceSetting.deleteMany({ where: { key } });
  }

  async setBool(key: string, value: boolean): Promise<void> {
    const str = value ? 'true' : 'false';
    await this.prisma.instanceSetting.upsert({
      where: { key },
      create: { key, value: str },
      update: { value: str }
    });
  }

  private envOverride(envVar: string): boolean | null {
    const v = process.env[envVar];
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  }

  // A toggle with nothing stored takes its fallback, so a feature that ships on
  // stays on until somebody turns it off rather than needing a row written at
  // install time that an upgraded instance would never get.
  private async storedBool(key: string, fallback: boolean): Promise<boolean> {
    const raw = await this.getRaw(key);
    if (raw === null) return fallback;
    return raw === 'true';
  }

  private async resolveBool(key: string, envVar: string, fallback = false): Promise<boolean> {
    const env = this.envOverride(envVar);
    if (env !== null) return env;
    return this.storedBool(key, fallback);
  }

  /**
   * A variable that pins a toggle makes it read-only for everyone, not just for
   * the admin panel that hides the switch. Refusing the write is the difference
   * between a lock and a suggestion: an accepted write changes nothing now and
   * then silently becomes the instance's answer the day the variable is unset.
   */
  private assertUnlocked(envVar: string): void {
    if (this.envOverride(envVar) === null) return;
    throw new ConflictException(
      `This is pinned by the ${envVar} environment variable. Unset it to change this here.`
    );
  }

  private async toggleState(key: string, envVar: string, fallback = false): Promise<ToggleState> {
    const envOverride = this.envOverride(envVar);
    const dbValue = await this.storedBool(key, fallback);
    return { enabled: envOverride ?? dbValue, dbValue, envOverride };
  }

  isUserspaceSchedulingEnabled(): Promise<boolean> {
    return this.resolveBool(USERSPACE_NODE_SCHEDULING_KEY, USERSPACE_NODE_SCHEDULING_ENV);
  }

  getUserspaceSchedulingState(): Promise<ToggleState> {
    return this.toggleState(USERSPACE_NODE_SCHEDULING_KEY, USERSPACE_NODE_SCHEDULING_ENV);
  }

  async setUserspaceScheduling(value: boolean): Promise<void> {
    this.assertUnlocked(USERSPACE_NODE_SCHEDULING_ENV);
    await this.setBool(USERSPACE_NODE_SCHEDULING_KEY, value);
  }

  isMcpEnabled(): Promise<boolean> {
    return this.resolveBool(MCP_ENABLED_KEY, MCP_ENABLED_ENV, true);
  }

  getMcpState(): Promise<ToggleState> {
    return this.toggleState(MCP_ENABLED_KEY, MCP_ENABLED_ENV, true);
  }

  async setMcp(value: boolean): Promise<void> {
    this.assertUnlocked(MCP_ENABLED_ENV);
    await this.setBool(MCP_ENABLED_KEY, value);
  }

  isCustomDomainVerificationRequired(): Promise<boolean> {
    return this.resolveBool(
      CUSTOM_DOMAIN_VERIFICATION_KEY,
      CUSTOM_DOMAIN_VERIFICATION_ENV,
      signupMode() === 'open'
    );
  }

  getCustomDomainVerificationState(): Promise<ToggleState> {
    return this.toggleState(
      CUSTOM_DOMAIN_VERIFICATION_KEY,
      CUSTOM_DOMAIN_VERIFICATION_ENV,
      signupMode() === 'open'
    );
  }

  async setCustomDomainVerification(value: boolean): Promise<void> {
    this.assertUnlocked(CUSTOM_DOMAIN_VERIFICATION_ENV);
    await this.setBool(CUSTOM_DOMAIN_VERIFICATION_KEY, value);
  }

  isPublicIpSharingAllowed(): Promise<boolean> {
    return this.resolveBool(PUBLIC_IP_SHARING_KEY, PUBLIC_IP_SHARING_ENV);
  }

  getPublicIpSharingState(): Promise<ToggleState> {
    return this.toggleState(PUBLIC_IP_SHARING_KEY, PUBLIC_IP_SHARING_ENV);
  }

  async setPublicIpSharing(value: boolean): Promise<void> {
    this.assertUnlocked(PUBLIC_IP_SHARING_ENV);
    await this.setBool(PUBLIC_IP_SHARING_KEY, value);
  }

  isSsoEnforced(): Promise<boolean> {
    return this.resolveBool(SSO_ENFORCED_KEY, SSO_ENFORCED_ENV);
  }

  getSsoEnforcedState(): Promise<ToggleState> {
    return this.toggleState(SSO_ENFORCED_KEY, SSO_ENFORCED_ENV);
  }

  async setSsoEnforced(value: boolean): Promise<void> {
    this.assertUnlocked(SSO_ENFORCED_ENV);
    await this.setBool(SSO_ENFORCED_KEY, value);
  }

  isIdpAutoCreateOrgsEnabled(): Promise<boolean> {
    return this.resolveBool(IDP_AUTO_CREATE_ORGS_KEY, IDP_AUTO_CREATE_ORGS_ENV, false);
  }

  getIdpAutoCreateOrgsState(): Promise<ToggleState> {
    return this.toggleState(IDP_AUTO_CREATE_ORGS_KEY, IDP_AUTO_CREATE_ORGS_ENV, false);
  }

  async setIdpAutoCreateOrgs(value: boolean): Promise<void> {
    this.assertUnlocked(IDP_AUTO_CREATE_ORGS_ENV);
    await this.setBool(IDP_AUTO_CREATE_ORGS_KEY, value);
  }

  isDatabaseToggleOn(name: DatabaseToggle): Promise<boolean> {
    const t = DATABASE_TOGGLES[name];
    return this.resolveBool(t.key, t.env, t.fallback);
  }

  async getDatabaseToggles(): Promise<Record<DatabaseToggle, ToggleState>> {
    const names = Object.keys(DATABASE_TOGGLES) as DatabaseToggle[];
    const states = await Promise.all(
      names.map((n) =>
        this.toggleState(
          DATABASE_TOGGLES[n].key,
          DATABASE_TOGGLES[n].env,
          DATABASE_TOGGLES[n].fallback
        )
      )
    );
    return Object.fromEntries(names.map((n, i) => [n, states[i]])) as Record<
      DatabaseToggle,
      ToggleState
    >;
  }

  async databaseTogglesView(): Promise<Record<DatabaseToggle, ToggleState>> {
    const [toggles, backupsAvailable] = await Promise.all([
      this.getDatabaseToggles(),
      this.anyBackupStorage()
    ]);
    return markBackupDependent(toggles, backupsAvailable);
  }

  private async anyBackupStorage(): Promise<boolean> {
    if (tenantBackupTarget()) return true;
    const own = await this.prisma.organization.count({
      where: {
        backupR2Endpoint: { not: null },
        backupR2Bucket: { not: null },
        backupR2AccessKey: { not: null },
        backupR2SecretKey: { not: null }
      }
    });
    return own > 0;
  }

  async setDatabaseToggle(name: DatabaseToggle, value: boolean): Promise<void> {
    const t = DATABASE_TOGGLES[name];
    this.assertUnlocked(t.env);
    await this.setBool(t.key, value);
  }

  isPostgresAutoUpdateEnabled(): Promise<boolean> {
    return this.resolveBool(POSTGRES_AUTO_UPDATE_KEY, POSTGRES_AUTO_UPDATE_ENV, true);
  }

  getPostgresAutoUpdateState(): Promise<ToggleState> {
    return this.toggleState(POSTGRES_AUTO_UPDATE_KEY, POSTGRES_AUTO_UPDATE_ENV, true);
  }

  async setPostgresAutoUpdate(value: boolean): Promise<void> {
    this.assertUnlocked(POSTGRES_AUTO_UPDATE_ENV);
    await this.setBool(POSTGRES_AUTO_UPDATE_KEY, value);
  }

  async getResourceLimitsState(): Promise<ChoiceState<ResourceLimitsMode>> {
    const envOverride = parseResourceLimits(process.env[RESOURCE_LIMITS_ENV]);
    const dbValue = parseResourceLimits(await this.getRaw(RESOURCE_LIMITS_KEY));
    return { value: envOverride ?? dbValue ?? 'on', dbValue, envOverride };
  }

  async setResourceLimits(value: ResourceLimitsMode): Promise<void> {
    if (parseResourceLimits(process.env[RESOURCE_LIMITS_ENV]) !== null) {
      throw new ConflictException(
        `This is pinned by the ${RESOURCE_LIMITS_ENV} environment variable. Unset it to change this here.`
      );
    }
    await this.set(RESOURCE_LIMITS_KEY, value);
  }

  async getFastBuilderRoutingState(): Promise<FastBuilderRoutingState> {
    const dbValue = parseFastBuilderRouting(await this.getRaw(FAST_BUILDER_ROUTING_KEY));
    const fallback = parseFastBuilderRouting(process.env[FAST_BUILDER_ROUTING_ENV]) ?? 'flag';
    return { value: dbValue ?? fallback, dbValue, fallback };
  }

  async setFastBuilderRouting(value: FastBuilderRouting): Promise<void> {
    await this.set(FAST_BUILDER_ROUTING_KEY, value);
  }

  async getImageScannerState(
    fallback: () => Promise<ImageScannerChoice> = async () => 'off'
  ): Promise<ChoiceState<ImageScannerChoice>> {
    const envOverride = parseImageScanner(process.env[IMAGE_SCANNER_ENV]);
    const dbValue = parseImageScanner(await this.getRaw(IMAGE_SCANNER_KEY));
    return { value: envOverride ?? dbValue ?? (await fallback()), dbValue, envOverride };
  }

  async setImageScanner(value: ImageScannerChoice): Promise<void> {
    if (parseImageScanner(process.env[IMAGE_SCANNER_ENV]) !== null) {
      throw new ConflictException(
        `This is pinned by the ${IMAGE_SCANNER_ENV} environment variable. Unset it to change this here.`
      );
    }
    await this.set(IMAGE_SCANNER_KEY, value);
  }

  /**
   * Caps a new organization is created with. A stored instance default wins; with
   * none stored the answer is uncapped, unless the operator seeded the compute caps
   * through NEW_ORG_CPU / NEW_ORG_MEMORY. Read at creation time only: changing this
   * never touches an organization that already exists.
   */
  async getNewOrgDefaultsState(): Promise<{
    value: NewOrgDefaults;
    stored: NewOrgDefaults | null;
    fallback: NewOrgDefaults;
  }> {
    const stored = parseNewOrgDefaults(await this.getRaw(NEW_ORG_DEFAULTS_KEY));
    const fallback = envNewOrgDefaults();
    return { value: stored ?? fallback, stored, fallback };
  }

  async getNewOrgCaps(): Promise<NewOrgCaps> {
    return newOrgCapsData((await this.getNewOrgDefaultsState()).value);
  }

  async setNewOrgDefaults(value: NewOrgDefaults): Promise<void> {
    await this.set(NEW_ORG_DEFAULTS_KEY, JSON.stringify(value));
  }
}
