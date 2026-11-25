import { maxVolumeBytes, maxVolumeSize } from '../kubernetes/pvc-limits';
import { assertOrgCanCreate } from '../quotas/org-limits';
import { randomBytes } from 'crypto';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Inject,
  forwardRef,
  ForbiddenException
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { K8sWorkloadService } from '../kubernetes/k8s-workload.service';
import { K8sNamespaceService } from '../kubernetes/k8s-namespace.service';
import { K8sCnpgService } from '../kubernetes/k8s-cnpg.service';
import { databaseStatusFor } from '../kubernetes/cnpg-status';
import { R2ProxyService } from '../kubernetes/r2-proxy.service';
import { UsersService } from '../users/users.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { assertUploadUrlOwned } from '../organizations/upload-namespace';
import { DockerService } from '../docker/docker.service';
import { GitHubService } from '../github/github.service';
import { FaviconService } from './favicon.service';
import { NodesService } from '../nodes/nodes.service';
import { QuotasService } from '../quotas/quotas.service';
import { TailscaleService } from '../tailscale/tailscale.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { MembershipCacheService } from '../auth/membership-cache.service';
import { SessionsService } from '../auth/sessions.service';
import { AuthorizationService } from '../auth/authorization.service';
import { AuditService } from '../audit/audit.service';
import { ProjectAccessService } from './project-access.service';
import { EnvironmentsService } from './environments.service';
import { NamespaceTeardownService } from './namespace-teardown.service';
import { DeploymentsService } from './deployments.service';
import {
  formatSlug,
  redactDatabaseForViewer,
  scrubIngress,
  sealDatabaseCredentials,
  assertDeleteConfirmation,
  truncateKeepingSuffix
} from './projects.utils';
import { parseMemory } from '../kubernetes/quantity';
import { projectedFill, sizeToResumeWrites, WRITE_GUARD_EXIT } from '../kubernetes/volume-stats';
import { deriveDbTuning } from '../kubernetes/db-tuning';
import { requestAuthStorage } from '../auth/request-context';
import type { UploadOwner } from '../organizations/upload-references';
import { accountEmail } from '../users/account-scope';

const MAX_NAMESPACE_ATTEMPTS = 20;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kubernetesService: KubernetesService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly k8sNamespace: K8sNamespaceService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly usersService: UsersService,
    private readonly organizationsService: OrganizationsService,
    private readonly dockerService: DockerService,
    @Inject(forwardRef(() => GitHubService))
    private readonly githubService: GitHubService,
    private readonly faviconService: FaviconService,
    @Inject(forwardRef(() => NodesService))
    private readonly nodesService: NodesService,
    @Inject(forwardRef(() => QuotasService))
    private readonly quotasService: QuotasService,
    private readonly tailscaleService: TailscaleService,
    private readonly membershipCache: MembershipCacheService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    private readonly r2Proxy: R2ProxyService,
    private readonly access: ProjectAccessService,
    @Inject(forwardRef(() => DeploymentsService))
    private readonly deployments: DeploymentsService,
    private readonly environments: EnvironmentsService,
    private readonly teardown: NamespaceTeardownService,
    private readonly crypto: SecretCryptoService
  ) {}

  private scrubCreatorForViewer<C extends { email?: string | null }>(creator: C | null): C | null {
    return creator ? { ...creator, email: null } : creator;
  }

  private scrubMembersForViewer<
    M extends {
      user?: { email?: string | null } | null;
      adder?: { email?: string | null } | null;
    }
  >(members: M[] | null | undefined): M[] {
    if (!members) return [] as M[];
    return members.map((m) => ({
      ...m,
      user: m.user ? { ...m.user, email: null } : m.user,
      adder: m.adder ? { ...m.adder, email: null } : m.adder
    }));
  }

  /**
   * Strip secrets out of a deployment payload for project viewers (read-only role).
   * - Env var values are nulled (keys remain).
   * - Build logs/errors are nulled (often leak secrets via stack traces / cmdline).
   */
  /**
   * NOTE: a no-op. Resolving a per-deployment favicon here would fire N sequential
   * HTTP/disk lookups on every page load and block `getProjectBySlugsFull` and
   * `listProjects`, so the frontend decides its own fallback (Folder icon) when
   * `project.icon` is null.
   */
  private async resolveProjectIconFallback(
    _deployments: { ingresses?: { host?: string | null }[] | null }[] | null | undefined
  ): Promise<string | null> {
    return null;
  }

  /**
   * Auto banner: when a project has no manually-set backgroundImage, fall
   * back to the og:image of one of its deployments' sites (cached in R2 by
   * FaviconService). Response-only, never persisted, so a manual banner
   * always wins and clearing it reverts to the auto one.
   */
  private async resolveProjectBannerFallback(
    deployments: { ingresses?: { host?: string | null }[] | null }[] | null | undefined
  ): Promise<string | null> {
    try {
      const hosts = (deployments ?? [])
        .map((d) => d.ingresses?.[0]?.host?.split('/')[0])
        .filter(Boolean) as string[];
      if (hosts.length === 0) return null;
      const banners = await this.faviconService.peekBanners(hosts);
      return hosts.map((h) => banners[h]).find(Boolean) ?? null;
    } catch {
      return null;
    }
  }

  // Tenant namespaces are `{org-slug}-{project-slug}`. With no blocklist an
  // org named e.g. `kube` with project `system` would mint `kube-system`,
  // the existing-namespace 409 check below blocks collisions with namespaces
  // that already exist, but that's fragile (race on first install, control-
  // plane components in different clusters, etc). This list mirrors the
  // platform-owned namespaces; analogous to RESERVED_HOSTS for ingress.
  private static readonly RESERVED_NAMESPACES = new Set<string>([
    'kube-system',
    'kube-public',
    'kube-node-lease',
    'default',
    'orchard',
    'orchard-builders',
    'orchard-r2-proxy',
    'orchard-metrics',
    'orchard-scans',
    'orchard-fc-builders',
    'orchard-object-storage',
    'orchard-sandboxes',
    'orchard-restore-drills',
    'cnpg-system',
    'traefik',
    'harbor',
    'postgresql',
    'network',
    'longhorn-system',
    'flux-system',
    'monitoring',
    'cert-manager'
  ]);

  private async freshNamespace(parts: string[]): Promise<string> {
    for (let attempt = 0; attempt < MAX_NAMESPACE_ATTEMPTS; attempt++) {
      const namespace = this.buildNamespace(parts, `-${randomBytes(3).toString('hex')}`);
      const taken =
        (await this.prisma.project.findFirst({
          where: { namespace },
          select: { id: true }
        })) ??
        (await this.prisma.environment.findUnique({
          where: { namespace },
          select: { id: true }
        })) ??
        (await this.prisma.retiredNamespace.findUnique({
          where: { namespace },
          select: { namespace: true }
        })) ??
        (await this.prisma.deletedDatabase.findFirst({
          where: { namespace, purgedAt: null, restoredAs: null },
          select: { id: true }
        }));
      if (!taken) return namespace;
    }
    throw new BadRequestException("Couldn't pick a namespace for this project. Try again.");
  }

  private buildNamespace(parts: string[], suffix = '') {
    const sanitized = parts.map((part) => formatSlug(part)).filter((part) => part.length > 0);

    const namespace = sanitized.length ? truncateKeepingSuffix(sanitized.join('-'), suffix) : '';

    if (!namespace) {
      throw new BadRequestException('Failed to build namespace');
    }

    if (ProjectsService.RESERVED_NAMESPACES.has(namespace)) {
      throw new ConflictException("This project name isn't available");
    }

    return namespace;
  }

  static normalizeRepositoryUrl(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new BadRequestException('Repository URL must be a valid http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Repository URL must be a valid http(s) URL');
    }
    return trimmed;
  }

  async createProject(
    organizationId: string,
    data: {
      name: string;
      slug?: string;
      description?: string;
      repositoryUrl?: string;
      icon?: string;
      backgroundImage?: string;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId }
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    // Org membership + creation gate. Guests can be invited into an org per
    // project but explicitly cannot spawn new projects of their own.
    await this.authz.requireOrgCanCreateProjects(organizationId, user.id);
    await assertOrgCanCreate(this.prisma, organizationId, 'projects');

    assertUploadUrlOwned(data.icon?.trim(), null, null, 'Icon');
    assertUploadUrlOwned(data.backgroundImage?.trim(), null, null, 'Background image');
    const name = String(data.name || '').trim();

    if (!name) {
      throw new BadRequestException('Project name is required');
    }

    const slugExplicitlyProvided = !!(data.slug && data.slug.trim());
    const slugSource = slugExplicitlyProvided ? data.slug! : name;
    const baseSlug = formatSlug(slugSource);

    if (!baseSlug) {
      throw new BadRequestException("Project slug can't be empty");
    }

    let slug = baseSlug;
    let suffixCounter = 0;
    while (
      await this.prisma.project.findUnique({
        where: { organizationId_slug: { organizationId, slug } }
      })
    ) {
      if (slugExplicitlyProvided) {
        throw new BadRequestException('A project with this slug already exists');
      }
      suffixCounter += 1;
      slug = `${baseSlug}-${suffixCounter}`;
    }
    const namespace = await this.freshNamespace([organization.slug, slug]);

    const adminRole = await this.prisma.role.findFirst({ where: { name: 'admin' } });

    if (!adminRole) {
      throw new InternalServerErrorException(
        'The "admin" project role is missing; the database hasn\'t been fully migrated'
      );
    }

    const namespaceResult = await this.k8sNamespace.createNamespace(namespace, namespace);

    if (!namespaceResult.created) {
      throw new BadRequestException('Kubernetes namespace already exists');
    }

    const project = await this.prisma.project.create({
      data: {
        organizationId,
        name,
        slug,
        description: data.description?.trim() || null,
        repositoryUrl: ProjectsService.normalizeRepositoryUrl(data.repositoryUrl),
        icon: data.icon?.trim() || null,
        backgroundImage: data.backgroundImage?.trim() || null,
        namespace,
        createdBy: user.id,
        ownerId: user.id,
        members: {
          create: {
            userId: user.id,
            roleId: adminRole.id,
            addedBy: user.id
          }
        }
      },
      include: {
        organization: true,
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true
          }
        },
        _count: {
          select: {
            deployments: true
          }
        }
      }
    });

    // Create the default production environment. It reuses the namespace we
    // just provisioned (no second k8s namespace) so the project's resources
    // land in it directly.
    await this.environments.ensureDefaultEnvironment(project.id).catch((err) => {
      console.error('[Projects] default environment creation failed:', err);
    });

    // Push the effective ResourceQuota/LimitRange to the new namespace.
    await this.quotasService.applyProjectQuota(project.id).catch((err) => {
      console.error('[Projects] initial applyProjectQuota failed:', err);
    });

    void this.audit.log({
      action: 'project.created',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId,
      projectId: project.id,
      targetType: 'project',
      targetId: project.id,
      targetLabel: project.name,
      metadata: { slug: project.slug, namespace: project.namespace }
    });

    return project;
  }

  async updateDatabaseResources(
    databaseId: string,
    data: { cpuRequestMilli: number | null; memoryRequestBytes: number | null },
    userId?: string
  ) {
    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: { project: true }
    });
    if (!database) throw new NotFoundException('Database not found');

    // Defense-in-depth: re-assert project-edit even though the controller already did.
    if (userId) {
      await this.authz.requireProjectEdit(database.projectId, userId, 'update database resources');
    }

    if (database.mode !== 'cnpg' || !database.clusterName || !database.namespace) {
      throw new BadRequestException("Database doesn't support resource updates");
    }

    if (database.importBoosted) {
      throw new BadRequestException(
        "You can't change resources during the initial import. Try again when it finishes."
      );
    }

    if (await this.quotasService.limitsOff()) {
      return sealDatabaseCredentials(
        await this.prisma.database.update({
          where: { id: databaseId },
          data: {
            cpuRequestMilli: data.cpuRequestMilli,
            memoryRequestBytes:
              data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null
          }
        })
      );
    }

    const resolved = await this.quotasService.resolvePodResources(
      database.projectId,
      {
        cpuRequestMilli: data.cpuRequestMilli,
        memoryRequestBytes: data.memoryRequestBytes
      },
      'postgres'
    );
    // The new size applies to every instance in the cluster, not just the primary.
    const instances = Math.max(1, database.replicas ?? 1);
    const requested = {
      cpuMilli: resolved.cpuMilli * instances,
      memoryBytes: resolved.memoryBytes * instances
    };
    await this.quotasService.enforceOrgCapForNewPod(database.project.organizationId, requested);
    const current = await this.quotasService.resolvePodResources(
      database.projectId,
      {
        cpuRequestMilli: database.cpuRequestMilli,
        memoryRequestBytes:
          database.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null
      },
      'postgres'
    );
    await this.quotasService.enforceProjectCapForNewPod(database.projectId, {
      cpuMilli: Math.max(0, (resolved.cpuMilli - current.cpuMilli) * instances),
      memoryBytes: Math.max(0, (resolved.memoryBytes - current.memoryBytes) * instances),
      pods: 0
    });
    await this.quotasService.enforceMemberAllowanceForNewPod(
      database.project.organizationId,
      database.project.ownerId,
      requested
    );

    await this.k8sCnpg.updateCnpgClusterResources(
      database.namespace,
      database.clusterName,
      resolved
    );

    // Re-derive everything the user hasn't taken ownership of. Anything present
    // in pgParameters / backupCompression is theirs and is passed straight
    // through untouched.
    const tuning = deriveDbTuning({
      memoryLimitBytes: resolved.memoryBytes,
      overrides: {
        sharedBuffers: (database.pgParameters as Record<string, string> | null)?.shared_buffers,
        backupCompression: database.backupCompression
      }
    });
    await this.k8sCnpg
      .applyCnpgDerivedTuning(database.namespace, database.clusterName, tuning)
      .catch((e: any) => {
        // The resource change already landed; failing to retune is worth a log,
        // not an error the user has to retry the whole resize for.
        console.warn(`[DB/tuning] Failed to retune ${database.clusterName}: ${e?.message ?? e}`);
      });

    const updated = await this.prisma.database.update({
      where: { id: databaseId },
      data: {
        cpuRequestMilli: data.cpuRequestMilli,
        memoryRequestBytes:
          data.memoryRequestBytes != null ? BigInt(data.memoryRequestBytes) : null,
        // Pod is being force-recreated by updateCnpgClusterResources: surface this
        // in the UI until the new pod is ready (the getDatabase reconciler flips
        // it back to 'ready' once liveStatus.ready is true).
        status: 'restarting'
      }
    });
    void this.audit.log({
      action: 'database.resources.updated',
      actorUserId: userId ?? null,
      organizationId: database.project.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: databaseId,
      targetLabel: database.name,
      metadata: {
        cpuMilli: [database.cpuRequestMilli ?? null, data.cpuRequestMilli],
        memoryBytes: [
          database.memoryRequestBytes != null ? Number(database.memoryRequestBytes) : null,
          data.memoryRequestBytes
        ]
      }
    });
    return sealDatabaseCredentials(updated);
  }

  async expandDatabaseStorage(databaseId: string, storageSize: string, userId?: string) {
    const database = await this.prisma.database.findUnique({
      where: { id: databaseId },
      include: { project: true }
    });
    if (!database) throw new NotFoundException('Database not found');

    if (userId) {
      await this.authz.requireProjectEdit(database.projectId, userId, 'expand database storage');
    }

    if (database.mode !== 'cnpg' || !database.clusterName || !database.namespace) {
      throw new BadRequestException("Database doesn't support storage expansion");
    }

    const size = String(storageSize || '').trim();
    if (!/^\d+(Mi|Gi|Ti)$/.test(size)) {
      throw new BadRequestException('Storage size must be a Kubernetes quantity like "10Gi"');
    }
    if (parseMemory(size) > maxVolumeBytes()) {
      throw new BadRequestException(`Storage size can't exceed ${maxVolumeSize() ?? size}`);
    }

    const { previousSize, archivingFailure, resizedVolumes, failedVolumes } =
      await this.k8sCnpg.expandCnpgClusterStorage(database.namespace, database.clusterName, size);

    await this.prisma.database.update({
      where: { id: databaseId },
      data: { storageSize: size }
    });

    void this.audit.log({
      action: 'database.storage.expanded',
      actorUserId: userId ?? null,
      organizationId: database.project.organizationId,
      projectId: database.projectId,
      targetType: 'database',
      targetId: databaseId,
      targetLabel: database.name,
      metadata: { storageSize: [previousSize, size], resizedVolumes, failedVolumes }
    });

    const warnings: string[] = [];
    if (failedVolumes.length > 0) {
      warnings.push(
        `The database now asks for ${size}, but Orchard couldn't resize ${failedVolumes.join(', ')} directly. They grow later.`
      );
    }
    const writesPaused = (database.clusterStatus as { writeGuard?: boolean } | null)?.writeGuard;
    if (writesPaused && database.volumeUsedBytes != null && database.volumeCapacityBytes != null) {
      const usage = {
        usedBytes: Number(database.volumeUsedBytes),
        capacityBytes: Number(database.volumeCapacityBytes)
      };
      const resumeAt = sizeToResumeWrites(usage, previousSize);
      const fill = projectedFill(usage, previousSize, size);
      if (resumeAt && fill != null && fill >= WRITE_GUARD_EXIT) {
        warnings.push(
          `Writes stay paused until the volume is under ${WRITE_GUARD_EXIT * 100}% full, and at ${size} it is still about ${Math.round(fill * 100)}% full. Expand to at least ${resumeAt} to resume writes.`
        );
      }
    }
    if (archivingFailure) {
      warnings.push(
        `WAL archiving is failing (${archivingFailure}). Postgres can't recycle WAL while archiving fails, so the volume keeps filling at any size. Fix or turn off backups to stop this.`
      );
    }

    return {
      previousSize,
      storageSize: size,
      resizedVolumes,
      warning: warnings.length > 0 ? warnings.join(' ') : null
    };
  }

  async deleteProject(
    projectId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    confirmName?: unknown
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { organization: true, environments: { select: { namespace: true } } }
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    await this.authz.requireProjectDelete(project.id, user.id);
    assertDeleteConfirmation(project.name, confirmName, 'project');
    return this.destroyProject(project, { userId: user.id, email: user.email ?? undefined }, {});
  }

  async deleteProjectFromCluster(
    projectId: string,
    cause: { reason: string; source: string; namespace: string }
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { organization: true, environments: { select: { namespace: true } } }
    });
    if (!project) return null;
    return this.destroyProject(project, null, cause);
  }

  private async destroyProject(
    project: {
      id: string;
      name: string;
      slug: string;
      namespace: string;
      organizationId: string;
      environments: { namespace: string }[];
    },
    actor: { userId: string; email?: string } | null,
    cause: Record<string, unknown>
  ) {
    const projectId = project.id;

    // Capture guests on this project who'll be orphaned by its deletion so we
    // can drop their OrganizationMember rows below. Spec: a guest with zero
    // project memberships must not persist in the org. removeProjectMember
    // handles this case directly, but a project delete cascades through the DB
    // and bypasses that path, so we have to do it explicitly here.
    const guestsOnProject = await this.prisma.projectMember.findMany({
      where: {
        projectId,
        user: {
          organizationMembers: {
            some: { organizationId: project.organizationId, role: 'guest' }
          }
        }
      },
      select: { userId: true }
    });

    const summary = await this.teardown.teardown({
      projectId: project.id,
      organizationId: project.organizationId,
      namespace: project.namespace,
      reason: 'project.deleted',
      actor: actor ?? { userId: undefined },
      keepData: actor === null
    });

    const namespaces = new Set<string>([
      project.namespace,
      ...project.environments.map((env) => env.namespace)
    ]);
    for (const namespace of namespaces) {
      if (namespace === project.namespace) {
        await this.k8sNamespace.deleteNamespace(namespace);
        continue;
      }
      await this.tailscaleService.cleanupNamespace(namespace).catch(() => {});
      await this.k8sNamespace
        .deleteNamespace(namespace)
        .catch((e) => console.error(`[Projects] deleteNamespace(${namespace}) failed:`, e));
    }

    // Atomically delete the project and orphan-clean any affected guests.
    // Without the surrounding transaction, a concurrent add to another project
    // can leave a guest tied to zero projects in the org, or remove a guest
    // that was just legitimately attached elsewhere.
    const droppedGuests: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      await tx.project.deleteMany({ where: { id: projectId } });

      for (const g of guestsOnProject) {
        const remaining = await tx.projectMember.count({
          where: { userId: g.userId, project: { organizationId: project.organizationId } }
        });
        if (remaining === 0) {
          const res = await tx.organizationMember.deleteMany({
            where: {
              organizationId: project.organizationId,
              userId: g.userId,
              role: 'guest'
            }
          });
          if (res.count > 0) droppedGuests.push(g.userId);
        }
      }
    });

    for (const userId of droppedGuests) {
      this.membershipCache.revoked(project.organizationId, userId);
    }

    if (droppedGuests.length > 0) {
      await this.prisma.apiToken.deleteMany({
        where: {
          userId: { in: droppedGuests },
          restrictedProjectIds: { has: projectId }
        }
      });
    }

    void this.audit.log({
      action: 'project.deleted',
      actorUserId: actor?.userId,
      actorEmail: actor?.email,
      organizationId: project.organizationId,
      targetType: 'project',
      targetId: projectId,
      targetLabel: project.name,
      metadata: {
        slug: project.slug,
        namespace: project.namespace,
        namespaces: [...namespaces],
        ...cause,
        ...summary
      }
    });

    return {
      success: true,
      projectId,
      namespace: project.namespace,
      ...summary
    };
  }

  async getProject(
    projectId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // M-1: authorize FIRST with a cheap indexed lookup. Loading the project
    // with every relation before the access check turns non-member latency
    // into an existence oracle: a real project ID runs a multi-join query;
    // a random UUID returns after a single index miss. `requireProjectView`
    // throws the same 404 either way, so the timing matches the body.
    await this.authz.requireProjectView(projectId, user.id);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        organization: true,
        owner: { select: { username: true } },
        members: {
          include: {
            role: true,
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
        },
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true
          }
        },
        deployments: {
          include: {
            services: {
              include: {
                ports: true
              }
            },
            ingresses: {
              include: {
                service: true
              }
            },
            envVars: true,
            _count: {
              select: {
                pods: true,
                services: true
              }
            }
          }
        },
        ingresses: {
          select: {
            id: true,
            name: true,
            host: true,
            tlsSecretName: true
          }
        },
        databases: {
          select: {
            id: true,
            name: true,
            dbName: true,
            status: true,
            mode: true,
            createdAt: true,
            templateInstanceId: true
          }
        },
        templateInstances: {
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            template: {
              select: {
                id: true,
                name: true,
                displayName: true,
                icon: true,
                category: true
              }
            },
            _count: {
              select: {
                deployments: true,
                databases: true,
                ingresses: true
              }
            }
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const { access } = await this.access.assertProjectAccess(
      project.id,
      user.id,
      project.organizationId
    );

    const deploymentsWithComputedStatus = await Promise.all(
      project.deployments.map(async (deployment) => {
        const computedStatus = await this.deployments.computeDeploymentStatus(deployment);

        const merged = DeploymentsService.redactSecretEnv({
          ...deployment,
          ingresses: deployment.ingresses.map((ing) => scrubIngress(ing)),
          status: computedStatus
        });
        return access.canEdit ? merged : this.deployments.scrubDeploymentForViewer(merged);
      })
    );

    const icon = project.icon ?? (await this.resolveProjectIconFallback(project.deployments));
    const backgroundImage =
      project.backgroundImage ?? (await this.resolveProjectBannerFallback(project.deployments));
    const membersWithOrgRole = await this.attachOrgRoleToMembers(
      project.organizationId,
      project.members
    );
    const safeMembers = access.canEdit
      ? membersWithOrgRole
      : this.scrubMembersForViewer(membersWithOrgRole as any);

    return {
      ...project,
      creator: access.canEdit ? project.creator : this.scrubCreatorForViewer(project.creator),
      icon,
      backgroundImage,
      members: safeMembers,
      deployments: deploymentsWithComputedStatus,
      pendingTransfer: await this.getPendingProjectTransfer(project.id, {
        canEdit: access.canEdit,
        userId: user.id
      }),
      currentUserRole: {
        orgRole: access.orgRole,
        projectRole: access.projectRoleName,
        source: access.source,
        canView: access.canView,
        canEdit: access.canEdit,
        canManageMembers: access.canManageMembers,
        canDelete: access.canDelete,
        canTransferOwnership: this.authz.canTransferProjectOwnership(
          access,
          project.ownerId,
          user.id
        )
      }
    };
  }

  /**
   * Each ProjectMember row only carries the project-level role. To render the
   * "Guest" pill in the UI we also need the user's org-level role for each
   * member. One batched query, then merged in-place.
   */
  private async attachOrgRoleToMembers<M extends { user: { id: string } }>(
    organizationId: string,
    members: M[]
  ): Promise<(M & { orgRole: string | null })[]> {
    if (members.length === 0) return [] as (M & { orgRole: string | null })[];
    const userIds = members.map((m) => m.user.id);
    const orgMembers = await this.prisma.organizationMember.findMany({
      where: { organizationId, userId: { in: userIds } },
      select: { userId: true, role: true }
    });
    const byUserId = new Map(orgMembers.map((om) => [om.userId, om.role]));
    return members.map((m) => ({ ...m, orgRole: byUserId.get(m.user.id) ?? null }));
  }

  async updateProject(
    projectId: string,
    data: {
      name?: string;
      description?: string;
      repositoryUrl?: string | null;
      icon?: string | null;
      backgroundImage?: string | null;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');
    await this.authz.requireProjectEdit(projectId, user.id, 'update this project');

    const updates: Prisma.ProjectUpdateInput = {};
    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new BadRequestException("Project name can't be empty");
      updates.name = name;
    }
    if (data.description !== undefined) {
      updates.description = data.description?.toString().trim() || null;
    }
    if (data.repositoryUrl !== undefined) {
      updates.repositoryUrl = ProjectsService.normalizeRepositoryUrl(data.repositoryUrl);
    }
    if (data.icon !== undefined) {
      const v = data.icon?.toString().trim();
      assertUploadUrlOwned(v, `project-icons/${projectId}`, project.icon, 'Icon');
      updates.icon = v || null;
    }
    if (data.backgroundImage !== undefined) {
      const v = data.backgroundImage?.toString().trim();
      assertUploadUrlOwned(
        v,
        `project-backgrounds/${projectId}`,
        project.backgroundImage,
        'Background image'
      );
      updates.backgroundImage = v || null;
    }

    const before = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true, description: true, repositoryUrl: true, organizationId: true }
    });
    const updated = await this.prisma.project.update({
      where: { id: projectId },
      data: updates
    });

    const meta = this.audit.diff(before as any, updates, ['name', 'description', 'repositoryUrl']);
    if (meta) {
      void this.audit.log({
        action: 'project.updated',
        actorUserId: user.id,
        actorEmail: user.email,
        organizationId: before?.organizationId,
        projectId,
        targetType: 'project',
        targetId: projectId,
        targetLabel: updated.name,
        metadata: meta
      });
    }

    return updated;
  }

  async uploadProjectAsset(
    projectId: string,
    field: 'icon' | 'backgroundImage',
    file: Express.Multer.File,
    storageService: {
      uploadImage: (f: Express.Multer.File, folder: string) => Promise<string>;
      deleteReplaced: (url: string, namespace: string, owner: UploadOwner) => Promise<void>;
    },
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const existing = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!existing) throw new NotFoundException('Project not found');
    await this.authz.requireProjectEdit(projectId, user.id, 'update project assets');

    const namespace = `${field === 'icon' ? 'project-icons' : 'project-backgrounds'}/${projectId}`;
    const url = await storageService.uploadImage(file, namespace);

    const previous = existing[field];
    if (previous) {
      try {
        await storageService.deleteReplaced(previous, namespace, {
          model: 'project',
          id: projectId,
          column: field
        });
      } catch (e) {
        console.error(`Failed to delete old ${field}:`, e);
      }
    }

    return this.prisma.project.update({
      where: { id: projectId },
      data: { [field]: url }
    });
  }

  async addProjectMember(
    projectId: string,
    email: string,
    roleName: string,
    addedByClerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const adder = await this.usersService.findOrCreateByClerkId(addedByClerkId, userData);
    if (!adder) throw new NotFoundException('User adding member not found');

    await this.access.assertProjectAdmin(projectId, adder.id);

    const normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail) throw new BadRequestException('Email is required');

    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new BadRequestException(`Invalid role: ${roleName}`);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true, name: true }
    });
    if (!project) throw new NotFoundException('Project not found');

    const user = await this.prisma.user.findUnique({ where: accountEmail(normalizedEmail) });
    const orgMember = user
      ? await this.prisma.organizationMember.findUnique({
          where: {
            organizationId_userId: { organizationId: project.organizationId, userId: user.id }
          }
        })
      : null;

    // Not in this org yet: send a project-targeted guest invitation. Joining an
    // org is the recipient's decision, whether or not they already have an
    // account. Accepting creates the guest membership and this project
    // membership in one step, and the answer doesn't reveal whether the address
    // has an account.
    if (!user || !orgMember) {
      const invitation = await this.organizationsService.createProjectGuestInvitation({
        organizationId: project.organizationId,
        projectId,
        projectName: project.name,
        projectRoleId: role.id,
        projectRoleName: role.name,
        email: normalizedEmail,
        inviter: adder
      });
      return { invited: true, invitation };
    }

    const existing = await this.prisma.projectMember.findFirst({
      where: { projectId, userId: user.id }
    });
    if (existing) throw new BadRequestException('User is already a member of this project');

    const created = await this.prisma.projectMember.create({
      data: {
        projectId,
        userId: user.id,
        roleId: role.id,
        addedBy: adder.id
      },
      include: {
        role: true,
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

    void this.audit.log({
      action: 'project.member.added',
      actorUserId: adder.id,
      actorEmail: adder.email,
      organizationId: project.organizationId,
      projectId,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: { role: role.name }
    });

    return created;
  }

  async revokeProjectInvitation(
    projectId: string,
    invitationId: string,
    revokedByClerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const revoker = await this.usersService.findOrCreateByClerkId(revokedByClerkId, userData);
    if (!revoker) throw new NotFoundException('User not found');

    await this.access.assertProjectAdmin(projectId, revoker.id);

    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId },
      select: { id: true, email: true, projectId: true, organizationId: true }
    });
    if (!invitation || invitation.projectId !== projectId) {
      throw new NotFoundException('Invitation not found for this project');
    }

    await this.prisma.organizationInvitation.delete({ where: { id: invitationId } });

    void this.audit.log({
      action: 'project.invitation.revoked',
      actorUserId: revoker.id,
      actorEmail: revoker.email,
      organizationId: invitation.organizationId,
      projectId,
      targetType: 'invitation',
      targetId: invitation.id,
      targetLabel: invitation.email
    });

    return { success: true };
  }

  async removeProjectMember(
    projectId: string,
    memberId: string,
    removedByClerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const remover = await this.usersService.findOrCreateByClerkId(removedByClerkId, userData);
    if (!remover) throw new NotFoundException('User removing member not found');

    await this.access.assertProjectAdmin(projectId, remover.id);

    const member = await this.prisma.projectMember.findUnique({
      where: { id: memberId }
    });
    if (!member || member.projectId !== projectId) {
      throw new NotFoundException('Member not found in this project');
    }

    const adminRole = await this.prisma.role.findUnique({ where: { name: 'admin' } });
    if (adminRole && member.roleId === adminRole.id) {
      const adminCount = await this.prisma.projectMember.count({
        where: { projectId, roleId: adminRole.id }
      });
      if (adminCount <= 1) {
        throw new BadRequestException("You can't remove the last admin of a project");
      }
    }

    const memberFull = await this.prisma.projectMember.findUnique({
      where: { id: memberId },
      include: { user: { select: { id: true, email: true } }, role: { select: { name: true } } }
    });

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true }
    });

    // Atomically delete the project membership and, if the user is a guest
    // with no remaining project memberships in this org, drop the org
    // membership too. Concurrent add/remove on the same guest can otherwise
    // leave an orphaned zero-project guest in the org or remove a guest who
    // has just been added to another project.
    let guestDropped = false;
    await this.prisma.$transaction(async (tx) => {
      await tx.projectMember.delete({ where: { id: memberId } });

      if (!project) return;

      const orgMember = await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: project.organizationId, userId: member.userId }
        }
      });
      if (orgMember?.role !== 'guest') return;

      const remaining = await tx.projectMember.count({
        where: { userId: member.userId, project: { organizationId: project.organizationId } }
      });
      if (remaining === 0) {
        await tx.organizationMember.delete({ where: { id: orgMember.id } });
        guestDropped = true;
      }
    });

    if (project) {
      this.membershipCache.revoked(project.organizationId, member.userId);
    } else if (guestDropped) {
      this.membershipCache.invalidateInternalUserId(member.userId);
    }

    // Token-scope cleanup: any API tokens this user holds that were restricted
    // to this specific project should not survive their removal from it.
    await this.prisma.apiToken.deleteMany({
      where: {
        userId: member.userId,
        restrictedProjectIds: { has: projectId }
      }
    });

    void this.audit.log({
      action: 'project.member.removed',
      actorUserId: remover.id,
      actorEmail: remover.email,
      organizationId: project?.organizationId,
      projectId,
      targetType: 'user',
      targetId: memberFull?.user.id ?? member.userId,
      targetLabel: memberFull?.user.email,
      metadata: { role: memberFull?.role.name ?? null }
    });

    return { success: true, message: 'Member removed from project' };
  }

  async updateProjectMemberRole(
    projectId: string,
    memberId: string,
    roleName: string,
    updatedByClerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const updater = await this.usersService.findOrCreateByClerkId(updatedByClerkId, userData);
    if (!updater) throw new NotFoundException('User updating role not found');

    await this.access.assertProjectAdmin(projectId, updater.id);

    const role = await this.prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new BadRequestException(`Invalid role: ${roleName}`);

    const member = await this.prisma.projectMember.findUnique({ where: { id: memberId } });
    if (!member || member.projectId !== projectId) {
      throw new NotFoundException('Member not found in this project');
    }

    const adminRole = await this.prisma.role.findUnique({ where: { name: 'admin' } });
    if (adminRole && member.roleId === adminRole.id && role.id !== adminRole.id) {
      const adminCount = await this.prisma.projectMember.count({
        where: { projectId, roleId: adminRole.id }
      });
      if (adminCount <= 1) {
        throw new BadRequestException("You can't demote the last admin of a project");
      }
    }

    const oldRole = await this.prisma.role.findUnique({
      where: { id: member.roleId },
      select: { name: true }
    });
    const updated = await this.prisma.projectMember.update({
      where: { id: memberId },
      data: { roleId: role.id },
      include: {
        role: true,
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

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { organizationId: true }
    });
    void this.audit.log({
      action: 'project.member.role_changed',
      actorUserId: updater.id,
      actorEmail: updater.email,
      organizationId: project?.organizationId,
      projectId,
      targetType: 'user',
      targetId: member.userId,
      targetLabel: updated.user.email,
      metadata: { role: [oldRole?.name ?? null, role.name] }
    });

    return updated;
  }

  private static readonly TRANSFER_REQUEST_TTL_DAYS = 7;

  private static readonly TRANSFER_REQUEST_SHAPE = {
    id: true,
    status: true,
    createdAt: true,
    expiresAt: true,
    project: {
      select: {
        id: true,
        name: true,
        slug: true,
        organization: { select: { id: true, name: true, slug: true } }
      }
    },
    from: {
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        imageUrl: true
      }
    },
    to: {
      select: {
        id: true,
        email: true,
        username: true,
        firstName: true,
        lastName: true,
        imageUrl: true
      }
    }
  } as const;

  /**
   * The live transfer offer for a project, if any. Folded into the project
   * payload so both sides of the handshake see the same banner: the sender
   * gets a "waiting on them" state, the recipient gets accept/decline.
   *
   * Pass `viewer` whenever this goes into a response. Viewers already have
   * member emails nulled by scrubMembersForViewer, and the two parties to a
   * transfer are members, so without the same treatment here the banner would
   * hand a read-only member the emails the members list just withheld. The
   * recipient is the exception: the offer is addressed to them.
   */
  async getPendingProjectTransfer(
    projectId: string,
    viewer?: { canEdit: boolean; userId: string }
  ) {
    const transfer = await this.prisma.projectTransferRequest.findFirst({
      where: { projectId, status: 'pending', expiresAt: { gt: new Date() } },
      select: ProjectsService.TRANSFER_REQUEST_SHAPE
    });
    if (!transfer || !viewer) return transfer;
    if (viewer.canEdit || transfer.to.id === viewer.userId) return transfer;
    return {
      ...transfer,
      from: { ...transfer.from, email: null },
      to: { ...transfer.to, email: null }
    };
  }

  /**
   * Validate a candidate new owner. Project membership is the invariant the
   * rest of the flow leans on: it proves they are in the org (so they have an
   * allowance to be billed against) and that they can reach the project they
   * would become accountable for.
   */
  private async resolveTransferRecipient(
    projectId: string,
    target: { userId?: string; email?: string },
    notAMemberMessage = 'The new owner must be a member of this project. Add them first, then request the transfer.'
  ) {
    const targetUserId = target.userId?.trim();
    const targetEmail = target.email?.toLowerCase().trim();
    if (!targetUserId && !targetEmail) {
      throw new BadRequestException('A userId or email for the new owner is required');
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId,
        user: targetUserId ? { id: targetUserId } : { email: targetEmail! }
      },
      select: {
        id: true,
        roleId: true,
        role: { select: { name: true } },
        user: { select: { id: true, email: true, username: true } }
      }
    });
    if (!membership) throw new BadRequestException(notAMemberMessage);
    const { user, ...rest } = membership;

    return { user, membership: rest };
  }

  /**
   * Open a transfer request. `Project.ownerId` is what every deployment and
   * database under the project is billed against, so handing it over spends
   * somebody else's allowance, which is exactly why this only opens an offer.
   * Nothing moves until the recipient accepts.
   */
  async requestProjectOwnershipTransfer(
    projectId: string,
    target: { userId?: string; email?: string },
    requestedByClerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const actor = await this.usersService.findOrCreateByClerkId(requestedByClerkId, userData);
    if (!actor) throw new NotFoundException('User requesting the transfer not found');

    await this.authz.requireProjectOwnershipTransfer(projectId, actor.id);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, organizationId: true, ownerId: true }
    });
    if (!project) throw new NotFoundException('Project not found');

    const { user: recipient } = await this.resolveTransferRecipient(projectId, target);
    if (recipient.id === project.ownerId) {
      throw new BadRequestException('That user already owns this project');
    }

    const open = await this.getPendingProjectTransfer(projectId);
    if (open) {
      throw new ConflictException(
        `This project already has a pending transfer to ${open.to.email}. Cancel it before opening another.`
      );
    }

    // Fail fast so the sender learns about a quota wall now rather than
    // leaving the recipient to hit it on accept. The authoritative check runs
    // again at accept time, since usage moves in between.
    await this.quotasService.enforceMemberAllowanceForProjectTransfer(
      project.organizationId,
      recipient.id,
      projectId
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + ProjectsService.TRANSFER_REQUEST_TTL_DAYS);

    // Stale rows keep the partial unique index from doing its job (it matches
    // on status alone and can't see expiry), so the sweep of any expired
    // request and the insert go together.
    const created = await this.prisma
      .$transaction(async (tx) => {
        await tx.projectTransferRequest.updateMany({
          where: { projectId, status: 'pending', expiresAt: { lte: new Date() } },
          data: { status: 'canceled', respondedAt: new Date() }
        });
        return tx.projectTransferRequest.create({
          data: { projectId, fromUserId: actor.id, toUserId: recipient.id, expiresAt },
          select: ProjectsService.TRANSFER_REQUEST_SHAPE
        });
      })
      .catch((e) => {
        // The check above is not atomic with the insert, so two admins acting
        // at once both reach here and the index rejects the loser. That's the
        // intended outcome, but it has to read as a conflict, not a 500.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new ConflictException('This project already has a pending ownership transfer');
        }
        throw e;
      });

    void this.audit.log({
      action: 'project.ownership.transfer_requested',
      actorUserId: actor.id,
      actorEmail: actor.email,
      organizationId: project.organizationId,
      projectId,
      targetType: 'user',
      targetId: recipient.id,
      targetLabel: recipient.email,
      metadata: { requestId: created.id, expiresAt: expiresAt.toISOString() }
    });

    return created;
  }

  async cancelProjectOwnershipTransfer(
    projectId: string,
    canceledByClerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const actor = await this.usersService.findOrCreateByClerkId(canceledByClerkId, userData);
    if (!actor) throw new NotFoundException('User canceling the transfer not found');

    await this.authz.requireProjectOwnershipTransfer(projectId, actor.id);

    const open = await this.getPendingProjectTransfer(projectId);
    if (!open) throw new NotFoundException('This project has no pending ownership transfer');

    await this.prisma.projectTransferRequest.update({
      where: { id: open.id },
      data: { status: 'canceled', respondedAt: new Date() }
    });

    void this.audit.log({
      action: 'project.ownership.transfer_canceled',
      actorUserId: actor.id,
      actorEmail: actor.email,
      organizationId: open.project.organization.id,
      projectId,
      targetType: 'user',
      targetId: open.to.id,
      targetLabel: open.to.email,
      metadata: { requestId: open.id }
    });

    return { success: true };
  }

  /** Every live offer addressed to the caller, across every org they're in. */
  async listIncomingProjectTransfers(
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    return this.prisma.projectTransferRequest.findMany({
      where: { toUserId: user.id, status: 'pending', expiresAt: { gt: new Date() } },
      select: ProjectsService.TRANSFER_REQUEST_SHAPE,
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Only the addressee can act on a request, and only on their own: the
   * permission gate here is recipient identity, not project role. Everything
   * checked at request time is re-checked, because a week can pass in between:
   * the recipient can have been removed from the project, and their allowance
   * can have filled up with other work.
   */
  private async loadTransferForRecipient(requestId: string, userId: string) {
    const request = await this.prisma.projectTransferRequest.findUnique({
      where: { id: requestId },
      select: { ...ProjectsService.TRANSFER_REQUEST_SHAPE, toUserId: true, fromUserId: true }
    });
    // Same 404 for "not yours" as for "doesn't exist": a request id must not
    // be an oracle for the existence of somebody else's project transfer.
    if (!request || request.toUserId !== userId) {
      throw new NotFoundException('Ownership transfer request not found');
    }
    if (request.status !== 'pending') {
      throw new BadRequestException(`This transfer request was already ${request.status}`);
    }
    if (request.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('This transfer request has expired');
    }
    return request;
  }

  async acceptProjectTransfer(
    requestId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const request = await this.loadTransferForRecipient(requestId, user.id);
    const projectId = request.project.id;

    // The request side authorizes through requireProjectOwnershipTransfer,
    // which picks up API-token project-scoping and tenant confinement on the
    // way. Answering a request is authorized by recipient identity alone, so
    // without this the accept path would be the one place a project-scoped
    // token or an off-tenant session could still move ownership.
    await this.authz.requireProjectView(projectId, user.id);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, organizationId: true, ownerId: true }
    });
    if (!project) throw new NotFoundException('Project not found');
    if (project.ownerId === user.id) {
      throw new BadRequestException('You already own this project');
    }

    const { membership } = await this.resolveTransferRecipient(
      projectId,
      { userId: user.id },
      "You're no longer a member of this project, so ownership can't transfer to you"
    );

    await this.quotasService.enforceMemberAllowanceForProjectTransfer(
      project.organizationId,
      user.id,
      projectId
    );

    const adminRole = await this.prisma.role.findUnique({ where: { name: 'admin' } });
    if (!adminRole) throw new BadRequestException('The admin role is missing from this instance');
    // Whoever carries the bill needs to be able to administer what is running
    // it up, so accepting also lifts the new owner to project admin. The old
    // owner keeps whatever role they already had.
    const promoted = membership.roleId !== adminRole.id;

    const previousOwner = project.ownerId
      ? await this.prisma.user.findUnique({
          where: { id: project.ownerId },
          select: { id: true, email: true, username: true }
        })
      : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { ownerId: user.id } });
      if (promoted) {
        await tx.projectMember.update({
          where: { id: membership.id },
          data: { roleId: adminRole.id }
        });
      }
      await tx.projectTransferRequest.update({
        where: { id: request.id },
        data: { status: 'accepted', respondedAt: new Date() }
      });
    });

    if (promoted) {
      await this.sessions.revokeUserSessions(user.id).catch(() => {});
    }

    void this.audit.log({
      action: 'project.ownership.transferred',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: project.organizationId,
      projectId,
      targetType: 'user',
      targetId: user.id,
      targetLabel: user.email,
      metadata: {
        requestId: request.id,
        owner: [previousOwner?.email ?? null, user.email],
        requestedBy: request.from.email
      }
    });

    return {
      success: true,
      projectId,
      previousOwner: previousOwner
        ? { id: previousOwner.id, username: previousOwner.username, email: previousOwner.email }
        : null,
      owner: { id: user.id, username: user.username, email: user.email },
      promotedToAdmin: promoted
    };
  }

  async declineProjectTransfer(
    requestId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');

    const request = await this.loadTransferForRecipient(requestId, user.id);

    await this.prisma.projectTransferRequest.update({
      where: { id: request.id },
      data: { status: 'declined', respondedAt: new Date() }
    });

    void this.audit.log({
      action: 'project.ownership.transfer_declined',
      actorUserId: user.id,
      actorEmail: user.email,
      organizationId: request.project.organization.id,
      projectId: request.project.id,
      targetType: 'user',
      targetId: request.from.id,
      targetLabel: request.from.email,
      metadata: { requestId: request.id }
    });

    return { success: true };
  }

  async getProjectBySlug(organizationId: string, slug: string, clerkId: string, userData?: any) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    // Prisma throws a 500-producing validation error when the compound unique
    // key is queried with an undefined organizationId, so a missing orgId
    // query param must 404 before the lookup.
    if (!organizationId) {
      throw new NotFoundException('Project not found');
    }
    const proj = await this.prisma.project.findUnique({
      where: { organizationId_slug: { organizationId, slug } },
      select: { id: true, organizationId: true }
    });
    if (!proj) {
      throw new NotFoundException('Project not found');
    }
    const access = await this.authz.requireProjectView(proj.id, user.id);
    const project = await this.prisma.project.findUnique({
      where: {
        organizationId_slug: {
          organizationId,
          slug
        }
      },
      include: {
        organization: true,
        creator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true
          }
        },
        deployments: {
          include: {
            services: {
              include: {
                ports: true
              }
            },
            ingresses: {
              include: {
                service: true
              }
            },
            _count: {
              select: {
                pods: true,
                services: true
              }
            }
          }
        },
        ingresses: {
          select: {
            id: true,
            name: true,
            host: true
          }
        }
      }
    });

    if (!project) {
      throw new NotFoundException(`Project with slug ${slug} not found`);
    }

    const deploymentsWithComputedStatus = await Promise.all(
      project.deployments.map(async (deployment) => {
        const computedStatus = await this.deployments.computeDeploymentStatus(deployment);

        const merged = {
          ...deployment,
          ingresses: deployment.ingresses.map((ing) => scrubIngress(ing)),
          status: computedStatus
        };
        return access.canEdit ? merged : this.deployments.scrubDeploymentForViewer(merged);
      })
    );

    const icon = project.icon ?? (await this.resolveProjectIconFallback(project.deployments));
    const backgroundImage =
      project.backgroundImage ?? (await this.resolveProjectBannerFallback(project.deployments));

    return {
      ...project,
      creator: access.canEdit ? project.creator : this.scrubCreatorForViewer(project.creator),
      icon,
      backgroundImage,
      deployments: deploymentsWithComputedStatus
    };
  }

  async getProjectBySlugsFull(
    orgSlug: string,
    projectSlug: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { slug: orgSlug },
      select: { id: true, slug: true, name: true }
    });
    if (!organization) {
      throw new NotFoundException('Project not found');
    }

    const project = await this.prisma.project.findUnique({
      where: {
        organizationId_slug: {
          organizationId: organization.id,
          slug: projectSlug
        }
      },
      include: {
        organization: true,
        owner: { select: { username: true } },
        members: {
          include: {
            role: true,
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
        },
        creator: {
          select: { id: true, email: true, username: true, firstName: true, lastName: true }
        },
        deployments: {
          select: {
            id: true,
            name: true,
            displayName: true,
            status: true,
            buildStatus: true,
            buildStep: true,
            replicas: true,
            namespace: true,
            image: true,
            githubRepo: true,
            githubBranch: true,
            projectId: true,
            environmentId: true,
            templateInstanceId: true,
            updatedAt: true,
            createdAt: true,
            creator: {
              select: { id: true, username: true, firstName: true, lastName: true, imageUrl: true }
            },
            imageHistory: {
              where: { isActive: true },
              take: 1,
              orderBy: { createdAt: 'desc' },
              select: {
                buildStartedAt: true,
                buildCompletedAt: true,
                commitAuthorName: true,
                commitAuthorUsername: true,
                triggeredBy: {
                  select: {
                    id: true,
                    username: true,
                    firstName: true,
                    lastName: true,
                    imageUrl: true
                  }
                }
              }
            },
            services: { include: { ports: true } },
            ingresses: { include: { service: true } },
            // envVars omitted: large per-deployment, only needed on deployment detail.
            _count: { select: { pods: true, services: true } }
          }
        },
        ingresses: {
          select: { id: true, name: true, host: true, tlsSecretName: true }
        },
        databases: {
          select: {
            id: true,
            name: true,
            dbName: true,
            status: true,
            mode: true,
            createdAt: true,
            namespace: true,
            clusterName: true,
            environmentId: true,
            templateInstanceId: true
          }
        },
        templateInstances: {
          select: {
            id: true,
            name: true,
            status: true,
            createdAt: true,
            template: {
              select: { id: true, name: true, displayName: true, icon: true, category: true }
            },
            _count: { select: { deployments: true, databases: true, ingresses: true } }
          },
          orderBy: { createdAt: 'desc' }
        }
      }
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    let access;
    try {
      ({ access } = await this.access.assertProjectAccess(
        project.id,
        user.id,
        project.organizationId
      ));
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw new NotFoundException('Project not found');
      }
      throw e;
    }

    // Statuses come from the pods/workloads projections the mirror maintains.
    // Synced/imported deployments can use selectors whose pods never carry the
    // app.kubernetes.io/name label, so an empty pod bucket falls back to the
    // mirrored apps/v1 Deployment readiness instead of reporting 'pending'.
    const deploymentIds = project.deployments.map((d) => d.id);
    const [storedPods, workloads] = await Promise.all([
      this.prisma.pod.findMany({
        where: { deploymentId: { in: deploymentIds } },
        select: {
          deploymentId: true,
          name: true,
          status: true,
          restartCount: true,
          lastTerminationReason: true
        }
      }),
      this.prisma.k8sWorkload.findMany({ where: { deploymentId: { in: deploymentIds } } })
    ]);
    const podsByDeployment = new Map<string, typeof storedPods>();
    for (const pod of storedPods) {
      const bucket = podsByDeployment.get(pod.deploymentId);
      if (bucket) bucket.push(pod);
      else podsByDeployment.set(pod.deploymentId, [pod]);
    }
    const workloadByDeployment = new Map(workloads.map((w) => [w.deploymentId, w]));

    const deploymentsWithComputedStatus = await Promise.all(
      project.deployments.map(async (deployment) => {
        const bucket = podsByDeployment.get(deployment.id) ?? [];
        let computedStatus = await this.deployments.computeDeploymentStatus(deployment, {
          pods: bucket,
          warnings: this.deployments.synthesizePodWarnings(bucket)
        });
        if (computedStatus === 'pending' && bucket.length === 0) {
          const workload = workloadByDeployment.get(deployment.id);
          if (workload && workload.readyReplicas > 0) computedStatus = 'running';
        }
        const merged = {
          ...deployment,
          ingresses: deployment.ingresses.map((ing) => scrubIngress(ing)),
          status: computedStatus
        };
        return access.canEdit ? merged : this.deployments.scrubDeploymentForViewer(merged as any);
      })
    );

    // The cnpg mirror consumer keeps database.status in sync with the watched
    // Cluster CRs, so the stored status is current.
    const reconciledDatabases = project.databases as any[];

    const icon = project.icon ?? (await this.resolveProjectIconFallback(project.deployments));
    const backgroundImage =
      project.backgroundImage ?? (await this.resolveProjectBannerFallback(project.deployments));
    const membersWithOrgRole = await this.attachOrgRoleToMembers(
      project.organizationId,
      project.members
    );
    const safeMembers = access.canEdit
      ? membersWithOrgRole
      : this.scrubMembersForViewer(membersWithOrgRole as any);
    const safeDatabases = access.canEdit
      ? (reconciledDatabases as any[]).map((d) => sealDatabaseCredentials(d))
      : (reconciledDatabases as any[]).map((d) => redactDatabaseForViewer(d));

    // Pending email invitations targeted at this project, only revealed to
    // users who can manage members (emails of people not yet in the org).
    const pendingInvitations = access.canManageMembers
      ? await this.prisma.organizationInvitation.findMany({
          where: { projectId: project.id, expiresAt: { gt: new Date() } },
          select: {
            id: true,
            email: true,
            createdAt: true,
            expiresAt: true,
            projectRole: { select: { name: true } }
          },
          orderBy: { createdAt: 'desc' }
        })
      : [];

    return {
      ...project,
      creator: access.canEdit ? project.creator : this.scrubCreatorForViewer(project.creator),
      icon,
      backgroundImage,
      members: safeMembers,
      pendingInvitations,
      deployments: deploymentsWithComputedStatus,
      databases: safeDatabases,
      pendingTransfer: await this.getPendingProjectTransfer(project.id, {
        canEdit: access.canEdit,
        userId: user.id
      }),
      currentUserRole: {
        orgRole: access.orgRole,
        projectRole: access.projectRoleName,
        source: access.source,
        canView: access.canView,
        canEdit: access.canEdit,
        canManageMembers: access.canManageMembers,
        canDelete: access.canDelete,
        canTransferOwnership: this.authz.canTransferProjectOwnership(
          access,
          project.ownerId,
          user.id
        )
      }
    };
  }

  async listProjects(userId: string, orgId?: string, opts: { members?: boolean } = {}) {
    const where = await this.access.buildProjectAccessFilter(userId, orgId);
    if (!where) return [];

    const projects = await this.prisma.project.findMany({
      where,
      include: {
        organization: { select: { id: true, name: true, slug: true } },
        owner: { select: { username: true } },
        members:
          opts.members === false
            ? false
            : {
                include: {
                  role: true,
                  user: {
                    select: {
                      id: true,
                      email: true,
                      firstName: true,
                      lastName: true,
                      imageUrl: true
                    }
                  }
                }
              },
        deployments: {
          select: {
            id: true,
            name: true,
            displayName: true,
            status: true,
            ingresses: { select: { id: true, host: true } }
          }
        },
        _count: {
          select: { deployments: true, databases: true, ingresses: true }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    if (projects.length === 0) return [];

    // One membership-cache hit + one batched projectMember.findMany over the
    // candidate set, then decide canEdit in memory. resolveProjectAccess per
    // project would be 2 DB queries each (org membership + project membership),
    // so 2N round-trips for N projects. Superadmin still short-circuits to
    // canEdit=true.
    const isSuperAdmin = await this.authz.isUnrestrictedSuperAdmin(userId);
    const orgRoleByOrgId = new Map<string, string>();
    if (!isSuperAdmin) {
      const memberships = await this.membershipCache.getMemberships(userId);
      for (const m of memberships) orgRoleByOrgId.set(m.organizationId, m.role);
    }

    const projectIds = projects.map((p) => p.id);
    const projectMembersByProjectId = new Map<string, string>();
    if (!isSuperAdmin) {
      const memberUserId = (await this.membershipCache.resolveUserId(userId)) ?? userId;
      const rows = await this.prisma.projectMember.findMany({
        where: { userId: memberUserId, projectId: { in: projectIds } },
        select: { projectId: true, role: { select: { name: true } } }
      });
      for (const r of rows) projectMembersByProjectId.set(r.projectId, r.role.name);
    }

    return projects.map((p) => {
      let canEdit: boolean;
      if (isSuperAdmin) {
        canEdit = true;
      } else {
        const orgRole = orgRoleByOrgId.get(p.organization.id);
        if (orgRole === 'owner' || orgRole === 'admin') {
          canEdit = true;
        } else {
          const projRole = projectMembersByProjectId.get(p.id);
          canEdit = projRole === 'admin' || projRole === 'member';
        }
      }
      if (opts.members === false) return { ...p, icon: p.icon ?? null, canEdit };
      const members = canEdit ? p.members : this.scrubMembersForViewer(p.members as any);
      return { ...p, members, icon: p.icon ?? null, canEdit };
    });
  }

  /**
   * Lightweight bulk fetch of all deployments the user has access to.
   * Returns only the fields needed for the overview page: NO k8s calls.
   */
  async listDatabasesSummary(userId: string, orgId?: string) {
    const projectFilter = await this.access.buildProjectAccessFilter(userId, orgId);
    if (!projectFilter) return [];

    const rows = await this.prisma.database.findMany({
      where: { project: projectFilter },
      select: {
        id: true,
        name: true,
        dbName: true,
        status: true,
        clusterStatus: true,
        mode: true,
        createdAt: true,
        updatedAt: true,
        project: {
          select: {
            id: true,
            name: true,
            slug: true,
            organizationId: true
          }
        },
        // Matches the deployment summary so a person search covers everything
        // they own, not just their apps. No email, same as everywhere else.
        creator: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            imageUrl: true
          }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });
    return rows.map(({ clusterStatus, ...row }) => ({
      ...row,
      status: databaseStatusFor(row.status, clusterStatus)
    }));
  }

  /**
   * Single-roundtrip overview aggregator. Looks up org by slug, runs RBAC once
   * (via cached memberships), and fans out the four list queries in parallel.
   */
  private async assertOrgOverviewAccess(organizationId: string, userId: string) {
    if (await this.authz.orgRequiresSso(organizationId, userId)) {
      throw new ForbiddenException({
        error: 'org_sso_required',
        message: 'This organization requires single sign-on.'
      });
    }
    if (!(await this.authz.getOrgAccess(organizationId, userId))) {
      throw new NotFoundException('Organization not found');
    }
  }

  async getUserOverview(userId: string) {
    const sessionOrgId = requestAuthStorage.getStore()?.sessionOrgId;
    const blocked = await this.authz.ssoBlockedOrgIds(userId);
    const memberships = await this.prisma.organizationMember.findMany({
      where: {
        userId,
        status: 'active',
        ...(sessionOrgId ? { organizationId: sessionOrgId } : {}),
        ...(blocked.length ? { organizationId: { notIn: blocked } } : {})
      },
      select: { organization: { select: { id: true, slug: true, name: true } } }
    });
    const organizations = memberships
      .map((m) => m.organization)
      .sort((a, b) => a.name.localeCompare(b.name));
    const [projects, deployments, databases] = await Promise.all([
      this.listProjects(userId, undefined, { members: false }),
      this.deployments.listDeploymentsSummary(userId),
      this.listDatabasesSummary(userId)
    ]);
    return { organizations, projects, deployments, databases };
  }

  async getOrgOverviewBySlug(userId: string, orgSlug: string) {
    const org = await this.prisma.organization.findUnique({
      where: { slug: orgSlug },
      select: { id: true, slug: true, name: true }
    });
    if (!org) throw new NotFoundException('Organization not found');

    await this.assertOrgOverviewAccess(org.id, userId);

    const [isSuper, memberships] = await Promise.all([
      this.authz.isUnrestrictedSuperAdmin(userId),
      this.membershipCache.getMembershipsForOrg(userId, org.id)
    ]);
    if (!isSuper && memberships.length === 0) {
      throw new NotFoundException('Organization not found');
    }
    // Inline what GET /organizations/:id/members/me would return so the
    // dashboard doesn't need a second round trip. `synthetic` marks a
    // superadmin viewing an org they aren't actually a member of.
    const m = memberships[0];
    let currentMember: { role: string; synthetic: boolean } | null = null;
    if (isSuper) currentMember = { role: 'owner' as const, synthetic: !m };
    else if (m) currentMember = { role: m.role, synthetic: false };

    const [projects, deployments, databases] = await Promise.all([
      this.listProjects(userId, org.id, { members: false }),
      this.deployments.listDeploymentsSummary(userId, org.id),
      this.listDatabasesSummary(userId, org.id)
    ]);

    const hostOf = (d: any): string | null => d?.ingresses?.[0]?.host?.split('/')[0] || null;

    const decorateFavicons = async () => {
      const hosts = deployments.map(hostOf).filter(Boolean) as string[];
      const favicons = await this.faviconService.peekFavicons(hosts);
      for (const d of deployments as any[]) {
        const h = hostOf(d);
        d.faviconUrl = h ? (favicons[h] ?? null) : null;
      }
    };

    const decorateActivity = async () => {
      const projectIds = (projects as any[]).map((p) => p.id);
      const deploymentProject = new Map<string, string>();
      for (const p of projects as any[])
        for (const d of p.deployments ?? []) deploymentProject.set(d.id, p.id);
      const deploymentIds = [...deploymentProject.keys()];
      const [audits, releases, builds] = await Promise.all([
        this.prisma.auditLog.groupBy({
          by: ['projectId'],
          where: { projectId: { in: projectIds } },
          _max: { createdAt: true }
        }),
        this.prisma.imageHistory.groupBy({
          by: ['deploymentId'],
          where: { deploymentId: { in: deploymentIds } },
          _max: { createdAt: true }
        }),
        this.prisma.buildRun.groupBy({
          by: ['deploymentId'],
          where: { deploymentId: { in: deploymentIds } },
          _max: { createdAt: true }
        })
      ]);
      const activity = new Map<string, number>();
      const bump = (projectId: string | null | undefined, at: Date | null | undefined) => {
        if (!projectId || !at) return;
        activity.set(projectId, Math.max(activity.get(projectId) ?? 0, at.getTime()));
      };
      for (const a of audits) bump(a.projectId, a._max.createdAt);
      for (const r of [...releases, ...builds])
        bump(deploymentProject.get(r.deploymentId), r._max.createdAt);
      for (const p of projects as any[]) {
        const created = p.createdAt ? new Date(p.createdAt).getTime() : 0;
        const at = Math.max(activity.get(p.id) ?? 0, created);
        p.activityAt = at ? new Date(at).toISOString() : null;
      }
    };

    const decorateBanners = async () => {
      const candidateHosts = new Map<string, string[]>();
      for (const p of projects as any[]) {
        if (p.backgroundImage) continue;
        const hosts = (p.deployments ?? [])
          .map((d: any) => d.ingresses?.[0]?.host?.split('/')[0])
          .filter(Boolean) as string[];
        if (hosts.length) candidateHosts.set(p.id, hosts);
      }
      if (candidateHosts.size === 0) return;
      const banners = await this.faviconService.peekBanners([...candidateHosts.values()].flat());
      for (const p of projects as any[]) {
        const hosts = candidateHosts.get(p.id);
        if (!hosts) continue;
        const found = hosts.map((h) => banners[h]).find(Boolean);
        if (found) p.backgroundImage = found;
      }
    };

    await Promise.all([
      decorateFavicons().catch(() => undefined),
      decorateActivity().catch(() => undefined),
      decorateBanners().catch(() => undefined)
    ]);

    const faviconByDeployment = new Map(
      (deployments as any[]).filter((d) => d.faviconUrl).map((d) => [d.id, d.faviconUrl as string])
    );
    for (const p of projects as any[]) {
      if (typeof p.icon === 'string' && /^(https?:)?\/\//.test(p.icon)) continue;
      const borrowed = (p.deployments ?? [])
        .map((d: any) => faviconByDeployment.get(d.id))
        .find(Boolean);
      if (borrowed) p.icon = borrowed;
    }

    return { organization: org, projects, deployments, databases, currentMember };
  }

  /**
   * The live build feed for the org dashboard sidebar. Split from the full
   * overview so it can be refetched aggressively on build events without
   * paying for the project grid, and scoped to the caller's own projects by
   * default. Falls back to org-wide visibility when the user has no explicit
   * project memberships in the org (solo and small orgs).
   */
  async getOrgBuildsBySlug(userId: string, orgSlug: string, scope: 'mine' | 'all' = 'mine') {
    const org = await this.prisma.organization.findUnique({
      where: { slug: orgSlug },
      select: { id: true }
    });
    if (!org) throw new NotFoundException('Organization not found');

    await this.assertOrgOverviewAccess(org.id, userId);

    const [isSuper, memberships] = await Promise.all([
      this.authz.isUnrestrictedSuperAdmin(userId),
      this.membershipCache.getMembershipsForOrg(userId, org.id)
    ]);
    if (!isSuper && memberships.length === 0) {
      throw new NotFoundException('Organization not found');
    }

    const builds = await this.deployments.listRecentBuilds(userId, org.id, {
      scope,
      activeLimit: 15,
      recentLimit: 8
    });

    try {
      const hostOf = (d: any): string | null => d?.ingresses?.[0]?.host?.split('/')[0] || null;
      const targets: any[] = [
        ...builds.active,
        ...builds.recent.map((b: any) => b.deployment).filter(Boolean)
      ];
      const favicons = await this.faviconService.peekFavicons(
        targets.map(hostOf).filter(Boolean) as string[]
      );
      for (const d of targets) {
        const h = hostOf(d);
        d.faviconUrl = h ? (favicons[h] ?? null) : null;
      }
    } catch {
      // decorative
    }

    return builds;
  }
}
