import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import test, { mock } from 'node:test';
import * as k8s from '@kubernetes/client-node';
import { PodFilesService } from '../src/kubernetes/pod-files.service';

const kubernetes = { kc: {}, ensureKubeConfig() {} } as any;
const service = () => new PodFilesService(kubernetes, {} as any);
const tick = () => new Promise((resolve) => setImmediate(resolve));

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

test('streamFile writes the file bytes and resolves once cat succeeds', async () => {
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    const [, , , , stdout, , , , status] = args;
    stdout.write('hello ');
    stdout.write('world');
    status({ status: 'Success' });
    return { close() {} };
  });
  try {
    const { out, text } = collector();
    await service().streamFile('ns', 'pod', '/a', out, new AbortController().signal, 'app');
    assert.equal(text(), 'hello world');
  } finally {
    mock.restoreAll();
  }
});

test('streamFile rejects with the stderr of a failed cat', async () => {
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    const [, , , , , stderr, , , status] = args;
    stderr.write('cat: /a: Permission denied');
    status({ status: 'Failure' });
    return { close() {} };
  });
  try {
    const { out } = collector();
    await assert.rejects(
      service().streamFile('ns', 'pod', '/a', out, new AbortController().signal, 'app'),
      (err: any) => err.message === 'cat: /a: Permission denied'
    );
  } finally {
    mock.restoreAll();
  }
});

test('streamFile closes the exec socket and resolves when the client aborts', async () => {
  let closed = 0;
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    const [, , , , stdout] = args;
    stdout.write('part');
    return {
      close() {
        closed += 1;
      }
    };
  });
  try {
    const { out, text } = collector();
    const abort = new AbortController();
    const running = service().streamFile('ns', 'pod', '/a', out, abort.signal, 'app');
    await tick();
    abort.abort();
    await running;
    assert.equal(text(), 'part');
    assert.equal(closed, 1);
  } finally {
    mock.restoreAll();
  }
});

test('streamFile does not start an exec for a request that is already aborted', async () => {
  let calls = 0;
  mock.method(k8s.Exec.prototype, 'exec', async () => {
    calls += 1;
    return { close() {} };
  });
  try {
    const { out } = collector();
    const abort = new AbortController();
    abort.abort();
    await service().streamFile('ns', 'pod', '/a', out, abort.signal, 'app');
    assert.equal(calls, 0);
  } finally {
    mock.restoreAll();
  }
});
