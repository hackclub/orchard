import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER, ModuleRef } from '@nestjs/core';
import * as k8s from '@kubernetes/client-node';
import { posix } from 'path';
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

type DoorState = { graft: GraftRecord; moduleRef: ModuleRef; prisma: PrismaService };
const doorState = new WeakMap<object, DoorState>();

function state(door: object): DoorState {
  return doorState.get(door)!;
}

@Injectable({ scope: Scope.TRANSIENT })
export class ProjectsDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'projects',
    version: 1,
    status: 'stable',
    capability: 'projects.read'
  };

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(ModuleRef) moduleRef: ModuleRef,
    @Inject(PrismaService) prisma: PrismaService
  ) {
    doorState.set(this, { graft: bindGraft(parent, ProjectsDoorV1.meta), moduleRef, prisma });
  }

  onEnvironmentEnvChanged(listener: (change: EnvironmentEnvChange) => void): () => void {
    return onEnvironmentEnvChanged(listener);
  }

  async createDeploymentFromGitHub(
    ...args: Parameters<CreateFromGitHub>
  ): Promise<Awaited<ReturnType<CreateFromGitHub>>> {
    const [projectId, data, ...rest] = args;
    return (await deployments(this)).createDeploymentFromGitHub(
      projectId,
      { ...data, createdByGraft: state(this).graft.id },
      ...rest
    );
  }
  async createDeployment(
    ...args: Parameters<CreateDeployment>
  ): Promise<Awaited<ReturnType<CreateDeployment>>> {
    const [projectId, data, ...rest] = args;
    return (await deployments(this)).createDeployment(
      projectId,
      { ...data, createdByGraft: state(this).graft.id },
      ...rest
    );
  }

  async listOwnDeployments(): Promise<{ id: string; projectId: string; name: string }[]> {
    return state(this).prisma.deployment.findMany({
      where: { createdByGraft: state(this).graft.id },
      select: { id: true, projectId: true, name: true }
    });
  }

  async getDeployment(deploymentId: string) {
    await own(this, deploymentId);
    const svc = await deployments(this, false);
    return svc.getDeployment(deploymentId, false);
  }

  async getDeploymentPods(deploymentId: string) {
    await own(this, deploymentId);
    return (await deployments(this, false)).getDeploymentPods(deploymentId);
  }

  async startDeployment(deploymentId: string, clerkId: string) {
    await own(this, deploymentId);
    return (await deployments(this)).startDeployment(deploymentId, clerkId);
  }

  async stopDeployment(deploymentId: string, clerkId: string) {
    await own(this, deploymentId);
    return (await deployments(this)).stopDeployment(deploymentId, clerkId);
  }

  async restartDeployment(deploymentId: string, clerkId: string) {
    await own(this, deploymentId);
    return (await deployments(this)).restartDeployment(deploymentId, clerkId);
  }

  async scaleDeployment(deploymentId: string, replicas: number, clerkId: string) {
    await own(this, deploymentId);
    return (await deployments(this)).scaleDeployment(deploymentId, replicas, clerkId);
  }

  async deleteDeployment(deploymentId: string, clerkId: string) {
    await own(this, deploymentId);
    return (await deployments(this)).deleteDeployment(deploymentId, clerkId);
  }

  async updateDeploymentImage(deploymentId: string, image: string, clerkId: string) {
    await own(this, deploymentId);
    return (await deployments(this)).updateDeploymentImage(deploymentId, image, clerkId);
  }

  async updateStartCommand(deploymentId: string, startCommand: string | null, clerkId: string) {
    await own(this, deploymentId);
    return (await deployments(this)).updateDeploymentBuildConfig(
      deploymentId,
      { startCommand },
      clerkId
    );
  }

  async updateDeploymentEnvVars(deploymentId: string, env: EnvWrite, clerkId: string) {
    await own(this, deploymentId);
    return (await deployments(this)).updateDeploymentEnvVars(deploymentId, env, clerkId);
  }
  async updateDeploymentVolumes(deploymentId: string, volumes: DeploymentVolumes, clerkId: string) {
    await own(this, deploymentId);
    return (await deployments(this)).updateDeploymentVolumes(deploymentId, volumes, clerkId);
  }

  async getPodLogs(
    deploymentId: string,
    podName: string,
    opts: { container?: string; tailLines?: number; previous?: boolean; sinceSeconds?: number } = {}
  ) {
    const { namespace } = await ownPod(this, deploymentId, podName);
    const { K8sWorkloadService } = await import('../../kubernetes/k8s-workload.service.js');
    const workload: K8sWorkloadService = state(this).moduleRef.get(K8sWorkloadService, {
      strict: false
    });
    return workload.getPodLogs(
      podName,
      namespace,
      opts.container,
      opts.tailLines ?? 100,
      opts.previous ?? false,
      opts.sinceSeconds
    );
  }
  async execInPod(
    deploymentId: string,
    podName: string,
    command: string | string[],
    opts: { container?: string; timeoutMs?: number; stdin?: string | Buffer } = {}
  ): Promise<PodExecResult> {
    requireWrite(this);
    const { namespace } = await ownPod(this, deploymentId, podName);
    const cmd = Array.isArray(command) ? command : ['/bin/sh', '-c', command];
    if (cmd.length === 0 || (typeof command === 'string' && !command.trim())) {
      throw new Error('command is required');
    }
    return runExec(this, namespace, podName, cmd, opts);
  }

  async listPodFiles(deploymentId: string, podName: string, dir: string, container?: string) {
    assertPodPath(dir);
    const res = await this.execInPod(
      deploymentId,
      podName,
      `cd ${shellQuote(dir)} && for f in .* *; do [ "$f" = . ] || [ "$f" = .. ] || [ ! -e "$f" ] && [ ! -L "$f" ] && continue; n=0; if [ -d "$f" ]; then t=dir; elif [ -f "$f" ]; then t=file; n=$(wc -c < "$f" 2>/dev/null || echo 0); else t=other; fi; printf '%s\\t%s\\t%s\\000' "$t" "$n" "$f"; done`,
      { container }
    );
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `cannot list ${dir}`);
    return res.stdout
      .split('\0')
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
    const normalized = posix.normalize(path);
    if (normalized === '/' || normalized === '//') throw new Error('refusing to delete /');
    const res = await this.execInPod(deploymentId, podName, `rm -rf -- ${shellQuote(normalized)}`, {
      container
    });
    if (res.exitCode !== 0) throw new Error(res.stderr.trim() || `cannot delete ${path}`);
  }
  async attachConsole(
    deploymentId: string,
    podName: string,
    opts: { container?: string; tty?: boolean } = {}
  ): Promise<PtyHandle> {
    requireWrite(this);
    const { namespace } = await ownPod(this, deploymentId, podName);
    const kc = await kubeConfig(this);
    const container = opts.container || (await firstContainer(kc, namespace, podName));
    const tty = opts.tty ?? true;
    const stdin = new PassThrough();
    stdin.on('error', () => {});
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
        stdin.destroy();
        resolve({ ok: true, message: null });
      });
      ws.on('error', (err: Error) => {
        output.end();
        stdin.destroy();
        ws.close();
        resolve({ ok: false, message: err.message });
      });
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
    return (await deployments(this)).rebuildDeployment(...args);
  }

  async setDeploymentBranch(deploymentId: string, branch: string): Promise<void> {
    requireWrite(this);
    if (!isSafeGitRef(branch)) throw new Error('Invalid branch name');
    await state(this).prisma.deployment.update({
      where: { id: deploymentId },
      data: { githubBranch: branch }
    });
  }

  async createEnvironment(
    ...args: Parameters<CreateEnvironment>
  ): Promise<Awaited<ReturnType<CreateEnvironment>>> {
    return (await environments(this)).createEnvironment(...args);
  }

  async deleteEnvironment(
    ...args: Parameters<DeleteEnvironment>
  ): Promise<Awaited<ReturnType<DeleteEnvironment>>> {
    return (await environments(this)).deleteEnvironment(...args);
  }

  async deleteEnvironmentFromCluster(
    ...args: Parameters<DeleteFromCluster>
  ): Promise<Awaited<ReturnType<DeleteFromCluster>>> {
    return (await environments(this)).deleteEnvironmentFromCluster(...args);
  }

  async createAutoIngressForDeployment(
    ...args: Parameters<AutoIngress>
  ): Promise<Awaited<ReturnType<AutoIngress>>> {
    requireWrite(this);
    const { IngressService } = await import('../../projects/ingress.service.js');
    return state(this)
      .moduleRef.get(IngressService, { strict: false })
      .createAutoIngressForDeployment(...args);
  }
}

function requireWrite(door: ProjectsDoorV1): void {
  if (!state(door).graft.manifest!.capabilities.includes('projects.write')) {
    throw new Error(
      `graft ${state(door).graft.id} needs the "projects.write" capability to change projects`
    );
  }
}

async function own(
  door: ProjectsDoorV1,
  deploymentId: string
): Promise<{ id: string; namespace: string }> {
  const deployment = await state(door).prisma.deployment.findUnique({
    where: { id: deploymentId },
    select: { id: true, namespace: true, createdByGraft: true }
  });
  if (!deployment || deployment.createdByGraft !== state(door).graft.id) {
    throw new Error(`graft ${state(door).graft.id} did not create deployment ${deploymentId}`);
  }
  return deployment;
}

async function ownPod(
  door: ProjectsDoorV1,
  deploymentId: string,
  podName: string
): Promise<{ namespace: string }> {
  const { namespace } = await own(door, deploymentId);
  const pod = await state(door).prisma.k8sObject.findFirst({
    where: { kind: 'Pod', deploymentId, namespace, name: podName },
    select: { name: true }
  });
  if (!pod) throw new Error(`pod ${podName} does not belong to deployment ${deploymentId}`);
  return { namespace };
}

async function kubeConfig(door: ProjectsDoorV1): Promise<k8s.KubeConfig> {
  const { KubernetesService } = await import('../../kubernetes/kubernetes.service.js');
  const kube: KubernetesService = state(door).moduleRef.get(KubernetesService, { strict: false });
  kube.ensureKubeConfig();
  return kube.kc!;
}

async function firstContainer(kc: k8s.KubeConfig, namespace: string, pod: string) {
  const { body } = await kc.makeApiClient(k8s.CoreV1Api).readNamespacedPod(pod, namespace);
  const name = body.spec?.containers?.[0]?.name;
  if (!name) throw new Error(`pod ${pod} has no containers`);
  return name;
}

async function runExec(
  door: ProjectsDoorV1,
  namespace: string,
  pod: string,
  cmd: string[],
  opts: { container?: string; timeoutMs?: number; stdin?: string | Buffer }
): Promise<PodExecResult> {
  const kc = await kubeConfig(door);
  const container = opts.container || (await firstContainer(kc, namespace, pod));
  const requested = Number(opts.timeoutMs);
  const timeoutMs = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1_000), 300_000)
    : 60_000;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let truncated = false;
  const collect = (into: Buffer[]) => {
    const stream = new PassThrough();
    let size = 0;
    stream.on('data', (c: Buffer) => {
      if (size + c.length > MAX_EXEC_OUTPUT) {
        truncated = true;
        return;
      }
      size += c.length;
      into.push(c);
    });
    return stream;
  };
  const stdin = opts.stdin === undefined ? null : new PassThrough();
  return new Promise<PodExecResult>((resolve, reject) => {
    let socket: { close(): void } | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      reject(e);
    };
    timer = setTimeout(() => fail(new Error(`exec timed out after ${timeoutMs}ms`)), timeoutMs);
    new k8s.Exec(kc)
      .exec(namespace, pod, container, cmd, collect(out), collect(err), stdin, false, (status) => {
        if (settled) return;
        if (truncated) {
          fail(new Error(`exec output exceeded ${MAX_EXEC_OUTPUT} bytes`));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: exitCodeOf(status),
          stdout: Buffer.concat(out).toString('utf-8'),
          stderr: Buffer.concat(err).toString('utf-8')
        });
      })
      .then((ws) => {
        if (settled) {
          ws.close();
          return;
        }
        socket = ws;
        ws.on('close', () =>
          setImmediate(() => fail(new Error('exec connection closed without a status')))
        );
        if (stdin) stdin.end(opts.stdin);
      })
      .catch((e: Error) => fail(e));
  });
}

async function deployments(door: ProjectsDoorV1, write = true): Promise<DeploymentsService> {
  if (write) requireWrite(door);
  const { DeploymentsService } = await import('../../projects/deployments.service.js');
  return state(door).moduleRef.get(DeploymentsService, { strict: false });
}

async function environments(door: ProjectsDoorV1): Promise<EnvironmentsService> {
  requireWrite(door);
  const { EnvironmentsService } = await import('../../projects/environments.service.js');
  return state(door).moduleRef.get(EnvironmentsService, { strict: false });
}
