import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { K8sNetworkService } from '../kubernetes/k8s-network.service';
import { AuditService } from '../audit/audit.service';
import { optionalDomain } from '../env/platform-domains';
import {
  isReservedSubdomainLabel,
  lockHostnameClaims,
  normalizeHost
} from '../instance-network/reserved-hosts';
import { CERT_CLUSTER_ISSUER } from '../projects/projects.utils';
import {
  MAX_COMPONENTS,
  SLUG_PATTERN,
  SUBDOMAIN_PATTERN,
  databaseStatus,
  deploymentStatus,
  incidentsFromTransitions,
  normalizeComponents,
  overallStatus,
  uptimeDays,
  uptimePercent,
  type ComponentRef,
  type ComponentStatus,
  type Incident
} from './status-model';

export interface StatusPageInput {
  slug?: string;
  title?: string;
  description?: string | null;
  subdomain?: string | null;
  isPublic?: boolean;
  components?: unknown;
}

interface Actor {
  id: string;
  email?: string | null;
}

const RESERVED_SLUGS = new Set(['new', 'edit', 'resolve', 'api', 'admin']);
const RENDER_CACHE_MS = 15_000;
const HISTORY_DAYS = 30;
const MAX_INCIDENTS = 20;
const TRANSITIONS_PER_DEPLOYMENT = 2000;
const MAX_PAGES_PER_ORG = 10;

interface Rendered {
  at: number;
  payload: PublicStatusPage | null;
}

export interface PublicComponent {
  id: string;
  kind: 'deployment' | 'database';
  name: string;
  status: ComponentStatus;
  detail: string | null;
  since: string | null;
  uptime: number;
  days: { day: string; status: string }[];
}

export interface PublicStatusPage {
  slug: string;
  title: string;
  description: string | null;
  organization: string;
  overall: 'operational' | 'degraded' | 'down';
  updatedAt: string;
  components: PublicComponent[];
  incidents: {
    componentId: string;
    componentName: string;
    startedAt: string;
    endedAt: string | null;
  }[];
}

@Injectable()
export class StatusPagesService {
  private readonly logger = new Logger(StatusPagesService.name);

  private readonly baseDomain: string;

  private readonly platformNamespace: string;

  private readonly platformServiceName: string;

  private readonly platformServicePort: number;

  private readonly cache = new Map<string, Rendered>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly k8sNetwork: K8sNetworkService,
    private readonly audit: AuditService
  ) {
    this.baseDomain = optionalDomain(process.env.BASE_DOMAIN);
    this.platformNamespace = process.env.PLATFORM_NAMESPACE || 'default';
    this.platformServiceName = process.env.PLATFORM_SERVICE_NAME || 'leaf-frontend';
    this.platformServicePort = parseInt(process.env.PLATFORM_SERVICE_PORT || '3000', 10);
  }

  async list(organizationId: string) {
    const rows = await this.prisma.statusPage.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' }
    });
    return rows.map((r) => this.present(r));
  }

  async options(organizationId: string) {
    const [deployments, databases] = await Promise.all([
      this.prisma.deployment.findMany({
        where: { project: { organizationId } },
        select: {
          id: true,
          name: true,
          displayName: true,
          project: { select: { name: true } }
        },
        orderBy: { name: 'asc' }
      }),
      this.prisma.database.findMany({
        where: { project: { organizationId } },
        select: { id: true, name: true, project: { select: { name: true } } },
        orderBy: { name: 'asc' }
      })
    ]);
    return [
      ...deployments.map((d) => ({
        kind: 'deployment' as const,
        resourceId: d.id,
        name: d.displayName || d.name,
        project: d.project.name
      })),
      ...databases.map((d) => ({
        kind: 'database' as const,
        resourceId: d.id,
        name: d.name,
        project: d.project.name
      }))
    ];
  }

  async create(organizationId: string, input: StatusPageInput, actor: Actor) {
    const count = await this.prisma.statusPage.count({ where: { organizationId } });
    if (count >= MAX_PAGES_PER_ORG) {
      throw new BadRequestException(
        `An organization is limited to ${MAX_PAGES_PER_ORG} status pages`
      );
    }
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, slug: true }
    });
    if (!org) throw new NotFoundException('Organization not found');
    const slug = this.validateSlug(input.slug ?? org.slug);
    await this.assertSlugFree(slug, null);
    const requestedSubdomain = this.checkSubdomainShape(input.subdomain ?? null);
    const components = await this.validateComponents(organizationId, input.components ?? []);
    const title = this.validateTitle(input.title ?? `${org.name} status`);
    const description = this.validateDescription(input.description);
    const { row, subdomain } = await this.withClaimedSubdomain(
      requestedSubdomain,
      null,
      async (db, claimed) => ({
        subdomain: claimed,
        row: await db.statusPage.create({
          data: {
            organizationId,
            slug,
            title,
            description,
            subdomain: claimed,
            isPublic: input.isPublic !== false,
            components: components as unknown as Prisma.InputJsonValue,
            createdById: actor.id
          }
        })
      })
    );
    if (subdomain) await this.attachHost(row.id, subdomain, null);
    this.audit
      .log({
        action: 'status_page.created',
        actorUserId: actor.id,
        actorEmail: actor.email ?? undefined,
        organizationId,
        targetType: 'status_page',
        targetId: row.id,
        targetLabel: slug
      })
      .catch(() => {});
    return this.present(await this.prisma.statusPage.findUniqueOrThrow({ where: { id: row.id } }));
  }

  async update(organizationId: string, pageId: string, input: StatusPageInput, actor: Actor) {
    const existing = await this.prisma.statusPage.findFirst({
      where: { id: pageId, organizationId }
    });
    if (!existing) throw new NotFoundException('Status page not found');
    const data: Prisma.StatusPageUpdateInput = {};
    if (input.slug !== undefined) {
      data.slug = this.validateSlug(input.slug, existing.slug);
      await this.assertSlugFree(data.slug, existing.id);
    }
    if (input.title !== undefined) data.title = this.validateTitle(input.title);
    if (input.description !== undefined)
      data.description = this.validateDescription(input.description);
    if (input.isPublic !== undefined) data.isPublic = input.isPublic === true;
    if (input.components !== undefined) {
      data.components = (await this.validateComponents(
        organizationId,
        input.components
      )) as unknown as Prisma.InputJsonValue;
    }
    let nextSubdomain = existing.subdomain;
    let requestedSubdomain: string | null = null;
    const changingSubdomain = input.subdomain !== undefined;
    if (changingSubdomain) {
      requestedSubdomain = this.checkSubdomainShape(input.subdomain ?? null, existing.subdomain);
      nextSubdomain = requestedSubdomain;
      data.subdomain = nextSubdomain;
    }
    const row = await this.withClaimedSubdomain(
      changingSubdomain ? requestedSubdomain : null,
      existing.id,
      (db) => db.statusPage.update({ where: { id: pageId }, data })
    );
    if (nextSubdomain !== existing.subdomain) {
      await this.attachHost(row.id, nextSubdomain, existing.subdomain);
    }
    this.cache.delete(existing.slug);
    this.cache.delete(row.slug);
    this.audit
      .log({
        action: 'status_page.updated',
        actorUserId: actor.id,
        actorEmail: actor.email ?? undefined,
        organizationId,
        targetType: 'status_page',
        targetId: row.id,
        targetLabel: row.slug,
        metadata: this.audit.diff(existing, row, ['slug', 'title', 'subdomain', 'isPublic'])
      })
      .catch(() => {});
    return this.present(await this.prisma.statusPage.findUniqueOrThrow({ where: { id: row.id } }));
  }

  async remove(organizationId: string, pageId: string, actor: Actor) {
    const existing = await this.prisma.statusPage.findFirst({
      where: { id: pageId, organizationId }
    });
    if (!existing) throw new NotFoundException('Status page not found');
    await this.prisma.statusPage.delete({ where: { id: pageId } });
    if (existing.subdomain) await this.deleteIngress(existing.subdomain);
    this.cache.delete(existing.slug);
    this.audit
      .log({
        action: 'status_page.deleted',
        actorUserId: actor.id,
        actorEmail: actor.email ?? undefined,
        organizationId,
        targetType: 'status_page',
        targetId: pageId,
        targetLabel: existing.slug
      })
      .catch(() => {});
    return { ok: true };
  }

  /** The slug served on a status host, or null when the host is not one. */
  async resolveHost(host: string): Promise<{ slug: string } | null> {
    const clean = String(host || '')
      .toLowerCase()
      .split(':')[0];
    if (!this.baseDomain || !clean.endsWith(`.${this.baseDomain}`)) return null;
    const subdomain = clean.slice(0, -(this.baseDomain.length + 1));
    if (!subdomain || subdomain.includes('.')) return null;
    const page = await this.prisma.statusPage.findUnique({
      where: { subdomain },
      select: { slug: true, isPublic: true }
    });
    return page && page.isPublic ? { slug: page.slug } : null;
  }

  async render(slug: string): Promise<PublicStatusPage | null> {
    const cached = this.cache.get(slug);
    if (cached && Date.now() - cached.at < RENDER_CACHE_MS) return cached.payload;
    const started = Date.now();
    let payload: PublicStatusPage | null;
    try {
      payload = await this.build(slug);
    } catch (error) {
      this.logger.error(
        `status page ${JSON.stringify(slug)} failed after ${Date.now() - started}ms: ${(error as Error)?.message ?? error}`
      );
      throw error;
    }
    this.cache.set(slug, { at: Date.now(), payload });
    if (this.cache.size > 500) {
      const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    return payload;
  }

  private async build(slug: string): Promise<PublicStatusPage | null> {
    const page = await this.prisma.statusPage.findUnique({
      where: { slug },
      include: { organization: { select: { name: true } } }
    });
    if (!page || !page.isPublic) return null;
    const components = normalizeComponents(page.components);
    const deploymentIds = components
      .filter((c) => c.kind === 'deployment')
      .map((c) => c.resourceId);
    const databaseIds = components.filter((c) => c.kind === 'database').map((c) => c.resourceId);
    const now = new Date();
    const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);

    const [deployments, workloads, crashStates, alertStates, transitions, databases, dbCrash] =
      await Promise.all([
        this.prisma.deployment.findMany({
          where: { id: { in: deploymentIds }, project: { organizationId: page.organizationId } },
          select: {
            id: true,
            name: true,
            displayName: true,
            status: true,
            stopped: true,
            replicas: true
          }
        }),
        this.prisma.k8sWorkload.findMany({
          where: { deploymentId: { in: deploymentIds } },
          select: { deploymentId: true, specReplicas: true, readyReplicas: true }
        }),
        this.prisma.deploymentCrashState.findMany({
          where: { deploymentId: { in: deploymentIds } },
          select: { deploymentId: true, crashingSince: true }
        }),
        this.prisma.metricAlertState.findMany({
          where: { targetId: { in: deploymentIds }, notifiedAt: { not: null }, okSince: null },
          select: { targetId: true }
        }),
        Promise.all(
          deploymentIds.map((deploymentId) =>
            this.prisma.podTransition.findMany({
              where: {
                deploymentId,
                at: { gte: since },
                toStatus: { in: ['crashing', 'failed', 'ready'] }
              },
              select: { deploymentId: true, podName: true, toStatus: true, at: true },
              orderBy: { at: 'desc' },
              take: TRANSITIONS_PER_DEPLOYMENT
            })
          )
        ).then((rows) => rows.flat()),
        this.prisma.database.findMany({
          where: { id: { in: databaseIds }, project: { organizationId: page.organizationId } },
          select: { id: true, name: true, status: true }
        }),
        this.prisma.databaseCrashState.findMany({
          where: { databaseId: { in: databaseIds } },
          select: { databaseId: true, crashingSince: true }
        })
      ]);

    const depById = new Map(deployments.map((d) => [d.id, d]));
    const workloadById = new Map(workloads.map((w) => [w.deploymentId, w]));
    const crashById = new Map(crashStates.map((c) => [c.deploymentId, c.crashingSince]));
    const alertsById = new Map<string, number>();
    for (const a of alertStates) alertsById.set(a.targetId, (alertsById.get(a.targetId) ?? 0) + 1);
    const transitionsById = new Map<string, { podName: string; toStatus: string; at: Date }[]>();
    for (const t of transitions) {
      const list = transitionsById.get(t.deploymentId) ?? [];
      list.push({ podName: t.podName, toStatus: t.toStatus, at: t.at });
      transitionsById.set(t.deploymentId, list);
    }
    const dbById = new Map(databases.map((d) => [d.id, d]));
    const dbCrashById = new Map(dbCrash.map((c) => [c.databaseId, c.crashingSince]));

    const out: PublicComponent[] = [];
    const incidents: PublicStatusPage['incidents'] = [];
    for (const c of components) {
      if (c.kind === 'deployment') {
        const dep = depById.get(c.resourceId);
        if (!dep) {
          out.push(this.missing(c));
          continue;
        }
        const crashingSince = crashById.get(dep.id) ?? null;
        const s = deploymentStatus({
          status: dep.status,
          stopped: dep.stopped,
          replicas: dep.replicas,
          workload: workloadById.get(dep.id) ?? null,
          crashingSince,
          firingAlerts: alertsById.get(dep.id) ?? 0
        });
        const history = incidentsFromTransitions(
          transitionsById.get(dep.id) ?? [],
          crashingSince,
          now
        );
        const days = uptimeDays(history, now, HISTORY_DAYS);
        out.push({
          id: c.id,
          kind: 'deployment',
          name: c.name || dep.displayName || dep.name,
          status: s.status,
          detail: s.detail,
          since: crashingSince?.toISOString() ?? null,
          uptime: uptimePercent(days, now),
          days: days.map((d) => ({ day: d.day, status: d.status }))
        });
        this.collectIncidents(incidents, c.id, c.name || dep.displayName || dep.name, history);
      } else {
        const db = dbById.get(c.resourceId);
        if (!db) {
          out.push(this.missing(c));
          continue;
        }
        const crashingSince = dbCrashById.get(db.id) ?? null;
        const s = databaseStatus({ status: db.status, crashingSince });
        const history: Incident[] = crashingSince
          ? [{ startedAt: crashingSince, endedAt: null }]
          : [];
        const days = uptimeDays(history, now, HISTORY_DAYS);
        out.push({
          id: c.id,
          kind: 'database',
          name: c.name || db.name,
          status: s.status,
          detail: s.detail,
          since: crashingSince?.toISOString() ?? null,
          uptime: uptimePercent(days, now),
          days: days.map((d) => ({ day: d.day, status: d.status }))
        });
        this.collectIncidents(incidents, c.id, c.name || db.name, history);
      }
    }
    incidents.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return {
      slug: page.slug,
      title: page.title,
      description: page.description,
      organization: page.organization.name,
      overall: overallStatus(out.map((c) => c.status)),
      updatedAt: now.toISOString(),
      components: out,
      incidents: incidents.slice(0, MAX_INCIDENTS)
    };
  }

  private collectIncidents(
    into: PublicStatusPage['incidents'],
    componentId: string,
    componentName: string,
    history: readonly Incident[]
  ) {
    for (const inc of history) {
      into.push({
        componentId,
        componentName,
        startedAt: inc.startedAt.toISOString(),
        endedAt: inc.endedAt?.toISOString() ?? null
      });
    }
  }

  private missing(c: ComponentRef): PublicComponent {
    return {
      id: c.id,
      kind: c.kind,
      name: c.name || 'Removed',
      status: 'unknown',
      detail: 'No longer exists',
      since: null,
      uptime: 100,
      days: []
    };
  }

  private present(row: {
    id: string;
    slug: string;
    title: string;
    description: string | null;
    subdomain: string | null;
    isPublic: boolean;
    components: unknown;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const components = normalizeComponents(row.components);
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      subdomain: row.subdomain,
      host: row.subdomain && this.baseDomain ? `${row.subdomain}.${this.baseDomain}` : null,
      isPublic: row.isPublic,
      components,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }

  private validateSlug(raw: string, current: string | null = null): string {
    const slug = String(raw ?? '')
      .trim()
      .toLowerCase();
    if ((slug !== current && !SLUG_PATTERN.test(slug)) || RESERVED_SLUGS.has(slug)) {
      throw new BadRequestException(
        'Slug must be 3-64 characters, lowercase letters, digits and hyphens'
      );
    }
    return slug;
  }

  private async assertSlugFree(slug: string, exceptId: string | null) {
    const taken = await this.prisma.statusPage.findUnique({
      where: { slug },
      select: { id: true }
    });
    if (taken && taken.id !== exceptId) throw new ConflictException('That slug is already in use');
  }

  private validateTitle(raw: string): string {
    const title = String(raw ?? '').trim();
    if (title.length < 1 || title.length > 120) {
      throw new BadRequestException('Title must be 1-120 characters');
    }
    return title;
  }

  private validateDescription(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    const text = String(raw).trim();
    if (text.length > 500)
      throw new BadRequestException('Description must be 500 characters or fewer');
    return text || null;
  }

  private checkSubdomainShape(raw: string | null, current: string | null = null): string | null {
    const normalized = raw ? normalizeHost(raw) || raw.trim().toLowerCase() : null;
    if (!normalized) return null;
    if (!this.baseDomain) {
      throw new BadRequestException(
        "This instance has no BASE_DOMAIN, so status page hosts aren't available"
      );
    }
    if (normalized !== current && !SUBDOMAIN_PATTERN.test(normalized)) {
      throw new BadRequestException(
        "Subdomain must be 3 to 50 letters, digits or hyphens, and can't start or end with a hyphen"
      );
    }
    if (isReservedSubdomainLabel(normalized, this.baseDomain)) {
      throw new BadRequestException('This subdomain is reserved');
    }
    return normalized;
  }

  private async withClaimedSubdomain<T>(
    subdomain: string | null,
    exceptId: string | null,
    write: (db: Prisma.TransactionClient, subdomain: string | null) => Promise<T>
  ): Promise<T> {
    return this.prisma.$transaction(async (db) => {
      if (subdomain) {
        await lockHostnameClaims(db);
        const [org, page, ingress] = await Promise.all([
          db.organization.findUnique({ where: { subdomain }, select: { id: true } }),
          db.statusPage.findUnique({ where: { subdomain }, select: { id: true } }),
          db.ingress.findFirst({
            where: { host: { equals: `${subdomain}.${this.baseDomain}`, mode: 'insensitive' } },
            select: { id: true }
          })
        ]);
        if (org || ingress || (page && page.id !== exceptId)) {
          throw new ConflictException('That subdomain is already in use');
        }
      }
      try {
        return await write(db, subdomain);
      } catch (err) {
        if ((err as { code?: string })?.code === 'P2002') {
          throw new ConflictException('That subdomain is already in use');
        }
        throw err;
      }
    });
  }

  private async validateComponents(organizationId: string, raw: unknown): Promise<ComponentRef[]> {
    const components = normalizeComponents(raw);
    if (components.length > MAX_COMPONENTS) {
      throw new BadRequestException(`A status page is limited to ${MAX_COMPONENTS} components`);
    }
    const deploymentIds = components
      .filter((c) => c.kind === 'deployment')
      .map((c) => c.resourceId);
    const databaseIds = components.filter((c) => c.kind === 'database').map((c) => c.resourceId);
    const [deployments, databases] = await Promise.all([
      this.prisma.deployment.findMany({
        where: { id: { in: deploymentIds }, project: { organizationId } },
        select: { id: true, name: true, displayName: true }
      }),
      this.prisma.database.findMany({
        where: { id: { in: databaseIds }, project: { organizationId } },
        select: { id: true, name: true }
      })
    ]);
    const depNames = new Map(deployments.map((d) => [d.id, d.displayName || d.name]));
    const dbNames = new Map(databases.map((d) => [d.id, d.name]));
    return components.map((c) => {
      const known =
        c.kind === 'deployment' ? depNames.get(c.resourceId) : dbNames.get(c.resourceId);
      if (!known)
        throw new BadRequestException(`Unknown ${c.kind} on this organization: ${c.resourceId}`);
      return { ...c, name: c.name || known };
    });
  }

  private ingressName(subdomain: string): string {
    return `status-${subdomain}`;
  }

  private async attachHost(pageId: string, next: string | null, previous: string | null) {
    if (next) {
      try {
        await this.ensureIngress(next);
      } catch (error) {
        await this.prisma.statusPage
          .update({ where: { id: pageId }, data: { subdomain: previous } })
          .catch(() => {});
        this.logger.error(`status host ${next} failed: ${(error as Error)?.message ?? error}`);
        throw new ConflictException("Couldn't attach that host to the status page");
      }
    }
    if (previous && previous !== next) await this.deleteIngress(previous);
  }

  private async ensureIngress(subdomain: string) {
    const host = `${subdomain}.${this.baseDomain}`;
    const opts = {
      namespace: this.platformNamespace,
      name: this.ingressName(subdomain),
      host,
      path: '/',
      pathType: 'Prefix',
      serviceName: this.platformServiceName,
      servicePort: this.platformServicePort,
      tlsSecretName: `status-tls-${subdomain}`,
      tlsHosts: [host],
      annotations: { 'cert-manager.io/cluster-issuer': CERT_CLUSTER_ISSUER }
    };
    try {
      await this.k8sNetwork.createIngress(opts);
      this.logger.log(`Created status ingress for ${host}`);
    } catch (error) {
      if (error?.response?.error === 'Ingress already exists') {
        await this.k8sNetwork.updateIngress(opts);
      } else {
        throw error;
      }
    }
  }

  private async deleteIngress(subdomain: string) {
    try {
      await this.k8sNetwork.deleteIngress(this.platformNamespace, this.ingressName(subdomain));
    } catch (error) {
      this.logger.warn(`Failed to delete status ingress "${subdomain}": ${error?.message}`);
    }
  }
}
