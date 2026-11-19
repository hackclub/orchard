import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { PassThrough, Writable } from 'node:stream';
import { KubernetesService } from './kubernetes.service';
import { K8sCnpgService } from './k8s-cnpg.service';
import { LIST_SCRIPT, STAT_FILE_SCRIPT, parsePodListing, type PodFileEntry } from './pod-files';

const EXEC_TIMEOUT_MS = 30_000;

@Injectable()
export class PodFilesService {
  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly k8sCnpg: K8sCnpgService
  ) {}

  async list(
    namespace: string,
    pod: string,
    path: string,
    container?: string
  ): Promise<PodFileEntry[]> {
    const result = await this.run(
      namespace,
      pod,
      ['/bin/sh', '-c', LIST_SCRIPT, 'sh', path],
      container
    );
    if (!result.success) this.failed(result.stderr, `No directory at ${path}`);
    return parsePodListing(result.stdout);
  }

  async assertReadableFile(
    namespace: string,
    pod: string,
    path: string,
    container?: string
  ): Promise<void> {
    const result = await this.run(
      namespace,
      pod,
      ['/bin/sh', '-c', STAT_FILE_SCRIPT, 'sh', path],
      container
    );
    if (!result.success) this.failed(result.stderr, `No readable file at ${path}`);
  }

  async streamFile(
    namespace: string,
    pod: string,
    path: string,
    out: Writable,
    signal: AbortSignal,
    container?: string
  ): Promise<void> {
    const kc = this.requireKubeConfig();
    const target = await this.resolveContainer(namespace, pod, container);
    if (signal.aborted) return;
    const exec = new k8s.Exec(kc);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const errChunks: Buffer[] = [];
    stdout.on('error', () => undefined);
    stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    stdout.pipe(out, { end: false });
    let socket: { close(): void } | undefined;
    const onAbort = () => {
      stdout.destroy();
      socket?.close();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    await new Promise<void>((resolve, reject) => {
      let failure: string | null = null;
      stdout.on('close', () => {
        signal.removeEventListener('abort', onAbort);
        if (failure && !signal.aborted) reject(new BadGatewayException(failure));
        else resolve();
      });
      exec
        .exec(namespace, pod, target, ['cat', path], stdout, stderr, null, false, (status) => {
          if (status.status !== 'Success') {
            failure =
              Buffer.concat(errChunks).toString('utf-8').trim() || 'The file could not be read';
          }
          if (!stdout.destroyed) stdout.end();
        })
        .then((ws) => {
          socket = ws;
          if (signal.aborted) ws.close();
        })
        .catch((err: unknown) => {
          failure = err instanceof Error ? err.message : String(err);
          if (!stdout.destroyed) stdout.end();
        });
    });
  }

  private async run(
    namespace: string,
    pod: string,
    cmd: string[],
    container?: string
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    this.requireKubeConfig();
    const target = await this.resolveContainer(namespace, pod, container);
    return Promise.race([
      this.k8sCnpg.runExec(namespace, pod, cmd, target),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new BadGatewayException('The container did not answer in time')),
          EXEC_TIMEOUT_MS
        );
      })
    ]);
  }

  private failed(stderr: string, notFound: string): never {
    if (stderr.trim()) throw new BadGatewayException(stderr.trim());
    throw new NotFoundException(notFound);
  }

  private requireKubeConfig(): k8s.KubeConfig {
    this.kubernetes.ensureKubeConfig();
    if (!this.kubernetes.kc) throw new ServiceUnavailableException('Kubernetes API not available');
    return this.kubernetes.kc;
  }

  private async resolveContainer(
    namespace: string,
    pod: string,
    container?: string
  ): Promise<string> {
    const requested = container?.trim();
    if (requested) return requested;
    const kc = this.requireKubeConfig();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    try {
      const { body } = await coreApi.readNamespacedPod(pod, namespace);
      const name = body.spec?.containers?.[0]?.name;
      if (!name) throw new BadGatewayException('Pod has no containers');
      return name;
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      throw new NotFoundException(`Pod ${pod} not found`);
    }
  }
}
