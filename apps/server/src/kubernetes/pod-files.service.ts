import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException
} from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { randomBytes } from 'node:crypto';
import * as querystring from 'node:querystring';
import { Readable, Writable } from 'node:stream';
import { KubernetesService } from './kubernetes.service';
import {
  CONTENT_SCRIPT,
  DELETE_SCRIPT,
  DOWNLOAD_CHECK_SCRIPT,
  LIST_SCRIPT,
  MKDIR_SCRIPT,
  MOVE_SCRIPT,
  PREVIEW_MAX_BYTES,
  SCRIPT_EXIT,
  WRITE_SCRIPT,
  classifyExecStatus,
  parsePodListing,
  parsePreview,
  parseSizeAndMtime,
  type ExecStatusLike,
  type PodFilePreview,
  type PodListing
} from './pod-files';

export const EXEC_TIMEOUT_MS = 30_000;
export const LISTING_MAX_BYTES = 2 * 1024 * 1024;
export const CAPTURE_MAX_BYTES = PREVIEW_MAX_BYTES + 64 * 1024;
export const STDERR_MAX_BYTES = 64 * 1024;
export const WRITE_OUTPUT_MAX_BYTES = 256 * 1024;
export const DOWNLOAD_STALL_MS = 60_000;
export const UPLOAD_STALL_MS = 60_000;
export const UPLOAD_FINISH_MS = 120_000;
export const STDIN_FRAME_BYTES = 64 * 1024;

export const NO_SHELL_MESSAGE = "This image has no shell, so its files can't be browsed";
const CONNECTION_LOST = 'The connection to the container was lost';
const CONNECT_FAILED = 'Could not reach the container';
const EXEC_FAILED = 'The command could not run in the container';
const STDIN_PREFIX = Buffer.from([0]);
const STDOUT_CHANNEL = 1;
const STDERR_CHANNEL = 2;
const STATUS_CHANNEL = 3;

export interface PodExecTarget {
  namespace: string;
  pod: string;
  container: string;
}

export interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  truncated?: boolean;
}

export type ExecOutcomeLabel = 'ok' | 'failed' | 'unknown';

const UNCERTAIN = new WeakSet<object>();

function uncertain<T extends Error>(error: T): T {
  UNCERTAIN.add(error);
  return error;
}

export function outcomeOf(error: unknown): ExecOutcomeLabel {
  return error && typeof error === 'object' && UNCERTAIN.has(error) ? 'unknown' : 'failed';
}

export interface WrittenFile {
  path: string;
  size: number | null;
  mtime: number | null;
}

interface ExecSocket {
  close(): void;
  pause?(): void;
  resume?(): void;
  on?(event: 'close', listener: () => void): unknown;
}

interface StdinSocket {
  close(): void;
  send(data: Buffer, cb: (err?: Error) => void): void;
  on?(event: 'close', listener: () => void): unknown;
}

export type WriteMode = 'create' | 'overwrite' | 'edit' | 'check';

export interface FailureMessages {
  notFound?: string;
  exists?: string;
  readOnly?: string;
  wrongKind?: string;
  wrongKindStatus?: 400 | 404 | 409;
}

export function noShellError(): HttpException {
  return new UnprocessableEntityException({
    statusCode: 422,
    message: NO_SHELL_MESSAGE,
    code: 'no_shell'
  });
}

export function scriptFailure(result: ExecResult, messages: FailureMessages): HttpException {
  const stderr = result.stderr.trim();
  switch (result.code) {
    case SCRIPT_EXIT.notFound:
      return new NotFoundException(messages.notFound ?? 'Nothing at that path');
    case SCRIPT_EXIT.exists:
      return new ConflictException({
        statusCode: 409,
        message: messages.exists ?? 'Something already exists at that path',
        code: 'exists'
      });
    case SCRIPT_EXIT.readOnly:
      return new ConflictException({
        statusCode: 409,
        message: messages.readOnly ?? 'That location is read-only',
        code: 'read_only'
      });
    case SCRIPT_EXIT.wrongKind: {
      const message = messages.wrongKind ?? 'That path is the wrong kind of file';
      if (messages.wrongKindStatus === 404) return new NotFoundException(message);
      if (messages.wrongKindStatus === 409) return new ConflictException(message);
      return new BadRequestException(message);
    }
    case SCRIPT_EXIT.modified:
      return new ConflictException({
        statusCode: 409,
        message: 'The file changed since it was opened',
        code: 'modified'
      });
    case SCRIPT_EXIT.missingTool: {
      const tool = result.stdout.toString('utf-8').trim().slice(0, 32) || 'unknown';
      return new UnprocessableEntityException({
        statusCode: 422,
        message: `This image has no ${tool}, which this needs`,
        code: 'missing_tool',
        tool
      });
    }
    case SCRIPT_EXIT.short:
      return new BadRequestException('The upload ended before every byte arrived');
    case SCRIPT_EXIT.refused:
      return new ConflictException({
        statusCode: 409,
        message: 'That path is a mount root',
        code: 'mount_root'
      });
    default:
      return new UnprocessableEntityException(stderr.slice(0, 2000) || EXEC_FAILED);
  }
}

export function execPath(target: PodExecTarget, cmd: string[], stdin: boolean): string {
  const query = querystring.stringify({
    stdout: true,
    stderr: true,
    stdin,
    tty: false,
    command: cmd,
    container: target.container
  });
  return `/api/v1/namespaces/${encodeURIComponent(target.namespace)}/pods/${encodeURIComponent(target.pod)}/exec?${query}`;
}

function sh(script: string, ...args: string[]): string[] {
  return ['/bin/sh', '-c', script, 'sh', ...args];
}

function tempName(): string {
  return `.orchard-upload-${randomBytes(12).toString('hex')}`;
}

@Injectable()
export class PodFilesService {
  private readonly logger = new Logger(PodFilesService.name);

  constructor(private readonly kubernetes: KubernetesService) {}

  async list(target: PodExecTarget, path: string): Promise<PodListing> {
    const result = await this.capture(target, sh(LIST_SCRIPT, path), {
      maxBytes: LISTING_MAX_BYTES,
      truncate: true
    });
    if (result.truncated) {
      const end = result.stdout.lastIndexOf(0);
      const listing = parsePodListing(result.stdout.subarray(0, end + 1).toString('utf-8'));
      return { ...listing, truncated: true };
    }
    if (result.code !== 0) {
      throw scriptFailure(result, { notFound: `No directory at ${path}` });
    }
    return parsePodListing(result.stdout.toString('utf-8'));
  }

  async preview(target: PodExecTarget, path: string): Promise<PodFilePreview> {
    const result = await this.capture(
      target,
      sh(CONTENT_SCRIPT, path, String(PREVIEW_MAX_BYTES + 1))
    );
    if (result.code !== 0) {
      throw scriptFailure(result, {
        notFound: `No readable file at ${path}`,
        wrongKind: `${path} is a folder`,
        wrongKindStatus: 404
      });
    }
    return parsePreview(result.stdout);
  }

  async checkDownload(target: PodExecTarget, path: string): Promise<'file' | 'dir'> {
    const result = await this.capture(target, sh(DOWNLOAD_CHECK_SCRIPT, path));
    if (result.code !== 0) {
      throw scriptFailure(result, { notFound: `No readable file at ${path}` });
    }
    return result.stdout.toString('utf-8').trim() === 'd' ? 'dir' : 'file';
  }

  async writeFile(
    target: PodExecTarget,
    path: string,
    mode: Exclude<WriteMode, 'check'>,
    input: Readable,
    length: number,
    signal: AbortSignal,
    expectedMtime: number | null = null
  ): Promise<WrittenFile> {
    const result = await this.execWithInput(
      target,
      sh(
        WRITE_SCRIPT,
        path,
        String(length),
        tempName(),
        mode,
        expectedMtime === null ? '' : String(expectedMtime)
      ),
      input,
      length,
      signal
    );
    if (result.code !== 0) throw scriptFailure(result, this.writeMessages(path, mode));
    const meta = parseSizeAndMtime(result.stdout.toString('utf-8'));
    return { path, size: meta.size ?? length, mtime: meta.mtime };
  }

  async checkWrite(
    target: PodExecTarget,
    path: string,
    mode: Exclude<WriteMode, 'check'>
  ): Promise<void> {
    const result = await this.capture(
      target,
      sh(WRITE_SCRIPT, path, '0', tempName(), 'check', '', mode)
    );
    if (result.code !== 0) throw scriptFailure(result, this.writeMessages(path, mode));
  }

  async mkdir(target: PodExecTarget, path: string): Promise<void> {
    const result = await this.capture(target, sh(MKDIR_SCRIPT, path));
    if (result.code !== 0) {
      throw scriptFailure(result, {
        exists: `${path} already exists`,
        readOnly: `Can't create folders here`,
        wrongKind: 'A parent of that path is not a folder'
      });
    }
  }

  async move(
    target: PodExecTarget,
    from: string,
    to: string,
    mountPaths: readonly string[]
  ): Promise<void> {
    const result = await this.capture(target, sh(MOVE_SCRIPT, from, to, ...mountPaths));
    if (result.code !== 0) {
      throw scriptFailure(result, {
        notFound: `Nothing at ${from}, or no folder to move it into`,
        exists: `${to} already exists`,
        readOnly: `Can't move that here`
      });
    }
  }

  async remove(
    target: PodExecTarget,
    path: string,
    mountPaths: readonly string[]
  ): Promise<'file' | 'dir'> {
    const result = await this.capture(target, sh(DELETE_SCRIPT, path, ...mountPaths));
    if (result.code !== 0) {
      throw scriptFailure(result, {
        notFound: `Nothing at ${path}`,
        readOnly: `Can't delete from this folder`
      });
    }
    return result.stdout.toString('utf-8').startsWith('d') ? 'dir' : 'file';
  }

  private writeMessages(path: string, mode: WriteMode): FailureMessages {
    return {
      notFound: mode === 'edit' ? `The folder for ${path} does not exist` : `Nothing at ${path}`,
      exists: `${path} already exists`,
      readOnly: `Can't write to ${path}`,
      wrongKind: `${path} is a folder or a special file`,
      wrongKindStatus: 409
    };
  }

  async streamFile(
    target: PodExecTarget,
    cmd: string[],
    out: Writable,
    signal: AbortSignal,
    onStart?: () => void,
    okCodes: readonly number[] = [0]
  ): Promise<void> {
    const kc = this.requireKubeConfig();
    if (signal.aborted) return;
    const exec = new k8s.Exec(kc);

    await new Promise<void>((resolve, reject) => {
      const errChunks: Buffer[] = [];
      let errBytes = 0;
      let socket: ExecSocket | undefined;
      let settled = false;
      let started = false;
      let waiting = false;
      let statusSeen = false;
      let failure: HttpException | null = null;
      let stall: NodeJS.Timeout | undefined;
      const listening = new AbortController();

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(stall);
        listening.abort();
        socket?.close();
        if (error && !signal.aborted) reject(error);
        else resolve();
      };
      const armStall = () => {
        clearTimeout(stall);
        stall = setTimeout(
          () => finish(uncertain(new BadGatewayException('The download stalled'))),
          DOWNLOAD_STALL_MS
        );
      };

      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          if (settled) return done();
          if (!started) {
            started = true;
            onStart?.();
          }
          armStall();
          if (out.write(chunk)) return done();
          waiting = true;
          socket?.pause?.();
          out.once('drain', () => {
            waiting = false;
            socket?.resume?.();
            done();
          });
        }
      });
      sink.on('finish', () => finish(failure ?? undefined));
      const stderr = new Writable({
        write(chunk: Buffer, _encoding, done) {
          errBytes += chunk.length;
          if (errBytes <= 64 * 1024) errChunks.push(chunk);
          done();
        }
      });

      signal.addEventListener('abort', () => finish(), { once: true, signal: listening.signal });
      armStall();
      exec
        .exec(
          target.namespace,
          target.pod,
          target.container,
          cmd,
          sink,
          stderr,
          null,
          false,
          (status) => {
            statusSeen = true;
            const outcome = classifyExecStatus(status as ExecStatusLike);
            if (outcome.kind === 'exit' && okCodes.includes(outcome.code)) return;
            if (outcome.kind === 'no_shell') {
              failure = noShellError();
              return;
            }
            const text = Buffer.concat(errChunks).toString('utf-8').trim();
            failure = new BadGatewayException(
              outcome.kind === 'exit' && text ? text.slice(0, 2000) : 'The file could not be read'
            );
          }
        )
        .then((ws) => {
          socket = ws as unknown as ExecSocket;
          if (settled) return socket.close();
          if (waiting) socket.pause?.();
          socket.on?.('close', () => {
            if (!statusSeen) finish(uncertain(new BadGatewayException(CONNECTION_LOST)));
          });
        })
        .catch((err: unknown) => {
          this.logConnectFailure(err);
          finish(new BadGatewayException(CONNECT_FAILED));
        });
    });
  }

  async execWithInput(
    target: PodExecTarget,
    cmd: string[],
    input: Readable,
    length: number,
    signal: AbortSignal
  ): Promise<ExecResult> {
    const kc = this.requireKubeConfig();
    if (signal.aborted) throw uncertain(new BadRequestException('The upload was interrupted'));
    const handler = new k8s.Exec(kc).handler;

    return new Promise<ExecResult>((resolve, reject) => {
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let bytes = 0;
      let sent = 0;
      let socket: StdinSocket | undefined;
      let settled = false;
      let statusSeen = false;
      let timer: NodeJS.Timeout | undefined;
      let detach = () => {};
      const listening = new AbortController();

      const settle = (result: Error | ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listening.abort();
        detach();
        socket?.close();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const arm = (ms: number, message: string) => {
        clearTimeout(timer);
        timer = setTimeout(() => settle(uncertain(new BadGatewayException(message))), ms);
      };
      const armStall = () => arm(UPLOAD_STALL_MS, 'The upload stalled');
      const armFinish = () => arm(UPLOAD_FINISH_MS, 'The container did not answer in time');

      const afterLastFrame = (err?: Error) => {
        if (settled) return;
        if (err) return settle(uncertain(new BadGatewayException(CONNECTION_LOST)));
        if (sent >= length) return armFinish();
        armStall();
        input.resume();
      };
      const onFrameError = (err?: Error) => {
        if (err) settle(uncertain(new BadGatewayException(CONNECTION_LOST)));
      };
      const onData = (chunk: Buffer | string) => {
        if (settled || !socket) return;
        let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const room = length - sent;
        if (buf.length > room) buf = buf.subarray(0, room);
        if (!buf.length) return;
        sent += buf.length;
        input.pause();
        armStall();
        for (let offset = 0; offset < buf.length; offset += STDIN_FRAME_BYTES) {
          const slice = buf.subarray(offset, offset + STDIN_FRAME_BYTES);
          const last = offset + STDIN_FRAME_BYTES >= buf.length;
          socket.send(Buffer.concat([STDIN_PREFIX, slice]), last ? afterLastFrame : onFrameError);
        }
      };
      const onEnd = () => {
        if (sent < length) settle(uncertain(new BadRequestException('The upload ended early')));
      };
      const onInterrupted = () =>
        settle(uncertain(new BadRequestException('The upload was interrupted')));
      const onClose = () => {
        if (!input.readableEnded && sent < length) onInterrupted();
      };
      detach = () => {
        input.off('data', onData);
        input.off('end', onEnd);
        input.off('error', onInterrupted);
        input.off('close', onClose);
      };

      const collect = (chunks: Buffer[], buff: Buffer) => {
        bytes += buff.length;
        if (bytes > WRITE_OUTPUT_MAX_BYTES) {
          settle(uncertain(new BadGatewayException('The container sent too much output')));
          return false;
        }
        chunks.push(Buffer.from(buff));
        return true;
      };
      const onFrame = (stream: number, buff: Buffer): boolean => {
        if (settled) return false;
        if (stream === STDOUT_CHANNEL) return collect(outChunks, buff);
        if (stream === STDERR_CHANNEL) return collect(errChunks, buff);
        if (stream !== STATUS_CHANNEL) return true;
        statusSeen = true;
        let status: ExecStatusLike | null = null;
        try {
          status = JSON.parse(buff.toString('utf-8'));
        } catch {
          status = null;
        }
        const outcome = classifyExecStatus(status);
        if (outcome.kind === 'no_shell') settle(noShellError());
        else if (outcome.kind === 'error') settle(new BadGatewayException(EXEC_FAILED));
        else {
          settle({
            code: outcome.code,
            stdout: Buffer.concat(outChunks),
            stderr: Buffer.concat(errChunks).toString('utf-8')
          });
        }
        return false;
      };

      signal.addEventListener('abort', onInterrupted, { once: true, signal: listening.signal });
      arm(EXEC_TIMEOUT_MS, CONNECT_FAILED);
      handler
        .connect(execPath(target, cmd, true), null, onFrame)
        .then((ws) => {
          socket = ws as unknown as StdinSocket;
          if (settled) return socket.close();
          socket.on?.('close', () => {
            if (!statusSeen) settle(uncertain(new BadGatewayException(CONNECTION_LOST)));
          });
          if (length === 0) return armFinish();
          armStall();
          input.on('data', onData);
          input.on('end', onEnd);
          input.on('error', onInterrupted);
          input.on('close', onClose);
          input.resume();
        })
        .catch((err: unknown) => {
          this.logConnectFailure(err);
          settle(new BadGatewayException(CONNECT_FAILED));
        });
    });
  }

  async capture(
    target: PodExecTarget,
    cmd: string[],
    opts: { maxBytes?: number; truncate?: boolean } = {}
  ): Promise<ExecResult> {
    const kc = this.requireKubeConfig();
    const exec = new k8s.Exec(kc);
    const maxBytes = opts.maxBytes ?? CAPTURE_MAX_BYTES;

    return new Promise((resolve, reject) => {
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let socket: ExecSocket | undefined;
      let settled = false;
      let statusSeen = false;
      let timer: NodeJS.Timeout | undefined;

      const settle = (result: Error | ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.close();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const result = (code: number, truncated: boolean): ExecResult => ({
        code,
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString('utf-8'),
        ...(truncated ? { truncated } : {})
      });
      timer = setTimeout(
        () => settle(uncertain(new BadGatewayException('The container did not answer in time'))),
        EXEC_TIMEOUT_MS
      );
      const stdout = new Writable({
        write(chunk: Buffer, _encoding, done) {
          if (settled) return done();
          const room = maxBytes - outBytes;
          outBytes += chunk.length;
          if (chunk.length <= room) {
            outChunks.push(chunk);
          } else if (opts.truncate) {
            outChunks.push(chunk.subarray(0, room));
            settle(result(0, true));
          } else {
            settle(uncertain(new BadGatewayException('The container sent too much output')));
          }
          done();
        }
      });
      const stderr = new Writable({
        write(chunk: Buffer, _encoding, done) {
          if (errBytes < STDERR_MAX_BYTES) {
            errChunks.push(chunk.subarray(0, STDERR_MAX_BYTES - errBytes));
          }
          errBytes += chunk.length;
          done();
        }
      });

      exec
        .exec(
          target.namespace,
          target.pod,
          target.container,
          cmd,
          stdout,
          stderr,
          null,
          false,
          (status) => {
            statusSeen = true;
            const outcome = classifyExecStatus(status as ExecStatusLike);
            if (outcome.kind === 'no_shell') return settle(noShellError());
            if (outcome.kind === 'error') return settle(new BadGatewayException(EXEC_FAILED));
            settle(result(outcome.code, false));
          }
        )
        .then((ws) => {
          socket = ws as unknown as ExecSocket;
          if (settled) return socket.close();
          socket.on?.('close', () => {
            if (!statusSeen) settle(uncertain(new BadGatewayException(CONNECTION_LOST)));
          });
        })
        .catch((err: unknown) => {
          this.logConnectFailure(err);
          settle(new BadGatewayException(CONNECT_FAILED));
        });
    });
  }

  private logConnectFailure(err: unknown) {
    this.logger.warn(`pod exec failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  private requireKubeConfig(): k8s.KubeConfig {
    this.kubernetes.ensureKubeConfig();
    if (!this.kubernetes.kc) throw new ServiceUnavailableException('Kubernetes API not available');
    return this.kubernetes.kc;
  }
}
