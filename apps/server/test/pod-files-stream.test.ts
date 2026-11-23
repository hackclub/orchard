import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test, { mock } from 'node:test';
import * as k8s from '@kubernetes/client-node';
import { WebSocketHandler } from '@kubernetes/client-node/dist/web-socket-handler';
import {
  CAPTURE_MAX_BYTES,
  LISTING_MAX_BYTES,
  PodFilesService,
  outcomeOf,
  STDIN_FRAME_BYTES,
  scriptFailure
} from '../src/kubernetes/pod-files.service';

const kubernetes = { kc: {}, ensureKubeConfig() {} } as any;
const service = () => new PodFilesService(kubernetes);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const T = { namespace: 'ns', pod: 'pod', container: 'app' };
const CAT = ['cat', '--', '/a'];
const exitStatus = (code: number) => ({
  status: 'Failure',
  reason: 'NonZeroExitCode',
  message: `command terminated with non-zero exit code: exit code ${code}`,
  details: { causes: [{ reason: 'ExitCode', message: String(code) }] }
});

function collector() {
  const chunks: Buffer[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    }
  });
  return { out, text: () => Buffer.concat(chunks).toString('utf8') };
}

class FakeSocket extends EventEmitter {
  closed = 0;
  paused = 0;
  resumed = 0;
  close() {
    this.closed += 1;
  }
  pause() {
    this.paused += 1;
  }
  resume() {
    this.resumed += 1;
  }
}

test('streamFile writes the file bytes and resolves once cat succeeds', async () => {
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    const [, , , , stdout, , , , status] = args;
    stdout.write('hello ');
    stdout.write('world');
    stdout.end();
    status({ status: 'Success' });
    return new FakeSocket();
  });
  try {
    const { out, text } = collector();
    let started = 0;
    await service().streamFile(T, CAT, out, new AbortController().signal, () => {
      started += 1;
    });
    assert.equal(text(), 'hello world');
    assert.equal(started, 1);
  } finally {
    mock.restoreAll();
  }
});

test('streamFile rejects with the stderr of a failed cat before any byte is sent', async () => {
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    const [, , , , stdout, stderr, , , status] = args;
    stderr.write('cat: /a: Permission denied');
    stdout.end();
    status(exitStatus(1));
    return new FakeSocket();
  });
  try {
    const { out } = collector();
    let started = 0;
    await assert.rejects(
      service().streamFile(T, CAT, out, new AbortController().signal, () => {
        started += 1;
      }),
      (err: any) => err.message === 'cat: /a: Permission denied'
    );
    assert.equal(started, 0);
  } finally {
    mock.restoreAll();
  }
});

test('streamFile closes the exec socket and resolves when the client aborts', async () => {
  const socket = new FakeSocket();
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    const [, , , , stdout] = args;
    stdout.write('part');
    return socket;
  });
  try {
    const { out, text } = collector();
    const abort = new AbortController();
    const running = service().streamFile(T, CAT, out, abort.signal);
    await tick();
    abort.abort();
    await running;
    assert.equal(text(), 'part');
    assert.equal(socket.closed, 1);
  } finally {
    mock.restoreAll();
  }
});

test('streamFile does not start an exec for a request that is already aborted', async () => {
  let calls = 0;
  mock.method(k8s.Exec.prototype, 'exec', async () => {
    calls += 1;
    return new FakeSocket();
  });
  try {
    const { out } = collector();
    const abort = new AbortController();
    abort.abort();
    await service().streamFile(T, CAT, out, abort.signal);
    assert.equal(calls, 0);
  } finally {
    mock.restoreAll();
  }
});

test('streamFile pauses the exec socket while the client is not reading', async () => {
  const socket = new FakeSocket();
  let stdout: Writable | undefined;
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    stdout = args[4];
    return socket;
  });
  const pending: Array<() => void> = [];
  const out = new Writable({
    highWaterMark: 4,
    write(_chunk, _encoding, callback) {
      pending.push(callback);
    }
  });
  try {
    const running = service().streamFile(T, CAT, out, new AbortController().signal);
    await tick();
    stdout!.write(Buffer.alloc(16));
    await tick();
    assert.equal(socket.paused, 1);
    assert.equal(socket.resumed, 0);
    pending.shift()!();
    await tick();
    assert.equal(socket.resumed, 1);
    stdout!.end();
    await running;
  } finally {
    mock.restoreAll();
  }
});

test('streamFile fails when the exec socket closes without a status', async () => {
  const socket = new FakeSocket();
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    args[4].write('part');
    return socket;
  });
  try {
    const { out } = collector();
    const running = service().streamFile(T, CAT, out, new AbortController().signal);
    await tick();
    socket.emit('close');
    await assert.rejects(running, /connection to the container was lost/);
  } finally {
    mock.restoreAll();
  }
});

test('list fails when the exec socket closes without a status', async () => {
  const socket = new FakeSocket();
  mock.method(k8s.Exec.prototype, 'exec', async () => socket);
  try {
    const running = service().list(T, '/');
    await tick();
    socket.emit('close');
    await assert.rejects(running, /connection to the container was lost/);
  } finally {
    mock.restoreAll();
  }
});

test('list stops at the byte cap, kills the exec and returns what it has', async () => {
  const socket = new FakeSocket();
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    const record = (i: number) => `f\tfile-${String(i).padStart(8, '0')}\0`;
    args[4].write(Buffer.from('w\0'));
    let written = 2;
    let i = 0;
    while (written <= LISTING_MAX_BYTES) {
      const chunk = Buffer.from(Array.from({ length: 1000 }, () => record(i++)).join(''));
      args[4].write(chunk);
      written += chunk.length;
    }
    return socket;
  });
  try {
    const listing = await service().list(T, '/');
    assert.equal(listing.truncated, true);
    assert.ok(listing.entries.length > 1000);
    assert.ok(listing.entries.every((e) => /^file-\d{8}$/.test(e.name)));
    assert.equal(socket.closed, 1);
  } finally {
    mock.restoreAll();
  }
});

test('capture refuses output past its cap for non-listing scripts', async () => {
  const socket = new FakeSocket();
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    args[4].write(Buffer.alloc(CAPTURE_MAX_BYTES + 1));
    return socket;
  });
  try {
    await assert.rejects(service().preview(T, '/a'), (err: any) => {
      return /too much output/.test(err.message) && outcomeOf(err) === 'unknown';
    });
    assert.equal(socket.closed, 1);
  } finally {
    mock.restoreAll();
  }
});

class FakeStdinSocket extends EventEmitter {
  sent: Buffer[] = [];
  pending: Array<(err?: Error) => void> = [];
  closed = 0;
  send(data: Buffer, cb: (err?: Error) => void) {
    this.sent.push(Buffer.from(data));
    this.pending.push(cb);
  }
  flush(err?: Error) {
    const callbacks = this.pending.splice(0);
    for (const cb of callbacks) cb(err);
  }
  close() {
    this.closed += 1;
  }
  stdin() {
    for (const frame of this.sent) assert.equal(frame[0], 0);
    return Buffer.concat(this.sent.map((frame) => frame.subarray(1)));
  }
}

function frame(channel: number, data: string | Buffer) {
  return Buffer.concat([Buffer.from([channel]), Buffer.from(data)]).subarray(1);
}

function connectWith(socket: FakeStdinSocket) {
  const calls: { path: string; onFrame: (stream: number, buff: Buffer) => boolean }[] = [];
  mock.method(WebSocketHandler.prototype, 'connect', async (...args: any[]) => {
    calls.push({ path: args[0], onFrame: args[2] });
    return socket;
  });
  return calls;
}

function trackedInput(chunks: Buffer[]) {
  const input = new PassThrough();
  for (const chunk of chunks) input.write(chunk);
  return input;
}

test('execWithInput sends stdin on channel 0 and waits for each send before reading more', async () => {
  const socket = new FakeStdinSocket();
  const calls = connectWith(socket);
  try {
    const input = new PassThrough({ highWaterMark: 4 });
    const running = service().execWithInput(
      T,
      ['/bin/sh', '-c', 'x', 'sh', '/a b'],
      input,
      10,
      new AbortController().signal
    );
    input.write(Buffer.from('hello'));
    await tick();
    assert.equal(calls.length, 1);
    assert.match(calls[0].path, /^\/api\/v1\/namespaces\/ns\/pods\/pod\/exec\?/);
    assert.match(calls[0].path, /stdin=true/);
    assert.match(calls[0].path, /container=app/);
    assert.match(calls[0].path, /command=%2Fa%20b/);
    assert.equal(socket.sent.length, 1);
    assert.equal(input.isPaused(), true);
    input.write(Buffer.from('world'));
    await tick();
    assert.equal(socket.sent.length, 1);
    socket.flush();
    await tick();
    assert.equal(socket.sent.length, 2);
    socket.flush();
    await tick();
    assert.equal(socket.stdin().toString(), 'helloworld');
    calls[0].onFrame(1, frame(1, '10 1763900000\n'));
    calls[0].onFrame(3, frame(3, JSON.stringify({ status: 'Success' })));
    const result = await running;
    assert.equal(result.code, 0);
    assert.equal(result.stdout.toString(), '10 1763900000\n');
    assert.equal(socket.closed, 1);
  } finally {
    mock.restoreAll();
  }
});

test('execWithInput splits large chunks into bounded frames and never sends more than asked', async () => {
  const socket = new FakeStdinSocket();
  const calls = connectWith(socket);
  try {
    const input = trackedInput([Buffer.alloc(STDIN_FRAME_BYTES * 2 + 10, 7), Buffer.from('tail')]);
    const length = STDIN_FRAME_BYTES * 2 + 5;
    const running = service().execWithInput(T, ['x'], input, length, new AbortController().signal);
    await tick();
    assert.equal(socket.sent.length, 3);
    assert.ok(socket.sent.every((f) => f.length <= STDIN_FRAME_BYTES + 1));
    socket.flush();
    await tick();
    assert.equal(socket.stdin().length, length);
    calls[0].onFrame(3, frame(3, JSON.stringify({ status: 'Success' })));
    await running;
  } finally {
    mock.restoreAll();
  }
});

test('execWithInput returns the script exit code and stderr', async () => {
  const socket = new FakeStdinSocket();
  const calls = connectWith(socket);
  try {
    const running = service().execWithInput(
      T,
      ['x'],
      trackedInput([Buffer.from('abc')]),
      3,
      new AbortController().signal
    );
    await tick();
    socket.flush();
    calls[0].onFrame(2, frame(2, 'mv: nope'));
    calls[0].onFrame(3, frame(3, JSON.stringify(exitStatus(4))));
    const result = await running;
    assert.equal(result.code, 4);
    assert.equal(result.stderr, 'mv: nope');
  } finally {
    mock.restoreAll();
  }
});

test('execWithInput stops sending when the script answers early', async () => {
  const socket = new FakeStdinSocket();
  const calls = connectWith(socket);
  try {
    const input = new PassThrough();
    const running = service().execWithInput(T, ['x'], input, 100, new AbortController().signal);
    input.write(Buffer.from('abc'));
    await tick();
    calls[0].onFrame(3, frame(3, JSON.stringify(exitStatus(4))));
    const result = await running;
    assert.equal(result.code, 4);
    assert.equal(socket.closed, 1);
    socket.flush();
    input.write(Buffer.from('more'));
    await tick();
    assert.equal(socket.sent.length, 1);
    assert.equal(input.listenerCount('data'), 0);
  } finally {
    mock.restoreAll();
  }
});

test('execWithInput closes the socket when the client goes away mid-upload', async () => {
  const socket = new FakeStdinSocket();
  connectWith(socket);
  try {
    const input = new PassThrough();
    const abort = new AbortController();
    const running = service().execWithInput(T, ['x'], input, 100, abort.signal);
    input.write(Buffer.from('abc'));
    await tick();
    abort.abort();
    await assert.rejects(running, /interrupted/);
    assert.equal(socket.closed, 1);
    assert.equal(input.listenerCount('data'), 0);
  } finally {
    mock.restoreAll();
  }
});

test('execWithInput fails when the body ends short or errors', async () => {
  const socket = new FakeStdinSocket();
  connectWith(socket);
  try {
    const input = new PassThrough();
    const short = assert.rejects(
      service().execWithInput(T, ['x'], input, 100, new AbortController().signal),
      /ended early/
    );
    input.end(Buffer.from('abc'));
    await tick();
    socket.flush();
    await short;
    assert.equal(socket.closed, 1);

    const broken = new PassThrough();
    const reset = assert.rejects(
      service().execWithInput(T, ['x'], broken, 100, new AbortController().signal),
      /interrupted/
    );
    await tick();
    broken.destroy(new Error('ECONNRESET'));
    await reset;
    assert.equal(socket.closed, 2);
  } finally {
    mock.restoreAll();
  }
});

test('execWithInput maps a missing shell, a lost socket and a failed send', async () => {
  const socket = new FakeStdinSocket();
  const calls = connectWith(socket);
  try {
    const noShell = assert.rejects(
      service().execWithInput(T, ['x'], new PassThrough(), 1, new AbortController().signal),
      (err: any) => err.getResponse().code === 'no_shell'
    );
    await tick();
    calls[0].onFrame(
      3,
      frame(
        3,
        JSON.stringify({
          status: 'Failure',
          reason: 'InternalError',
          message: 'exec: "/bin/sh": stat /bin/sh: no such file or directory: unknown'
        })
      )
    );
    await noShell;

    const lost = service().execWithInput(
      T,
      ['x'],
      new PassThrough(),
      1,
      new AbortController().signal
    );
    await tick();
    socket.emit('close');
    await assert.rejects(lost, /connection to the container was lost/);

    const input = trackedInput([Buffer.from('a')]);
    const failedSend = assert.rejects(
      service().execWithInput(T, ['x'], input, 2, new AbortController().signal),
      /connection to the container was lost/
    );
    await tick();
    socket.flush(new Error('socket hang up'));
    await failedSend;
  } finally {
    mock.restoreAll();
  }
});

test('execWithInput hides connection errors behind a generic message', async () => {
  mock.method(WebSocketHandler.prototype, 'connect', async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.1:6443 https://kube.internal:6443/api/v1/x');
  });
  try {
    await assert.rejects(
      service().execWithInput(T, ['x'], new PassThrough(), 1, new AbortController().signal),
      (err: any) => err.message === 'Could not reach the container'
    );
  } finally {
    mock.restoreAll();
  }
});

test('capture reports a missing shell with the no_shell code', async () => {
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    args[8]({
      status: 'Failure',
      reason: 'InternalError',
      message:
        'Internal error occurred: error executing command in container: failed to exec in container: failed to start exec: OCI runtime exec failed: exec failed: unable to start container process: exec: "/bin/sh": stat /bin/sh: no such file or directory: unknown'
    });
    return new FakeSocket();
  });
  try {
    await assert.rejects(service().list(T, '/'), (err: any) => {
      const body = err.getResponse();
      return err.getStatus() === 422 && body.code === 'no_shell';
    });
  } finally {
    mock.restoreAll();
  }
});

test('capture hides apiserver failures and connection errors', async () => {
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    args[8]({
      status: 'Failure',
      reason: 'InternalError',
      message: 'error dialing backend: dial tcp 10.1.2.3:10250: i/o timeout'
    });
    return new FakeSocket();
  });
  try {
    await assert.rejects(service().list(T, '/'), (err: any) => !/10\.1\.2\.3/.test(err.message));
  } finally {
    mock.restoreAll();
  }
  mock.method(k8s.Exec.prototype, 'exec', async () => {
    throw new Error('Unexpected server response: 403 https://10.0.0.1:6443');
  });
  try {
    await assert.rejects(
      service().list(T, '/'),
      (err: any) => err.message === 'Could not reach the container'
    );
  } finally {
    mock.restoreAll();
  }
});

test('script exit codes map to the documented errors', async () => {
  const codes: Array<[number, number, string | undefined]> = [
    [3, 404, undefined],
    [4, 409, 'exists'],
    [5, 409, 'read_only'],
    [7, 409, 'modified'],
    [8, 422, 'missing_tool'],
    [10, 409, 'mount_root'],
    [1, 422, undefined]
  ];
  for (const [code, status, name] of codes) {
    const err = scriptFailure(
      { code, stdout: Buffer.from(code === 8 ? 'tar' : ''), stderr: 'boom' },
      {}
    );
    assert.equal(err.getStatus(), status, String(code));
    const body = err.getResponse() as any;
    assert.equal(body.code, name, String(code));
    if (code === 8) assert.equal(body.tool, 'tar');
  }
});

test('an edit of a file that changed since it was opened is a 409 modified', async () => {
  const socket = new FakeStdinSocket();
  const calls = connectWith(socket);
  try {
    const running = service().writeFile(
      T,
      '/app/config.json',
      'edit',
      trackedInput([Buffer.from('{}')]),
      2,
      new AbortController().signal,
      1700000000
    );
    running.catch(() => {});
    await tick();
    const query = decodeURIComponent(calls[0].path);
    assert.ok(query.includes('command=/app/config.json'));
    assert.ok(query.includes('command=edit'));
    assert.ok(query.includes('command=1700000000'));
    calls[0].onFrame(3, frame(3, JSON.stringify(exitStatus(7))));
    await assert.rejects(running, (err: any) => {
      return err.getStatus() === 409 && err.getResponse().code === 'modified';
    });
  } finally {
    mock.restoreAll();
  }
});

test('writeFile returns the size and mtime the container reports', async () => {
  const socket = new FakeStdinSocket();
  const calls = connectWith(socket);
  try {
    const running = service().writeFile(
      T,
      '/app/a',
      'create',
      trackedInput([Buffer.from('abc')]),
      3,
      new AbortController().signal
    );
    await tick();
    socket.flush();
    calls[0].onFrame(1, frame(1, '3 1763900000\n'));
    calls[0].onFrame(3, frame(3, JSON.stringify({ status: 'Success' })));
    assert.deepEqual(await running, { path: '/app/a', size: 3, mtime: 1763900000 });
  } finally {
    mock.restoreAll();
  }
});

test('timeouts, aborts and lost connections are unknown outcomes; script failures are failed', async () => {
  const socket = new FakeSocket();
  mock.method(k8s.Exec.prototype, 'exec', async () => socket);
  try {
    const running = service().remove(T, '/app/x', []);
    running.catch(() => {});
    await tick();
    socket.emit('close');
    await assert.rejects(running, (err: any) => outcomeOf(err) === 'unknown');
  } finally {
    mock.restoreAll();
  }
  assert.equal(
    outcomeOf(scriptFailure({ code: 1, stdout: Buffer.alloc(0), stderr: 'rm: x' }, {})),
    'failed'
  );
  const stdinSocket = new FakeStdinSocket();
  connectWith(stdinSocket);
  try {
    const abort = new AbortController();
    const upload = service().execWithInput(T, ['x'], new PassThrough(), 10, abort.signal);
    upload.catch(() => {});
    await tick();
    abort.abort();
    await assert.rejects(upload, (err: any) => outcomeOf(err) === 'unknown');
  } finally {
    mock.restoreAll();
  }
});
