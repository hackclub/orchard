import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  OnModuleInit,
  OnModuleDestroy
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { LeaseService } from '../coordination/lease.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import { DatabasesService } from '../projects/databases.service';
import { DeploymentsService } from '../projects/deployments.service';
import { IngressService } from '../projects/ingress.service';
import { scrubIngress } from '../projects/projects.utils';
import { AuthorizationService } from '../auth/authorization.service';
import { UsersService } from '../users/users.service';
import { TemplateEngineService, ResolutionContext, ParameterDef } from './template-engine.service';
import {
  loadVerifiedRegistryIndex,
  MissingRegistryObject,
  parseRegistryState,
  registrySignaturePolicyFromEnv,
  registryStateKey,
  type RegistryIndexStateStore
} from '../registry-index/signed-index';
import { chosenPodSize, isolateTemplateVolumes, type PodSizeOverride } from './template-defaults';

const REGISTRY_SYNC_MS = 6 * 60 * 60 * 1000;
const REGISTRY_FETCH_TIMEOUT_MS = 15_000;

interface RegistryEntry {
  name: string;
  version: string;
  yaml: string;
  sha256: string;
}

function blankParameterValues(parameters: unknown): unknown {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return parameters;
  return Object.fromEntries(Object.keys(parameters).map((key) => [key, null]));
}

const SECRET_NAME =
  /(token|secret|passw(or)?d|passphrase|api_?key|private_?key|access_?key|credential|auth_?key|signing|dsn|webhook_?url|cookie|session_?key|salt|pepper)/i;

export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name.replace(/[-.\s]/g, '_'));
}

export function isSecretParameter(def: Pick<ParameterDef, 'name' | 'type'>): boolean {
  return def.type === 'secret' || looksSecret(def.name);
}

export function redactSecretParameters(
  parameters: unknown,
  defs: Pick<ParameterDef, 'name' | 'type'>[]
): unknown {
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return parameters;
  const secret = new Set(defs.filter(isSecretParameter).map((d) => d.name));
  return Object.fromEntries(
    Object.entries(parameters as Record<string, unknown>).map(([key, value]) => [
      key,
      secret.has(key) || looksSecret(key) ? null : value
    ])
  );
}

export function describeParameters(defs: ParameterDef[]) {
  return defs.map((def) => ({
    name: def.name,
    displayName: def.displayName || def.name,
    type: isSecretParameter(def) ? ('secret' as const) : def.type,
    ...(def.options?.length ? { options: def.options } : {})
  }));
}

export function secretParameterValues(
  parameters: Record<string, unknown>,
  defs: Pick<ParameterDef, 'name' | 'type'>[]
): string[] {
  return defs
    .filter(isSecretParameter)
    .map((d) => parameters[d.name])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}

export function sealTemplateEnv<T>(env: T, secretValues: readonly string[]): T {
  if (!Array.isArray(env)) return env;
  const values = secretValues.filter((v) => v.length > 0);
  return env.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.value !== 'string') return entry;
    return values.some((v) => entry.value.includes(v)) ? { ...entry, secret: true } : entry;
  }) as T;
}

export const DEFAULT_REGISTRY_URL = 'https://assets.orchard.my/registry';

export function registryUrl(): string | null {
  const raw = process.env.TEMPLATE_REGISTRY_URL;
  if (raw === undefined) return DEFAULT_REGISTRY_URL;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

@Injectable()
export class TemplatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TemplatesService.name);

  private registryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly projectsService: ProjectsService,
    private readonly databases: DatabasesService,
    private readonly deployments: DeploymentsService,
    private readonly ingress: IngressService,
    private readonly templateEngine: TemplateEngineService,
    private readonly authz: AuthorizationService,
    private readonly usersService: UsersService,
    private readonly lease: LeaseService
  ) {}

  private async resolveUserId(clerkId: string, userData?: any): Promise<string> {
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    return user.id;
  }

  private async requireSuperAdmin(clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true }
    });
    if (!u?.isSuperAdmin) {
      throw new ForbiddenException('Only superadmins can manage global templates');
    }
    return userId;
  }

  async onModuleInit() {
    this.logger.log('onModuleInit: starting seedBuiltInTemplates...');
    await this.seedBuiltInTemplates();
    this.logger.log('onModuleInit: seedBuiltInTemplates complete');
    this.startRegistrySync();
  }

  onModuleDestroy() {
    if (this.registryTimer) clearInterval(this.registryTimer);
  }

  private startRegistrySync() {
    const base = registryUrl();
    if (!base) return;
    if (!this.lease.canCoordinate) {
      this.logger.warn(
        "TEMPLATE_REGISTRY_URL is set but this process isn't a member of the cluster; skipping registry sync"
      );
      return;
    }
    void this.syncRegistry();
    this.registryTimer = setInterval(() => {
      void this.syncRegistry();
    }, REGISTRY_SYNC_MS);
    this.registryTimer.unref?.();
  }

  private async fetchRegistry(url: string): Promise<Response> {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json, application/yaml, text/plain',
        'user-agent': 'orchard-server'
      },
      signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response;
  }

  private registryStateStore(): RegistryIndexStateStore {
    return {
      load: async (name) =>
        parseRegistryState(
          (await this.prisma.instanceSetting.findUnique({ where: { key: registryStateKey(name) } }))
            ?.value
        ),
      save: async (name, state) => {
        const value = JSON.stringify(state);
        await this.prisma.instanceSetting.upsert({
          where: { key: registryStateKey(name) },
          update: { value },
          create: { key: registryStateKey(name), value }
        });
      }
    };
  }

  async syncRegistry(): Promise<{ synced: number; skipped: number }> {
    const base = registryUrl();
    if (!base) return { synced: 0, skipped: 0 };
    let entries: RegistryEntry[];
    try {
      const verified = await loadVerifiedRegistryIndex({
        name: 'templates/index.json',
        read: async (suffix) => {
          const url = `${base}/templates/index.json${suffix}`;
          if (suffix) {
            const probe = await fetch(url, {
              headers: { 'user-agent': 'orchard-server' },
              signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS)
            });
            if (probe.status === 404) throw new MissingRegistryObject(url);
            if (!probe.ok) throw new Error(`${url} answered ${probe.status}`);
            return Buffer.from(await probe.arrayBuffer());
          }
          return Buffer.from(await (await this.fetchRegistry(url)).arrayBuffer());
        },
        store: this.registryStateStore(),
        policy: registrySignaturePolicyFromEnv()
      });
      for (const warning of verified.warnings) this.logger.warn(warning);
      const index = verified.body as { templates?: RegistryEntry[] };
      entries = Array.isArray(index.templates) ? index.templates : [];
    } catch (e) {
      this.logger.warn(
        `Registry sync skipped, keeping the last accepted catalogue: ${(e as Error).message}`
      );
      return { synced: 0, skipped: 0 };
    }

    let synced = 0;
    let skipped = 0;
    for (const entry of entries) {
      try {
        const yamlContent = await (await this.fetchRegistry(`${base}/${entry.yaml}`)).text();
        const digest = createHash('sha256').update(yamlContent).digest('hex');
        if (digest !== entry.sha256) {
          this.logger.warn(`Registry template ${entry.name}: checksum mismatch, not importing`);
          skipped += 1;
          continue;
        }
        const parsed = this.templateEngine.parseTemplate(yamlContent);
        if (parsed.metadata.name !== entry.name) {
          this.logger.warn(
            `Registry template ${entry.name}: yaml names itself ${parsed.metadata.name}, not importing`
          );
          skipped += 1;
          continue;
        }
        const existing = await this.prisma.template.findUnique({
          where: { name: entry.name },
          select: { source: true, yaml: true }
        });
        if (existing?.source === 'custom') {
          this.logger.warn(
            `Registry template ${entry.name}: a custom template already uses this name, leaving it alone`
          );
          skipped += 1;
          continue;
        }
        if (existing?.source === 'registry' && existing.yaml === yamlContent) continue;
        const fields = {
          displayName: parsed.metadata.displayName,
          description: parsed.metadata.description,
          icon: parsed.metadata.icon,
          version: parsed.metadata.version,
          category: parsed.metadata.category,
          tags: parsed.metadata.tags || [],
          yaml: yamlContent,
          isBuiltIn: true,
          source: 'registry'
        };
        await this.prisma.template.upsert({
          where: { name: entry.name },
          update: fields,
          create: { name: entry.name, ...fields }
        });
        synced += 1;
      } catch (e) {
        this.logger.warn(`Registry template ${entry.name}: ${e.message}`);
        skipped += 1;
      }
    }
    this.logger.log(
      `Registry sync: ${synced} updated, ${skipped} skipped, ${entries.length} listed`
    );
    return { synced, skipped };
  }

  private async seedBuiltInTemplates() {
    const builtInDir = path.join(__dirname, 'built-in');
    this.logger.log(`Looking for built-in templates in: ${builtInDir}`);
    if (!fs.existsSync(builtInDir)) {
      this.logger.warn(`Built-in templates directory not found: ${builtInDir}`);
      return;
    }

    const files = fs
      .readdirSync(builtInDir)
      .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    this.logger.log(`Found ${files.length} template files: ${files.join(', ')}`);

    const shipped = new Set<string>();
    let unreadable = 0;
    for (const file of files) {
      try {
        this.logger.log(`Processing template file: ${file}`);
        const yamlContent = fs.readFileSync(path.join(builtInDir, file), 'utf-8');
        const parsed = this.templateEngine.parseTemplate(yamlContent);
        shipped.add(parsed.metadata.name);
        this.logger.log(`Parsed template: ${parsed.metadata.name}, upserting to DB...`);

        const claimed = await this.prisma.template.findUnique({
          where: { name: parsed.metadata.name },
          select: { source: true }
        });
        if (claimed?.source === 'registry') {
          this.logger.log(
            `Template ${parsed.metadata.name} is managed by the registry, not reseeding`
          );
          continue;
        }

        await this.prisma.template.upsert({
          where: { name: parsed.metadata.name },
          update: {
            displayName: parsed.metadata.displayName,
            description: parsed.metadata.description,
            icon: parsed.metadata.icon,
            version: parsed.metadata.version,
            category: parsed.metadata.category,
            tags: parsed.metadata.tags || [],
            yaml: yamlContent,
            isBuiltIn: true,
            source: 'built-in'
          },
          create: {
            name: parsed.metadata.name,
            displayName: parsed.metadata.displayName,
            description: parsed.metadata.description,
            icon: parsed.metadata.icon,
            version: parsed.metadata.version,
            category: parsed.metadata.category,
            tags: parsed.metadata.tags || [],
            yaml: yamlContent,
            isBuiltIn: true,
            source: 'built-in'
          }
        });

        this.logger.log(`Seeded built-in template: ${parsed.metadata.name}`);
      } catch (e) {
        unreadable += 1;
        this.logger.error(`Failed to seed template ${file}: ${e.message}`);
      }
    }

    if (unreadable === 0 && this.lease.canCoordinate) {
      await this.pruneRetiredBuiltIns(shipped);
    }
  }

  private async pruneRetiredBuiltIns(shipped: Set<string>) {
    const retired = await this.prisma.template.findMany({
      where: { source: 'built-in', name: { notIn: [...shipped] }, instances: { none: {} } },
      select: { id: true, name: true }
    });
    if (retired.length === 0) return;
    await this.prisma.template.deleteMany({
      where: { id: { in: retired.map((t) => t.id) }, instances: { none: {} } }
    });
    this.logger.log(
      `Removed built-in templates that no longer ship: ${retired.map((t) => t.name).join(', ')}`
    );
  }

  async listTemplates() {
    return this.prisma.template.findMany({
      orderBy: [{ isBuiltIn: 'desc' }, { displayName: 'asc' }],
      select: {
        id: true,
        name: true,
        displayName: true,
        description: true,
        icon: true,
        version: true,
        category: true,
        tags: true,
        isBuiltIn: true,
        source: true
      }
    });
  }

  async getTemplate(id: string) {
    const template = await this.prisma.template.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Template not found');

    const parsed = this.templateEngine.parseTemplate(template.yaml);

    return {
      ...template,
      parameters: parsed.parameters,
      resources: parsed.resources.map((r) => ({
        name: r.name,
        type: r.type,
        cpuMilli: r.recommended?.cpuMilli ?? null,
        memoryBytes: r.recommended?.memoryBytes ?? null
      }))
    };
  }

  async createTemplate(yamlContent: string, clerkId: string, userData?: any) {
    await this.requireSuperAdmin(clerkId, userData);
    const parsed = this.templateEngine.parseTemplate(yamlContent);

    const existing = await this.prisma.template.findUnique({
      where: { name: parsed.metadata.name }
    });
    if (existing) {
      throw new BadRequestException(
        `A template with name "${parsed.metadata.name}" already exists`
      );
    }

    const template = await this.prisma.template.create({
      data: {
        name: parsed.metadata.name,
        displayName: parsed.metadata.displayName,
        description: parsed.metadata.description,
        icon: parsed.metadata.icon,
        version: parsed.metadata.version,
        category: parsed.metadata.category,
        tags: parsed.metadata.tags || [],
        yaml: yamlContent,
        isBuiltIn: false
      }
    });

    return {
      ...template,
      parameters: parsed.parameters,
      resources: parsed.resources.map((r) => ({ name: r.name, type: r.type }))
    };
  }

  async updateTemplate(id: string, yamlContent: string, clerkId: string, userData?: any) {
    await this.requireSuperAdmin(clerkId, userData);
    const existing = await this.prisma.template.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Template not found');
    if (existing.isBuiltIn) {
      throw new BadRequestException("You can't change built-in templates");
    }

    const parsed = this.templateEngine.parseTemplate(yamlContent);

    const nameConflict = await this.prisma.template.findFirst({
      where: { name: parsed.metadata.name, id: { not: id } }
    });
    if (nameConflict) {
      throw new BadRequestException(
        `A template with name "${parsed.metadata.name}" already exists`
      );
    }

    const template = await this.prisma.template.update({
      where: { id },
      data: {
        name: parsed.metadata.name,
        displayName: parsed.metadata.displayName,
        description: parsed.metadata.description,
        icon: parsed.metadata.icon,
        version: parsed.metadata.version,
        category: parsed.metadata.category,
        tags: parsed.metadata.tags || [],
        yaml: yamlContent
      }
    });

    return {
      ...template,
      parameters: parsed.parameters,
      resources: parsed.resources.map((r) => ({ name: r.name, type: r.type }))
    };
  }

  async deleteTemplate(id: string, clerkId: string, userData?: any) {
    await this.requireSuperAdmin(clerkId, userData);
    const existing = await this.prisma.template.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Template not found');
    if (existing.isBuiltIn) {
      throw new BadRequestException("You can't delete built-in templates");
    }

    const instances = await this.prisma.templateInstance.count({
      where: { templateId: id }
    });
    if (instances > 0) {
      throw new BadRequestException(
        `This template has ${instances} active ${instances === 1 ? 'instance' : 'instances'}. Delete ${instances === 1 ? 'it' : 'them'} first.`
      );
    }

    await this.prisma.template.delete({ where: { id } });
    return { success: true };
  }

  async deployTemplate(
    projectId: string,
    templateId: string,
    parameters: Record<string, any>,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    },
    resourceOverride?: PodSizeOverride,
    perResource?: Record<string, PodSizeOverride | null | undefined> | null
  ) {
    const template = await this.prisma.template.findUnique({ where: { id: templateId } });
    if (!template) throw new NotFoundException('Template not found');

    // Resolve user up front so we can authorise the project edit before doing
    // any work; the per-resource calls below also re-check, but failing fast
    // gives a clean 403 instead of a half-created TemplateInstance row.
    const user = await this.usersService.findOrCreateByClerkId(clerkId, userData);
    if (!user) throw new NotFoundException('User not found');
    await this.authz.requireProjectEdit(projectId, user.id, 'deploy a template');

    const parsed = this.templateEngine.parseTemplate(template.yaml);
    const validatedParams = this.templateEngine.validateParameters(parameters, parsed.parameters);

    const instance = await this.prisma.templateInstance.create({
      data: {
        templateId,
        projectId,
        name: validatedParams.appName || parsed.metadata.displayName,
        parameters: validatedParams,
        status: 'deploying',
        createdBy: user?.id
      }
    });

    const context: ResolutionContext = {
      params: validatedParams,
      resources: {}
    };
    const secretValues = secretParameterValues(validatedParams, parsed.parameters);

    try {
      for (const resource of parsed.resources) {
        const config = this.templateEngine.resolveResourceConfig(resource, context);
        const podSize = resource.recommended
          ? chosenPodSize(
              resource.recommended,
              resourceOverride,
              perResource && Object.hasOwn(perResource, resource.name)
                ? perResource[resource.name]
                : null
            )
          : null;

        switch (resource.type) {
          case 'database': {
            const db = await this.databases.createDatabase(
              projectId,
              {
                name: config.name,
                templateInstanceId: instance.id,
                replicas: config.replicas ? Number(config.replicas) : 1,
                ...podSize
              },
              clerkId,
              userData
            );

            const connection = await this.databases.databaseConnection(db.id);
            secretValues.push(connection.password);
            context.resources[resource.name] = {
              id: db.id,
              host: db.host,
              port: db.port,
              dbName: db.dbName,
              dbUser: db.dbUser,
              dbPassword: connection.password,
              connectionString: connection.connectionString
            };
            break;
          }

          case 'deployment': {
            const repoUrl = config.repo || config.githubRepo || config.repoUrl;
            const buildsFromRepo = Boolean(repoUrl);
            const volumes = isolateTemplateVolumes(config.name, config.volumes);

            let deployment;
            if (buildsFromRepo) {
              const buildType = config.buildType === 'railpack' ? 'railpack' : 'dockerfile';
              deployment = await this.deployments.createDeploymentFromGitHub(
                projectId,
                {
                  name: config.name,
                  repoUrl,
                  branch: config.branch,
                  buildType,
                  dockerfilePath:
                    buildType === 'dockerfile' ? config.dockerfilePath || 'Dockerfile' : undefined,
                  rootDirectory: config.rootDirectory,
                  installCommand: config.installCommand,
                  buildCommand: config.buildCommand,
                  startCommand: config.startCommand,
                  outputDirectory: config.outputDirectory,
                  replicas: config.replicas ? Number(config.replicas) : 1,
                  ports: config.ports,
                  port: config.port ? Number(config.port) : undefined,
                  env: sealTemplateEnv(config.env, secretValues),
                  volumes,
                  exposePublic: config.exposePublic ?? false,
                  autoDeployEnabled: config.autoDeploy,
                  autoDeployBranch: config.autoDeployBranch,
                  templateInstanceId: instance.id,
                  ...podSize
                },
                clerkId,
                userData
              );
            } else {
              const deployData: any = {
                name: config.name,
                image: config.image,
                replicas: config.replicas ? Number(config.replicas) : 1,
                ports: config.ports,
                env: sealTemplateEnv(config.env, secretValues),
                volumes,
                exposePublic: config.exposePublic ?? false,
                templateInstanceId: instance.id,
                startCommand: config.startCommand ?? null,
                ...podSize
              };

              deployment = await this.deployments.createDeployment(
                projectId,
                deployData,
                clerkId,
                userData
              );
            }

            const services = await this.prisma.service.findMany({
              where: { deploymentId: deployment.id },
              include: { ports: true }
            });

            const published: Record<string, unknown> = {};
            const wanted = (Array.isArray(config.ports) ? config.ports : []).filter(
              (p: any) => p && (p.public === true || p.public === 'true')
            );
            for (const want of wanted) {
              const containerPort = Number(want.containerPort);
              const hit = services
                .flatMap((s) => s.ports.map((p) => ({ service: s, port: p })))
                .find(
                  ({ port }) =>
                    port.targetPort === containerPort ||
                    port.port === Number(want.servicePort ?? containerPort)
                );
              if (!hit) {
                throw new BadRequestException(
                  `Resource "${resource.name}" asks to publish port ${want.containerPort}, but the deployment has no such port`
                );
              }
              const result = await this.deployments.enableServicePortPublic(
                deployment.id,
                hit.service.id,
                hit.port.id,
                clerkId,
                userData,
                {
                  preserveClientIp:
                    want.preserveClientIp === true || want.preserveClientIp === 'true'
                }
              );
              if (!('publicPort' in published)) {
                published.publicIp = result.ip;
                published.publicPort = result.port;
                published.publicHost = result.host;
              }
              published[`publicPort_${want.name ?? containerPort}`] = result.port;
            }

            context.resources[resource.name] = {
              id: deployment.id,
              serviceName: services[0]?.name || `${config.name}-svc`,
              ...published
            };
            break;
          }

          case 'ingress': {
            const routes = config.routes || [
              {
                path: config.path || '/',
                serviceName: config.serviceName,
                servicePort: config.servicePort || 80
              }
            ];

            await this.ingress.createProjectIngress(
              projectId,
              {
                host: config.host,
                tlsEnabled: config.tlsEnabled !== false,
                routes,
                basicAuth: config.basicAuth,
                templateInstanceId: instance.id
              },
              clerkId,
              userData
            );

            const linkedIngress = await this.prisma.ingress.findFirst({
              where: { projectId, templateInstanceId: instance.id, host: config.host },
              select: { id: true }
            });

            context.resources[resource.name] = {
              id: linkedIngress?.id,
              host: config.host
            };
            break;
          }
          default:
            break;
        }
      }

      await this.prisma.templateInstance.update({
        where: { id: instance.id },
        data: { status: 'active' }
      });

      return this.getTemplateInstance(instance.id, clerkId, userData);
    } catch (e) {
      await this.prisma.templateInstance
        .update({
          where: { id: instance.id },
          data: { status: 'failed' }
        })
        .catch(() => {
          /* ignore */
        });

      try {
        await this.deleteTemplateInstance(instance.id, clerkId, userData);
      } catch (rollbackErr: any) {
        this.logger.error(
          `Rollback of failed template instance ${instance.id} incomplete: ${rollbackErr?.message}`
        );
      }

      throw new BadRequestException(`Template deployment failed: ${e.message}`);
    }
  }

  async renameTemplateInstance(instanceId: string, name: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const instance = await this.prisma.templateInstance.findUnique({
      where: { id: instanceId },
      select: { id: true, name: true, projectId: true }
    });
    if (!instance) throw new NotFoundException('Template instance not found');
    await this.authz.requireProjectEdit(instance.projectId, userId, 'rename template instances');

    const trimmed = String(name || '').trim();
    if (!trimmed) throw new BadRequestException('Name is required');
    if (trimmed.length > 255) throw new BadRequestException('Name is too long');

    if (trimmed !== instance.name) {
      await this.prisma.templateInstance.update({
        where: { id: instanceId },
        data: { name: trimmed }
      });
    }

    return this.getTemplateInstance(instanceId, clerkId, userData);
  }

  private editorParameters(parameters: unknown, yaml: string | null | undefined): unknown {
    try {
      return redactSecretParameters(
        parameters,
        this.templateEngine.parseTemplate(yaml ?? '').parameters
      );
    } catch {
      return blankParameterValues(parameters);
    }
  }

  private parameterDefs(yaml: string | null | undefined) {
    try {
      return describeParameters(this.templateEngine.parseTemplate(yaml ?? '').parameters);
    } catch {
      return [];
    }
  }

  async getTemplateInstance(instanceId: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const owner = await this.prisma.templateInstance.findUnique({
      where: { id: instanceId },
      select: { projectId: true }
    });
    if (!owner) throw new NotFoundException('Template instance not found');
    const access = await this.authz.requireProjectView(owner.projectId, userId);
    const instance = await this.prisma.templateInstance.findUnique({
      where: { id: instanceId },
      include: {
        project: { select: { id: true, name: true, slug: true } },
        template: {
          select: {
            id: true,
            name: true,
            displayName: true,
            icon: true,
            category: true,
            yaml: true
          }
        },
        deployments: {
          select: {
            id: true,
            name: true,
            displayName: true,
            status: true,
            buildStatus: true,
            image: true
          }
        },
        databases: {
          select: {
            id: true,
            name: true,
            status: true,
            dbName: true
          }
        },
        ingresses: {
          select: {
            id: true,
            name: true,
            host: true,
            path: true,
            tlsSecretName: true,
            entrypoints: true,
            deploymentId: true
          }
        }
      }
    });

    if (!instance) throw new NotFoundException('Template instance not found');
    const { yaml, ...template } = instance.template;
    return {
      ...instance,
      template,
      parameters: access.canEdit
        ? this.editorParameters(instance.parameters, yaml)
        : blankParameterValues(instance.parameters),
      parameterDefs: this.parameterDefs(yaml),
      ingresses: instance.ingresses.map((ing) => scrubIngress(ing))
    };
  }

  async getProjectTemplateInstances(projectId: string, clerkId: string, userData?: any) {
    const userId = await this.resolveUserId(clerkId, userData);
    const access = await this.authz.requireProjectView(projectId, userId);
    const instances = await this.prisma.templateInstance.findMany({
      where: { projectId },
      include: {
        template: {
          select: {
            id: true,
            name: true,
            displayName: true,
            icon: true,
            category: true,
            yaml: true
          }
        },
        deployments: { select: { id: true } },
        databases: { select: { id: true } },
        ingresses: { select: { id: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    return instances.map(({ template: { yaml, ...template }, ...instance }) => ({
      ...instance,
      template,
      parameters: access.canEdit
        ? this.editorParameters(instance.parameters, yaml)
        : blankParameterValues(instance.parameters)
    }));
  }

  async deleteTemplateInstance(
    instanceId: string,
    clerkId: string,
    userData?: {
      email?: string;
      username?: string;
      firstName?: string;
      lastName?: string;
      imageUrl?: string;
    }
  ) {
    const instance = await this.prisma.templateInstance.findUnique({
      where: { id: instanceId },
      include: {
        deployments: { select: { id: true } },
        databases: { select: { id: true } },
        ingresses: { select: { id: true, projectId: true } }
      }
    });

    if (!instance) throw new NotFoundException('Template instance not found');

    const userId = await this.resolveUserId(clerkId, userData);
    await this.authz.requireProjectEdit(instance.projectId, userId, 'delete a template instance');

    await this.prisma.templateInstance.update({
      where: { id: instanceId },
      data: { status: 'deleting' }
    });

    const errors: string[] = [];

    // Delete ingresses first
    for (const ingress of instance.ingresses) {
      try {
        await this.ingress.deleteProjectIngress(ingress.projectId, ingress.id, clerkId, userData);
      } catch (e) {
        errors.push(`Failed to delete ingress ${ingress.id}: ${e.message}`);
      }
    }

    for (const deployment of instance.deployments) {
      try {
        await this.deployments.deleteDeployment(deployment.id, clerkId, userData);
      } catch (e) {
        errors.push(`Failed to delete deployment ${deployment.id}: ${e.message}`);
      }
    }

    for (const database of instance.databases) {
      try {
        await this.databases.deleteDatabase(database.id, clerkId, userData);
      } catch (e) {
        errors.push(`Failed to delete database ${database.id}: ${e.message}`);
      }
    }

    if (errors.length > 0) {
      this.logger.warn(`Template instance ${instanceId} cleanup had errors: ${errors.join('; ')}`);
      await this.prisma.templateInstance.update({
        where: { id: instanceId },
        data: { status: 'failed' }
      });
      throw new BadRequestException(`Template instance cleanup failed: ${errors.join('; ')}`);
    }

    await this.prisma.templateInstance.delete({ where: { id: instanceId } });

    return { success: true, errors };
  }
}
