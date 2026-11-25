import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService, sanitizeUsername } from '../users/users.service';
import { StorageService } from './storage.service';
import { EmailService } from '../email/email.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../auth/authorization.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { requestAuthStorage } from '../auth/request-context';
import { TailscaleService } from '../tailscale/tailscale.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { PublicIpPolicyService } from '../kubernetes/public-ip-policy.service';
import { canonicalIp } from '../kubernetes/public-ip-policy';
import { RateLimitService } from '../auth/rate-limit.service';
import { signupMode, signupDeniedError } from '../auth/signup-mode';
import { PasswordRefused, hashAccountPassword } from '../auth/superadmin-password';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { assertPublicUrl, guardedS3Options } from '../notifications/webhook-guard';
import { accountEmail } from '../users/account-scope';

export function normalizeBackupEndpoint(input: string | null): string | null {
  const raw = (input ?? '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException(
      'backupR2Endpoint must be a full URL such as https://<account-id>.r2.cloudflarestorage.com'
    );
  }
  const schemeOk = url.protocol === 'https:' || url.protocol === 'http:';
  const hostOk = url.hostname.includes('.') || url.hostname === 'localhost';
  if (!schemeOk || !hostOk || url.search || url.hash) {
    throw new BadRequestException(
      'backupR2Endpoint must be a full URL such as https://<account-id>.r2.cloudflarestorage.com'
    );
  }
  return raw;
}

const MAIL_LABEL_MAX = 100;

function mailLabel(value: string): string {
  return value.replace(/\p{Cc}/gu, ' ').slice(0, MAIL_LABEL_MAX);
}

const INVITE_MAIL_WAIT_MS = 15_000;

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly emailService: EmailService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    private readonly membershipCache: MembershipCacheService,
    private readonly tailscale: TailscaleService,
    private readonly instanceConfig: InstanceConfigService,
    private readonly crypto: SecretCryptoService,
    private readonly rateLimit: RateLimitService,
    @Optional() private readonly instanceSettings?: InstanceSettingsService,
    @Optional() private readonly publicIpPolicy?: PublicIpPolicyService
  ) {}

  // M-3: SHA-256 of the plaintext invitation token. Stored alongside the
  // legacy `token` column during the transition window; lookups go through
  // this hash so a DB read cannot yield working invite links.
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private inviteLink(token: string): string {
    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/invite/${token}`;
  }

  private inviteDelivery(): 'email' | 'link' {
    return this.emailService.isConfigured() ? 'email' : 'link';
  }

  private async inviteMailed(send: Promise<boolean>, what: string): Promise<boolean> {
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), INVITE_MAIL_WAIT_MS).unref?.();
    });
    const sent = await Promise.race([
      send.catch((err) => {
        console.error(`Failed to send ${what}:`, err);
        return false;
      }),
      timeout
    ]);
    return sent !== false;
  }

  async checkPermission(organizationId: string, userId: string, requiredRole: 'owner' | 'admin') {
    if (requiredRole === 'owner') {
      await this.authz.requireOrgOwner(organizationId, userId);
    } else {
      await this.authz.requireOrgAdmin(organizationId, userId);
    }
    return this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } }
    });
  }

  private async resolveUserId(clerkId: string, userData?: any): Promise<string> {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    return user.id;
  }

  async getUserOrganizations(clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      return [];
    }

    const isSuperAdmin = await this.authz.isUnrestrictedSuperAdmin(user.id);

    // This listing reads memberships directly rather than going through
    // AuthorizationService, so tenant confinement has to be repeated here,
    // otherwise an org-scoped session could still enumerate the account's
    // other organizations by name, even while unable to open them.
    const sessionOrgId = requestAuthStorage.getStore()?.sessionOrgId;

    const memberOf = { members: { some: { userId: user.id, status: 'active' as const } } };
    let orgFilter: Record<string, unknown> | undefined = memberOf;
    if (sessionOrgId) orgFilter = { id: sessionOrgId, ...memberOf };
    else if (isSuperAdmin) orgFilter = undefined;

    const orgs = await this.prisma.organization.findMany({
      where: orgFilter,
      include: {
        _count: {
          select: {
            projects: true,
            members: true
          }
        }
      },
      orderBy: {
        createdAt: 'asc'
      }
    });

    const memberships = await this.prisma.organizationMember.findMany({
      where: { userId: user.id },
      select: { organizationId: true, role: true }
    });
    const roleByOrg = new Map(memberships.map((m) => [m.organizationId, m.role]));
    const ssoBlocked = new Set(await this.authz.ssoBlockedOrgIds(user.id));

    return orgs.map((o) =>
      ssoBlocked.has(o.id)
        ? {
            id: o.id,
            name: o.name,
            slug: o.slug,
            myRole: roleByOrg.get(o.id) ?? null,
            ssoRequired: true
          }
        : {
            ...this.scrubOrgSecrets(o as any),
            myRole: isSuperAdmin ? 'owner' : (roleByOrg.get(o.id) ?? null)
          }
    );
  }

  // Backup credentials are write-only over the API. We never return the access key
  // or the secret access key in plaintext, only a "configured" flag and the last
  // 4 chars of the access key so an operator can recognize which credential is set.
  private scrubOrgSecrets<
    T extends { backupR2SecretKey?: string | null; backupR2AccessKey?: string | null }
  >(org: T | null): T | null {
    if (!org) return org;
    const accessKey = org.backupR2AccessKey ?? null;
    const hasSecret = Boolean(org.backupR2SecretKey);
    const hasAccessKey = Boolean(accessKey);
    const clone: any = {
      ...org,
      backupR2SecretKey: null,
      backupR2SecretKeyConfigured: hasSecret,
      backupR2AccessKey: null,
      backupR2AccessKeyConfigured: hasAccessKey,
      backupR2AccessKeyLast4: accessKey && accessKey.length >= 4 ? accessKey.slice(-4) : null
    };
    return clone;
  }

  private async probeBackupStorage(target: {
    endpoint: string;
    bucket: string;
    region: string | null;
    accessKey: string;
    secretKey: string;
  }): Promise<void> {
    let guard = {};
    if (process.env.BACKUP_ALLOW_INTERNAL_ENDPOINT !== 'true') {
      try {
        guard = await guardedS3Options(target.endpoint, 'backupR2Endpoint');
      } catch (error) {
        throw new BadRequestException(
          `${(error as Error).message}. An operator can allow private endpoints with BACKUP_ALLOW_INTERNAL_ENDPOINT=true.`
        );
      }
    }
    const s3 = new S3Client({
      endpoint: target.endpoint,
      region: target.region || 'auto',
      credentials: { accessKeyId: target.accessKey, secretAccessKey: target.secretKey },
      forcePathStyle: true,
      ...guard
    });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 10_000);
    try {
      await s3.send(new ListObjectsV2Command({ Bucket: target.bucket, MaxKeys: 1 }), {
        abortSignal: abort.signal
      });
    } catch (e: any) {
      const reason = e?.name === 'AbortError' ? 'timed out after 10s' : e?.message || String(e);
      throw new BadRequestException(
        `Backup storage check failed against ${target.endpoint} bucket ${target.bucket}: ${reason}`
      );
    } finally {
      clearTimeout(timer);
      s3.destroy();
    }
  }

  async getBackupSettings(organizationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    await this.checkPermission(organizationId, user.id, 'admin');
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        backupR2Endpoint: true,
        backupR2Bucket: true,
        backupR2Region: true,
        backupR2AccessKey: true,
        backupR2SecretKey: true,
        databasePublicIp: true,
        postgresAutoUpdate: true
      }
    });
    if (!org) throw new NotFoundException('Organization not found');
    const accessKey = org.backupR2AccessKey;
    return {
      endpoint: org.backupR2Endpoint,
      bucket: org.backupR2Bucket,
      region: org.backupR2Region,
      // Write-only: never return the access key value. Surface a fingerprint instead.
      accessKeyConfigured: Boolean(accessKey),
      accessKeyLast4: accessKey && accessKey.length >= 4 ? accessKey.slice(-4) : null,
      secretKeyConfigured: Boolean(org.backupR2SecretKey),
      databasePublicIp: org.databasePublicIp,
      // What this organization falls back to when it sets nothing, so the
      // field can say what leaving it empty actually means.
      instanceDefaultPublicIp: this.instanceConfig.defaultPublicIp() || null,
      postgresAutoUpdate: org.postgresAutoUpdate,
      postgresAutoUpdateAllowed: this.instanceSettings
        ? await this.instanceSettings.isPostgresAutoUpdateEnabled()
        : true
    };
  }

  async getOrganization(organizationId: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const access = await this.authz.requireOrgMember(organizationId, userId);
    const visibleProjectIds = await this.authz.listVisibleProjectIds(organizationId, userId);
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false },
      include: {
        projects: {
          where: visibleProjectIds === null ? undefined : { id: { in: visibleProjectIds } },
          include: {
            _count: {
              select: {
                deployments: true,
                members: true
              }
            }
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                username: true,
                firstName: true,
                lastName: true,
                imageUrl: true,
                externalAuthId: true
              }
            }
          }
        }
      }
    });

    if (!organization) {
      throw new NotFoundException(`Organization ${organizationId} not found`);
    }

    // Guests only see members who share at least one project with them.
    if (access.role === 'guest') {
      const coMemberIds = new Set<string>();
      coMemberIds.add(userId); // always include self
      if (visibleProjectIds && visibleProjectIds.length > 0) {
        const coMembers = await this.prisma.projectMember.findMany({
          where: { projectId: { in: visibleProjectIds } },
          select: { userId: true },
          distinct: ['userId']
        });
        for (const cm of coMembers) coMemberIds.add(cm.userId);
      }
      (organization as any).members = organization.members.filter((m) =>
        coMemberIds.has(m.user.id)
      );
    }

    return this.scrubOrgSecrets(organization as any);
  }

  async getOrganizationMembers(organizationId: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const access = await this.authz.requireOrgMember(organizationId, userId);
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false }
    });

    if (!organization) {
      throw new NotFoundException(`Organization ${organizationId} not found`);
    }

    const members = await this.prisma.organizationMember.findMany({
      where: { organizationId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
            imageUrl: true,
            externalAuthId: true,
            homeOrganizationId: true,
            linkedAccount: { select: { createdAt: true } }
          }
        }
      },
      orderBy: { addedAt: 'asc' }
    });

    // Guests only see members who share at least one project with them.
    if (access.role === 'guest') {
      const visibleProjectIds = await this.authz.listVisibleProjectIds(organizationId, userId);
      const coMemberIds = new Set<string>();
      coMemberIds.add(userId);
      if (visibleProjectIds && visibleProjectIds.length > 0) {
        const coMembers = await this.prisma.projectMember.findMany({
          where: { projectId: { in: visibleProjectIds } },
          select: { userId: true },
          distinct: ['userId']
        });
        for (const cm of coMembers) coMemberIds.add(cm.userId);
      }
      return members.filter((m) => coMemberIds.has(m.user.id));
    }

    // Admins/owners get each member's project access inlined so the members
    // table can show and revoke it without N per-row round trips.
    if (access.role === 'owner' || access.role === 'admin') {
      // A project-restricted token only sees the projects it is scoped to.
      const visibleProjectIds = await this.authz.listVisibleProjectIds(organizationId, userId);
      const projectMembers = await this.prisma.projectMember.findMany({
        where: {
          project: {
            organizationId,
            ...(visibleProjectIds ? { id: { in: visibleProjectIds } } : {})
          }
        },
        select: {
          id: true,
          userId: true,
          project: { select: { id: true, name: true, slug: true } },
          role: { select: { name: true } }
        }
      });
      const byUser = new Map<string, Record<string, unknown>[]>();
      for (const pm of projectMembers) {
        const list = byUser.get(pm.userId) ?? [];
        list.push({
          projectMemberId: pm.id,
          id: pm.project.id,
          name: pm.project.name,
          slug: pm.project.slug,
          role: pm.role?.name ?? 'member'
        });
        byUser.set(pm.userId, list);
      }
      return members.map((m) => ({
        ...m,
        projects: (byUser.get(m.user.id) ?? []).sort((a, b) =>
          String(a.name).localeCompare(String(b.name))
        )
      }));
    }

    return members;
  }

  async getOrganizationBySlug(slug: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const orgRow = await this.prisma.organization.findUnique({
      where: { slug },
      select: { id: true }
    });
    if (!orgRow) {
      throw new NotFoundException('Organization not found');
    }
    let access;
    try {
      access = await this.authz.requireOrgMember(orgRow.id, userId);
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw new NotFoundException('Organization not found');
      }
      throw e;
    }
    const visibleProjectIds = await this.authz.listVisibleProjectIds(orgRow.id, userId);
    const organization = await this.prisma.organization.findUnique({
      where: { slug },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false },
      include: {
        projects: {
          where: visibleProjectIds === null ? undefined : { id: { in: visibleProjectIds } },
          include: {
            _count: {
              select: {
                deployments: true,
                members: true
              }
            }
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                username: true,
                firstName: true,
                lastName: true,
                imageUrl: true,
                externalAuthId: true
              }
            }
          }
        }
      }
    });

    if (!organization) {
      throw new NotFoundException(`Organization with slug ${slug} not found`);
    }

    // Guests only see members who share at least one project with them.
    if (access.role === 'guest') {
      const coMemberIds = new Set<string>();
      coMemberIds.add(userId);
      if (visibleProjectIds && visibleProjectIds.length > 0) {
        const coMembers = await this.prisma.projectMember.findMany({
          where: { projectId: { in: visibleProjectIds } },
          select: { userId: true },
          distinct: ['userId']
        });
        for (const cm of coMembers) coMemberIds.add(cm.userId);
      }
      (organization as any).members = organization.members.filter((m) =>
        coMemberIds.has(m.user.id)
      );
    }

    return this.scrubOrgSecrets(organization as any);
  }

  async getMembershipByUserId(organizationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // M-5: route through AuthorizationService.getOrgAccess so the synthetic
    // superadmin "owner" only materialises for orgs that actually exist (the
    // helper does a row-exists check). Otherwise a superadmin probing
    // /orgs/<random-uuid>/membership/me gets a 200 with a fabricated row,
    // which both leaks superadmin-ness to clients and runs with a bogus org
    // id through downstream calls.
    const access = await this.authz.getOrgAccess(organizationId, user.id);
    if (!access) {
      throw new NotFoundException('Organization not found');
    }

    if (access.source === 'membership') {
      const membership = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId, userId: user.id }
        }
      });
      if (membership) return membership;
      // Theoretically unreachable: access.source === 'membership' implies
      // the row exists, but treat the race as "not found" rather than
      // synthesising data.
      throw new NotFoundException('Organization not found');
    }

    // source === 'superadmin': synthesise an in-memory "owner" record so
    // the UI can present admin affordances. The id prefix makes the synthetic
    // origin obvious to any consumer that joins back on OrganizationMember.
    return {
      id: `superadmin:${user.id}`,
      organizationId,
      userId: user.id,
      role: 'owner' as const,
      addedAt: new Date(),
      addedBy: null
    };
  }

  async updateOrganization(
    organizationId: string,
    clerkId: string,
    data: {
      name?: string;
      description?: string;
      backupR2Endpoint?: string | null;
      backupR2Bucket?: string | null;
      backupR2Region?: string | null;
      backupR2AccessKey?: string | null;
      backupR2SecretKey?: string | null;
      databasePublicIp?: string | null;
      postgresAutoUpdate?: boolean;
    },
    userData?: any
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.checkPermission(organizationId, user.id, 'admin');

    const before = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        name: true,
        description: true,
        backupR2Endpoint: true,
        backupR2Bucket: true,
        backupR2Region: true,
        backupR2AccessKey: true,
        backupR2SecretKey: true,
        databasePublicIp: true,
        postgresAutoUpdate: true
      }
    });

    const updateData: any = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.backupR2Endpoint !== undefined)
      updateData.backupR2Endpoint = normalizeBackupEndpoint(data.backupR2Endpoint);
    if (updateData.backupR2Endpoint && process.env.BACKUP_ALLOW_INTERNAL_ENDPOINT !== 'true') {
      try {
        await assertPublicUrl(updateData.backupR2Endpoint, 'backupR2Endpoint');
      } catch (error) {
        throw new BadRequestException(
          `${(error as Error).message}. An operator can allow private endpoints with BACKUP_ALLOW_INTERNAL_ENDPOINT=true.`
        );
      }
    }
    if (data.backupR2Bucket !== undefined) updateData.backupR2Bucket = data.backupR2Bucket || null;
    if (data.backupR2Region !== undefined) updateData.backupR2Region = data.backupR2Region || null;
    if (data.backupR2AccessKey !== undefined)
      updateData.backupR2AccessKey = data.backupR2AccessKey || null;
    if (data.backupR2SecretKey !== undefined)
      updateData.backupR2SecretKey = this.crypto.seal(data.backupR2SecretKey || null);
    if (data.databasePublicIp !== undefined) {
      const raw =
        data.databasePublicIp === null ? null : String(data.databasePublicIp).trim() || null;
      const ip = raw === null ? null : canonicalIp(raw);
      if (raw !== null && ip === null) {
        throw new BadRequestException('databasePublicIp must be a valid IPv4 or IPv6 address');
      }
      if (ip && ip !== canonicalIp(before?.databasePublicIp)) {
        if (!this.publicIpPolicy) {
          throw new ServiceUnavailableException("Couldn't check who else uses this IP");
        }
        await this.publicIpPolicy.assertOrgMayUse(organizationId, ip);
      }
      updateData.databasePublicIp = ip;
    }
    if (data.postgresAutoUpdate !== undefined) {
      if (typeof data.postgresAutoUpdate !== 'boolean') {
        throw new BadRequestException('postgresAutoUpdate must be true or false');
      }
      updateData.postgresAutoUpdate = data.postgresAutoUpdate;
    }

    const backupFields = [
      'backupR2Endpoint',
      'backupR2Bucket',
      'backupR2Region',
      'backupR2AccessKey',
      'backupR2SecretKey'
    ];
    if (backupFields.some((field) => field in updateData)) {
      const pick = (field: string) =>
        field in updateData ? updateData[field] : (before as any)?.[field];
      const secretKey =
        'backupR2SecretKey' in updateData
          ? data.backupR2SecretKey || null
          : before?.backupR2SecretKey
            ? this.crypto.open(before.backupR2SecretKey)
            : null;
      const endpoint = pick('backupR2Endpoint');
      const bucket = pick('backupR2Bucket');
      const accessKey = pick('backupR2AccessKey');
      if (endpoint && bucket && accessKey && secretKey) {
        await this.probeBackupStorage({
          endpoint,
          bucket,
          region: pick('backupR2Region'),
          accessKey,
          secretKey
        });
      }
    }

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false },
      data: updateData,
      include: {
        projects: {
          include: {
            _count: {
              select: {
                deployments: true,
                members: true
              }
            }
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                username: true,
                firstName: true,
                lastName: true,
                imageUrl: true
              }
            }
          }
        }
      }
    });

    const changedFields = Object.keys(updateData);
    // Track which secret-bearing fields changed without leaking values.
    const secretFields = ['backupR2SecretKey', 'backupR2AccessKey'];
    const meta: Record<string, any> = {};
    if (before) {
      for (const f of changedFields) {
        if (secretFields.includes(f)) {
          meta[f] = ['***', '***'];
        } else {
          meta[f] = [(before as any)[f] ?? null, (updateData as any)[f] ?? null];
        }
      }
    }
    if (changedFields.length > 0) {
      void this.audit.log({
        action: 'org.updated',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId,
        targetType: 'organization',
        targetId: organizationId,
        targetLabel: updated.name,
        metadata: meta
      });
    }

    return this.scrubOrgSecrets(updated as any);
  }

  async uploadAvatar(
    organizationId: string,
    clerkId: string,
    file: Express.Multer.File,
    storageService: StorageService,
    userData?: any
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.checkPermission(organizationId, user.id, 'admin');

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId }
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const avatarUrl = await storageService.uploadImage(file, `organizations/${organizationId}`);

    if (organization.avatarUrl) {
      try {
        await storageService.deleteReplaced(
          organization.avatarUrl,
          `organizations/${organizationId}`,
          { model: 'organization', id: organizationId, column: 'avatarUrl' }
        );
      } catch (error) {
        console.error('Failed to delete old avatar:', error);
      }
    }

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false },
      data: { avatarUrl },
      include: {
        projects: {
          include: {
            _count: {
              select: {
                deployments: true,
                members: true
              }
            }
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                username: true,
                firstName: true,
                lastName: true,
                imageUrl: true
              }
            }
          }
        }
      }
    });
    return this.scrubOrgSecrets(updated as any);
  }

  async deleteAvatar(
    organizationId: string,
    clerkId: string,
    storageService: StorageService,
    userData?: any
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.checkPermission(organizationId, user.id, 'admin');

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId }
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    if (organization.avatarUrl) {
      try {
        await storageService.deleteReplaced(
          organization.avatarUrl,
          `organizations/${organizationId}`,
          { model: 'organization', id: organizationId, column: 'avatarUrl' }
        );
      } catch (error) {
        console.error('Failed to delete avatar:', error);
      }
    }

    const updated = await this.prisma.organization.update({
      where: { id: organizationId },
      omit: { backupR2AccessKey: false, backupR2SecretKey: false },
      data: { avatarUrl: null },
      include: {
        projects: {
          include: {
            _count: {
              select: {
                deployments: true,
                members: true
              }
            }
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                email: true,
                username: true,
                firstName: true,
                lastName: true,
                imageUrl: true
              }
            }
          }
        }
      }
    });
    return this.scrubOrgSecrets(updated as any);
  }

  async superadminJoinOrganization(
    organizationId: string,
    role: OrganizationRole,
    clerkId: string,
    userData?: any
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    if (!(await this.authz.isUnrestrictedSuperAdmin(user.id))) {
      throw new ForbiddenException('Only superadmins can join organizations directly');
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId }
    });
    if (!org) throw new NotFoundException('Organization not found');

    const existing = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } }
    });
    if (existing) {
      throw new BadRequestException('You are already a member of this organization');
    }

    const member = await this.prisma.organizationMember.create({
      data: {
        organizationId,
        userId: user.id,
        role,
        addedBy: user.id
      },
      include: {
        user: {
          select: { id: true, email: true, firstName: true, lastName: true, imageUrl: true }
        }
      }
    });

    this.membershipCache.invalidateInternalUserId(user.id);

    return member;
  }

  async inviteMemberToOrganization(
    organizationId: string,
    email: string,
    role: OrganizationRole,
    invitedByClerkId: string,
    userData?: any
  ) {
    const inviter = await this.usersService.findOrCreateByClerkId(invitedByClerkId, userData);

    if (!inviter) {
      throw new NotFoundException('Inviter not found');
    }

    if (role === 'guest') {
      throw new BadRequestException(
        "You can't invite guests directly to an organization. Invite them to a project instead."
      );
    }

    const inviterAccess = await this.authz.requireOrgAdmin(organizationId, inviter.id);

    // Only owners can invite with the 'owner' role: admins cannot escalate.
    if (role === 'owner' && inviterAccess.role !== 'owner') {
      throw new ForbiddenException('Only organization owners can invite new owners');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId }
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const normalizedEmail = email.toLowerCase().trim();
    await this.rateLimit.checkInviteMail({
      email: normalizedEmail,
      organizationId,
      userId: inviter.id,
      organizationCreatedAt: (organization as { createdAt?: Date }).createdAt
    });

    const existingUser = await this.prisma.user.findUnique({
      where: accountEmail(normalizedEmail)
    });

    if (existingUser) {
      const existingMember = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId,
            userId: existingUser.id
          }
        }
      });

      if (existingMember) {
        throw new BadRequestException('User is already a member of this organization');
      }
    }

    // Always go through the invitation flow, even when the user already exists.
    // Direct-add bypasses the recipient's consent, which is the moral equivalent
    // of accepting on behalf of another user.
    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invitation = await this.prisma.$transaction(async (tx) => {
      await tx.organizationInvitation.deleteMany({
        where: { organizationId, email: normalizedEmail }
      });
      return tx.organizationInvitation.create({
        data: {
          organizationId,
          email: normalizedEmail,
          role,
          // H-2: never persist the plaintext token. The plaintext ships in
          // the invite email (`loginUrl`) and is only ever held in this
          // request's memory; the at-rest source of truth is `tokenHash`.
          token: null,
          tokenHash,
          invitedBy: inviter.id,
          expiresAt
        },
        include: {
          organization: true,
          inviter: {
            select: {
              id: true,
              email: true,
              username: true,
              firstName: true,
              lastName: true
            }
          }
        }
      });
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviterName =
      inviter.firstName && inviter.lastName
        ? `${inviter.firstName} ${inviter.lastName}`
        : inviter.username || inviter.email || 'Someone';

    const configured = this.inviteDelivery() === 'email';
    const mailed =
      configured &&
      (await this.inviteMailed(
        this.emailService.sendOrganizationInviteEmail({
          recipientEmail: normalizedEmail,
          recipientName: normalizedEmail.split('@')[0],
          organizationName: organization.name,
          inviterName,
          role,
          loginUrl: frontendUrl
        }),
        'organization invite email'
      ));

    void this.audit.log({
      action: 'org.member.invited',
      actorUserId: inviter.id,
      actorEmail: inviter.email,
      organizationId,
      targetType: 'invitation',
      targetId: invitation.id,
      targetLabel: normalizedEmail,
      metadata: { email: normalizedEmail, role }
    });

    const { tokenHash: _hash, ...visible } = invitation;
    const delivery = mailed ? 'email' : 'link';
    return {
      ...visible,
      delivery,
      ...(configured && !mailed ? { emailFailed: true } : {}),
      ...(delivery === 'link' ? { inviteLink: this.inviteLink(token) } : {})
    };
  }

  /**
   * Invitation issued from a project's members page for an email with no
   * existing account. On accept the user joins the org as a guest AND becomes
   * a member of the target project. Authorization (project admin) is the
   * caller's responsibility: this is invoked by ProjectsService, which has
   * already run assertProjectAdmin.
   */
  async createProjectGuestInvitation(params: {
    organizationId: string;
    projectId: string;
    projectName: string;
    projectRoleId: string;
    projectRoleName: string;
    email: string;
    inviter: {
      id: string;
      email: string;
      username?: string | null;
      firstName?: string | null;
      lastName?: string | null;
    };
  }) {
    const {
      organizationId,
      projectId,
      projectName,
      projectRoleId,
      projectRoleName,
      email,
      inviter
    } = params;
    const normalizedEmail = email.toLowerCase().trim();

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, createdAt: true }
    });
    if (!organization) throw new NotFoundException('Organization not found');

    await this.rateLimit.checkInviteMail({
      email: normalizedEmail,
      organizationId,
      userId: inviter.id,
      organizationCreatedAt: (organization as { createdAt?: Date }).createdAt
    });

    // One pending invitation per org+email (DB unique). Re-inviting to the
    // same project refreshes the token/expiry; a pending invite for a
    // different target must be resolved first so we don't silently clobber it.
    const existing = await this.prisma.organizationInvitation.findUnique({
      where: { organizationId_email: { organizationId, email: normalizedEmail } }
    });
    if (existing && existing.projectId !== projectId) {
      throw new BadRequestException(
        'An invitation for this email is already pending in this organization'
      );
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invitation = await this.prisma.$transaction(async (tx) => {
      await tx.organizationInvitation.deleteMany({
        where: { organizationId, email: normalizedEmail }
      });
      return tx.organizationInvitation.create({
        data: {
          organizationId,
          email: normalizedEmail,
          role: 'guest',
          token: null,
          tokenHash,
          invitedBy: inviter.id,
          expiresAt,
          projectId,
          projectRoleId
        }
      });
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviterName =
      inviter.firstName && inviter.lastName
        ? `${inviter.firstName} ${inviter.lastName}`
        : inviter.username || inviter.email || 'Someone';

    const configured = this.inviteDelivery() === 'email';
    const mailed =
      configured &&
      (await this.inviteMailed(
        this.emailService.sendProjectInviteEmail({
          recipientEmail: normalizedEmail,
          recipientName: normalizedEmail.split('@')[0],
          organizationName: mailLabel(organization.name),
          projectName: mailLabel(projectName),
          inviterName: mailLabel(inviterName),
          role: projectRoleName,
          loginUrl: frontendUrl
        }),
        'project invite email'
      ));

    void this.audit.log({
      action: 'project.member.invited',
      actorUserId: inviter.id,
      actorEmail: inviter.email,
      organizationId,
      projectId,
      targetType: 'invitation',
      targetId: invitation.id,
      targetLabel: normalizedEmail,
      metadata: { email: normalizedEmail, role: projectRoleName }
    });

    const delivery = mailed ? 'email' : 'link';
    const orgAccess = await this.authz.getOrgAccess(organizationId, inviter.id);
    return {
      id: invitation.id,
      email: invitation.email,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      delivery,
      ...(configured && !mailed ? { emailFailed: true } : {}),
      ...(delivery === 'link' && orgAccess?.isAdmin ? { inviteLink: this.inviteLink(token) } : {})
    };
  }

  async acceptInvitationByToken(token: string, clerkId: string, userData?: any) {
    // M-3: hash lookup only. A fallback that queries by raw `token` would turn a
    // DB-read foothold (backup leak, replica access) into working invitation
    // links.
    const tokenHash = this.hashToken(token);
    return this.acceptInvitationByLookup({ tokenHash }, clerkId, userData, 'invitation');
  }

  /**
   * In-app accept variant. The user is already authenticated; the listing
   * endpoint returns invitation IDs instead of plaintext tokens (the token
   * column is hashed at rest and nulled on existing rows), so this is the
   * only way for the in-app "Accept" button to consume an invite without
   * the email link. All security checks are identical to the token path
   * (email-match + emailVerified + already-member + expiry) and collapse to
   * the same 404 shape on any reject branch.
   */
  async acceptInvitationById(invitationId: string, clerkId: string, userData?: any) {
    return this.acceptInvitationByLookup(
      { id: invitationId },
      clerkId,
      userData,
      'invitation_in_app'
    );
  }

  private async acceptInvitationByLookup(
    where: { tokenHash: string } | { id: string },
    clerkId: string,
    userData: any,
    via: 'invitation' | 'invitation_in_app'
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    // M-9: every "no" branch collapses to the SAME 404. Distinct responses
    // (NotFound for missing, Forbidden for wrong-email, BadRequest for
    // expired or already-member) would let a holder of a stolen token probe
    // whether it ever existed, who it was addressed to, and whether it had
    // been redeemed.
    const notFound = () => new NotFoundException('Invitation not found or expired.');

    if (!user) {
      throw notFound();
    }

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: where as any,
      include: { organization: true }
    });

    if (!invitation) {
      throw notFound();
    }

    if (invitation.expiresAt < new Date()) {
      await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });
      throw notFound();
    }

    // H-6: only a user who has proven ownership of the invited address may
    // accept. Without this, an attacker can register an unverified account
    // under the victim's email and inherit any pending invitations.
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw notFound();
    }
    // L-1: collapse to the same 404 shape: distinguishing "wrong user"
    // from "not verified" lets a freshly-registered unverified account
    // under the victim's email probe whether an invitation exists.
    const linkIsProof = via === 'invitation' && this.inviteDelivery() === 'link';
    if (!user.emailVerified && !linkIsProof) {
      throw notFound();
    }

    const existingMember = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId,
          userId: user.id
        }
      }
    });

    if (existingMember) {
      // Project-targeted invite where the user joined the org through some
      // other path in the meantime: still honor the project membership grant
      // (never touching their existing, possibly higher, org role).
      if (invitation.projectId && invitation.projectRoleId) {
        const granted = await this.prisma.$transaction(async (tx) => {
          const alreadyInProject = await tx.projectMember.findUnique({
            where: { projectId_userId: { projectId: invitation.projectId!, userId: user.id } }
          });
          if (!alreadyInProject) {
            await tx.projectMember.create({
              data: {
                projectId: invitation.projectId!,
                userId: user.id,
                roleId: invitation.projectRoleId!,
                addedBy: invitation.invitedBy
              }
            });
          }
          await tx.organizationInvitation.delete({ where: { id: invitation.id } });
          return !alreadyInProject;
        });
        if (granted) {
          void this.audit.log({
            action: 'project.member.added',
            actorUserId: user.id,
            actorEmail: user.email,
            organizationId: invitation.organizationId,
            projectId: invitation.projectId,
            targetType: 'user',
            targetId: user.id,
            targetLabel: user.email,
            metadata: { via }
          });
        }
        return existingMember;
      }
      // M-9: preserve the same 404 shape as every other reject branch.
      await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });
      throw notFound();
    }

    const member = await this.prisma.$transaction(async (tx) => {
      const newMember = await tx.organizationMember.create({
        data: {
          organizationId: invitation.organizationId,
          userId: user.id,
          role: invitation.role,
          addedBy: invitation.invitedBy
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              firstName: true,
              lastName: true,
              imageUrl: true
            }
          },
          organization: true
        }
      });

      // Project-targeted guest invite: also grant the project membership the
      // invite was issued for.
      if (invitation.projectId && invitation.projectRoleId) {
        await tx.projectMember.create({
          data: {
            projectId: invitation.projectId,
            userId: user.id,
            roleId: invitation.projectRoleId,
            addedBy: invitation.invitedBy
          }
        });
      }

      await tx.organizationInvitation.delete({ where: { id: invitation.id } });

      return newMember;
    });

    this.membershipCache.invalidateInternalUserId(user.id);

    void this.audit.log({
      action: 'org.member.joined',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: invitation.organizationId,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { role: invitation.role, via }
    });

    return member;
  }

  // M-4: this is a LIST-only operation. Accepting every pending invitation for
  // the signed-in user's email in one shot would be a bulk-accept primitive: a
  // single CSRF/cross-tab/foothold action could land the victim in arbitrary
  // organizations they never consented to join, with whatever role the
  // inviter chose. The client is expected to call `acceptInvitationByToken`
  // once per invitation, which enforces the per-token email + emailVerified
  // checks individually.
  async acceptPendingInvitationsForUser(clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      return { invitations: [] };
    }

    // H-6: do not even reveal pending invitations to an unverified account.
    // An attacker who registered under the victim's email should not learn
    // which orgs they were invited to.
    if (!user.emailVerified) {
      return { invitations: [] };
    }

    const pending = await this.prisma.organizationInvitation.findMany({
      where: {
        email: user.email.toLowerCase(),
        expiresAt: { gt: new Date() }
      },
      include: {
        organization: { select: { name: true, slug: true, avatarUrl: true } },
        project: { select: { name: true, slug: true } },
        inviter: {
          select: {
            firstName: true,
            lastName: true,
            username: true,
            email: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // H-2: never return the plaintext token in API responses. The hash is
    // the source of truth and the plaintext is nulled at rest; in-app
    // acceptance happens via `acceptInvitationById` using the row id, which
    // re-runs every per-token check under the caller's session.
    return {
      invitations: pending.map((inv) => ({
        id: inv.id,
        orgName: inv.organization.name,
        orgSlug: inv.organization.slug,
        orgAvatarUrl: inv.organization.avatarUrl,
        role: inv.role,
        project: inv.project,
        inviter: inv.inviter,
        expiresAt: inv.expiresAt
      }))
    };
  }

  async getInvitationByToken(token: string) {
    // M-3: hash lookup only, see acceptInvitationByToken for why there is no
    // plaintext-column fallback.
    const tokenHash = this.hashToken(token);
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { tokenHash },
      include: {
        organization: {
          select: {
            name: true,
            slug: true,
            avatarUrl: true
          }
        }
      }
    });

    if (!invitation || invitation.expiresAt < new Date()) {
      throw new NotFoundException('Invitation not found');
    }

    // Minimal payload for the unauthenticated landing page. Inviter identity
    // and invited email are revealed only on the authenticated accept path,
    // so that a leaked link could not dox both the inviter and the invited
    // user.
    const base = {
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      organization: invitation.organization
    };
    if (this.inviteDelivery() === 'email') return base;
    return {
      ...base,
      email: invitation.email,
      next: await this.nextStepForLink(invitation.email)
    };
  }

  private async nextStepForLink(email: string): Promise<'sign_up' | 'sign_in' | 'sso' | 'closed'> {
    try {
      await this.authz.assertSsoNotEnforcedForEmail(email, 'password');
    } catch (err) {
      if (err instanceof ForbiddenException) return 'sso';
      throw err;
    }
    const account = await this.prisma.user.findUnique({
      where: accountEmail(email.toLowerCase()),
      select: { id: true }
    });
    if (account) return 'sign_in';
    return signupMode() === 'closed' ? 'closed' : 'sign_up';
  }

  async signUpWithInvitation(token: string, password: string | null) {
    const notFound = () => new NotFoundException('Invitation not found or expired.');
    if (this.inviteDelivery() === 'email') throw notFound();

    const tokenHash = this.hashToken(token);
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { tokenHash },
      include: { organization: { select: { id: true, name: true, slug: true } } }
    });
    if (!invitation || invitation.expiresAt < new Date()) throw notFound();

    const email = invitation.email.toLowerCase();
    const next = await this.nextStepForLink(email);
    if (next === 'sso') await this.authz.assertSsoNotEnforcedForEmail(email, 'password');
    if (next === 'closed') throw new ForbiddenException(signupDeniedError());
    if (next === 'sign_in') {
      throw new ConflictException('This email already has an account. Sign in to accept.');
    }

    let passwordHash: string | null = null;
    if (password !== null) {
      try {
        passwordHash = await hashAccountPassword(password);
      } catch (err) {
        if (err instanceof PasswordRefused) throw new BadRequestException(err.message);
        throw err;
      }
    }

    const base = sanitizeUsername(email.split('@')[0]);
    let username = base;
    let counter = 1;
    while (await this.prisma.user.findUnique({ where: { username } })) {
      username = `${base}${counter}`;
      counter += 1;
    }

    const user = await this.prisma
      .$transaction(async (tx) => {
        const spent = await tx.organizationInvitation.deleteMany({
          where: { id: invitation.id, tokenHash }
        });
        if (spent.count !== 1) throw notFound();
        const created = await tx.user.create({ data: { email, username, passwordHash } });
        await tx.organizationMember.create({
          data: {
            organizationId: invitation.organizationId,
            userId: created.id,
            role: invitation.role,
            addedBy: invitation.invitedBy
          }
        });
        if (invitation.projectId && invitation.projectRoleId) {
          await tx.projectMember.create({
            data: {
              projectId: invitation.projectId,
              userId: created.id,
              roleId: invitation.projectRoleId,
              addedBy: invitation.invitedBy
            }
          });
        }
        return created;
      })
      .catch((err) => {
        if (err?.code === 'P2002') {
          throw new ConflictException('This email already has an account. Sign in to accept.');
        }
        throw err;
      });

    void this.audit.log({
      action: 'user.signed_up',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: invitation.organizationId,
      targetType: 'user',
      targetId: user.id,
      metadata: { signup_method: 'invitation_link' }
    });
    void this.audit.log({
      action: 'org.member.joined',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: invitation.organizationId,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { role: invitation.role, via: 'invitation_link' }
    });

    return { user, organization: invitation.organization };
  }

  async getPendingInvitationsForUser(clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user || !user.emailVerified) {
      return [];
    }

    // H-2: explicit field selection, never return `token` / `tokenHash` to
    // the client. The in-app accept flow uses the row `id` via
    // acceptInvitationById, which re-runs every per-token security check
    // under the caller's session.
    const rows = await this.prisma.organizationInvitation.findMany({
      where: {
        email: user.email.toLowerCase(),
        expiresAt: { gt: new Date() }
      },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            avatarUrl: true
          }
        },
        project: {
          select: {
            id: true,
            name: true,
            slug: true
          }
        },
        inviter: {
          select: {
            firstName: true,
            lastName: true,
            username: true,
            email: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    return rows;
  }

  async declineInvitationByToken(token: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    // M-9: collapse every reject branch to one 404 shape: see
    // acceptInvitationByToken for the rationale.
    const notFound = () => new NotFoundException('Invitation not found or expired.');

    if (!user) {
      throw notFound();
    }

    const tokenHash = this.hashToken(token);
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { tokenHash }
    });

    if (!invitation) {
      throw notFound();
    }

    // L-1: parity with acceptInvitationByToken: require a verified email and
    // collapse mismatch / unverified branches to the same 404 shape so a freshly
    // registered unverified account can't probe pending invitation addresses.
    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw notFound();
    }
    if (!user.emailVerified && this.inviteDelivery() === 'email') {
      throw notFound();
    }
    if (invitation.expiresAt < new Date()) {
      await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });
      throw notFound();
    }

    await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });

    return { success: true, message: 'Invitation declined' };
  }

  async declineInvitationById(invitationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    const notFound = () => new NotFoundException('Invitation not found or expired.');

    if (!user) {
      throw notFound();
    }

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId }
    });

    if (!invitation) {
      throw notFound();
    }

    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw notFound();
    }
    if (!user.emailVerified) {
      throw notFound();
    }
    if (invitation.expiresAt < new Date()) {
      await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });
      throw notFound();
    }

    await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });

    return { success: true, message: 'Invitation declined' };
  }

  async getOrganizationInvitations(organizationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.checkPermission(organizationId, user.id, 'admin');

    const rows = await this.prisma.organizationInvitation.findMany({
      where: {
        organizationId,
        expiresAt: { gt: new Date() }
      },
      include: {
        inviter: {
          select: {
            firstName: true,
            lastName: true,
            username: true,
            email: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    const delivery = this.inviteDelivery();
    return rows.map(({ tokenHash: _hash, ...row }) => ({ ...row, delivery }));
  }

  async cancelInvitation(invitationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId }
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    try {
      await this.checkPermission(invitation.organizationId, user.id, 'admin');
    } catch {
      throw new NotFoundException('Invitation not found');
    }

    await this.prisma.organizationInvitation.delete({ where: { id: invitationId } });

    void this.audit.log({
      action: 'org.invitation.cancelled',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: invitation.organizationId,
      targetType: 'invitation',
      targetId: invitationId,
      targetLabel: invitation.email
    });

    return { success: true, message: 'Invitation cancelled' };
  }

  async resendInvitation(invitationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId },
      include: {
        organization: true,
        inviter: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true
          }
        }
      }
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    try {
      await this.checkPermission(invitation.organizationId, user.id, 'admin');
    } catch {
      throw new NotFoundException('Invitation not found');
    }

    // M-4: collapse expired-state to 404 for parity with other invitation
    // branches and so the response shape is uniform. Drop the stale row to
    // close the resend-after-expiry path.
    if (invitation.expiresAt < new Date()) {
      await this.prisma.organizationInvitation.delete({ where: { id: invitation.id } });
      throw new NotFoundException('Invitation not found');
    }

    if (this.inviteDelivery() === 'link') {
      return this.reissueInvitationLink(invitation, user);
    }

    await this.rateLimit.checkInviteMail({
      email: invitation.email,
      organizationId: invitation.organizationId,
      userId: user.id,
      organizationCreatedAt: invitation.organization.createdAt
    });

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviterName =
      invitation.inviter.firstName && invitation.inviter.lastName
        ? `${invitation.inviter.firstName} ${invitation.inviter.lastName}`
        : invitation.inviter.username || invitation.inviter.email || 'Someone';

    const mailed = await this.inviteMailed(
      this.emailService.sendOrganizationInviteEmail({
        recipientEmail: invitation.email,
        recipientName: invitation.email.split('@')[0],
        organizationName: invitation.organization.name,
        inviterName,
        role: invitation.role,
        loginUrl: frontendUrl
      }),
      'organization invite email'
    );
    if (!mailed) {
      return { ...(await this.reissueInvitationLink(invitation, user)), emailFailed: true };
    }

    return { success: true, message: 'Invitation resent', delivery: 'email' as const };
  }

  private async reissueInvitationLink(
    invitation: { id: string; organizationId: string; email: string; role: OrganizationRole },
    actor: { id: string; email: string }
  ) {
    if (invitation.role === 'owner') {
      await this.checkPermission(invitation.organizationId, actor.id, 'owner');
    }
    await this.rateLimit.checkRateLimit(invitation.organizationId, 'org', 'invite');

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    await this.prisma.organizationInvitation.update({
      where: { id: invitation.id },
      data: { tokenHash: this.hashToken(token), expiresAt }
    });

    void this.audit.log({
      action: 'org.invitation.link_issued',
      actorUserId: actor.id,
      actorEmail: actor.email,
      organizationId: invitation.organizationId,
      targetType: 'invitation',
      targetId: invitation.id,
      targetLabel: invitation.email
    });

    return {
      success: true,
      message: 'New invitation link created',
      delivery: 'link' as const,
      inviteLink: this.inviteLink(token),
      expiresAt
    };
  }

  async removeMemberFromOrganization(
    organizationId: string,
    memberId: string,
    removedBy: string,
    userData?: any
  ) {
    const remover = await this.usersService.findOrCreateByClerkId(removedBy, userData);

    if (!remover) {
      throw new NotFoundException('User removing member not found');
    }

    const removerAccess = await this.authz.requireOrgAdmin(organizationId, remover.id);

    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { user: true }
    });

    if (!member || member.organizationId !== organizationId) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (member.role === 'owner') {
      throw new BadRequestException("You can't remove the organization owner");
    }

    // Admins are senior to plain members; only owners can remove them. Without
    // this, any admin can boot peer admins (or the entire admin tier) and the
    // sole remaining owner is the only check on org control.
    if (member.role === 'admin' && removerAccess.role !== 'owner') {
      throw new ForbiddenException('Only the organization owner can remove an admin');
    }

    if (member.status === 'disabled') {
      return { success: true, message: "This member's access is already turned off" };
    }
    await this.disableMember(member, organizationId, 'Turned off by an admin');

    void this.audit.log({
      action: 'org.member.disabled',
      actorUserId: remover.id,
      actorEmail: remover.email,
      organizationId,
      targetType: 'user',
      targetId: member.userId,
      targetLabel: member.user.email,
      metadata: { role: member.role }
    });

    return { success: true, message: 'Access turned off' };
  }

  async disableMember(
    member: { id: string; userId: string; user?: { homeOrganizationId?: string | null } | null },
    organizationId: string,
    reason: string
  ): Promise<void> {
    await this.prisma.organizationMember.update({
      where: { id: member.id },
      data: { status: 'disabled', disabledAt: new Date(), disabledReason: reason.slice(0, 255) }
    });
    await this.revokeMemberAccess(member, organizationId);
    await this.prisma.sessionOrgGrant.deleteMany({
      where: { organizationId, session: { userId: member.userId } }
    });
    await this.prisma.apiToken.deleteMany({
      where: { userId: member.userId, scopeOrganizationId: organizationId }
    });
    if (member.user?.homeOrganizationId === organizationId) {
      await this.prisma.session.updateMany({
        where: { userId: member.userId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
    }
  }

  async unlinkMemberAccount(
    organizationId: string,
    memberId: string,
    actorClerkId: string,
    userData?: any
  ) {
    const actor = await this.usersService.findOrCreateByClerkId(actorClerkId, userData);
    if (!actor) throw new NotFoundException('User not found');
    await this.authz.requireOrgAdmin(organizationId, actor.id);
    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { user: { select: { id: true, email: true, homeOrganizationId: true } } }
    });
    if (
      !member ||
      member.organizationId !== organizationId ||
      member.user.homeOrganizationId !== organizationId
    ) {
      throw new NotFoundException('Member not found in this organization');
    }
    const { count } = await this.prisma.accountLink.deleteMany({
      where: { identityUserId: member.userId, organizationId }
    });
    if (count) {
      void this.audit.log({
        action: 'account.link.removed',
        actorUserId: actor.id,
        actorEmail: actor.email,
        organizationId,
        targetType: 'user',
        targetId: member.userId,
        targetLabel: member.user.email,
        metadata: { by: 'organization' }
      });
    }
    return { success: true };
  }

  async enableMember(organizationId: string, memberId: string, enabledBy: string, userData?: any) {
    const actor = await this.usersService.findOrCreateByClerkId(enabledBy, userData);
    if (!actor) throw new NotFoundException('User not found');
    const access = await this.authz.requireOrgAdmin(organizationId, actor.id);
    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId },
      include: { user: true }
    });
    if (!member || member.organizationId !== organizationId) {
      throw new NotFoundException('Member not found in this organization');
    }
    if (member.role === 'admin' && access.role !== 'owner') {
      throw new ForbiddenException('Only the organization owner can turn an admin back on');
    }
    if (member.status === 'active') return { success: true };
    if (member.user.disabledAt) {
      throw new BadRequestException('This account is turned off for the whole instance');
    }
    await this.prisma.organizationMember.update({
      where: { id: member.id },
      data: { status: 'active', disabledAt: null, disabledReason: null }
    });
    this.membershipCache.invalidateInternalUserId(member.userId);
    void this.audit.log({
      action: 'org.member.enabled',
      actorUserId: actor.id,
      actorEmail: actor.email,
      organizationId,
      targetType: 'user',
      targetId: member.userId,
      targetLabel: member.user.email,
      metadata: { role: member.role }
    });
    return { success: true };
  }

  async leaveOrganization(organizationId: string, clerkId: string, userData?: any) {
    const ctx = requestAuthStorage.getStore();
    if (!ctx?.browserSession) {
      throw new ForbiddenException('Leave an organization from a signed-in browser');
    }
    if (ctx.sessionOrgId && ctx.sessionOrgId !== organizationId) {
      throw new NotFoundException('Organization not found');
    }
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: user.id } },
      include: { user: true }
    });
    if (!member) throw new NotFoundException('Organization not found');
    if (member.role === 'owner') {
      throw new BadRequestException('Transfer ownership before you leave this organization');
    }
    if (member.user?.homeOrganizationId === organizationId) {
      throw new ForbiddenException(
        'This profile belongs to the organization. Ask an admin to turn off your access.'
      );
    }
    if (member.scimManaged) {
      const domain = user.email.split('@')[1]?.toLowerCase() ?? '';
      const owned = await this.prisma.orgDomain.findFirst({
        where: { organizationId, domain, verifiedAt: { not: null } },
        select: { id: true }
      });
      if (owned) {
        throw new ForbiddenException(
          "This organization's identity provider manages your membership. Ask an owner to remove you."
        );
      }
    }

    await this.detachMember(member, organizationId);

    void this.audit.log({
      action: 'org.member.left',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { role: member.role }
    });

    return { success: true };
  }

  async detachMember(
    member: { id: string; userId: string },
    organizationId: string
  ): Promise<void> {
    const memberId = member.id;
    // Remove org membership AND all project memberships in this org atomically
    // to prevent stale ProjectMember rows from reactivating if the user is later
    // re-invited (e.g. as a guest, they'd inherit their old project admin roles).
    // No sole-project-admin guard here: org owners and admins resolve as
    // project admins on every project in the org (resolveProjectAccess ->
    // source: 'orgAdmin'), so a project is never left unmanageable. Blocking
    // the org removal instead would leave the member with org access and no way
    // out short of promoting a new admin in every project they held.
    await this.prisma.$transaction(async (tx) => {
      await tx.projectMember.deleteMany({
        where: { userId: member.userId, project: { organizationId } }
      });
      await tx.organizationMember.delete({ where: { id: memberId } });
    });
    await this.revokeMemberAccess(member, organizationId);
  }

  private async revokeMemberAccess(
    member: { id: string; userId: string },
    organizationId: string
  ): Promise<void> {
    await this.prisma.projectMember.deleteMany({
      where: {
        userId: member.userId,
        project: { organizationId }
      }
    });

    // Project-scoped API tokens that point at this org's projects must not
    // outlive the membership. Fetch the org's project IDs and drop any token
    // whose restriction list intersects them.
    const orgProjectIds = await this.prisma.project.findMany({
      where: { organizationId },
      select: { id: true }
    });
    if (orgProjectIds.length > 0) {
      await this.prisma.apiToken.deleteMany({
        where: {
          userId: member.userId,
          restrictedProjectIds: { hasSome: orgProjectIds.map((p) => p.id) }
        }
      });
    }

    this.membershipCache.revoked(organizationId, member.userId);
    // H4: revoke Tailscale exposure for deployments this user exposed in THIS org.
    // We do NOT delete their global TailscaleConnection (they may still belong to other orgs).
    // Best-effort: failures to remove the k8s sidecar must not block membership removal.
    try {
      const exposed = await this.prisma.deployment.findMany({
        where: {
          tailscaleExposedBy: member.userId,
          tailscaleExposed: true,
          project: { organizationId }
        },
        select: { id: true, name: true, namespace: true }
      });

      for (const dep of exposed) {
        try {
          await this.tailscale.cleanupDeployment({
            id: dep.id,
            name: dep.name,
            namespace: dep.namespace,
            tailscaleExposed: true
          });
        } catch (err: any) {
          this.logger.warn(
            `H4: failed to remove tailscale sidecar for deployment ${dep.name} in ${dep.namespace}: ${err?.message ?? err}`
          );
        }
      }

      if (exposed.length > 0) {
        await this.prisma.deployment.updateMany({
          where: {
            id: { in: exposed.map((d) => d.id) }
          },
          data: {
            tailscaleExposed: false,
            tailscaleHostname: null,
            tailscaleExposedBy: null
          }
        });
      }
    } catch (err: any) {
      this.logger.warn(
        `H4: tailscale cleanup on member removal failed (user=${member.userId} org=${organizationId}): ${err?.message ?? err}`
      );
    }

    // If user no longer belongs to any organization, reset their setup
    const remainingMemberships = await this.prisma.organizationMember.count({
      where: { userId: member.userId }
    });

    if (remainingMemberships === 0) {
      await this.prisma.user.update({
        where: { id: member.userId },
        data: { setupCompleted: false }
      });
    }
  }

  async updateMemberRole(
    organizationId: string,
    memberId: string,
    newRole: OrganizationRole,
    updatedBy: string,
    userData?: any
  ) {
    const updater = await this.usersService.findOrCreateByClerkId(updatedBy, userData);

    if (!updater) {
      throw new NotFoundException('User updating role not found');
    }

    await this.checkPermission(organizationId, updater.id, 'owner');

    const member = await this.prisma.organizationMember.findUnique({
      where: { id: memberId }
    });

    if (!member || member.organizationId !== organizationId) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (member.role === 'owner' && newRole !== 'owner') {
      throw new BadRequestException(
        "You can't change the owner's role. Transfer ownership instead."
      );
    }

    // H-1: explicit guard so the failure mode is obvious to operators.
    // The owner-demotion check above already covers this (an owner calling
    // updateMemberRole on themselves with newRole != owner hits it), but a
    // future refactor that loosens the role check above must keep this one.
    if (member.userId === updater.id && newRole !== member.role) {
      throw new BadRequestException(
        "You can't change your own organization role. Ask another owner to change it, or transfer ownership first."
      );
    }

    // Guests must have at least one project membership: prevent creating
    // orphaned guests that violate the lifecycle rule.
    if (newRole === 'guest') {
      const projectCount = await this.prisma.projectMember.count({
        where: { userId: member.userId, project: { organizationId } }
      });
      if (projectCount === 0) {
        throw new BadRequestException(
          "You can't make this user a guest because they aren't in a project in this organization. Add them to a project first, or remove them from the organization."
        );
      }
    }

    const updated = await this.prisma.organizationMember.update({
      where: { id: memberId },
      data: { role: newRole },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
            imageUrl: true
          }
        }
      }
    });

    // Invalidate AFTER the write commits. Pre-write invalidation races: a concurrent
    // request can read the OLD role from DB and repopulate the cache during the
    // update window, leaving the user with their previous role for up to the TTL.
    this.membershipCache.invalidateInternalUserId(member.userId);

    void this.audit.log({
      action: 'org.member.role_changed',
      actorUserId: updater.id,
      actorEmail: updater.email,
      organizationId,
      targetType: 'user',
      targetId: member.userId,
      targetLabel: updated.user.email,
      metadata: { role: [member.role, newRole] }
    });

    return updated;
  }
}
