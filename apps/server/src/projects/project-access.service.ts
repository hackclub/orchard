import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException
} from '@nestjs/common';
import { DeploymentGrantsService, type GrantRole } from './deployment-grants.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { AuthorizationService } from '../auth/authorization.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { requestAuthStorage } from '../auth/request-context';
import { isReservedHost, normalizeHost } from '../instance-network/reserved-hosts';
import { optionalDomain } from '../env/platform-domains';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import { platformWildcardDomains } from './projects.utils';
import { DomainBudget, isPlatformHost } from './domain-budget';
import {
  domainProofRecordName,
  domainProofToken,
  lookupDomainProof,
  parentDomains
} from './domain-proof';

export interface HostClaimReader {
  ingress: Pick<PrismaService['ingress'], 'findFirst'>;
  organization: Pick<PrismaService['organization'], 'findUnique'>;
  statusPage: Pick<PrismaService['statusPage'], 'findUnique'>;
}

/**
 * Centralized RBAC/access guards for projects, deployments, databases,
 * ingresses and service-ports. Extracted from ProjectsService so the guard
 * logic is testable and reusable without dragging the rest of the service in.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly authz: AuthorizationService,
    private readonly membershipCache: MembershipCacheService,
    private readonly instanceSettings: InstanceSettingsService,
    private readonly grants: DeploymentGrantsService
  ) {
    this.domainBudget = new DomainBudget(prisma);
  }

  protected domainBudget?: DomainBudget;

  /**
   * C-2: enforce global hostname uniqueness across projects.
   *
   * The schema's only unique constraint on Ingress is (namespace, name), which
   * is the K8s resource name, NOT the routed host. Without this check, org A
   * can register `app.example.com` in namespace `proj-a` and org B can register
   * the same host in `proj-b`; whichever IngressRoute the controller resolves
   * last wins, and traffic (including session cookies) can land in the wrong
   * tenant.
   *
   * Path-merging *within* the same project is allowed and handled separately
   * by the merge branch in createProjectIngress, so we scope this check to
   * "any other project."
   *
   * The 409 message is generic on purpose: revealing which org claimed the
   * host first is a low-grade enumeration oracle.
   */
  async assertHostnameAvailable(rawHost: string, projectId: string): Promise<void> {
    await this.assertHostnameUnclaimed(rawHost, projectId);
    const host = normalizeHost(rawHost);
    const budget = this.domainBudget;
    const organizationId =
      budget && !isPlatformHost(host) && !(await this.projectHoldsHost(host, projectId))
        ? (
            await this.prisma.project.findUnique({
              where: { id: projectId },
              select: { organizationId: true }
            })
          )?.organizationId
        : undefined;
    if (budget && organizationId) {
      await budget.assertProofNotPaused(organizationId);
      await budget.assertCapacity(organizationId);
    }
    const proof = await this.domainProofStatus(host, projectId);
    if (proof && !proof.found) {
      if (budget && organizationId) await budget.recordProofFailure(organizationId);
      throw new BadRequestException({
        error: 'domain_proof_required',
        message: `Prove you own ${host}: add a TXT record named ${proof.fullName} with the value ${proof.record.value}, then try again.`,
        records: [proof.record]
      });
    }
    if (budget && organizationId) {
      if (proof) await budget.clearProofFailures(organizationId);
      await budget.consumeCreate(organizationId);
    }
  }

  private async projectHoldsHost(host: string, projectId: string): Promise<boolean> {
    const held = await this.prisma.ingress.findFirst({
      where: { host: { equals: host, mode: 'insensitive' }, projectId },
      select: { id: true }
    });
    return !!held;
  }

  async assertHostnameUnclaimed(
    rawHost: string,
    projectId: string,
    db: HostClaimReader = this.prisma
  ): Promise<void> {
    const host = normalizeHost(rawHost);
    if (!host) {
      throw new BadRequestException('Hostname is required');
    }

    if (isReservedHost(host)) {
      throw new ConflictException(`Hostname ${rawHost} is unavailable. Choose a different domain.`);
    }

    const baseDomain = optionalDomain(process.env.BASE_DOMAIN);
    const subdomain =
      baseDomain && host.endsWith(`.${baseDomain}`)
        ? host.slice(0, -(baseDomain.length + 1))
        : null;
    const [conflict, vanity, statusPage] = await Promise.all([
      db.ingress.findFirst({
        where: { host: { equals: host, mode: 'insensitive' }, NOT: { projectId } },
        select: { id: true }
      }),
      subdomain ? db.organization.findUnique({ where: { subdomain }, select: { id: true } }) : null,
      subdomain ? db.statusPage.findUnique({ where: { subdomain }, select: { id: true } }) : null
    ]);
    if (conflict || vanity || statusPage) {
      throw new ConflictException(`Hostname ${rawHost} is unavailable. Choose a different domain.`);
    }
  }

  protected lookupProof = lookupDomainProof;

  async domainProofStatus(
    rawHost: string,
    projectId: string
  ): Promise<{
    found: boolean;
    fullName: string;
    record: { type: 'TXT'; name: string; value: string };
  } | null> {
    const host = rawHost.trim().toLowerCase().replace(/\.$/, '');
    if (!(await this.instanceSettings.isCustomDomainVerificationRequired())) return null;
    if (platformWildcardDomains().some((wildcard) => host.endsWith(wildcard.suffix))) return null;
    const [held, project] = await Promise.all([
      this.prisma.ingress.findFirst({
        where: { host: { equals: host, mode: 'insensitive' }, projectId },
        select: { id: true }
      }),
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { organizationId: true }
      })
    ]);
    if (held) return null;
    if (project) {
      const verified = await this.prisma.orgDomain.findFirst({
        where: {
          organizationId: project.organizationId,
          domain: { in: parentDomains(host) },
          verifiedAt: { not: null }
        },
        select: { id: true }
      });
      if (verified) return null;
    }
    const value = domainProofToken(projectId, host);
    const found = (await this.lookupProof(host)).includes(value);
    return {
      found,
      fullName: `_orchard-challenge.${host}`,
      record: { type: 'TXT', name: domainProofRecordName(host), value }
    };
  }

  /**
   * Build a Prisma `where` filter for Project queries that respects RBAC:
   * - Org owner/admin → all projects in the org
   * - Org member or guest → only projects where user is a ProjectMember
   *
   * Guests get the same scoping as members here: they're explicit-membership-only.
   * The difference between member and guest lives at write-side endpoints
   * (project creation, org settings); for reads, both see the same slice.
   */
  /** Sub → internal UUID for prisma conditions on user-id FK columns. */
  async resolveMemberUserId(sub: string): Promise<string | null> {
    return this.membershipCache.resolveUserId(sub);
  }

  async grantedDeployments(sub: string): Promise<Map<string, GrantRole>> {
    const userId = (await this.membershipCache.resolveUserId(sub)) ?? sub;
    return this.grants.grantedDeploymentIds(userId);
  }

  async buildProjectAccessFilter(userId: string, requestedOrgId?: string) {
    const sessionOrgId = requestAuthStorage.getStore()?.sessionOrgId;
    if (sessionOrgId && requestedOrgId && requestedOrgId !== sessionOrgId) return null;
    const orgId = requestedOrgId ?? sessionOrgId;

    // Superadmins bypass membership checks: they can see all projects.
    if (await this.authz.isUnrestrictedSuperAdmin(userId)) {
      return orgId ? { organizationId: orgId } : {};
    }

    const blocked = new Set(await this.authz.ssoBlockedOrgIds(userId));
    const all = (await this.membershipCache.getMemberships(userId)).filter(
      (m) => !blocked.has(m.organizationId)
    );
    const orgMemberships = orgId ? all.filter((m) => m.organizationId === orgId) : all;
    if (orgMemberships.length === 0) return null;

    // The sub may be a Hack Club id while projectMember.userId is a UUID FK,
    // comparing the raw sub silently matches nothing, which hid explicit-
    // membership projects from org members/guests logged in via SSO.
    const memberUserId = (await this.membershipCache.resolveUserId(userId)) ?? userId;

    const adminOrgIds = orgMemberships
      .filter((m) => m.role === 'owner' || m.role === 'admin')
      .map((m) => m.organizationId);
    const explicitOnlyOrgIds = orgMemberships
      .filter((m) => m.role === 'member' || m.role === 'guest')
      .map((m) => m.organizationId);

    const conditions: any[] = [];
    if (adminOrgIds.length > 0) {
      conditions.push({ organizationId: { in: adminOrgIds } });
    }
    if (explicitOnlyOrgIds.length > 0) {
      conditions.push({
        organizationId: { in: explicitOnlyOrgIds },
        members: { some: { userId: memberUserId } }
      });
    }
    if (conditions.length === 0) return null;
    const base = conditions.length === 1 ? conditions[0] : { OR: conditions };

    // If this request is authenticated via an API token with a non-empty
    // restrictedProjectIds list, every project read must also be inside
    // that allow-list. The membership-based filter alone would leak
    // project metadata for projects the underlying user can see but the
    // token explicitly excludes (see assertProjectView at
    // authorization.service.ts:284 for the single-project equivalent).
    const tokenCtx = requestAuthStorage.getStore();
    if (tokenCtx?.tokenProjectIds && tokenCtx.tokenProjectIds.length > 0) {
      return { AND: [base, { id: { in: tokenCtx.tokenProjectIds } }] };
    }
    return base;
  }

  /**
   * Resolve a deployment's owning project, then require the user can view it.
   * Used as a guard for every deployment-level read endpoint.
   */
  async assertDeploymentView(deploymentId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    const dep = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, projectId: true, project: { select: { organizationId: true } } }
    });
    if (!dep) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    const access = await this.authz.resolveProjectAccess(
      dep.projectId,
      dep.project.organizationId,
      user.id,
      dep.id
    );
    if (!access || !access.canView) {
      throw new NotFoundException(`Deployment ${deploymentId} not found`);
    }
    return { user, deployment: dep, access };
  }

  async assertProjectView(projectId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    const access = await this.authz.requireProjectView(projectId, user.id);
    return { user, access };
  }

  async assertProjectEditAccess(
    projectId: string,
    clerkId: string,
    userData?: any,
    action = 'perform this action'
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    const access = await this.authz.requireProjectEdit(projectId, user.id, action);
    return { user, access };
  }

  async assertOrgCanCreateProjects(organizationId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    const access = await this.authz.requireOrgCanCreateProjects(organizationId, user.id);
    return { user, access };
  }

  async assertDatabaseView(databaseId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    const db = await this.prisma.database.findUnique({
      where: { id: databaseId },
      select: { id: true, projectId: true, project: { select: { organizationId: true } } }
    });
    if (!db) throw new NotFoundException(`Database ${databaseId} not found`);
    const access = await this.authz.resolveProjectAccess(
      db.projectId,
      db.project.organizationId,
      user.id
    );
    if (!access || !access.canView) {
      throw new NotFoundException(`Database ${databaseId} not found`);
    }
    return { user, database: db, access };
  }

  async assertIngressView(ingressId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    const ing = await this.prisma.ingress.findUnique({
      where: { id: ingressId },
      select: { id: true, projectId: true, project: { select: { organizationId: true } } }
    });
    if (!ing) throw new NotFoundException(`Domain ${ingressId} not found`);
    const access = await this.authz.resolveProjectAccess(
      ing.projectId,
      ing.project.organizationId,
      user.id
    );
    if (!access || !access.canView) {
      throw new NotFoundException(`Domain ${ingressId} not found`);
    }
    return { user, ingress: ing, access };
  }

  async assertProjectAccess(projectId: string, userId: string, organizationId: string) {
    const access = await this.authz.resolveProjectAccess(projectId, organizationId, userId);
    if (!access || !access.canView) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    // Backwards-compatible shape for callers that still read these.
    const [projectMembership, orgMembership] = await Promise.all([
      this.prisma.projectMember.findFirst({
        where: { projectId, userId },
        include: { role: true }
      }),
      this.prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId } }
      })
    ]);
    return { orgMembership, projectMembership, access };
  }

  async assertProjectAdmin(projectId: string, userId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');
    await this.authz.requireProjectManageMembers(projectId, userId);
    return project;
  }

  async assertDatabaseEditor(databaseId: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: { project: { include: { organization: true } } }
    });
    if (!database) throw new NotFoundException('Database not found');

    await this.authz.requireProjectEdit(database.project.id, user.id, 'manage backups');

    return { user, database };
  }

  /**
   * View-level access guard that still returns the FULL database row (with project + org).
   * Use for read-only DB endpoints (settings, backup schedule, list backups, extensions list).
   * Returns `access` so callers can branch on `canEdit` for secret redaction.
   */
  async assertDatabaseEditorOrViewer(
    databaseId: string,
    clerkId: string,
    userData?: any,
    opts: { allowViewer?: boolean } = {}
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: { project: { include: { organization: true } } }
    });
    if (!database) throw new NotFoundException('Database not found');

    const access = await this.authz.resolveProjectAccess(
      database.project.id,
      database.project.organizationId,
      user.id
    );
    if (!access || !access.canView) {
      throw new NotFoundException(`Database ${databaseId} not found`);
    }
    if (!opts.allowViewer && !access.canEdit) {
      // Surface the same forbidden semantics requireProjectEdit would.
      await this.authz.requireProjectEdit(database.project.id, user.id, 'manage database');
    }
    return { user, database, access };
  }

  async assertServicePortEditor(
    deploymentId: string,
    serviceId: string,
    portId: string,
    clerkId: string,
    userData?: any
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const port = await this.prisma.servicePort.findFirst({
      where: {
        id: portId,
        serviceId,
        service: { deploymentId }
      },
      include: {
        service: {
          include: {
            deployment: {
              include: { project: { include: { organization: true } } }
            }
          }
        }
      }
    });
    if (!port || !port.service || !port.service.deployment) {
      throw new NotFoundException('Port not found');
    }

    const deployment = port.service.deployment;
    await this.authz.requireProjectEdit(deployment.project.id, user.id, 'update services');

    return { user, port, service: port.service, deployment };
  }
}
