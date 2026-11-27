import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrganizationRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service';
import {
  holdsSuperAdminPower,
  requestAuthStorage,
  type RequestAuthContext
} from './request-context';

export type ProjectRoleName = 'admin' | 'member' | 'viewer';

export type AuthMethod = 'sso' | 'instance_sso' | 'oauth' | 'otp' | 'passkey' | 'password';

export const INSTANCE_SSO_BLOCKED: ReadonlySet<AuthMethod> = new Set<AuthMethod>([
  'otp',
  'passkey',
  'password'
]);

export const INSTANCE_SSO_REQUIRED_MESSAGE =
  'This Orchard instance requires single sign-on. Use one of the sign-in providers on the sign-in page.';

export interface OrgAccess {
  organizationId: string;
  role: OrganizationRole;
  isAdmin: boolean;
  // 'membership' = real OrganizationMember row backs this access.
  // 'superadmin' = synthesised for User.isSuperAdmin; no underlying row.
  //   Consumers that depend on physical membership (member listings, audit log
  //   actor lookups, seat counts) MUST branch on this and not assume the user
  //   exists in OrganizationMember.
  source: 'membership' | 'superadmin';
}

export interface ProjectAccess {
  projectId: string;
  organizationId: string;
  source: 'orgAdmin' | 'projectMember' | 'superadmin' | 'deploymentGrant';
  orgRole: OrganizationRole | null;
  projectRoleName: ProjectRoleName | null;
  canView: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
  canDelete: boolean;
}

/**
 * Centralised RBAC for organizations and projects.
 *
 * Org roles: owner / admin / member.
 *   - Non-members must not see anything about the org.
 *   - Owners and admins can see/edit org settings AND every project in the org.
 *   - Plain members can only see/use projects they have been explicitly added to.
 *
 * Project roles: admin / member / viewer.
 *   - admin: full project control including delete and member management.
 *   - member: full project control except adding members and deleting the project.
 *   - viewer: read-only.
 *
 * Callers pass the internal user UUID (already resolved via UsersService).
 * Superadmins (User.isSuperAdmin) bypass every check.
 */
// H-5: Process-local cache, same multi-pod caveat as MembershipCacheService.
// invalidateSuperAdmin is called when the flag is toggled in this process,
// but other pods only learn about it when this TTL expires.
//
// MUST stay equal to MembershipCacheService.TTL_MS: the slower of the two
// caches sets the platform-wide revocation bound, and a mismatch means the
// stated SLA is a lie.
const SUPERADMIN_TTL_MS = 1_000;

const ENFORCING_SSO = { enforced: true, enabled: true, platformEnabled: true };

function actsForPerson(ctx: RequestAuthContext | undefined): boolean {
  return Boolean(ctx?.browserSession || ctx?.apiTokenId || ctx?.mcpGateway);
}

@Injectable()
export class AuthorizationService {
  // userId → { value, expiresAt }. TTL'd because superadmin status is sticky
  // (toggled rarely from /admin) and we hit this check on every authz call.
  private readonly superAdminCache = new Map<string, { value: boolean; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly instanceSettings: InstanceSettingsService
  ) {}

  async isSuperAdmin(userId: string): Promise<boolean> {
    const now = Date.now();
    const hit = this.superAdminCache.get(userId);
    if (hit && hit.expiresAt > now) return hit.value;

    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true }
    });
    const value = Boolean(u?.isSuperAdmin);
    this.superAdminCache.set(userId, { value, expiresAt: now + SUPERADMIN_TTL_MS });
    return value;
  }

  async isUnrestrictedSuperAdmin(userId: string): Promise<boolean> {
    if (!holdsSuperAdminPower(requestAuthStorage.getStore())) return false;
    return this.isSuperAdmin(userId);
  }

  /** Drop the cached isSuperAdmin entry for a user. Call after toggling the flag. */
  invalidateSuperAdmin(userId: string) {
    this.superAdminCache.delete(userId);
  }

  /**
   * H-1: If the user is a member of any organization with SSO enforced, refuse
   * non-SSO authentication paths (OTP, passkey, password, Hack Club OAuth).
   * Without this gate, `OrgSsoSettings.enforced=true` is purely cosmetic: an admin
   * who offboards a user from the IdP cannot prevent them from logging back
   * in via OTP to the same email, defeating the whole point of enforcement.
   *
   * Superadmins bypass enforcement (break-glass access): the assumption is
   * that they manage SSO config and need a way back in if it breaks.
   *
   * The `authMethod` param is the method the caller is about to use; only
   * 'sso' satisfies enforcement. Anything else throws, including
   * 'instance_sso', the platform-wide identity providers, because an org that
   * enforces its own IdP is not asking to also trust the instance's Google
   * button.
   */
  async assertSsoNotEnforced(
    user: { id: string; email?: string | null; isSuperAdmin?: boolean | null } | null,
    authMethod: AuthMethod
  ): Promise<void> {
    if (authMethod === 'sso') return;
    if (user?.isSuperAdmin) return;
    await this.assertInstanceSsoNotEnforced(authMethod);
  }

  async orgRequiresSso(organizationId: string, userId: string): Promise<boolean> {
    if (!this.sessionNeedsOrgSso(organizationId) || (await this.isUnrestrictedSuperAdmin(userId)))
      return false;
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true }
    });
    return Boolean(member) && (await this.blockedByOrgSso(organizationId, member!.role));
  }

  async ssoBlockedOrgIds(userId: string): Promise<string[]> {
    const ctx = requestAuthStorage.getStore();
    if (!actsForPerson(ctx) || ctx?.sessionOrgId || (await this.isUnrestrictedSuperAdmin(userId)))
      return [];
    const rows = await this.prisma.organizationMember.findMany({
      where: {
        userId,
        role: { not: 'owner' },
        organization: { ssoSettings: { is: ENFORCING_SSO } }
      },
      select: {
        organizationId: true,
        role: true,
        organization: { select: { ssoSettings: { select: { guestsUseOwnLogin: true } } } }
      }
    });
    const blocked = rows.filter(
      (row) => !(row.role === 'guest' && row.organization.ssoSettings?.guestsUseOwnLogin)
    );
    if (!blocked.length || !ctx?.browserSession || !ctx.sessionId) {
      return blocked.map((row) => row.organizationId);
    }
    const grants = await this.prisma.sessionOrgGrant.findMany({
      where: {
        sessionId: ctx.sessionId,
        organizationId: { in: blocked.map((row) => row.organizationId) },
        expiresAt: { gt: new Date() }
      },
      select: { organizationId: true }
    });
    const granted = new Set(grants.map((g) => g.organizationId));
    return blocked.map((row) => row.organizationId).filter((id) => !granted.has(id));
  }

  private sessionNeedsOrgSso(organizationId: string): boolean {
    const ctx = requestAuthStorage.getStore();
    return actsForPerson(ctx) && ctx?.sessionOrgId !== organizationId;
  }

  private async blockedByOrgSso(organizationId: string, role: string): Promise<boolean> {
    if (role === 'owner' || !this.sessionNeedsOrgSso(organizationId)) return false;
    const settings = await this.prisma.orgSsoSettings.findFirst({
      where: { organizationId, ...ENFORCING_SSO },
      select: { organizationId: true, guestsUseOwnLogin: true }
    });
    if (!settings) return false;
    if (role === 'guest' && settings.guestsUseOwnLogin) return false;
    const ctx = requestAuthStorage.getStore();
    if (
      ctx?.browserSession &&
      ctx.sessionId &&
      (await this.hasOrgGrant(ctx.sessionId, organizationId))
    ) {
      return false;
    }
    if (ctx && !ctx.sessionOrgId) ctx.orgSsoRefused = true;
    return true;
  }

  private async hasOrgGrant(sessionId: string, organizationId: string): Promise<boolean> {
    const grant = await this.prisma.sessionOrgGrant.findUnique({
      where: { sessionId_organizationId: { sessionId, organizationId } },
      select: { expiresAt: true }
    });
    return Boolean(grant && grant.expiresAt > new Date());
  }

  /**
   * H-4: closes the onboarding-side gap that `assertSsoNotEnforced` doesn't
   * cover. When a brand-new identity tries to sign in via OAuth/OTP/passkey,
   * the user row doesn't exist yet so the per-user enforcement check above
   * has nothing to fire against. But if there's a pending invitation under
   * that email from an SSO-enforced org, accepting it via a non-SSO path
   * would have let an attacker who controls the email (or who registers
   * the email under a non-SSO identity provider) bypass the IdP entirely.
   *
   * Call this BEFORE user creation/JIT in the OAuth, OTP, and passkey
   * registration flows. SSO callback itself is exempt (authMethod='sso').
   */
  async assertSsoNotEnforcedForEmail(_email: string, authMethod: AuthMethod): Promise<void> {
    if (authMethod === 'sso') return;
    await this.assertInstanceSsoNotEnforced(authMethod);
  }

  async assertInstanceSsoNotEnforced(authMethod: AuthMethod): Promise<void> {
    if (!INSTANCE_SSO_BLOCKED.has(authMethod)) return;
    if (!(await this.instanceSettings.isSsoEnforced())) return;
    throw new ForbiddenException(INSTANCE_SSO_REQUIRED_MESSAGE);
  }

  async getOrgAccess(organizationId: string, userId: string): Promise<OrgAccess | null> {
    // A project-scoped API token must not grant org-admin powers (settings,
    // member management, billing). Strip isAdmin so admin checks fall through
    // to ForbiddenException even when the underlying user is an org owner.
    const tokenCtx = requestAuthStorage.getStore();
    const tokenIsProjectScoped = !!tokenCtx?.tokenProjectIds && tokenCtx.tokenProjectIds.length > 0;

    // Tenant confinement: a session minted by one org's IdP sees only that org,
    // whatever the underlying account is a member of. Same 404 shape as a
    // non-member, so the session cannot even discover the user's other orgs.
    if (tokenCtx?.sessionOrgId && tokenCtx.sessionOrgId !== organizationId) {
      return null;
    }
    if (await this.isUnrestrictedSuperAdmin(userId)) {
      // Confirm the org actually exists. Without this, superadmins probing a
      // random UUID got a synthetic owner membership and downstream endpoints
      // returned inconsistent shapes (empty list vs 404), which is both a
      // fuzzing oracle and a foot-gun for write endpoints keyed on the bogus id.
      const exists = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { id: true }
      });
      if (!exists) return null;
      return {
        organizationId,
        role: 'owner',
        isAdmin: true,
        source: 'superadmin'
      };
    }
    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true, status: true }
    });
    if (!member || member.status === 'disabled') return null;
    if (await this.blockedByOrgSso(organizationId, member.role)) return null;
    return {
      organizationId,
      role: member.role,
      isAdmin: !tokenIsProjectScoped && (member.role === 'owner' || member.role === 'admin'),
      source: 'membership'
    };
  }

  /** Read access on the organisation. Returns 404 to non-members so the resource is undiscoverable. */
  async requireOrgMember(organizationId: string, userId: string): Promise<OrgAccess> {
    const access = await this.getOrgAccess(organizationId, userId);
    if (!access) {
      throw new NotFoundException('Organization not found');
    }
    return access;
  }

  /** Settings / member management on the organisation: owners and admins only. */
  async requireOrgAdmin(organizationId: string, userId: string): Promise<OrgAccess> {
    const access = await this.requireOrgMember(organizationId, userId);
    if (!access.isAdmin) {
      throw new ForbiddenException('Only organization owners and admins can perform this action');
    }
    return access;
  }

  /**
   * Project creation gate. Guests are explicitly forbidden from spawning new
   * projects: they only ever interact with projects they've been added to.
   * Everyone else (owner / admin / member) can create.
   */
  async requireOrgCanCreateProjects(organizationId: string, userId: string): Promise<OrgAccess> {
    const access = await this.requireOrgMember(organizationId, userId);
    if (access.role === 'guest') {
      throw new ForbiddenException("Guests can't create projects in this organization");
    }
    const tokenCtx = requestAuthStorage.getStore();
    if (tokenCtx?.tokenProjectIds && tokenCtx.tokenProjectIds.length > 0) {
      throw new ForbiddenException("Project-scoped tokens can't create new projects");
    }
    return access;
  }

  /**
   * M-4: for callers whose correctness depends on a real OrganizationMember
   * row existing (audit log actor lookups, seat counting, member list joins).
   * Superadmins get a synthetic access object from getOrgAccess; this helper
   * makes the failure mode explicit rather than letting a join silently
   * return zero rows.
   */
  async requirePhysicalOrgMembership(organizationId: string, userId: string): Promise<OrgAccess> {
    const access = await this.requireOrgMember(organizationId, userId);
    if (access.source !== 'membership') {
      throw new ForbiddenException(
        "This action needs organization membership. Superadmin access isn't enough."
      );
    }
    return access;
  }

  async requireOrgOwner(organizationId: string, userId: string): Promise<OrgAccess> {
    const access = await this.requireOrgMember(organizationId, userId);
    if (access.role !== 'owner') {
      throw new ForbiddenException('Only the organization owner can perform this action');
    }
    const tokenCtx = requestAuthStorage.getStore();
    if (tokenCtx?.tokenProjectIds && tokenCtx.tokenProjectIds.length > 0) {
      throw new ForbiddenException("Project-scoped tokens can't perform owner-level actions");
    }
    return access;
  }

  /**
   * Resolve a user's effective access to a project.
   * Returns null if the user has no path to the project (not org member, not project member).
   */
  async getProjectAccess(
    projectId: string,
    userId: string,
    deploymentId?: string
  ): Promise<ProjectAccess | null> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, organizationId: true }
    });
    if (!project) return null;
    return this.resolveProjectAccess(project.id, project.organizationId, userId, deploymentId);
  }

  /**
   * A grant gives one member a project role on one deployment and nothing else
   * in the project. It is only consulted by callers that name the deployment,
   * so every project-level check keeps refusing the grantee. Admin is not a
   * grantable role: a grant never manages members or deletes the project.
   */
  private async resolveDeploymentGrant(
    projectId: string,
    organizationId: string,
    userId: string,
    deploymentId: string
  ): Promise<'viewer' | 'member' | null> {
    const tokenCtx = requestAuthStorage.getStore();
    if (tokenCtx?.tokenProjectIds?.length && !tokenCtx.tokenProjectIds.includes(projectId)) {
      return null;
    }
    if (tokenCtx?.sessionOrgId && tokenCtx.sessionOrgId !== organizationId) return null;
    const [orgMember, grant] = await Promise.all([
      this.prisma.organizationMember.findFirst({
        where: { organizationId, userId, status: 'active' },
        select: { role: true }
      }),
      this.prisma.deploymentGrant.findUnique({
        where: { deploymentId_userId: { deploymentId, userId } },
        select: { projectId: true, role: true }
      })
    ]);
    if (!orgMember || !grant || grant.projectId !== projectId) return null;
    if (await this.blockedByOrgSso(organizationId, orgMember.role)) return null;
    return grant.role === 'member' ? 'member' : 'viewer';
  }

  /**
   * Same as getProjectAccess but skips the project lookup when the caller already
   * has the organizationId on hand (lets us avoid a redundant query in hot paths).
   */
  async resolveProjectAccess(
    projectId: string,
    organizationId: string,
    userId: string,
    deploymentId?: string
  ): Promise<ProjectAccess | null> {
    const base = await this.resolveBaseProjectAccess(projectId, organizationId, userId);
    if (!deploymentId || base?.canEdit) return base;
    const role = await this.resolveDeploymentGrant(projectId, organizationId, userId, deploymentId);
    if (!role) return base;
    const canEdit = role === 'member';
    if (base) return { ...base, canView: true, canEdit: base.canEdit || canEdit };
    return {
      projectId,
      organizationId,
      source: 'deploymentGrant',
      orgRole: null,
      projectRoleName: role,
      canView: true,
      canEdit,
      canManageMembers: false,
      canDelete: false
    };
  }

  private async resolveBaseProjectAccess(
    projectId: string,
    organizationId: string,
    userId: string
  ): Promise<ProjectAccess | null> {
    // Token project-scoping: when the request is authenticated by an API token
    // with a non-empty restrictedProjectIds, treat any project outside that
    // list as if it didn't exist for this caller, even if the underlying user
    // is org owner. Same 404 shape as a non-member to avoid leaking existence.
    const tokenCtx = requestAuthStorage.getStore();
    if (tokenCtx?.tokenProjectIds && tokenCtx.tokenProjectIds.length > 0) {
      if (!tokenCtx.tokenProjectIds.includes(projectId)) {
        return null;
      }
    }
    // Tenant confinement, applied to the project tree as well: most resources
    // (deployments, databases, ingresses) authorize through here by project id
    // without an org id ever being named, so the check has to live here too.
    if (tokenCtx?.sessionOrgId && tokenCtx.sessionOrgId !== organizationId) {
      return null;
    }
    if (await this.isUnrestrictedSuperAdmin(userId)) {
      return {
        projectId,
        organizationId,
        source: 'superadmin',
        orgRole: 'owner',
        projectRoleName: 'admin',
        canView: true,
        canEdit: true,
        canManageMembers: true,
        canDelete: true
      };
    }

    const [orgMember, projectMember] = await Promise.all([
      this.prisma.organizationMember.findFirst({
        where: { organizationId, userId, status: 'active' },
        select: { role: true }
      }),
      this.prisma.projectMember.findFirst({
        where: { projectId, userId },
        include: { role: true }
      })
    ]);

    if (orgMember && (await this.blockedByOrgSso(organizationId, orgMember.role))) return null;

    // Org admins/owners see and control every project in the org.
    if (orgMember && (orgMember.role === 'owner' || orgMember.role === 'admin')) {
      return {
        projectId,
        organizationId,
        source: 'orgAdmin',
        orgRole: orgMember.role,
        projectRoleName: (projectMember?.role.name as ProjectRoleName | undefined) ?? null,
        canView: true,
        canEdit: true,
        canManageMembers: true,
        canDelete: true
      };
    }

    // Invariant: project access requires org membership. A ProjectMember row
    // without an OrganizationMember row is an orphan (e.g. partial cleanup) and
    // must not grant access.
    if (!orgMember) return null;

    if (!projectMember) {
      // Plain org members without a project membership cannot see the project at all.
      return null;
    }

    const roleName = projectMember.role.name as ProjectRoleName;
    if (roleName === 'admin') {
      return {
        projectId,
        organizationId,
        source: 'projectMember',
        orgRole: orgMember?.role ?? null,
        projectRoleName: 'admin',
        canView: true,
        canEdit: true,
        canManageMembers: true,
        canDelete: true
      };
    }
    if (roleName === 'member') {
      return {
        projectId,
        organizationId,
        source: 'projectMember',
        orgRole: orgMember?.role ?? null,
        projectRoleName: 'member',
        canView: true,
        canEdit: true,
        canManageMembers: false,
        canDelete: false
      };
    }
    // viewer (or any unknown role name → treated as read-only, never as edit)
    return {
      projectId,
      organizationId,
      source: 'projectMember',
      orgRole: orgMember?.role ?? null,
      projectRoleName: 'viewer',
      canView: true,
      canEdit: false,
      canManageMembers: false,
      canDelete: false
    };
  }

  /** View access. Throws 404 (not 403) when the user has no path to the project. */
  async requireProjectView(
    projectId: string,
    userId: string,
    deploymentId?: string
  ): Promise<ProjectAccess> {
    const access = await this.getProjectAccess(projectId, userId, deploymentId);
    if (!access || !access.canView) {
      throw new NotFoundException('Project not found');
    }
    return access;
  }

  /** Mutate deployments/services/ingresses/databases/etc.: viewers are blocked. */
  async requireProjectEdit(
    projectId: string,
    userId: string,
    action = 'modify this project',
    deploymentId?: string
  ): Promise<ProjectAccess> {
    const access = await this.requireProjectView(projectId, userId, deploymentId);
    if (!access.canEdit) {
      throw new ForbiddenException(`Your role doesn't allow you to ${action}`);
    }
    return access;
  }

  async requireProjectManageMembers(projectId: string, userId: string): Promise<ProjectAccess> {
    const access = await this.requireProjectView(projectId, userId);
    if (!access.canManageMembers) {
      throw new ForbiddenException(
        'Only project admins or organization admins can manage project members'
      );
    }
    return access;
  }

  /**
   * Ownership transfer is deliberately narrower than member management.
   * `Project.ownerId` is what every deployment and database in the project is
   * billed against, so handing it over spends somebody else's allowance: a
   * project admin who doesn't own the project must not be able to do that to
   * the person who does. Org admins/owners keep the escape hatch they need to
   * reassign projects when a member leaves.
   */
  canTransferProjectOwnership(
    access: ProjectAccess,
    ownerId: string | null,
    userId: string
  ): boolean {
    if (access.source === 'superadmin') return true;
    if (access.orgRole === 'owner' || access.orgRole === 'admin') return true;
    return !!ownerId && ownerId === userId && access.canEdit;
  }

  async requireProjectOwnershipTransfer(projectId: string, userId: string): Promise<ProjectAccess> {
    const access = await this.requireProjectView(projectId, userId);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true }
    });
    if (!this.canTransferProjectOwnership(access, project?.ownerId ?? null, userId)) {
      throw new ForbiddenException(
        'Only the project owner or an organization admin can transfer ownership of this project'
      );
    }
    return access;
  }

  async requireProjectDelete(projectId: string, userId: string): Promise<ProjectAccess> {
    const access = await this.requireProjectView(projectId, userId);
    if (!access.canDelete) {
      throw new ForbiddenException(
        'Only project admins or organization admins can delete this project'
      );
    }
    return access;
  }

  /**
   * For list endpoints. Returns the set of project IDs the user can see in the org.
   * If the user is an org admin/owner, returns null meaning "no filter: show every project in the org".
   * If the user is a plain org member, returns the explicit list of project IDs they belong to.
   * If the user is not an org member at all, throws 404.
   */
  async listVisibleProjectIds(organizationId: string, userId: string): Promise<string[] | null> {
    const tokenCtx = requestAuthStorage.getStore();
    if (tokenCtx?.sessionOrgId && tokenCtx.sessionOrgId !== organizationId) {
      throw new NotFoundException('Organization not found');
    }
    const tokenAllowList =
      tokenCtx?.tokenProjectIds && tokenCtx.tokenProjectIds.length > 0
        ? tokenCtx.tokenProjectIds
        : null;
    if (await this.isUnrestrictedSuperAdmin(userId)) return null;

    const member = await this.prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { role: true, status: true }
    });
    if (
      !member ||
      member.status === 'disabled' ||
      (await this.blockedByOrgSso(organizationId, member.role))
    ) {
      throw new NotFoundException('Organization not found');
    }
    if (member.role === 'owner' || member.role === 'admin') {
      if (!tokenAllowList) return null;
      const projects = await this.prisma.project.findMany({
        where: { organizationId, id: { in: tokenAllowList } },
        select: { id: true }
      });
      return projects.map((p) => p.id);
    }

    const memberships = await this.prisma.projectMember.findMany({
      where: { userId, project: { organizationId } },
      select: { projectId: true }
    });
    const ids = memberships.map((m) => m.projectId);
    if (!tokenAllowList) return ids;
    return ids.filter((id) => tokenAllowList.includes(id));
  }
}
