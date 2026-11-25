import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER, ModuleRef } from '@nestjs/core';
import * as k8s from '@kubernetes/client-node';
import { PassThrough } from 'stream';
import { isSafeGitRef } from '../../docker/build-input';
import { onEnvironmentEnvChanged, type EnvironmentEnvChange } from '../../env/env-change-signal';
import { PrismaService } from '../../prisma/prisma.service';
import type { DeploymentsService } from '../../projects/deployments.service';
import type { EnvironmentsService } from '../../projects/environments.service';
import type { IngressService } from '../../projects/ingress.service';
import type { KubernetesService } from '../../kubernetes/kubernetes.service';
import type { K8sWorkloadService } from '../../kubernetes/k8s-workload.service';
import type { PtyHandle } from '../../kubernetes/pty';
import type { GraftRecord } from '../graft-registry';
import { bindGraft, type DoorMeta } from './door';

type CreateFromGitHub = DeploymentsService['createDeploymentFromGitHub'];
type Rebuild = DeploymentsService['rebuildDeployment'];
type CreateEnvironment = EnvironmentsService['createEnvironment'];
type DeleteEnvironment = EnvironmentsService['deleteEnvironment'];
type DeleteFromCluster = EnvironmentsService['deleteEnvironmentFromCluster'];
type AutoIngress = IngressService['createAutoIngressForDeployment'];
type CreateDeployment = DeploymentsService['createDeployment'];
type DeploymentVolumes = Parameters<DeploymentsService['updateDeploymentVolumes']>[1];
type EnvWrite = Parameters<DeploymentsService['updateDeploymentEnvVars']>[1];

export type PodExecResult = { exitCode: number; stdout: string; stderr: string };
export type PodFileEntry = { name: string; type: 'file' | 'dir' | 'other'; size: number };

const MAX_EXEC_OUTPUT = 4 * 1024 * 1024;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertPodPath(path: string): void {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
    throw new Error('pod file paths must be absolute');
  }
}

function exitCodeOf(status: k8s.V1Status | undefined): number {
  if (!status || status.status === 'Success') return 0;
  const cause = status.details?.causes?.find((c) => c.reason === 'ExitCode');
  const code = Number(cause?.message);
  return Number.isInteger(code) ? code : 1;
}

@Injectable({ scope: Scope.TRANSIENT })
export class ProjectsDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'projects',
    version: 1,
    status: 'stable',
    capability: 'projects.read'
  };
  private readonly graft: GraftRecord;

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {
    this.graft = bindGraft(parent, ProjectsDoorV1.meta);
  }

  onEnvironmentEnvChanged(listener: (change: EnvironmentEnvChange) => void): () => void {
    return onEnvironmentEnvChanged(listener);
  }

  async createDeploymentFromGitHub(
    ...args: Parameters<CreateFromGitHub>
  ): Promise<Awaited<ReturnType<CreateFromGitHub>>> {
    const created = await (await this.deployments()).createDeploymentFromGitHub(...args);
    await this.stamp(created);
    return created;
  }

  // Custom image deployment. `startCommand` overrides the image's CMD.
  async createDeployment(
    ...args: Parameters<CreateDeployment>
  ): Promise<Awaited<ReturnType<CreateDeployment>>> {
    const created = await (await this.deployments()).createDeployment(...args);
    await this.stamp(created);
    return created;
  }

  // Everything below acts only on deployments this graft created.

  async listOwnDeployments(): Promise<{ id: string; projectId: string; name: string }[]> {
    return this.prisma.deployment.findMany({
      where: { createdByGraft: this.graft.id },
      select: { id: true, projectId: true, name: true }
    });
  }

  async getDeployment(deploymentId: string) {
    await this.own(deploymentId);
    const svc = await this.deployments(false);
    return svc.getDeployment(deploymentId, false);
  }

  async getDeploymentPods(deploymentId: string) {
    await this.own(deploymentId);
    return (await this.deployments(false)).getDeploymentPods(deploymentId);
  }

  async startDeployment(deploymentId: string, clerkId: string) {
    await this.own(deploymentId);
    return (await this.deployments()).startDeployment(deploymentId, clerkId);
  }

  async stopDeployment(deploymentId: string, clerkId: string) {
    await this.own(deploymentId);
    return (await this.deployments()).stopDeployment(deploymentId, clerkId);
  }

  async restartDeployment(deploymentId: string, clerkId: string) {
    await this.own(deploymentId);
    return (await this.deployments()).restartDeployment(deploymentId, clerkId);
  }

  async scaleDeployment(deploymentId: string, replicas: number, clerkId: string) {
    await this.own(deploymentId);
    return (await this.deployments()).scaleDeployment(deploymentId, replicas, clerkId);
  }

  async deleteDeployment(deploymentId: string, clerkId: string) {
    await this.own(deploymentId);
    return (await this.deployments()).deleteDeployment(deploymentId, clerkId);
  }

  async updateDeploymentImage(deploymentId: string, image: string, clerkId: string) {
    await this.own(deploymentId);
    return (await this.deployments()).updateDeploymentImage(deploymentId, image, clerkId);
  }

  async updateStartCommand(deploymentId: string, startCommand: string | null, clerkId: string) {
    await this.own(deploymentId);
    return (await this.deployments()).updateDeploymentBuildConfig(
      deploymentId,
      { startCommand },
      clerkId
    );
  }

  async updateDeploymentEnvVars(deploymentId: string, env: EnvWrite, clerkId: string) {
    await this.own(deploymentId);
    return (await this.deployments()).updateDeploymentEnvVars(deploymentId, env, clerkId);
  }

  // Replaces the full volume list: add, resize or remove by sending the new set.
  async updateDeploymentVolumes(
    deploymentId: string,
    volumes: DeploymentVolumes,
    clerkId: string
  ) {
    await this.own(deploymentId);
    return (await this.deployments()).updateDeploymentVolumes(deploymentId, volumes, clerkId);
  }

  async getPodLogs(
    deploymentId: string,
    podName: string,
    opts: { container?: string; tailLines?: number; previous?: boolean; sinceSeconds?: number } = {}
  ) {
    const { namespace } = await this.ownPod(deploymentId, podName);
    const { K8sWorkloadService } = await import('../../kubernetes/k8s-workload.service.js');
    const workload: K8sWorkloadService = this.moduleRef.get(K8sWorkloadService, { strict: false });
    return workload.getPodLogs(
      podName,
      namespace,
      opts.container,
      opts.tailLines ?? 100,
      opts.previous ?? false,
      opts.sinceSeconds
    );
  }

  // One-shot command, no websocket for the caller. A string runs under /bin/sh -c.
  async execInPod(
    deploymentId: string,
    podName: string,
    command: string | string[],
    opts: { container?: string; timeoutMs?: number; stdin?: string | Buffer } = {}
  ): Promise<PodExecResult> {
    const { namespace } = await this.ownPod(deploymentId, podName);
    const cmd = Array.isArray(command) ? command : ['/bin/sh', '-c', command];
    if (cmd.length === 0 || (typeof command === 'string' && !command.trim())) {
      throw new Error('command is required');
    }
    return this.runExec(namespace, podName, cmd, opts);
  }

  async listPodFiles(deploymentId: string, podName: string, dir: string, container?: string) {
    assertPodPath(dir);
    const res = await this.execInPod(
      deploymentId,
      podName,
      `cd ${shellQuote(dir)} && for f in .* *; do [ "$f" = . ] || [ "$f" = .. ] || [ ! -e "$f" ] && [ ! -L "$f" ] && continue; if [ -d "$f" ]; then t=dir; elif [ -f "$f" ]; then t=file; else t=other; fi; printf '%s\\t%s\\t%s\\n' "$t" "$(wc -c < "$f" 2>/dev/null || echo 0)" "$f"; done`,
      { container }
    );
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `cannot list ${dir}`);
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line): PodFileEntry => {
        const [type, size, ...name] = line.split('\t');
        return {
          name: name.join('\t'),
          type: type as PodFileEntry['type'],
          size: type === 'file' ? Number(size) || 0 : 0
        };
      });
  }

  async readPodFile(
    deploymentId: string,
    podName: string,
    path: string,
    container?: string
  ): Promise<Buffer> {
    assertPodPath(path);
    const res = await this.execInPod(deploymentId, podName, `base64 < ${shellQuote(path)}`, {
      container
    });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `cannot read ${path}`);
    return Buffer.from(res.stdout.replace(/\s+/g, ''), 'base64');
  }

  // Creates or overwrites; covers both edit and upload.
  async writePodFile(
    deploymentId: string,
    podName: string,
    path: string,
    content: string | Buffer,
    container?: string
  ): Promise<void> {
    assertPodPath(path);
    const res = await this.execInPod(
      deploymentId,
      podName,
      `mkdir -p "$(dirname ${shellQuote(path)})" && base64 -d > ${shellQuote(path)}`,
      { container, stdin: Buffer.from(content).toString('base64') }
    );
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `cannot write ${path}`);
  }

  async deletePodFile(
    deploymentId: string,
    podName: string,
    path: string,
    container?: string
  ): Promise<void> {
    assertPodPath(path);
    if (path.replace(/\/+$/, '') === '') throw new Error('refusing to delete /');
    const res = await this.execInPod(deploymentId, podName, `rm -rf -- ${shellQuote(path)}`, {
      container
    });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `cannot delete ${path}`);
  }

  // Attaches to the container's PID 1 console (kubectl attach). Needs the
  // container to run with stdin/tty for input to reach it.
  async attachConsole(
    deploymentId: string,
    podName: string,
    opts: { container?: string; tty?: boolean } = {}
  ): Promise<PtyHandle> {
    const { namespace } = await this.ownPod(deploymentId, podName);
    const kc = await this.kubeConfig();
    const container = opts.container || (await this.firstContainer(kc, namespace, podName));
    const tty = opts.tty ?? true;
    const stdin = new PassThrough();
    const output = new PassThrough();
    const ws = await new k8s.Attach(kc).attach(
      namespace,
      podName,
      container,
      output,
      tty ? null : output,
      stdin,
      tty
    );
    const exited = new Promise<{ ok: boolean; message: string | null }>((resolve) => {
      ws.on('close', () => {
        output.end();
        resolve({ ok: true, message: null });
      });
      ws.on('error', (err: Error) => resolve({ ok: false, message: err.message }));
    });
    return {
      stdin,
      output,
      resize(cols, rows) {
        if (ws.readyState !== 1) return;
        const msg = Buffer.from(JSON.stringify({ Width: cols, Height: rows }));
        ws.send(Buffer.concat([Buffer.from([4]), msg]));
      },
      pause: () => output.pause(),
      resume: () => output.resume(),
      close: () => ws.close(),
      exited
    };
  }

  async rebuildDeployment(...args: Parameters<Rebuild>): Promise<Awaited<ReturnType<Rebuild>>> {
    return (await this.deployments()).rebuildDeployment(...args);
  }

  async setDeploymentBranch(deploymentId: string, branch: string): Promise<void> {
    this.requireWrite();
    if (!isSafeGitRef(branch)) throw new Error('Invalid branch name');
    await this.prisma.deployment.update({
      where: { id: deploymentId },
      data: { githubBranch: branch }
    });
  }

  async createEnvironment(
    ...args: Parameters<CreateEnvironment>
  ): Promise<Awaited<ReturnType<CreateEnvironment>>> {
    return (await this.environments()).createEnvironment(...args);
  }

  async deleteEnvironment(
    ...args: Parameters<DeleteEnvironment>
  ): Promise<Awaited<ReturnType<DeleteEnvironment>>> {
    return (await this.environments()).deleteEnvironment(...args);
  }

  async deleteEnvironmentFromCluster(
    ...args: Parameters<DeleteFromCluster>
  ): Promise<Awaited<ReturnType<DeleteFromCluster>>> {
    return (await this.environments()).deleteEnvironmentFromCluster(...args);
  }

  async createAutoIngressForDeployment(
    ...args: Parameters<AutoIngress>
  ): Promise<Awaited<ReturnType<AutoIngress>>> {
    this.requireWrite();
    const { IngressService } = await import('../../projects/ingress.service.js');
    return this.moduleRef
      .get(IngressService, { strict: false })
      .createAutoIngressForDeployment(...args);
  }

  private requireWrite(): void {
    if (!this.graft.manifest!.capabilities.includes('projects.write')) {
      throw new Error(
        `graft ${this.graft.id} needs the "projects.write" capability to change projects`
      );
    }
  }

  private async stamp(created: unknown): Promise<void> {
    const id = (created as { id?: string } | null)?.id;
    if (!id) return;
    await this.prisma.deployment.update({
      where: { id },
      data: { createdByGraft: this.graft.id }
    });
  }

  private async own(deploymentId: string): Promise<{ id: string; namespace: string }> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { id: true, namespace: true, createdByGraft: true }
    });
    if (!deployment || deployment.createdByGraft !== this.graft.id) {
      throw new Error(`graft ${this.graft.id} did not create deployment ${deploymentId}`);
    }
    return deployment;
  }

  private async ownPod(deploymentId: string, podName: string): Promise<{ namespace: string }> {
    const { namespace } = await this.own(deploymentId);
    const pod = await this.prisma.k8sObject.findFirst({
      where: { kind: 'Pod', deploymentId, namespace, name: podName },
      select: { name: true }
    });
    if (!pod) throw new Error(`pod ${podName} does not belong to deployment ${deploymentId}`);
    return { namespace };
  }

  private async kubeConfig(): Promise<k8s.KubeConfig> {
    const { KubernetesService } = await import('../../kubernetes/kubernetes.service.js');
    const kube: KubernetesService = this.moduleRef.get(KubernetesService, { strict: false });
    kube.ensureKubeConfig();
    return kube.kc!;
  }

  private async firstContainer(kc: k8s.KubeConfig, namespace: string, pod: string) {
    const { body } = await kc.makeApiClient(k8s.CoreV1Api).readNamespacedPod(pod, namespace);
    const name = body.spec?.containers?.[0]?.name;
    if (!name) throw new Error(`pod ${pod} has no containers`);
    return name;
  }

  private async runExec(
    namespace: string,
    pod: string,
    cmd: string[],
    opts: { container?: string; timeoutMs?: number; stdin?: string | Buffer }
  ): Promise<PodExecResult> {
    const kc = await this.kubeConfig();
    const container = opts.container || (await this.firstContainer(kc, namespace, pod));
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 60_000, 1_000), 300_000);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const collect = (into: Buffer[]) => {
      const stream = new PassThrough();
      stream.on('data', (c: Buffer) => {
        if (size >= MAX_EXEC_OUTPUT) return;
        size += c.length;
        into.push(c);
      });
      return stream;
    };
    const stdin = opts.stdin === undefined ? null : new PassThrough();
    return new Promise<PodExecResult>((resolve, reject) => {
      let socket: { close(): void } | undefined;
      const timer = setTimeout(() => {
        socket?.close();
        reject(new Error(`exec timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      new k8s.Exec(kc)
        .exec(namespace, pod, container, cmd, collect(out), collect(err), stdin, false, (status) => {
          clearTimeout(timer);
          resolve({
            exitCode: exitCodeOf(status),
            stdout: Buffer.concat(out).toString('utf-8'),
            stderr: Buffer.concat(err).toString('utf-8')
          });
        })
        .then((ws) => {
          socket = ws;
          if (stdin) stdin.end(opts.stdin);
        })
        .catch((e: Error) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  private async deployments(write = true): Promise<DeploymentsService> {
    if (write) this.requireWrite();
    const { DeploymentsService } = await import('../../projects/deployments.service.js');
    return this.moduleRef.get(DeploymentsService, { strict: false });
  }

  private async environments(): Promise<EnvironmentsService> {
    this.requireWrite();
    const { EnvironmentsService } = await import('../../projects/environments.service.js');
    return this.moduleRef.get(EnvironmentsService, { strict: false });
  }
}
