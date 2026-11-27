import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
  PayloadTooLargeException
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { KubernetesService } from './kubernetes.service';
import { K8sCnpgService } from './k8s-cnpg.service';
import { K8sWorkloadService } from './k8s-workload.service';
import { K8sNetworkService } from './k8s-network.service';
import {
  PodFilesService,
  outcomeOf,
  type ExecOutcomeLabel,
  type PodExecTarget
} from './pod-files.service';
import {
  EDIT_MAX_BYTES,
  FILE_RESPONSE_CSP,
  contentDisposition,
  fileNameFromPath,
  PodFileSlots,
  inlineImageType,
  isProtectedPath,
  isWithinPodPath,
  mountFor,
  normalizePodPath,
  parentPodPath,
  podMounts,
  queryString,
  type PodMount
} from './pod-files';
import { RAW_BODY_LIMIT } from '../http/body-limits';
import { AuditService, type AuditMetadataValue } from '../audit/audit.service';
import { Auth, RequireScope } from '../auth/decorators';
import { AuthorizationService } from '../auth/authorization.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveNamespaceScope } from '../projects/namespace-scope';
import { assertValidPodName } from './pod-name';
import { assertPodExecable } from './pod-exec-policy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const NAMESPACE_NOT_FOUND = 'Not found';
const NIL_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

interface PodFileAccess {
  target: PodExecTarget;
  mounts: PodMount[];
  userId: string;
  actorEmail: string | null;
  projectId: string;
  organizationId: string | null;
}

type PodFileQuery = Partial<
  Record<'namespace' | 'path' | 'container' | 'to' | 'overwrite' | 'inline', string>
>;

function podFileQuery(values: { [K in keyof PodFileQuery]?: unknown }): PodFileQuery {
  const out: PodFileQuery = {};
  for (const [name, value] of Object.entries(values) as Array<[keyof PodFileQuery, unknown]>) {
    out[name] = queryString(value, name);
  }
  return out;
}

function mountPaths(access: PodFileAccess): string[] {
  return access.mounts.map((mount) => mount.path);
}

function tooLarge(message: string): HttpException {
  return new PayloadTooLargeException({ statusCode: 413, message, code: 'too_large' });
}

class ExecTimeout extends BadRequestException {}

function mountRootError(): HttpException {
  return new ConflictException({
    statusCode: 409,
    message: 'That path holds a mount or system folder, so it cannot be changed',
    code: 'mount_root'
  });
}

@Auth()
@Controller()
export class KubernetesController {
  private readonly fileSlots = new PodFileSlots();

  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly k8sCnpg: K8sCnpgService,
    private readonly k8sWorkload: K8sWorkloadService,
    private readonly k8sNetwork: K8sNetworkService,
    private readonly authz: AuthorizationService,
    private readonly prisma: PrismaService,
    private readonly podFiles: PodFilesService,
    private readonly audit: AuditService
  ) {}

  /**
   * Resolve a namespace to its owning project and require the caller has the
   * appropriate access. Returns 404 (not 403) when the caller has no path to
   * the project: matches the wider RBAC contract.
   */
  private async resolveNamespace(
    namespace: string | undefined,
    req: any,
    mode: 'view' | 'edit',
    action = 'access this namespace',
    podName?: string
  ) {
    if (!namespace) throw new BadRequestException('namespace query parameter is required');
    const scope = await resolveNamespaceScope(this.prisma, namespace);
    const deploymentId =
      scope && podName
        ? ((
            await this.prisma.pod.findFirst({
              where: { name: podName, deployment: { namespace, projectId: scope.projectId } },
              select: { deploymentId: true }
            })
          )?.deploymentId ?? undefined)
        : undefined;
    const userId = await this.resolveUserId(req);
    const projectId = scope?.projectId ?? NIL_PROJECT_ID;
    const organizationId = scope?.organizationId ?? null;
    try {
      if (mode === 'edit') {
        await this.authz.requireProjectEdit(projectId, userId, action, deploymentId);
        if (!scope) throw new NotFoundException(NAMESPACE_NOT_FOUND);
        return { projectId, organizationId, userId, canEdit: true };
      }
      const access = await this.authz.requireProjectView(projectId, userId, deploymentId);
      if (!scope) throw new NotFoundException(NAMESPACE_NOT_FOUND);
      return { projectId, organizationId, userId, canEdit: access.canEdit };
    } catch (error) {
      if (error instanceof NotFoundException) throw new NotFoundException(NAMESPACE_NOT_FOUND);
      throw error;
    }
  }

  /**
   * Viewers get env var values nulled on the deployment path
   * (`scrubDeploymentForViewer`); the pod manifest carries the same values in
   * `spec.containers[].env` and has to match. Secret-flagged vars reach the
   * container through `secretKeyRef` and were never in the manifest to begin
   * with, so `valueFrom` entries are left intact.
   */
  private static scrubPodForViewer(pod: any): any {
    if (!pod?.spec) return pod;
    const scrubContainers = (containers: any[] | undefined) =>
      containers?.map((c: any) => ({
        ...c,
        env: c.env?.map((e: any) => (e?.value !== undefined ? { ...e, value: null } : e))
      }));
    return {
      ...pod,
      spec: {
        ...pod.spec,
        containers: scrubContainers(pod.spec.containers),
        initContainers: scrubContainers(pod.spec.initContainers),
        ephemeralContainers: scrubContainers(pod.spec.ephemeralContainers)
      }
    };
  }

  private async resolveUserId(req: any): Promise<string> {
    const sub = req.user?.sub as string | undefined;
    if (!sub) throw new ForbiddenException('Not authenticated');
    if (UUID_RE.test(sub)) return sub;
    const user = await this.prisma.user.findFirst({
      where: { externalAuthId: sub },
      select: { id: true }
    });
    if (!user) throw new ForbiddenException('User not found');
    return user.id;
  }

  @Get('pods')
  async listPods(
    @Query('namespace') namespace: string,
    @Req() req: any,
    @Query('live') live?: string
  ) {
    await this.resolveNamespace(namespace, req, 'view');
    if (live === '1' || live === 'true') {
      return this.k8sWorkload.listPods(namespace);
    }
    const objects = await this.prisma.k8sObject.findMany({
      where: { kind: 'Pod', namespace },
      select: { manifest: true }
    });
    const pods = objects.map((o) => {
      const pod = o.manifest as any;
      return {
        name: pod.metadata?.name,
        namespace: pod.metadata?.namespace,
        status: pod.status?.phase,
        podIP: pod.status?.podIP,
        hostIP: pod.status?.hostIP,
        startTime: pod.status?.startTime,
        conditions: pod.status?.conditions,
        containerStatuses: pod.status?.containerStatuses?.map((container: any) => ({
          name: container.name,
          ready: container.ready,
          restartCount: container.restartCount,
          image: container.image,
          state: container.state
        })),
        labels: pod.metadata?.labels,
        annotations: pod.metadata?.annotations
      };
    });
    return { namespace, podCount: pods.length, pods };
  }

  @Get('pods/:podName')
  async getPod(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
    @Query('live') live?: string
  ) {
    const access = await this.resolveNamespace(namespace, req, 'view', undefined, podName);
    const scrub = (pod: any) =>
      access.canEdit ? pod : KubernetesController.scrubPodForViewer(pod);
    if (live === '1' || live === 'true') {
      return scrub(await this.k8sWorkload.getPod(podName, namespace));
    }
    const object = await this.prisma.k8sObject.findFirst({
      where: { kind: 'Pod', namespace, name: podName },
      select: { manifest: true }
    });
    if (!object) return scrub(await this.k8sWorkload.getPod(podName, namespace));
    return scrub(object.manifest);
  }

  @Delete('pods/:podName')
  async deletePod(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string
  ) {
    await this.resolveNamespace(namespace, req, 'edit', 'delete a pod');
    return this.k8sWorkload.deletePod(podName, namespace);
  }

  @Get('pods/:podName/logs')
  async getPodLogs(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
    @Query('container') container?: string,
    @Query('tailLines') tailLines?: string,
    @Query('previous') previous?: string,
    @Query('sinceSeconds') sinceSeconds?: string,
    @Query('sinceTime') sinceTime?: string
  ) {
    await this.resolveNamespace(namespace, req, 'edit', 'stream pod logs', podName);
    if (sinceSeconds && sinceTime) {
      throw new BadRequestException('sinceSeconds and sinceTime are mutually exclusive');
    }
    const parsedSinceSeconds = sinceSeconds ? parseInt(sinceSeconds, 10) : undefined;
    if (sinceSeconds && (!Number.isInteger(parsedSinceSeconds) || parsedSinceSeconds <= 0)) {
      throw new BadRequestException('sinceSeconds must be a positive integer');
    }
    if (sinceTime && (!RFC3339_RE.test(sinceTime) || Number.isNaN(Date.parse(sinceTime)))) {
      throw new BadRequestException('sinceTime must be an RFC3339 timestamp');
    }
    const parsedTailLines = tailLines ? parseInt(tailLines, 10) : 100;
    const wantPrevious = previous === 'true' || previous === '1';
    return this.k8sWorkload.getPodLogs(
      podName,
      namespace,
      container,
      parsedTailLines,
      wantPrevious,
      parsedSinceSeconds,
      sinceTime
    );
  }

  // Synchronous one-shot exec. Used by the MCP exec tool and any non-WS
  // caller: the websocket terminal gateway handles interactive sessions.
  // Requires the `exec` API-token scope (the default for POST is `deploy`,
  // which is insufficient: exec is shell access and demands an explicit
  // higher-privilege scope, matching the WS terminal gateway).
  @Post('pods/:podName/exec')
  @RequireScope('exec')
  async execInPod(
    @Param('podName') podName: string,
    @Body() body: {
      namespace?: string;
      command: string | string[];
      container?: string;
      timeoutMs?: number;
    },
    @Req() req: any,
    @Query('namespace') namespaceQuery?: string
  ) {
    const bodyNamespace = typeof body?.namespace === 'string' ? body.namespace : undefined;
    const namespace = (bodyNamespace || queryString(namespaceQuery, 'namespace') || '').trim();
    if (!namespace) throw new BadRequestException('namespace is required');
    assertValidPodName(podName);
    const scope = await this.resolveNamespace(namespace, req, 'edit', 'exec in pod', podName);
    await assertPodExecable(
      async (ns, name) => (await this.k8sWorkload.getPod(name, ns)).metadata?.labels,
      namespace,
      podName
    );

    let cmd: string[] = [];
    if (Array.isArray(body?.command)) {
      cmd = body.command;
    } else if (typeof body?.command === 'string' && body.command.trim()) {
      cmd = ['/bin/sh', '-c', body.command];
    }
    if (cmd.length === 0) {
      throw new BadRequestException('command is required (string or string[])');
    }

    const timeoutMs = Math.min(Math.max(Number(body?.timeoutMs) || 60_000, 1_000), 300_000);
    let success = false;
    let outcome: ExecOutcomeLabel = 'unknown';
    let ranIn: string | null = typeof body?.container === 'string' ? body.container : null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.k8sCnpg.runExec(namespace, podName, cmd, body?.container),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ExecTimeout(`exec timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        })
      ]);
      success = result.success;
      outcome = result.success ? 'ok' : 'failed';
      ranIn = result.container;
      return result;
    } catch (error) {
      outcome = error instanceof ExecTimeout ? 'unknown' : 'failed';
      throw error;
    } finally {
      clearTimeout(timer);
      this.auditPod(
        {
          userId: scope.userId,
          actorEmail: typeof req.user?.email === 'string' ? req.user.email : null,
          projectId: scope.projectId,
          organizationId: scope.organizationId,
          target: { namespace, pod: podName }
        },
        'deployment.pod.exec.command',
        {
          namespace,
          container: ranIn,
          command: cmd.map(String).join(' '),
          success,
          outcome,
          timeoutMs
        }
      );
    }
  }

  @Get('pods/:podName/files')
  @RequireScope('exec')
  async listPodFiles(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
    @Query('path') path?: string,
    @Query('container') container?: string
  ) {
    const q = podFileQuery({ namespace, path, container });
    const access = await this.resolvePodFileAccess(q, podName, req, 'list files in pod');
    const dir = normalizePodPath(q.path);
    const listing = await this.withSlot(access, () => this.podFiles.list(access.target, dir));
    return {
      path: dir,
      writable: listing.writable && !mountFor(access.mounts, dir)?.readOnly,
      truncated: listing.truncated,
      entries: listing.entries,
      mounts: access.mounts
    };
  }

  @Get('pods/:podName/files/content')
  @RequireScope('exec')
  async readPodFile(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
    @Query('path') path?: string,
    @Query('container') container?: string
  ) {
    const q = podFileQuery({ namespace, path, container });
    const access = await this.resolvePodFileAccess(q, podName, req, 'read files in pod');
    const file = normalizePodPath(q.path);
    if (file === '/') throw new BadRequestException('path must name a file');
    const preview = await this.withSlot(access, () => this.podFiles.preview(access.target, file));
    this.auditPodFile(access, 'deployment.pod.file.read', { path: file, size: preview.size });
    return { path: file, ...preview };
  }

  @Get('pods/:podName/files/download')
  @RequireScope('exec')
  async downloadPodFile(
    @Param('podName') podName: string,
    @Req() req: any,
    @Res() res: Response,
    @Query('namespace') namespace?: string,
    @Query('path') path?: string,
    @Query('container') container?: string,
    @Query('inline') inline?: string
  ) {
    const q = podFileQuery({ namespace, path, container, inline });
    const access = await this.resolvePodFileAccess(q, podName, req, 'download files from pod');
    const file = normalizePodPath(q.path);
    if (file === '/') throw new BadRequestException('path must name a file or folder');
    const release = this.fileSlots.acquire(access.userId);
    try {
      await this.streamDownload(access, file, q.inline === '1' || q.inline === 'true', res);
    } finally {
      release();
    }
  }

  private async streamDownload(
    access: PodFileAccess,
    file: string,
    wantInline: boolean,
    res: Response
  ) {
    const kind = await this.podFiles.checkDownload(access.target, file);
    const name = fileNameFromPath(file);
    const imageType = kind === 'file' && wantInline ? inlineImageType(name) : null;
    const sendHeaders = () => {
      res.setHeader(
        'Content-Type',
        kind === 'dir' ? 'application/gzip' : (imageType ?? 'application/octet-stream')
      );
      res.setHeader(
        'Content-Disposition',
        contentDisposition(
          kind === 'dir' ? `${name}.tar.gz` : name,
          imageType ? 'inline' : 'attachment'
        )
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', FILE_RESPONSE_CSP);
      res.setHeader('Cache-Control', 'private, no-store');
      this.auditPodFile(
        access,
        imageType ? 'deployment.pod.file.read' : 'deployment.pod.file.download',
        { path: file, kind, inline: !!imageType }
      );
    };
    const cmd =
      kind === 'dir'
        ? ['tar', '-czf', '-', '-C', parentPodPath(file), '--', name]
        : ['cat', '--', file];
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    try {
      await this.podFiles.streamFile(
        access.target,
        cmd,
        res,
        abort.signal,
        sendHeaders,
        kind === 'dir' ? [0, 1] : [0]
      );
    } catch (error) {
      if (!res.headersSent) throw error;
      res.destroy();
      return;
    }
    if (res.destroyed) return;
    if (!res.headersSent) sendHeaders();
    res.end();
  }

  @Put('pods/:podName/files/content')
  @RequireScope('exec')
  async writePodFile(
    @Param('podName') podName: string,
    @Req() req: any,
    @Body() body: { content?: unknown; expectedMtime?: unknown },
    @Query('namespace') namespace?: string,
    @Query('path') path?: string,
    @Query('container') container?: string
  ) {
    const q = podFileQuery({ namespace, path, container });
    const access = await this.resolvePodFileAccess(q, podName, req, 'edit files in pod');
    const file = KubernetesController.writablePath(access.mounts, q.path);
    if (typeof body?.content !== 'string')
      throw new BadRequestException('content must be a string');
    const expected = body.expectedMtime ?? null;
    if (expected !== null && !(Number.isSafeInteger(expected) && (expected as number) >= 0)) {
      throw new BadRequestException('expectedMtime must be a unix timestamp or null');
    }
    const bytes = Buffer.from(body.content, 'utf-8');
    if (bytes.length > EDIT_MAX_BYTES) throw tooLarge('Files over 1 MiB cannot be edited here');
    return this.mutate(
      access,
      'deployment.pod.file.write',
      { path: file, size: bytes.length },
      () =>
        this.podFiles.writeFile(
          access.target,
          file,
          'edit',
          Readable.from([bytes]),
          bytes.length,
          new AbortController().signal,
          expected as number | null
        )
    );
  }

  @Put('pods/:podName/files/upload')
  @RequireScope('exec')
  async uploadPodFile(
    @Param('podName') podName: string,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
    @Query('namespace') namespace?: string,
    @Query('path') path?: string,
    @Query('container') container?: string,
    @Query('overwrite') overwrite?: string
  ) {
    try {
      const q = podFileQuery({ namespace, path, container, overwrite });
      const access = await this.resolvePodFileAccess(q, podName, req, 'upload files to pod');
      const file = KubernetesController.writablePath(access.mounts, q.path);
      const length = KubernetesController.uploadLength(req);
      const mode = q.overwrite === '1' || q.overwrite === 'true' ? 'overwrite' : 'create';
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      return await this.mutate(
        access,
        'deployment.pod.file.upload',
        { path: file, size: length, overwrite: mode === 'overwrite' },
        async () => {
          await this.podFiles.checkWrite(access.target, file, mode);
          return this.podFiles.writeFile(access.target, file, mode, req, length, abort.signal);
        }
      );
    } catch (error) {
      if (!req.complete && !res.headersSent) res.setHeader('Connection', 'close');
      throw error;
    }
  }

  @Post('pods/:podName/files/mkdir')
  @RequireScope('exec')
  async makePodDirectory(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
    @Query('path') path?: string,
    @Query('container') container?: string
  ) {
    const q = podFileQuery({ namespace, path, container });
    const access = await this.resolvePodFileAccess(q, podName, req, 'create folders in pod');
    const dir = KubernetesController.writablePath(access.mounts, q.path);
    await this.mutate(access, 'deployment.pod.file.mkdir', { path: dir }, () =>
      this.podFiles.mkdir(access.target, dir)
    );
    return { path: dir };
  }

  @Post('pods/:podName/files/move')
  @RequireScope('exec')
  async movePodFile(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
    @Query('path') path?: string,
    @Query('to') to?: string,
    @Query('container') container?: string
  ) {
    const q = podFileQuery({ namespace, path, container, to });
    const access = await this.resolvePodFileAccess(q, podName, req, 'move files in pod');
    const from = KubernetesController.writablePath(access.mounts, q.path);
    const dest = KubernetesController.writablePath(access.mounts, q.to);
    if (isProtectedPath(access.mounts, from) || isProtectedPath(access.mounts, dest)) {
      throw mountRootError();
    }
    if (isWithinPodPath(dest, from)) {
      throw new BadRequestException('A folder cannot be moved into itself');
    }
    await this.mutate(access, 'deployment.pod.file.move', { path: from, to: dest }, () =>
      this.podFiles.move(access.target, from, dest, mountPaths(access))
    );
    return { path: dest };
  }

  @Delete('pods/:podName/files')
  @RequireScope('exec')
  async deletePodFile(
    @Param('podName') podName: string,
    @Req() req: any,
    @Query('namespace') namespace?: string,
    @Query('path') path?: string,
    @Query('container') container?: string
  ) {
    const q = podFileQuery({ namespace, path, container });
    const access = await this.resolvePodFileAccess(q, podName, req, 'delete files in pod');
    const target = normalizePodPath(q.path);
    if (isProtectedPath(access.mounts, target)) throw mountRootError();
    KubernetesController.writablePath(access.mounts, target);
    const metadata: Record<string, AuditMetadataValue> = { path: target };
    const kind = await this.mutate(access, 'deployment.pod.file.delete', metadata, async () => {
      const removed = await this.podFiles.remove(access.target, target, mountPaths(access));
      metadata.kind = removed;
      return removed;
    });
    return { path: target, kind };
  }

  private async withSlot<T>(access: PodFileAccess, fn: () => Promise<T>): Promise<T> {
    const release = this.fileSlots.acquire(access.userId);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async mutate<T>(
    access: PodFileAccess,
    action: string,
    metadata: Record<string, AuditMetadataValue>,
    fn: () => Promise<T>
  ): Promise<T> {
    const release = this.fileSlots.acquire(access.userId);
    let outcome: ExecOutcomeLabel = 'unknown';
    try {
      const result = await fn();
      outcome = 'ok';
      return result;
    } catch (error) {
      outcome = outcomeOf(error);
      throw error;
    } finally {
      release();
      this.auditPodFile(access, action, { ...metadata, outcome });
    }
  }

  private static writablePath(mounts: PodMount[], input: unknown): string {
    const path = normalizePodPath(input);
    if (path === '/') throw new BadRequestException('path must not be /');
    if (mountFor(mounts, path)?.readOnly) {
      throw new ConflictException({
        statusCode: 409,
        message: `${path} is on a read-only mount`,
        code: 'read_only'
      });
    }
    return path;
  }

  private static uploadLength(req: any): number {
    const header = req.headers?.['content-length'];
    if (typeof header !== 'string' || req.headers?.['transfer-encoding']) {
      throw new HttpException(
        { statusCode: HttpStatus.LENGTH_REQUIRED, message: 'Content-Length is required' },
        HttpStatus.LENGTH_REQUIRED
      );
    }
    if (!/^\d+$/.test(header)) throw new BadRequestException('Content-Length is invalid');
    const length = Number(header);
    if (!Number.isSafeInteger(length) || length > RAW_BODY_LIMIT) {
      throw tooLarge('Uploads are limited to 512 MiB');
    }
    return length;
  }

  private auditPodFile(
    access: PodFileAccess,
    action: string,
    metadata: Record<string, AuditMetadataValue>
  ) {
    this.auditPod(access, action, {
      namespace: access.target.namespace,
      container: access.target.container,
      ...metadata
    });
  }

  private auditPod(
    actor: {
      userId: string;
      actorEmail: string | null;
      projectId: string;
      organizationId: string | null;
      target: { namespace: string; pod: string };
    },
    action: string,
    metadata: Record<string, AuditMetadataValue>
  ) {
    this.prisma.pod
      .findFirst({
        where: { name: actor.target.pod, deployment: { namespace: actor.target.namespace } },
        select: { deploymentId: true }
      })
      .catch(() => null)
      .then((row) =>
        this.audit.log({
          action,
          actorUserId: actor.userId,
          actorEmail: actor.actorEmail,
          organizationId: actor.organizationId,
          projectId: actor.projectId,
          deploymentId: row?.deploymentId ?? null,
          targetType: 'pod',
          targetId: actor.target.pod,
          targetLabel: actor.target.pod,
          metadata
        })
      )
      .catch(() => {});
  }

  private async resolvePodFileAccess(
    q: PodFileQuery,
    podName: string,
    req: any,
    action: string
  ): Promise<PodFileAccess> {
    assertValidPodName(podName);
    const container = q.container;
    const ns = (q.namespace ?? '').trim();
    if (!ns) throw new BadRequestException('namespace query parameter is required');
    const scope = await this.resolveNamespace(ns, req, 'edit', action, podName);
    let pod: Awaited<ReturnType<K8sWorkloadService['getPod']>> | undefined;
    await assertPodExecable(
      async (n, name) => {
        pod = await this.k8sWorkload.getPod(name, n);
        return pod.metadata?.labels;
      },
      ns,
      podName
    );
    const names = (pod?.spec?.containers ?? []).map((c) => c.name);
    const requested = container?.trim();
    if (requested && !names.includes(requested)) {
      throw new NotFoundException(`Container ${requested} not found in pod ${podName}`);
    }
    const target = requested || names[0];
    if (!target) throw new NotFoundException(`Pod ${podName} has no containers`);
    return {
      target: { namespace: ns, pod: podName, container: target },
      mounts: podMounts(pod, target),
      userId: scope.userId,
      actorEmail: typeof req.user?.email === 'string' ? req.user.email : null,
      projectId: scope.projectId,
      organizationId: scope.organizationId
    };
  }

  @Get('endpoints')
  async listEndpoints(@Query('namespace') namespace: string, @Req() req: any) {
    await this.resolveNamespace(namespace, req, 'view');
    return this.k8sNetwork.listEndpoints(namespace);
  }

  @Get('sync/:namespace')
  @RequireScope('deploy')
  async syncNamespace(@Param('namespace') namespace: string, @Req() req: any) {
    await this.resolveNamespace(namespace, req, 'edit', 'sync namespace state');
    return this.k8sWorkload.syncNamespaceToDatabase(namespace);
  }
}
