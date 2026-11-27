import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { requestAuthStorage } from '../auth/request-context';
import { normalizeBoundedEmail } from '../auth/email-normalize';

export const GRANT_ROLES = ['viewer', 'member'] as const;
export type GrantRole = (typeof GRANT_ROLES)[number];

export interface GrantView {
  userId: string;
  email: string;
  username: string;
  name: string | null;
  role: GrantRole;
  createdAt: Date;
}

@Injectable()
export class DeploymentGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService
  ) {}

  private async managedDeployment(deploymentId: string, actorId: string) {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: {
        id: true,
        name: true,
        projectId: true,
        project: { select: { organizationId: true } }
      }
    });
    if (!deployment) throw new NotFoundException(`Deployment ${deploymentId} not found`);
    await this.authz.requireProjectManageMembers(deployment.projectId, actorId);
    return deployment;
  }

  async list(deploymentId: string, actorId: string): Promise<GrantView[]> {
    await this.managedDeployment(deploymentId, actorId);
    const rows = await this.prisma.deploymentGrant.findMany({
      where: { deploymentId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        createdAt: true,
        user: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true }
        }
      }
    });
    return rows.map((r) => ({
      userId: r.user.id,
      email: r.user.email,
      username: r.user.username,
      name: [r.user.firstName, r.user.lastName].filter(Boolean).join(' ') || null,
      role: r.role === 'member' ? 'member' : 'viewer',
      createdAt: r.createdAt
    }));
  }

  async upsert(
    deploymentId: string,
    email: unknown,
    role: unknown,
    actorId: string,
    actorEmail: string | null
  ) {
    const deployment = await this.managedDeployment(deploymentId, actorId);
    if (typeof email !== 'string') throw new BadRequestException('email is required');
    if (typeof role !== 'string' || !GRANT_ROLES.includes(role as GrantRole)) {
      throw new BadRequestException(`role must be one of: ${GRANT_ROLES.join(', ')}`);
    }
    const normalized = normalizeBoundedEmail(email);
    const member = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId: deployment.project.organizationId,
        status: 'active',
        user: { email: { equals: normalized, mode: 'insensitive' } }
      },
      select: { userId: true, role: true }
    });
    if (!member) throw new NotFoundException('No organization member with that email');
    if (member.userId === actorId) throw new BadRequestException("You can't share with yourself");
    if (member.role === 'owner' || member.role === 'admin') {
      throw new BadRequestException('Organization admins already have access to every app');
    }
    await this.prisma.deploymentGrant.upsert({
      where: { deploymentId_userId: { deploymentId, userId: member.userId } },
      create: {
        projectId: deployment.projectId,
        deploymentId,
        userId: member.userId,
        role,
        createdBy: actorId
      },
      update: { role }
    });
    void this.audit.log({
      action: 'deployment.access.grant',
      actorUserId: actorId,
      actorEmail,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: { recipientUserId: member.userId, role }
    });
    return { userId: member.userId, role };
  }

  async remove(deploymentId: string, userId: string, actorId: string) {
    const deployment = await this.managedDeployment(deploymentId, actorId);
    const { count } = await this.prisma.deploymentGrant.deleteMany({
      where: { deploymentId, userId }
    });
    if (count === 0) throw new NotFoundException('Access not found');
    void this.audit.log({
      action: 'deployment.access.revoke',
      actorUserId: actorId,
      organizationId: deployment.project.organizationId,
      projectId: deployment.projectId,
      deploymentId,
      targetType: 'deployment',
      targetId: deploymentId,
      targetLabel: deployment.name,
      metadata: { recipientUserId: userId }
    });
  }

  async grantedDeploymentIds(userId: string): Promise<Map<string, GrantRole>> {
    const tokenCtx = requestAuthStorage.getStore();
    const rows = await this.prisma.deploymentGrant.findMany({
      where: {
        userId,
        ...(tokenCtx?.tokenProjectIds?.length
          ? { projectId: { in: tokenCtx.tokenProjectIds } }
          : {}),
        project: {
          ...(tokenCtx?.sessionOrgId ? { organizationId: tokenCtx.sessionOrgId } : {}),
          organization: { members: { some: { userId, status: 'active' } } }
        }
      },
      select: { deploymentId: true, role: true }
    });
    return new Map(rows.map((r) => [r.deploymentId, r.role === 'member' ? 'member' : 'viewer']));
  }
}
