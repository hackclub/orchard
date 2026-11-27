import { Idempotent } from '../idempotency/idempotency.interceptor';
import {
  APP_ICON_UPLOAD_BYTES,
  BUILD_CONTEXT_UPLOAD_BYTES,
  BuildContextUploadSlots,
  ImageUploadSlots,
  PROJECT_BACKGROUND_UPLOAD_BYTES,
  PROJECT_ICON_UPLOAD_BYTES,
  uploadLimits
} from '../http/upload-limits';
import { DatabaseRecoveryService } from './database-recovery.service';
import { Throttle } from '@nestjs/throttler';
import {
  Controller,
  Get,
  Param,
  Post,
  Body,
  Request,
  Delete,
  Put,
  Patch,
  Query,
  Res,
  HttpStatus,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ProjectsService } from './projects.service';
import { ProjectAccessService } from './project-access.service';
import { DatabasesService } from './databases.service';
import { DeploymentsService } from './deployments.service';
import { ProjectOrgTransferService } from './project-org-transfer.service';
import { IngressService } from './ingress.service';
import { FaviconService } from './favicon.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { StorageService } from '../organizations/storage.service';
import { Auth, RequireScope } from '../auth/decorators';
import {
  PERSONAL_CREDENTIAL_REFUSED,
  personalSourceSelectionRefused
} from '../auth/request-context';
import { MetricsService } from '../metrics/metrics.service';
import { RightsizingService } from '../rightsizing/rightsizing.service';
import { MetricsStoreError } from '../metrics/victoria-metrics.service';
import { PodLogCaptureService } from '../kubernetes/pod-log-capture.service';
import { GitHubService } from '../github/github.service';
import { UsersService } from '../users/users.service';
import { RolloutPinInterceptor } from './rollout.controller';
import { autoUrlChoice } from './auto-url';
import { detectedBuildFor } from './detected-build';

function withoutOwnerRefs<T extends object>(body: T): T {
  const safe = { ...body } as T & Record<string, unknown>;
  for (const key of ['composeStackId', 'composeServiceName', 'templateInstanceId']) {
    delete safe[key];
  }
  return safe;
}

@Auth()
@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectAccess: ProjectAccessService,
    private readonly databases: DatabasesService,
    private readonly deployments: DeploymentsService,
    private readonly ingress: IngressService,
    private readonly storageService: StorageService,
    private readonly githubService: GitHubService,
    private readonly usersService: UsersService,
    private readonly orgTransfer: ProjectOrgTransferService
  ) {}

  /**
   * One-shot import: repo in, live app out. Detects the build config, creates
   * a project named after the repo, kicks off the first build, and attaches a
   * protected platform URL. Auto-deploy comes on when the GitHub App covers the
   * repo; without it a public repo still imports and is rebuilt by hand. Partial
   * failures surface the ids that were created so the client can resume instead
   * of retrying from scratch.
   */
  @Post('import')
  async importFromGitHub(
    @Body()
    body: {
      organizationId: string;
      repoUrl: string;
      branch?: string;
      overrides?: {
        name?: string;
        port?: number;
        buildType?: 'dockerfile' | 'railpack';
        dockerfilePath?: string;
        replicas?: number;
        cpuRequestMilli?: number | null;
        memoryRequestBytes?: number | null;
        env?: { key: string; value: string; secret?: boolean }[];
      };
    },
    @Request() req
  ) {
    const clerkId = req.user.externalAuthId || req.user.sub;
    const userData = {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName || req.user.name?.split(' ')[0],
      lastName: req.user.lastName || req.user.name?.split(' ').slice(1).join(' '),
      imageUrl: req.user.imageUrl
    };

    let repoUrl = String(body.repoUrl || '').trim();
    if (repoUrl && !repoUrl.startsWith('http')) {
      repoUrl = `https://github.com/${repoUrl}`;
    }
    repoUrl = repoUrl.replace(/\.git$/, '');
    const parsed = this.githubService.parseRepoUrl(repoUrl);
    if (!parsed) {
      throw new BadRequestException("Couldn't read the repository URL");
    }

    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new BadRequestException('User not found');
    }
    const token = await this.githubService.resolveReadAccessToken(user, parsed.owner, parsed.repo);
    if (token === null) {
      throw new ForbiddenException(
        personalSourceSelectionRefused()
          ? PERSONAL_CREDENTIAL_REFUSED
          : "You don't have access to this repository on GitHub. Connect your GitHub account or check the repository URL."
      );
    }

    const branch =
      String(body.branch || '').trim() ||
      (await this.githubService.getDefaultBranch(token, parsed.owner, parsed.repo));

    const det = await this.githubService.detectRepoConfig(token, parsed.owner, parsed.repo, branch);
    const overrides = body.overrides ?? {};
    const name = String(overrides.name || det.suggestedName || parsed.repo).trim();

    const project = await this.projectsService.createProject(
      body.organizationId,
      { name, repositoryUrl: repoUrl },
      clerkId,
      userData
    );

    const detected = detectedBuildFor(det, { port: overrides.port, env: overrides.env });
    const buildType = overrides.buildType ?? detected.buildType;
    const dockerfilePath = overrides.dockerfilePath ?? detected.dockerfilePath;
    const ports = overrides.port ? [overrides.port] : det.ports;

    const envByKey = new Map<string, { key: string; value: string; secret?: boolean }>();
    for (const e of det.buildType === 'dockerfile' ? det.env : []) envByKey.set(e.key, e);
    for (const e of detected.env) envByKey.set(e.key, e);

    let deployment;
    try {
      deployment = await this.deployments.createDeploymentFromGitHub(
        project.id,
        {
          name,
          repoUrl,
          branch,
          buildType,
          dockerfilePath,
          ports: ports.map((p, i) => ({
            name: `port-${i + 1}`,
            containerPort: p,
            servicePort: p,
            protocol: 'TCP'
          })),
          replicas: overrides.replicas,
          env: Array.from(envByKey.values()),
          cpuRequestMilli: overrides.cpuRequestMilli ?? null,
          memoryRequestBytes: overrides.memoryRequestBytes ?? null,
          rootDirectory: detected.rootDirectory,
          framework: detected.framework,
          installCommand: detected.installCommand,
          buildCommand: detected.buildCommand,
          startCommand: detected.startCommand,
          outputDirectory: detected.outputDirectory,
          autoDeployBranch: branch
        },
        clerkId,
        userData
      );
    } catch (error) {
      throw new BadRequestException({
        message: `Project ${project.slug} was created but the deployment failed: ${error?.message ?? error}`,
        projectId: project.id,
        projectSlug: project.slug
      });
    }

    let liveUrl: string | null = null;
    if (ports.length > 0) {
      try {
        const withUrl = await this.ingress.createAutoIngressForDeployment(
          deployment.id,
          clerkId,
          userData
        );
        liveUrl = (withUrl as any)?.url ?? null;
      } catch (error) {
        console.warn(
          `[Projects] Auto URL creation failed for import ${deployment.id}:`,
          error?.message ?? error
        );
      }
    }

    return {
      projectId: project.id,
      projectSlug: project.slug,
      deploymentId: deployment.id,
      deploymentName: deployment.name,
      branch,
      buildType,
      framework: det.framework,
      autoDeployEnabled: Boolean(deployment.autoDeployEnabled),
      url: liveUrl
    };
  }

  @Get()
  async listProjects(@Request() req, @Query('orgId') orgId?: string) {
    return this.projectsService.listProjects(req.user.sub, orgId);
  }

  @Get('slug/:slug')
  async getProjectBySlug(
    @Param('slug') slug: string,
    @Query('orgId') orgId: string,
    @Request() req
  ) {
    return this.projectsService.getProjectBySlug(orgId, slug, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get('by-slugs/:orgSlug/:projectSlug')
  async getProjectBySlugsFull(
    @Param('orgSlug') orgSlug: string,
    @Param('projectSlug') projectSlug: string,
    @Request() req
  ) {
    return this.projectsService.getProjectBySlugsFull(orgSlug, projectSlug, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post('ingresses/validate-dns')
  async validateIngressDns(
    @Body()
    body: {
      projectId: string;
      domain: string;
    },
    @Request() req
  ) {
    if (!body || typeof body.projectId !== 'string' || !body.projectId.trim()) {
      throw new BadRequestException('projectId is required');
    }
    if (typeof body.domain !== 'string' || !body.domain.trim()) {
      throw new BadRequestException('domain is required');
    }
    // Require project-edit on the named project before performing any DNS
    // lookup. This prevents the endpoint from being abused as an arbitrary
    // DNS oracle by any authenticated user.
    await this.projectAccess.assertProjectEditAccess(body.projectId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.ingress.validateIngressDns(body.domain, body.projectId);
  }

  @Post()
  @Idempotent()
  async createProject(
    @Body()
    body: {
      organizationId: string;
      name: string;
      slug?: string;
      description?: string;
      repositoryUrl?: string;
      icon?: string;
      backgroundImage?: string;
    },
    @Request() req
  ) {
    const { organizationId, name, slug, description, repositoryUrl, icon, backgroundImage } = body;
    return this.projectsService.createProject(
      organizationId,
      { name, slug, description, repositoryUrl, icon, backgroundImage },
      req.user.externalAuthId || req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName || req.user.name?.split(' ')[0],
        lastName: req.user.lastName || req.user.name?.split(' ').slice(1).join(' '),
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Patch(':id')
  async updateProject(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      description?: string;
      repositoryUrl?: string | null;
      icon?: string | null;
      backgroundImage?: string | null;
    },
    @Request() req
  ) {
    return this.projectsService.updateProject(id, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/icon')
  @UseInterceptors(
    ImageUploadSlots,
    FileInterceptor('file', uploadLimits(PROJECT_ICON_UPLOAD_BYTES))
  )
  async uploadProjectIcon(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req
  ) {
    if (!file) throw new BadRequestException('No file provided');
    // SVG intentionally excluded: SVG is an executable document (can carry
    // <script> and event handlers) and we render project icons same-origin
    // in the dashboard. Allowing SVG turns "upload icon" into stored XSS
    // against any user who views the project.
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Use a JPEG, PNG, GIF or WebP image');
    }
    if (file.size > 2 * 1024 * 1024) {
      throw new BadRequestException('Use a file under 2 MB');
    }
    return this.projectsService.uploadProjectAsset(
      id,
      'icon',
      file,
      this.storageService,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Post(':id/background-image')
  @UseInterceptors(
    ImageUploadSlots,
    FileInterceptor('file', uploadLimits(PROJECT_BACKGROUND_UPLOAD_BYTES))
  )
  async uploadProjectBackground(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req
  ) {
    if (!file) throw new BadRequestException('No file provided');
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Use a JPEG, PNG or WebP image');
    }
    if (file.size > 8 * 1024 * 1024) {
      throw new BadRequestException('Use a file under 8 MB');
    }
    return this.projectsService.uploadProjectAsset(
      id,
      'backgroundImage',
      file,
      this.storageService,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Delete(':id')
  async deleteProject(
    @Param('id') id: string,
    @Body() body: { confirmName?: string } | undefined,
    @Request() req
  ) {
    return this.projectsService.deleteProject(
      id,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      },
      body?.confirmName
    );
  }

  @Get(':id')
  async getProject(@Param('id') id: string, @Request() req) {
    return this.projectsService.getProject(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/deployments')
  async getProjectDeployments(@Param('id') id: string, @Request() req) {
    return this.deployments.getProjectDeployments(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/members')
  async addProjectMember(
    @Param('id') id: string,
    @Body() body: { email: string; role: string },
    @Request() req
  ) {
    return this.projectsService.addProjectMember(id, body.email, body.role, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':id/invitations/:invitationId')
  async revokeProjectInvitation(
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
    @Request() req
  ) {
    return this.projectsService.revokeProjectInvitation(id, invitationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':id/members/:memberId')
  async removeProjectMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Request() req
  ) {
    return this.projectsService.removeProjectMember(id, memberId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Patch(':id/members/:memberId')
  async updateProjectMemberRole(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body('role') role: string,
    @Request() req
  ) {
    return this.projectsService.updateProjectMemberRole(id, memberId, role, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/transfer-request')
  async requestProjectOwnershipTransfer(
    @Param('id') id: string,
    @Body() body: { userId?: string; email?: string },
    @Request() req
  ) {
    return this.projectsService.requestProjectOwnershipTransfer(
      id,
      { userId: body.userId, email: body.email },
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Delete(':id/transfer-request')
  async cancelProjectOwnershipTransfer(@Param('id') id: string, @Request() req) {
    return this.projectsService.cancelProjectOwnershipTransfer(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  // Preview a project move to another org: slug collision, who loses access,
  // owner re-assignment, quota headroom, and whether backups can follow.
  @Get(':id/transfer-org/preview')
  async previewProjectOrgTransfer(
    @Param('id') id: string,
    @Query('destinationOrgId') destinationOrgId: string,
    @Query('slug') slug: string | undefined,
    @Request() req
  ) {
    return this.orgTransfer.preview(id, destinationOrgId, slug, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/transfer-org')
  async transferProjectToOrg(
    @Param('id') id: string,
    @Body() body: { destinationOrgId?: string; slug?: string },
    @Request() req
  ) {
    return this.orgTransfer.transfer(id, body?.destinationOrgId ?? '', body?.slug, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/databases')
  @Idempotent()
  async createDatabase(
    @Param('id') id: string,
    @Body() body: {
      name: string;
      storageSize?: string;
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      restoreFromUrl?: string;
      pgMajor?: number;
      replicas?: number | null;
      nodePoolId?: string | null;
      placementOverride?: unknown;
      environmentId?: string;
    },
    @Request() req
  ) {
    return this.databases.createDatabase(id, withoutOwnerRefs(body), req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/databases')
  async getProjectDatabases(@Param('id') id: string, @Request() req) {
    const { user, access } = await this.projectAccess.assertProjectView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.databases.getProjectDatabases(id, access.canEdit, user.id);
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post(':id/ingresses')
  async createProjectIngress(
    @Param('id') id: string,
    @Body()
    body: {
      host: string;
      tlsEnabled?: boolean;
      routes?: { path: string; serviceName: string; servicePort: number }[];
      deploymentId?: string;
      redirectTarget?: string;
      redirectStatus?: 301 | 302 | 307 | 308;
      basicAuth?: {
        enabled: boolean;
        username: string;
        password: string;
      };
    },
    @Request() req
  ) {
    return this.ingress.createProjectIngress(id, withoutOwnerRefs(body), req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Put(':id/ingresses/:ingressId')
  async updateProjectIngress(
    @Param('id') id: string,
    @Param('ingressId') ingressId: string,
    @Body()
    body: {
      host: string;
      tlsEnabled?: boolean;
      routes?: { path: string; serviceName: string; servicePort: number }[];
      redirectTarget?: string;
      redirectStatus?: number;
      basicAuth?: {
        enabled: boolean;
        username: string;
        password: string;
      };
    },
    @Request() req
  ) {
    return this.ingress.updateProjectIngress(id, ingressId, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/ingresses/:ingressId')
  async getProjectIngress(
    @Param('id') id: string,
    @Param('ingressId') ingressId: string,
    @Request() req
  ) {
    return this.ingress.getProjectIngress(id, ingressId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':id/ingresses/:ingressId')
  async deleteProjectIngress(
    @Param('id') id: string,
    @Param('ingressId') ingressId: string,
    @Request() req
  ) {
    return this.ingress.deleteProjectIngress(id, ingressId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/ingresses/:ingressId/protection')
  @RequireScope('deploy')
  async getIngressProtection(
    @Param('id') id: string,
    @Param('ingressId') ingressId: string,
    @Request() req
  ) {
    return this.ingress.getIngressProtection(id, ingressId, req.user.sub);
  }

  @Put(':id/ingresses/:ingressId/protection')
  async updateIngressProtection(
    @Param('id') id: string,
    @Param('ingressId') ingressId: string,
    @Body() body: {
      mode: 'none' | 'basic' | 'password' | 'orchard';
      username?: string;
      password?: string;
      bypassPaths?: string[];
    },
    @Request() req
  ) {
    return this.ingress.updateIngressProtection(
      id,
      ingressId,
      req.user.sub,
      body.mode,
      body.password,
      body.bypassPaths,
      body.username
    );
  }

  @Post(':id/deployments')
  @Idempotent()
  async createDeployment(
    @Param('id') id: string,
    @Body()
    body: {
      name: string;
      image: string;
      port?: number;
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        reach?: string;
      }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      exposePublic?: boolean;
      volumes?: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
        storageSize?: string;
        hostPath?: string;
        readOnly?: boolean;
      }[];
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      autoUrl?: boolean;
      nodePoolId?: string | null;
      placementOverride?: unknown;
      imagePullPolicy?: 'Always' | 'IfNotPresent';
      environmentId?: string;
      startCommand?: string | null;
      devices?: Record<string, number> | null;
    },
    @Request() req
  ) {
    const {
      name,
      image,
      port,
      ports,
      replicas,
      env,
      exposePublic,
      volumes,
      cpuRequestMilli,
      memoryRequestBytes,
      nodePoolId,
      placementOverride,
      imagePullPolicy,
      environmentId,
      startCommand,
      devices
    } = body;
    const result = await this.deployments.createDeployment(
      id,
      {
        name,
        image,
        port,
        ports,
        replicas,
        env,
        exposePublic,
        volumes,
        cpuRequestMilli,
        memoryRequestBytes,
        nodePoolId,
        placementOverride,
        imagePullPolicy,
        environmentId,
        startCommand,
        devices
      },
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );

    const declaredPort = Boolean(port || (Array.isArray(ports) && ports.length > 0));
    if ((body.autoUrl ?? declaredPort) && result?.id) {
      try {
        const withUrl = await this.ingress.createAutoIngressForDeployment(
          result.id,
          req.user.sub,
          {
            email: req.user.email,
            username: req.user.username,
            firstName: req.user.firstName,
            lastName: req.user.lastName,
            imageUrl: req.user.imageUrl
          },
          autoUrlChoice(ports)
        );
        if (withUrl) return withUrl;
      } catch (error) {
        console.warn(
          `[Projects] Auto URL creation failed for deployment ${result.id}:`,
          error?.message ?? error
        );
      }
    }
    return result;
  }

  @Post(':id/deployments/from-local')
  async createDeploymentFromLocal(
    @Param('id') id: string,
    @Body()
    body: {
      name: string;
      buildType?: 'dockerfile' | 'railpack';
      dockerfilePath?: string;
      target?: string;
      rootDirectory?: string | null;
      framework?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      outputDirectory?: string | null;
      port?: number;
      ports?: { name?: string; containerPort?: number; servicePort?: number; protocol?: string }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      environmentId?: string;
      autoUrl?: boolean;
    },
    @Request() req
  ) {
    const clerkId = req.user.externalAuthId || req.user.sub;
    const userData = {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName || req.user.name?.split(' ')[0],
      lastName: req.user.lastName || req.user.name?.split(' ').slice(1).join(' '),
      imageUrl: req.user.imageUrl
    };
    const result = await this.deployments.createDeploymentFromLocal(id, body, clerkId, userData);

    const declaredPort = Boolean(body.port || (Array.isArray(body.ports) && body.ports.length > 0));
    if ((body.autoUrl ?? declaredPort) && result?.id) {
      try {
        const withUrl = await this.ingress.createAutoIngressForDeployment(
          result.id,
          clerkId,
          userData
        );
        if (withUrl) return withUrl;
      } catch (error) {
        console.warn(
          `[Projects] Auto URL creation failed for deployment ${result.id}:`,
          error?.message ?? error
        );
      }
    }
    return result;
  }

  @Post(':id/deployments/from-github')
  @Idempotent()
  async createDeploymentFromGitHub(
    @Param('id') id: string,
    @Body()
    body: {
      name: string;
      gitConnectionId?: string | null;
      externalRepoId?: string | null;
      repoUrl?: string;
      githubRepo?: string;
      branch?: string;
      dockerfilePath?: string;
      target?: string;
      tag?: string;
      buildFromRoot?: boolean;
      buildWithDepot?: boolean;
      buildType?: 'dockerfile' | 'railpack';
      rootDirectory?: string | null;
      framework?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      outputDirectory?: string | null;
      port?: number;
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        reach?: string;
      }[];
      replicas?: number;
      env?: { key: string; value: string }[];
      exposePublic?: boolean;
      volumes?: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
        storageSize?: string;
        hostPath?: string;
        readOnly?: boolean;
      }[];
      cpuRequestMilli?: number | null;
      memoryRequestBytes?: number | null;
      autoUrl?: boolean;
      environmentId?: string;
    },
    @Request() req
  ) {
    const userData = {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName || req.user.name?.split(' ')[0],
      lastName: req.user.lastName || req.user.name?.split(' ').slice(1).join(' '),
      imageUrl: req.user.imageUrl
    };
    const clerkId = req.user.externalAuthId || req.user.sub;
    const request = await this.withDetectedBuild(withoutOwnerRefs(body), clerkId, userData);
    const result = await this.deployments.createDeploymentFromGitHub(
      id,
      request,
      clerkId,
      userData
    );

    // HTTP-shaped: an explicitly declared port, or a port the server detected
    // from the Dockerfile EXPOSE (anything other than the 80 fallback).
    const declaredPort = Boolean(
      request.port || (Array.isArray(request.ports) && request.ports.length > 0)
    );
    const exposeDetected =
      !declaredPort &&
      (result?.services ?? []).some((s: any) =>
        (s.ports ?? []).some((p: any) => Number(p.port) !== 80)
      );
    if ((body.autoUrl ?? (declaredPort || exposeDetected)) && result?.id) {
      try {
        const withUrl = await this.ingress.createAutoIngressForDeployment(
          result.id,
          req.user.externalAuthId || req.user.sub,
          userData,
          autoUrlChoice(body.ports)
        );
        if (withUrl) return withUrl;
      } catch (error) {
        console.warn(
          `[Projects] Auto URL creation failed for deployment ${result.id}:`,
          error?.message ?? error
        );
      }
    }
    return result;
  }

  /**
   * A request that names a GitHub repo and no build gets what the create form
   * would have suggested. A request that names a build type or a Dockerfile keeps
   * it, and a repo that can't be read falls through to the service, which owns
   * the access check and its error.
   */
  private async withDetectedBuild<
    T extends {
      gitConnectionId?: string | null;
      repoUrl?: string;
      githubRepo?: string;
      branch?: string;
      buildType?: 'dockerfile' | 'railpack';
      dockerfilePath?: string;
      port?: number;
      ports?: unknown[];
      env?: { key: string; value: string }[];
      rootDirectory?: string | null;
      framework?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      outputDirectory?: string | null;
    }
  >(
    body: T,
    clerkId: string,
    userData: Parameters<UsersService['findOrCreateByClerkId']>[1]
  ): Promise<T> {
    if (body.gitConnectionId) return body;
    const rawRepo = String(body.repoUrl || body.githubRepo || '').trim();
    if (!rawRepo) return body;
    const needsBuild = !body.buildType && !String(body.dockerfilePath || '').trim();
    if (!needsBuild && body.branch) return body;

    const repoUrl = rawRepo.startsWith('http') ? rawRepo : `https://github.com/${rawRepo}`;
    const parsed = this.githubService.parseRepoUrl(repoUrl.replace(/\.git$/, ''));
    if (!parsed) return body;
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) return body;
    const token = await this.githubService.resolveReadAccessToken(user, parsed.owner, parsed.repo);
    if (token === null) return body;

    const branch =
      body.branch || (await this.githubService.getDefaultBranch(token, parsed.owner, parsed.repo));
    if (!needsBuild) return { ...body, branch };

    const det = await this.githubService.detectRepoConfig(token, parsed.owner, parsed.repo, branch);
    const detected = detectedBuildFor(det, {
      port: body.port,
      declaresPorts: Array.isArray(body.ports) && body.ports.length > 0,
      env: body.env
    });
    return {
      ...body,
      branch,
      buildType: detected.buildType,
      dockerfilePath: detected.dockerfilePath,
      port: detected.port,
      env: detected.env,
      rootDirectory: body.rootDirectory ?? detected.rootDirectory,
      framework: body.framework ?? detected.framework,
      installCommand: body.installCommand ?? detected.installCommand,
      buildCommand: body.buildCommand ?? detected.buildCommand,
      startCommand: body.startCommand ?? detected.startCommand,
      outputDirectory: body.outputDirectory ?? detected.outputDirectory
    };
  }
}

@Auth()
@Controller('deployments')
export class DeploymentsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectAccess: ProjectAccessService,
    private readonly deployments: DeploymentsService,
    private readonly ingress: IngressService,
    private readonly webhooksService: WebhooksService,
    private readonly faviconService: FaviconService,
    private readonly metricsService: MetricsService,
    private readonly logCapture: PodLogCaptureService,
    private readonly rightsizing: RightsizingService,
    private readonly recovery: DatabaseRecoveryService,
    private readonly storageService: StorageService
  ) {}

  @Post(':id/icon')
  @UseInterceptors(ImageUploadSlots, FileInterceptor('file', uploadLimits(APP_ICON_UPLOAD_BYTES)))
  async uploadDeploymentIcon(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req
  ) {
    if (!file) throw new BadRequestException('No file provided');
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) {
      throw new BadRequestException('Use a JPEG, PNG, GIF or WebP image');
    }
    return this.deployments.uploadDeploymentIcon(id, file, this.storageService, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/build-runs')
  async getBuildRuns(@Param('id') id: string, @Request() req, @Query('limit') limitStr?: string) {
    await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.deployments.listBuildRuns(id, Number(limitStr) || 20);
  }

  @Get(':id/releases')
  async getReleases(@Param('id') id: string, @Request() req, @Query('limit') limitStr?: string) {
    const { access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.deployments.listReleases(id, Number(limitStr) || 20, access.canEdit);
  }

  @Get(':id/rightsizing')
  async getRightsizing(@Param('id') id: string, @Request() req) {
    await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    try {
      return await this.rightsizing.recommend(id);
    } catch (err) {
      if (err instanceof MetricsStoreError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  @Get(':id/releases/:releaseId/verdict')
  async getReleaseVerdict(
    @Param('id') id: string,
    @Param('releaseId') releaseId: string,
    @Request() req
  ) {
    await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.deployments.getReleaseVerdict(id, releaseId);
  }

  @Get(':id/build-runs/:runId/logs')
  async getBuildRunLogs(@Param('id') id: string, @Param('runId') runId: string, @Request() req) {
    const { access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) return '';
    return this.deployments.getBuildRunLogs(id, runId);
  }

  @Get(':id/metrics')
  async getDeploymentMetrics(
    @Param('id') id: string,
    @Request() req,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('step') stepStr?: string,
    @Query('groupBy') groupBy?: string
  ) {
    await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    const end = Number(endStr) || Date.now();
    const start = Number(startStr) || end - 60 * 60 * 1000;
    const step = Math.max(1000, Number(stepStr) || 30_000);
    if (end <= start) throw new BadRequestException('end must be > start');

    const dep = await this.deployments.metricsTarget(id);
    if (!dep?.namespace || !dep?.name) {
      throw new BadRequestException('Deployment has no namespace/name');
    }

    try {
      const args = {
        namespace: dep.namespace,
        deploymentName: dep.name,
        startMs: start,
        endMs: end,
        stepMs: step
      };
      const throttle = this.metricsService.fetchDeploymentThrottle(args).catch(() => []);
      const forecast =
        end >= Date.now() - 10 * 60 * 1000
          ? this.metricsService
              .forecastDeploymentMemory({
                id,
                name: dep.name,
                namespace: dep.namespace,
                memoryRequestBytes:
                  dep.memoryRequestBytes != null ? Number(dep.memoryRequestBytes) : null
              })
              .catch(() => null)
          : Promise.resolve(null);
      if (groupBy === 'pod') {
        const grouped = await this.metricsService.fetchDeploymentMetricsByPod(args);
        return {
          start,
          end,
          step,
          groupBy: 'pod',
          grouped,
          throttle: await throttle,
          forecast: await forecast
        };
      }

      const data = await this.metricsService.fetchDeploymentMetrics(args);
      return { start, end, step, data, throttle: await throttle, forecast: await forecast };
    } catch (err) {
      if (err instanceof MetricsStoreError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  @Patch(':id/strategy')
  async updateDeploymentStrategy(
    @Param('id') id: string,
    @Body() body: { strategy: 'rollingUpdate' | 'recreate' | 'blueGreen' },
    @Request() req
  ) {
    const { user, access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException("Your role doesn't allow you to change the deploy strategy");
    }
    return this.deployments.updateDeploymentStrategy(id, body.strategy, user.id);
  }

  @Patch(':id/disruption-budget')
  async updateDeploymentDisruptionBudget(
    @Param('id') id: string,
    @Body() body: { minAvailable: number },
    @Request() req
  ) {
    const { user, access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException("Your role doesn't allow you to change the disruption budget");
    }
    return this.deployments.updateDeploymentDisruptionBudget(id, body.minAvailable, user.id);
  }

  @Get(':id/next-steps')
  async getDeploymentNextSteps(@Param('id') id: string, @Request() req) {
    const { user } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.deployments.getDeploymentNextSteps(id, user.id);
  }

  @Patch(':id/devices')
  async updateDeploymentDevices(
    @Param('id') id: string,
    @Body() body: { devices: Record<string, number> | null },
    @Request() req
  ) {
    const { user, access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException("Your role doesn't allow you to change attached devices");
    }
    if (!body || typeof body !== 'object' || !('devices' in body)) {
      throw new BadRequestException('Send devices, or null to detach every device');
    }
    return this.deployments.updateDeploymentDevices(id, body.devices, user.id);
  }

  @Patch(':id/pull-policy')
  async updateDeploymentPullPolicy(
    @Param('id') id: string,
    @Body() body: { imagePullPolicy: 'Always' | 'IfNotPresent' | null },
    @Request() req
  ) {
    const { user, access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException("Your role doesn't allow you to change the image pull policy");
    }
    return this.deployments.updateDeploymentPullPolicy(id, body.imagePullPolicy ?? null, user.id);
  }

  @Patch(':id/image')
  @UseInterceptors(RolloutPinInterceptor)
  async updateDeploymentImage(
    @Param('id') id: string,
    @Body() body: { image: string },
    @Request() req
  ) {
    const { user, access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException("Your role doesn't allow you to change the app image");
    }
    return this.deployments.updateDeploymentImage(id, body.image, user.id);
  }

  @Patch(':id/resources')
  async updateResources(
    @Param('id') id: string,
    @Body() body: { cpuRequestMilli?: number | null; memoryRequestBytes?: number | null },
    @Request() req
  ) {
    const { user, access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException("Your role doesn't allow you to update app resources");
    }
    return this.deployments.updateDeploymentResources(
      id,
      {
        cpuRequestMilli: body.cpuRequestMilli ?? null,
        memoryRequestBytes: body.memoryRequestBytes ?? null
      },
      user.id
    );
  }

  @Get()
  async listDeployments(@Request() req, @Query('orgId') orgId?: string) {
    return this.deployments.listDeploymentsSummary(req.user.sub, orgId);
  }

  @Get('recent-builds')
  async listRecentBuilds(@Request() req, @Query('orgId') orgId?: string) {
    return this.deployments.listRecentBuilds(req.user.sub, orgId);
  }

  @Get('favicon')
  async getFavicon(@Query('domain') domain: string, @Res() res: Response) {
    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return res.status(HttpStatus.BAD_REQUEST).json({ error: 'Invalid domain' });
    }

    const url = await this.faviconService.getFavicon(domain);
    if (url) {
      // 302 (not 301) so a bad target isn't cached permanently by browsers;
      // the explicit Cache-Control still avoids re-hitting this endpoint.
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.redirect(302, url);
    }
    // Cache the miss too, otherwise every dashboard load re-runs the full
    // fetch pipeline for domains that have no favicon. 204 (not 404) so the
    // <img> onerror fallback fires without a console error on every load.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(HttpStatus.NO_CONTENT).end();
  }

  @Get(':id')
  async getDeployment(@Param('id') id: string, @Request() req) {
    const { user, access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.deployments.getDeployment(id, access.canEdit, user.id);
  }

  @Get(':id/logs')
  async getDeploymentLogs(@Param('id') id: string, @Request() req) {
    const { user, access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    const deployment = await this.deployments.getDeployment(id, access.canEdit, user.id);
    return {
      logs: access.canEdit ? deployment.buildLogs || '' : '',
      status: deployment.status,
      buildError: access.canEdit ? deployment.buildError : null
    };
  }

  @Post(':id/cancel')
  async cancelDeploymentBuild(@Param('id') id: string, @Request() req) {
    return this.deployments.cancelDeploymentBuild(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':id')
  async deleteDeployment(@Param('id') id: string, @Request() req) {
    return this.deployments.deleteDeployment(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/pods')
  async getDeploymentPods(@Param('id') id: string, @Request() req, @Query('live') live?: string) {
    const { user } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (live === '1' || live === 'true') {
      const result = await this.deployments.getDeploymentPodsLive(id, user.id);
      return result.pods ?? result;
    }
    return this.deployments.getDeploymentPods(id, user.id);
  }

  @Get(':id/pods-live')
  async getDeploymentPodsLive(@Param('id') id: string, @Request() req) {
    const { user } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.deployments.getDeploymentPodsLive(id, user.id);
  }

  @Get(':id/killed-containers')
  async getKilledContainers(@Param('id') id: string, @Request() req) {
    await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.logCapture.list(id);
  }

  @Get(':id/killed-containers/:entryId/logs')
  async getKilledContainerLogs(
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Request() req
  ) {
    const { access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException('Logs need edit access to the project');
    }
    const entry = await this.logCapture.getLogs(id, entryId);
    if (!entry) throw new NotFoundException('Captured logs expired or not found');
    return entry;
  }

  @Post(':id/build-context')
  @UseInterceptors(RolloutPinInterceptor)
  @UseInterceptors(
    BuildContextUploadSlots,
    FileInterceptor('context', uploadLimits(BUILD_CONTEXT_UPLOAD_BYTES))
  )
  async uploadBuildContext(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req
  ) {
    if (!file) {
      throw new BadRequestException('Attach the build context as multipart field "context"');
    }
    return this.deployments.uploadBuildContextAndBuild(
      id,
      { buffer: file.buffer, size: file.size },
      req.user.externalAuthId || req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Post(':id/rebuild')
  @UseInterceptors(RolloutPinInterceptor)
  @Idempotent()
  async rebuildDeployment(@Param('id') id: string, @Request() req) {
    return this.deployments.rebuildDeployment(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/scale')
  @UseInterceptors(RolloutPinInterceptor)
  async scaleDeployment(
    @Param('id') id: string,
    @Body() body: { replicas: number },
    @Request() req
  ) {
    return this.deployments.scaleDeployment(id, body.replicas, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/stop')
  async stopDeployment(@Param('id') id: string, @Request() req) {
    return this.deployments.stopDeployment(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/start')
  @UseInterceptors(RolloutPinInterceptor)
  async startDeployment(
    @Param('id') id: string,
    @Body() body: { build?: boolean } | undefined,
    @Request() req
  ) {
    return this.deployments.startDeployment(
      id,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      },
      { build: body?.build === true }
    );
  }

  @Post(':id/restart')
  @UseInterceptors(RolloutPinInterceptor)
  @Idempotent()
  async restartDeployment(@Param('id') id: string, @Request() req) {
    return this.deployments.restartDeployment(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/retry-apply')
  async retryApply(@Param('id') id: string, @Request() req) {
    return this.deployments.retryApply(id, req.user.sub);
  }

  @Patch(':id/placement')
  async updateDeploymentPlacement(
    @Param('id') id: string,
    @Body() body: { nodePoolId?: string | null; placementOverride?: unknown },
    @Request() req
  ) {
    return this.deployments.updateDeploymentPlacement(
      id,
      { nodePoolId: body.nodePoolId, placementOverride: body.placementOverride },
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Get(':id/image-history')
  async getImageHistory(@Param('id') id: string, @Request() req) {
    const { access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    const history = await this.deployments.getImageHistory(id, req.user.sub);
    return access.canEdit ? history : history.map((entry) => ({ ...entry, buildLogs: null }));
  }

  @Get(':id/image-history/:imageHistoryId/logs')
  async getImageHistoryLogs(
    @Param('id') id: string,
    @Param('imageHistoryId') imageHistoryId: string,
    @Request() req
  ) {
    const { access } = await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      return { logs: '' };
    }
    return this.deployments.getImageHistoryLogs(id, imageHistoryId, req.user.sub);
  }

  @Post(':id/rollback')
  @UseInterceptors(RolloutPinInterceptor)
  @Idempotent()
  async rollbackToPrevious(
    @Param('id') id: string,
    @Body() body: { restoreDatabases?: boolean },
    @Request() req
  ) {
    const userData = {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    };
    const databaseRestores = body?.restoreDatabases
      ? await this.recovery.restoreBeforeLastDeploy(id, req.user.sub, userData)
      : undefined;
    const result = await this.deployments.rollbackToPrevious(id, req.user.sub, userData);
    return databaseRestores ? { ...result, databaseRestores } : result;
  }

  @Post(':id/rollback/:imageHistoryId')
  @UseInterceptors(RolloutPinInterceptor)
  @Idempotent()
  async rollbackToImage(
    @Param('id') id: string,
    @Param('imageHistoryId') imageHistoryId: string,
    @Body() body: { restoreDatabases?: boolean },
    @Request() req
  ) {
    const userData = {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    };
    const databaseRestores = body?.restoreDatabases
      ? await this.recovery.restoreBeforeLastDeploy(id, req.user.sub, userData)
      : undefined;
    const result = await this.deployments.rollbackToImage(
      id,
      imageHistoryId,
      req.user.sub,
      userData
    );
    return databaseRestores ? { ...result, databaseRestores } : result;
  }

  @Put(':id/env')
  async updateDeploymentEnvVars(
    @Param('id') id: string,
    @Body()
    body: {
      env: { key: string; value?: string | null; secret?: boolean }[];
    },
    @Request() req
  ) {
    return this.deployments.updateDeploymentEnvVars(id, body.env || [], req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Put(':id/build-config')
  async updateDeploymentBuildConfig(
    @Param('id') id: string,
    @Body()
    body: {
      buildFromRoot?: boolean;
      buildWithDepot?: boolean;
      persistentBuildCache?: boolean;
      builderOverride?: 'firecracker' | 'kubernetes' | null;
      buildType?: 'dockerfile' | 'railpack';
      dockerfilePath?: string | null;
      dockerfileTarget?: string | null;
      rootDirectory?: string | null;
      framework?: string | null;
      installCommand?: string | null;
      buildCommand?: string | null;
      startCommand?: string | null;
      outputDirectory?: string | null;
    },
    @Request() req
  ) {
    return this.deployments.updateDeploymentBuildConfig(id, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Patch(':id/name')
  async renameDeployment(@Param('id') id: string, @Body() body: { name?: string }, @Request() req) {
    return this.deployments.renameDeployment(id, body?.name ?? '', req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Put(':id/github-repo')
  async updateDeploymentGitHubRepo(
    @Param('id') id: string,
    @Body()
    body: {
      repoUrl?: string;
      githubRepo?: string;
      branch?: string;
      dockerfilePath?: string;
    },
    @Request() req
  ) {
    return this.deployments.updateDeploymentGitHubRepo(
      id,
      {
        repoUrl: body.repoUrl || body.githubRepo || '',
        branch: body.branch || '',
        dockerfilePath: body.dockerfilePath
      },
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Put(':id/health-check')
  async updateDeploymentHealthCheck(
    @Param('id') id: string,
    @Body()
    body: {
      healthCheckEnabled: boolean;
      healthCheckType: string;
      healthCheckPath?: string;
      healthCheckPort?: number;
      healthCheckCommand?: string;
      livenessEnabled: boolean;
      readinessEnabled: boolean;
      startupEnabled: boolean;
      healthCheckInterval: number;
      healthCheckTimeout: number;
      healthCheckRetries: number;
      startupFailureThreshold: number;
      healthCheckOverride?: boolean;
    },
    @Request() req
  ) {
    return this.deployments.updateDeploymentHealthCheck(id, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Put(':id/volumes')
  async updateDeploymentVolumes(
    @Param('id') id: string,
    @Body()
    body: {
      volumes: {
        name: string;
        type: 'pvc' | 'hostPath' | 'emptyDir';
        mountPath: string;
        pvcName?: string;
        storageSize?: string;
        hostPath?: string;
        readOnly?: boolean;
      }[];
    },
    @Request() req
  ) {
    return this.deployments.updateDeploymentVolumes(id, body.volumes || [], req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @Post(':id/ingresses')
  async createDeploymentIngress(
    @Param('id') id: string,
    @Body()
    body: {
      host: string;
      path?: string;
      serviceName?: string;
      servicePort?: number;
      tlsEnabled?: boolean;
      annotations?: Record<string, string>;
      routes?: { path: string; serviceName: string; servicePort: number }[];
      basicAuth?: {
        enabled: boolean;
        username: string;
        password: string;
      };
    },
    @Request() req
  ) {
    return this.ingress.createDeploymentIngress(id, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Put(':deploymentId/ingresses/:ingressId')
  async updateDeploymentIngress(
    @Param('deploymentId') deploymentId: string,
    @Param('ingressId') ingressId: string,
    @Body()
    body: {
      host: string;
      path?: string;
      serviceName?: string;
      servicePort?: number;
      tlsEnabled?: boolean;
      annotations?: Record<string, string>;
      basicAuth?: {
        enabled: boolean;
        username?: string;
        password?: string;
      };
    },
    @Request() req
  ) {
    return this.ingress.updateDeploymentIngress(deploymentId, ingressId, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':deploymentId/ingresses/:ingressId')
  async deleteDeploymentIngress(
    @Param('deploymentId') deploymentId: string,
    @Param('ingressId') ingressId: string,
    @Request() req
  ) {
    return this.ingress.deleteDeploymentIngress(deploymentId, ingressId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':deploymentId/services')
  async createDeploymentService(
    @Param('deploymentId') deploymentId: string,
    @Body()
    body: {
      name: string;
      ports: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        nodePort?: number;
      }[];
      exposePublic?: boolean;
      domain?: string | null;
    },
    @Request() req
  ) {
    return this.deployments.createDeploymentService(deploymentId, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Put(':deploymentId/services/:serviceId')
  async updateServiceConfiguration(
    @Param('deploymentId') deploymentId: string,
    @Param('serviceId') serviceId: string,
    @Body()
    body: {
      ports?: {
        name?: string;
        containerPort?: number;
        servicePort?: number;
        protocol?: string;
        nodePort?: number;
      }[];
      domain?: string | null;
    },
    @Request() req
  ) {
    return this.deployments.updateServiceConfiguration(
      deploymentId,
      serviceId,
      {
        ports: body.ports,
        domain: body.domain
      },
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Delete(':deploymentId/services/:serviceId')
  async deleteDeploymentService(
    @Param('deploymentId') deploymentId: string,
    @Param('serviceId') serviceId: string,
    @Request() req
  ) {
    return this.deployments.deleteDeploymentService(deploymentId, serviceId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Patch(':deploymentId/services/:serviceId/exposure')
  async updateServiceExposure(
    @Param('deploymentId') deploymentId: string,
    @Param('serviceId') serviceId: string,
    @Body()
    body: {
      exposePublic: boolean;
    },
    @Request() req
  ) {
    return this.deployments.updateServiceExposure(
      deploymentId,
      serviceId,
      Boolean(body.exposePublic),
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Post(':deploymentId/services/:serviceId/ports/:portId/public')
  async enableServicePortPublic(
    @Param('deploymentId') deploymentId: string,
    @Param('serviceId') serviceId: string,
    @Param('portId') portId: string,
    @Request() req
  ) {
    return this.deployments.enableServicePortPublic(deploymentId, serviceId, portId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':deploymentId/services/:serviceId/ports/:portId/public')
  async disableServicePortPublic(
    @Param('deploymentId') deploymentId: string,
    @Param('serviceId') serviceId: string,
    @Param('portId') portId: string,
    @Request() req
  ) {
    return this.deployments.disableServicePortPublic(
      deploymentId,
      serviceId,
      portId,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Get(':id/auto-deploy')
  async getAutoDeployStatus(@Param('id') id: string, @Request() req) {
    await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.deployments.getAutoDeployStatus(id, req.user.sub);
  }

  @Post(':id/auto-deploy/enable')
  async enableAutoDeploy(
    @Param('id') id: string,
    @Body() body: { branch: string; paths?: string[] },
    @Request() req
  ) {
    return this.deployments.enableAutoDeploy(
      id,
      body.branch,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      },
      body.paths
    );
  }

  @Post(':id/auto-deploy/disable')
  async disableAutoDeploy(@Param('id') id: string, @Request() req) {
    return this.deployments.disableAutoDeploy(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/github-deployments')
  async getGitHubDeployments(@Param('id') id: string, @Request() req) {
    await this.projectAccess.assertDeploymentView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.deployments.getGitHubDeployments(id, req.user.sub);
  }

  @Get(':id/webhook-tokens')
  async listWebhookTokens(@Param('id') id: string, @Request() req) {
    return this.webhooksService.listWebhookTokens(id, req.user.sub);
  }

  @Post(':id/webhook-tokens')
  async createWebhookToken(
    @Param('id') id: string,
    @Body() body: { label?: string },
    @Request() req
  ) {
    // H-3: forward the originating API token id (if any) so the webhook is
    // cascade-deleted when the API token is revoked. Session-auth requests
    // leave req.auth.apiTokenId undefined, which we pass through as null.
    const apiTokenId = (req as any).auth?.apiTokenId ?? null;
    return this.webhooksService.createWebhookToken(id, req.user.sub, body?.label, apiTokenId);
  }

  @Delete(':id/webhook-tokens/:tokenId')
  async deleteWebhookToken(
    @Param('id') id: string,
    @Param('tokenId') tokenId: string,
    @Request() req
  ) {
    return this.webhooksService.deleteWebhookToken(id, tokenId, req.user.sub);
  }
}

@Auth()
@Controller('ingresses')
export class IngressesController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectAccess: ProjectAccessService,
    private readonly ingress: IngressService
  ) {}

  @Get(':id')
  async getIngress(@Param('id') id: string, @Request() req) {
    return this.ingress.getIngressById(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }
}

@Auth()
@Controller('databases')
export class DatabasesController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly projectAccess: ProjectAccessService,
    private readonly databases: DatabasesService,
    private readonly metricsService: MetricsService,
    private readonly logCapture: PodLogCaptureService,
    private readonly recovery: DatabaseRecoveryService
  ) {}

  @Post(':id/rotate-password')
  async rotatePassword(@Param('id') id: string, @Request() req) {
    return this.databases.rotateDatabasePassword(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/connection')
  @RequireScope('deploy')
  async getConnection(@Param('id') id: string, @Request() req) {
    return this.databases.revealDatabaseConnection(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  // The post-mortem safety net app deployments already had. A crashing Postgres
  // is replaced fast enough that by the time anyone opens the page the pod that
  // died is gone and its logs with it.
  @Get(':id/killed-containers')
  async getDatabaseKilledContainers(@Param('id') id: string, @Request() req) {
    await this.projectAccess.assertDatabaseView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.logCapture.list(id, 'database');
  }

  @Get(':id/killed-containers/:entryId/logs')
  async getDatabaseKilledContainerLogs(
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Request() req
  ) {
    const { access } = await this.projectAccess.assertDatabaseView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException('Logs need edit access to the project');
    }
    const entry = await this.logCapture.getLogs(id, entryId, 'database');
    if (!entry) throw new NotFoundException('Captured logs expired or not found');
    return entry;
  }

  @Get()
  async listDatabases(@Request() req, @Query('orgId') orgId?: string) {
    return this.projectsService.listDatabasesSummary(req.user.sub, orgId);
  }

  // Instance-wide database limits the create form needs before a database
  // exists. Declared above @Get(':id') so it isn't swallowed by the wildcard.
  @Get('limits')
  async getDatabaseLimits() {
    return { maxReplicas: this.databases.maxReplicas };
  }

  @Get(':id')
  async getDatabase(@Param('id') id: string, @Request() req, @Query('fast') fast?: string) {
    const { user, access } = await this.projectAccess.assertDatabaseView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.databases.getDatabase(id, access.canEdit, user.id, fast === '1');
  }

  @Get(':id/live')
  async getDatabaseLive(@Param('id') id: string, @Request() req) {
    const { user } = await this.projectAccess.assertDatabaseView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    return this.databases.getDatabaseLive(id, user.id);
  }

  @Get(':id/metrics')
  async getDatabaseMetrics(
    @Param('id') id: string,
    @Request() req,
    @Query('start') startStr?: string,
    @Query('end') endStr?: string,
    @Query('step') stepStr?: string
  ) {
    const { user } = await this.projectAccess.assertDatabaseView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    const end = Number(endStr) || Date.now();
    const start = Number(startStr) || end - 60 * 60 * 1000;
    const step = Math.max(1000, Number(stepStr) || 30_000);
    if (end <= start) throw new BadRequestException('end must be > start');

    const db = await this.databases.getDatabase(id, true, user.id);
    // Resolve the pod prefix: CNPG uses clusterName, container mode uses containerName
    const podPrefix = db?.clusterName || db?.containerName;
    if (!db?.namespace || !podPrefix) {
      throw new BadRequestException('Database has no namespace/pod info');
    }

    try {
      const data = await this.metricsService.fetchDatabaseMetrics({
        namespace: db.namespace,
        podPrefix,
        startMs: start,
        endMs: end,
        stepMs: step,
        dbName: db.mode === 'cnpg' ? db.dbName : null
      });
      return { start, end, step, data };
    } catch (err) {
      if (err instanceof MetricsStoreError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  @Patch(':id/resources')
  async updateDatabaseResources(
    @Param('id') id: string,
    @Body() body: { cpuRequestMilli?: number | null; memoryRequestBytes?: number | null },
    @Request() req
  ) {
    const { user, access } = await this.projectAccess.assertDatabaseView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException("Your role doesn't allow you to update database resources");
    }
    return this.projectsService.updateDatabaseResources(
      id,
      {
        cpuRequestMilli: body.cpuRequestMilli ?? null,
        memoryRequestBytes: body.memoryRequestBytes ?? null
      },
      user.id
    );
  }

  @Patch(':id/replicas')
  async updateDatabaseReplicas(
    @Param('id') id: string,
    @Body() body: { replicas?: number },
    @Request() req
  ) {
    return this.databases.updateDatabaseReplicas(id, Number(body?.replicas), req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/stop')
  async stopDatabase(@Param('id') id: string, @Request() req) {
    return this.databases.stopDatabase(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/start')
  async startDatabase(@Param('id') id: string, @Request() req) {
    return this.databases.startDatabase(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/restart')
  @Idempotent()
  async restartDatabase(@Param('id') id: string, @Request() req) {
    return this.databases.restartDatabase(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/query-stats')
  async getDatabaseQueryStats(@Param('id') id: string, @Request() req) {
    const { access } = await this.projectAccess.assertDatabaseView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException('Query statistics need edit access to the project');
    }
    return this.databases.getDatabaseQueryStats(id);
  }

  @Post(':id/query-stats/reset')
  async resetDatabaseQueryStats(@Param('id') id: string, @Request() req) {
    return this.databases.resetDatabaseQueryStats(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Patch(':id/name')
  async renameDatabase(@Param('id') id: string, @Body() body: { name?: string }, @Request() req) {
    return this.databases.renameDatabase(id, body?.name ?? '', req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Patch(':id/storage')
  async expandDatabaseStorage(
    @Param('id') id: string,
    @Body() body: { storageSize?: string },
    @Request() req
  ) {
    const { user, access } = await this.projectAccess.assertDatabaseView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    if (!access.canEdit) {
      throw new ForbiddenException("Your role doesn't allow you to expand database storage");
    }
    return this.projectsService.expandDatabaseStorage(id, String(body.storageSize || ''), user.id);
  }

  @Delete(':id')
  async deleteDatabase(@Param('id') id: string, @Request() req) {
    return this.databases.deleteDatabase(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/provisioning')
  async getProvisioning(@Param('id') id: string, @Request() req) {
    const { user, access } = await this.projectAccess.assertDatabaseView(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
    const provisioning: any = await this.databases.getDatabaseProvisioning(id, user.id);
    return access.canEdit ? provisioning : { ...provisioning, importLogs: null };
  }

  @Get(':id/backups')
  async listBackups(@Param('id') id: string, @Request() req) {
    return this.databases.listDatabaseBackups(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/backups')
  async createBackup(
    @Param('id') id: string,
    @Body() body: { label?: string; type?: 'full' | 'diff' | 'incr' },
    @Request() req
  ) {
    return this.databases.createDatabaseBackup(id, body || {}, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/restore')
  @Idempotent()
  async restoreBackup(
    @Param('id') id: string,
    @Body()
    body: {
      backupId?: string;
      checkpointId?: string;
      at?: string;
      mode?: 'in_place' | 'fork';
      name?: string;
      environmentId?: string;
    },
    @Request() req
  ) {
    return this.recovery.restore(id, body ?? {}, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/extensions')
  async listExtensions(@Param('id') id: string, @Request() req) {
    return this.databases.listDatabaseExtensions(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/extensions')
  async installExtension(
    @Param('id') id: string,
    @Body() body: { name: string; addToPreload?: boolean },
    @Request() req
  ) {
    return this.databases.installDatabaseExtension(id, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':id/extensions/:name')
  async uninstallExtension(
    @Param('id') id: string,
    @Param('name') name: string,
    @Query('removeFromPreload') removeFromPreload: string,
    @Request() req
  ) {
    return this.databases.uninstallDatabaseExtension(
      id,
      { name, removeFromPreload: removeFromPreload === 'true' },
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Get(':id/settings')
  async getSettings(@Param('id') id: string, @Request() req) {
    return this.databases.getDatabaseSettings(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/public')
  async enablePublic(@Param('id') id: string, @Request() req) {
    return this.databases.enableDatabasePublic(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':id/public')
  async disablePublic(@Param('id') id: string, @Request() req) {
    return this.databases.disableDatabasePublic(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/backup-schedule')
  async getBackupSchedule(@Param('id') id: string, @Request() req) {
    return this.databases.getBackupSchedule(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Put(':id/backup-schedule')
  async setBackupSchedule(@Param('id') id: string, @Body() body: { cron: string }, @Request() req) {
    return this.databases.setBackupSchedule(id, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':id/backup-schedule')
  async clearBackupSchedule(@Param('id') id: string, @Request() req) {
    return this.databases.deleteBackupSchedule(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Patch(':id/settings')
  async updateSettings(
    @Param('id') id: string,
    @Body() body: { parameters: Record<string, string>; backupCompression?: string | null },
    @Request() req
  ) {
    return this.databases.updateDatabaseSettings(id, body, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }
}
