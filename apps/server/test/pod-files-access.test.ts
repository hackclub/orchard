import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { REQUIRED_SCOPE_KEY } from '../src/auth/decorators';
import { PassThrough } from 'node:stream';
import { KubernetesController } from '../src/kubernetes/kubernetes.controller';
import { PodFilesService, scriptFailure } from '../src/kubernetes/pod-files.service';

const PROJECT = '11111111-2222-4333-8444-555555555555';
const STRANGER = '99999999-2222-4333-8444-555555555555';
const VIEWER = '88888888-2222-4333-8444-555555555555';
const EDITOR = '77777777-2222-4333-8444-555555555555';
const NS = 'victim-shop-a1b2c3';

const APP_LABELS = { 'app.kubernetes.io/managed-by': 'orchard', 'app.kubernetes.io/name': 'web' };

const PODS: Record<string, any> = {
  web: {
    metadata: { labels: APP_LABELS },
    spec: {
      containers: [
        {
          name: 'app',
          volumeMounts: [
            { name: 'data', mountPath: '/data' },
            { name: 'cfg', mountPath: '/etc/config' }
          ]
        }
      ],
      volumes: [
        { name: 'data', persistentVolumeClaim: { claimName: 'web-data' } },
        { name: 'cfg', configMap: { name: 'cfg' } }
      ]
    }
  },
  db: {
    metadata: {
      labels: { ...APP_LABELS, 'cnpg.io/cluster': 'db', 'app.kubernetes.io/name': 'db' }
    },
    spec: { containers: [{ name: 'postgres' }] }
  },
  tailscale: {
    metadata: { labels: { ...APP_LABELS, 'orchard.my/tailscale': 'true' } },
    spec: { containers: [{ name: 'ts' }] }
  }
};

function build() {
  const calls: string[] = [];
  const audits: any[] = [];
  const prisma: any = {
    project: {
      findFirst: async ({ where }: any) =>
        where.namespace === NS ? { id: PROJECT, organizationId: 'org-1' } : null
    },
    environment: { findUnique: async () => null },
    pod: {
      findFirst: async ({ where }: any) =>
        where.deployment?.namespace === NS ? { deploymentId: 'dep-1' } : null
    }
  };
  const authz: any = {
    async requireProjectView(projectId: string, userId: string) {
      if (projectId !== PROJECT || userId === STRANGER) throw new NotFoundException('Not found');
      return { canEdit: userId === EDITOR };
    },
    async requireProjectEdit(projectId: string, userId: string, action: string) {
      const access = await this.requireProjectView(projectId, userId);
      if (!access.canEdit) throw new ForbiddenException(`Your role doesn't allow you to ${action}`);
      return access;
    }
  };
  const k8sWorkload: any = {
    async getPod(name: string, namespace: string) {
      calls.push(`getPod ${namespace}/${name}`);
      const pod = PODS[name];
      if (!pod || namespace !== NS) throw new Error('404');
      return pod;
    }
  };
  const record =
    (name: string, value: unknown = undefined) =>
    async (...args: any[]) => {
      calls.push(`${name} ${JSON.stringify(args[0])} ${args.slice(1, 3).join(' ')}`);
      return value;
    };
  const podFiles: any = {
    list: record('list', { writable: true, entries: [] }),
    preview: record('preview', {
      size: 2,
      mtime: 1,
      binary: false,
      truncated: false,
      content: 'hi'
    }),
    checkDownload: async (target: any, path: string) => {
      calls.push(`checkDownload ${JSON.stringify(target)} ${path}`);
      return path.endsWith('.png') || path.endsWith('.svg') || path.endsWith('.txt')
        ? 'file'
        : 'dir';
    },
    streamFile: async (target: any, cmd: string[], out: any, _s: any, onStart: () => void) => {
      calls.push(`streamFile ${JSON.stringify(target)} ${JSON.stringify(cmd)}`);
      onStart();
      out.write('x');
    },
    writeFile: async (target: any, path: string, mode: string, _i: any, length: number) => {
      calls.push(`writeFile ${JSON.stringify(target)} ${path} ${mode} ${length}`);
      return { path, size: length, mtime: 1 };
    },
    checkWrite: record('checkWrite'),
    mkdir: record('mkdir'),
    move: record('move'),
    remove: record('remove', 'file')
  };
  const audit: any = {
    log: async (entry: any) => {
      audits.push(entry);
    }
  };
  const k8sCnpg: any = {
    runExec: async () => ({ stdout: '', stderr: '', success: true, container: 'app' })
  };
  const controller = new KubernetesController(
    {} as any,
    k8sCnpg,
    k8sWorkload,
    {} as any,
    authz,
    prisma,
    podFiles,
    audit
  );
  return { controller, calls, audits };
}

function fakeRes() {
  const res: any = new EventEmitter();
  res.headers = {} as Record<string, string>;
  res.headersSent = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.setHeader = (k: string, v: string) => {
    res.headers[k.toLowerCase()] = v;
  };
  res.write = () => {
    res.headersSent = true;
    return true;
  };
  res.end = () => {
    res.writableFinished = true;
  };
  res.destroy = () => {
    res.destroyed = true;
  };
  return res;
}

function fakeUpload(user: string, length: string | null = '3') {
  const req: any = new EventEmitter();
  req.user = { sub: user, email: 'e@example.com' };
  req.headers = length === null ? {} : { 'content-length': length };
  req.complete = false;
  return req;
}

const req = (sub: string) => ({ user: { sub, email: 'e@example.com' } });

type Route = (c: KubernetesController, sub: string, ns: string, pod: string) => Promise<unknown>;

const ROUTES: Record<string, Route> = {
  list: (c, sub, ns, pod) => c.listPodFiles(pod, req(sub), ns, '/data'),
  content: (c, sub, ns, pod) => c.readPodFile(pod, req(sub), ns, '/data/a.txt'),
  download: (c, sub, ns, pod) => c.downloadPodFile(pod, req(sub), fakeRes(), ns, '/data/a.txt'),
  write: (c, sub, ns, pod) =>
    c.writePodFile(pod, req(sub), { content: 'hi', expectedMtime: null }, ns, '/data/a.txt'),
  upload: (c, sub, ns, pod) => c.uploadPodFile(pod, fakeUpload(sub), fakeRes(), ns, '/data/a.txt'),
  mkdir: (c, sub, ns, pod) => c.makePodDirectory(pod, req(sub), ns, '/data/new'),
  move: (c, sub, ns, pod) => c.movePodFile(pod, req(sub), ns, '/data/a', '/data/b'),
  delete: (c, sub, ns, pod) => c.deletePodFile(pod, req(sub), ns, '/data/a')
};

async function failure(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error: any) {
    return error;
  }
  assert.fail('expected rejection');
}

test('every pod file route requires the exec token scope', () => {
  for (const name of [
    'listPodFiles',
    'readPodFile',
    'downloadPodFile',
    'writePodFile',
    'uploadPodFile',
    'makePodDirectory',
    'movePodFile',
    'deletePodFile'
  ]) {
    const handler = (KubernetesController.prototype as any)[name];
    assert.equal(Reflect.getMetadata(REQUIRED_SCOPE_KEY, handler), 'exec', name);
  }
});

for (const [name, call] of Object.entries(ROUTES)) {
  test(`${name}: another tenant's namespace answers exactly like a missing one`, async () => {
    const { controller, calls } = build();
    const hidden = await failure(() => call(controller, STRANGER, NS, 'web'));
    const missing = await failure(() => call(controller, STRANGER, 'nope-ffffff', 'web'));
    assert.ok(hidden instanceof NotFoundException);
    assert.deepEqual(hidden.getResponse(), missing.getResponse());
    assert.ok(!JSON.stringify(hidden.getResponse()).includes(PROJECT));
    assert.deepEqual(calls, []);
  });

  test(`${name}: a viewer is refused before the pod is touched`, async () => {
    const { controller, calls } = build();
    const error = await failure(() => call(controller, VIEWER, NS, 'web'));
    assert.ok(error instanceof ForbiddenException);
    assert.deepEqual(calls, []);
  });

  test(`${name}: database and platform pods are refused`, async () => {
    for (const pod of ['db', 'tailscale']) {
      const { controller, calls } = build();
      const error = await failure(() => call(controller, EDITOR, NS, pod));
      assert.ok(error instanceof ForbiddenException, pod);
      assert.deepEqual(calls, [`getPod ${NS}/${pod}`]);
    }
  });

  test(`${name}: an editor reaches the verified pod and container`, async () => {
    const { controller, calls } = build();
    await call(controller, EDITOR, NS, 'web');
    const target = JSON.stringify({ namespace: NS, pod: 'web', container: 'app' });
    assert.ok(calls.slice(1).length > 0);
    for (const line of calls.slice(1)) assert.ok(line.includes(target), line);
  });
}

test('a container that is not in the pod spec is a 404', async () => {
  const { controller, calls } = build();
  const error = await failure(() =>
    controller.listPodFiles('web', req(EDITOR), NS, '/', 'sidecar')
  );
  assert.ok(error instanceof NotFoundException);
  assert.deepEqual(calls, [`getPod ${NS}/web`]);
});

test('listing returns the mounts and marks read-only mounts unwritable', async () => {
  const { controller } = build();
  const listing: any = await controller.listPodFiles('web', req(EDITOR), NS, '/etc/config');
  assert.equal(listing.writable, false);
  assert.deepEqual(
    listing.mounts.map((m: any) => [m.path, m.type, m.readOnly, m.claim]),
    [
      ['/data', 'persistent', false, 'web-data'],
      ['/etc/config', 'config', true, null]
    ]
  );
});

test('writes to a read-only mount are a 409 read_only without an exec', async () => {
  const { controller, calls } = build();
  for (const run of [
    () => controller.writePodFile('web', req(EDITOR), { content: 'x' }, NS, '/etc/config/a'),
    () => controller.makePodDirectory('web', req(EDITOR), NS, '/etc/config/d'),
    () => controller.movePodFile('web', req(EDITOR), NS, '/data/a', '/etc/config/a'),
    () => controller.deletePodFile('web', req(EDITOR), NS, '/etc/config/a'),
    () => controller.uploadPodFile('web', fakeUpload(EDITOR), fakeRes(), NS, '/etc/config/a')
  ]) {
    const error = await failure(run);
    assert.equal(error.getStatus(), 409);
    assert.equal(error.getResponse().code, 'read_only');
  }
  assert.ok(calls.every((line) => line.startsWith('getPod')));
});

test('delete and move refuse mount roots, their parents and /', async () => {
  const { controller, calls } = build();
  for (const path of ['/', '/data', '/etc', '/proc']) {
    const error = await failure(() => controller.deletePodFile('web', req(EDITOR), NS, path));
    assert.equal(error.getResponse().code, 'mount_root', path);
  }
  const move = await failure(() => controller.movePodFile('web', req(EDITOR), NS, '/data', '/x'));
  assert.equal(move.getResponse().code, 'mount_root');
  const into = await failure(() =>
    controller.movePodFile('web', req(EDITOR), NS, '/app/dir', '/app/dir/sub')
  );
  assert.equal(into.getStatus(), 400);
  for (const run of [
    () => controller.writePodFile('web', req(EDITOR), { content: 'x' }, NS, '/'),
    () => controller.makePodDirectory('web', req(EDITOR), NS, '/'),
    () => controller.movePodFile('web', req(EDITOR), NS, '/app/a', undefined)
  ]) {
    assert.equal((await failure(run)).getStatus(), 400);
  }
  assert.ok(calls.every((line) => line.startsWith('getPod')));
});

test('uploads need a Content-Length within the limit before anything runs', async () => {
  const { controller, calls } = build();
  const res = fakeRes();
  const big = await failure(() =>
    controller.uploadPodFile(
      'web',
      fakeUpload(EDITOR, String(512 * 1024 * 1024 + 1)),
      res,
      NS,
      '/data/a'
    )
  );
  assert.equal(big.getStatus(), 413);
  assert.equal(big.getResponse().code, 'too_large');
  assert.equal(res.headers.connection, 'close');
  const none = await failure(() =>
    controller.uploadPodFile('web', fakeUpload(EDITOR, null), fakeRes(), NS, '/data/a')
  );
  assert.equal(none.getStatus(), 411);
  const bad = await failure(() =>
    controller.uploadPodFile('web', fakeUpload(EDITOR, '12abc'), fakeRes(), NS, '/data/a')
  );
  assert.equal(bad.getStatus(), 400);
  assert.ok(calls.every((line) => line.startsWith('getPod')));
});

test('uploads check the target first, then stream exactly Content-Length bytes', async () => {
  const { controller, calls, audits } = build();
  const result = await controller.uploadPodFile(
    'web',
    fakeUpload(EDITOR, '3'),
    fakeRes(),
    NS,
    '/data/a.bin',
    undefined,
    '1'
  );
  assert.deepEqual(result, { path: '/data/a.bin', size: 3, mtime: 1 });
  assert.match(calls[1], /^checkWrite .* \/data\/a\.bin overwrite$/);
  assert.match(calls[2], /^writeFile .* \/data\/a\.bin overwrite 3$/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audits[0].action, 'deployment.pod.file.upload');
  assert.deepEqual(audits[0].metadata, {
    namespace: NS,
    container: 'app',
    path: '/data/a.bin',
    size: 3,
    overwrite: true,
    outcome: 'ok'
  });
  assert.equal(audits[0].deploymentId, 'dep-1');
  assert.equal(audits[0].organizationId, 'org-1');
  assert.equal(audits[0].projectId, PROJECT);
});

test('edits over 1 MiB are refused and audits never carry file content', async () => {
  const { controller, calls, audits } = build();
  const big = await failure(() =>
    controller.writePodFile('web', req(EDITOR), { content: 'é'.repeat(600_000) }, NS, '/data/a')
  );
  assert.equal(big.getStatus(), 413);
  assert.equal(big.getResponse().code, 'too_large');
  const badMtime = await failure(() =>
    controller.writePodFile(
      'web',
      req(EDITOR),
      { content: 'x', expectedMtime: 'yesterday' },
      NS,
      '/data/a'
    )
  );
  assert.equal(badMtime.getStatus(), 400);
  assert.ok(calls.every((line) => line.startsWith('getPod')));
  await controller.writePodFile(
    'web',
    req(EDITOR),
    { content: 'SECRET-CONTENT', expectedMtime: 5 },
    NS,
    '/data/a'
  );
  await controller.readPodFile('web', req(EDITOR), NS, '/data/a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    audits.map((a) => a.action),
    ['deployment.pod.file.write', 'deployment.pod.file.read']
  );
  assert.ok(!JSON.stringify(audits).includes('SECRET-CONTENT'));
  assert.ok(!JSON.stringify(audits).includes('"hi"'));
});

test('downloads send hardened headers and only inline raster images', async () => {
  const cases: Array<[string, string | undefined, string, string, string]> = [
    ['/data/cat.png', '1', 'image/png', 'inline', 'deployment.pod.file.read'],
    [
      '/data/logo.svg',
      '1',
      'application/octet-stream',
      'attachment',
      'deployment.pod.file.download'
    ],
    ['/data/a.txt', '1', 'application/octet-stream', 'attachment', 'deployment.pod.file.download'],
    [
      '/data/cat.png',
      undefined,
      'application/octet-stream',
      'attachment',
      'deployment.pod.file.download'
    ],
    ['/data/-rf', undefined, 'application/gzip', 'attachment', 'deployment.pod.file.download']
  ];
  for (const [path, inline, type, disposition, action] of cases) {
    const { controller, calls, audits } = build();
    const res = fakeRes();
    await controller.downloadPodFile('web', req(EDITOR), res, NS, path, undefined, inline);
    assert.equal(res.headers['content-type'], type, path);
    assert.ok(res.headers['content-disposition'].startsWith(`${disposition};`), path);
    assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox");
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(audits[0].action, action, path);
    if (type === 'application/gzip') {
      assert.match(res.headers['content-disposition'], /filename="-rf\.tar\.gz"/);
      assert.ok(
        calls[2].endsWith(JSON.stringify(['tar', '-czf', '-', '-C', '/data', '--', '-rf']))
      );
      assert.equal(audits[0].metadata.kind, 'dir');
    } else {
      assert.ok(calls[2].endsWith(JSON.stringify(['cat', '--', path])));
    }
  }
});

test('the one-shot exec route is audited with the command', async () => {
  const { controller, audits } = build();
  const execReq = req(EDITOR);
  await controller.execInPod('web', { namespace: NS, command: ['ls', '-la', '/data'] }, execReq);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audits[0].action, 'deployment.pod.exec.command');
  assert.deepEqual(audits[0].metadata, {
    namespace: NS,
    container: 'app',
    command: 'ls -la /data',
    success: true,
    outcome: 'ok',
    timeoutMs: 60000
  });
});

test('repeated or structured query values answer 400 on every pod file route', async () => {
  const { controller, calls } = build();
  const twice: any = [NS, NS];
  const paths: any = ['/data/a', '/data/b'];
  const runs: Array<() => Promise<unknown>> = [
    () => controller.listPodFiles('web', req(EDITOR), twice, '/data'),
    () => controller.listPodFiles('web', req(EDITOR), NS, paths),
    () => controller.readPodFile('web', req(EDITOR), NS, '/data/a', twice),
    () =>
      controller.downloadPodFile(
        'web',
        req(EDITOR),
        fakeRes(),
        NS,
        '/data/a.png',
        undefined,
        paths
      ),
    () => controller.writePodFile('web', req(EDITOR), { content: 'x' }, NS, paths),
    () =>
      controller.uploadPodFile(
        'web',
        fakeUpload(EDITOR),
        fakeRes(),
        NS,
        '/data/a',
        undefined,
        paths
      ),
    () => controller.makePodDirectory('web', req(EDITOR), twice, '/data/d'),
    () => controller.movePodFile('web', req(EDITOR), NS, '/data/a', paths),
    () => controller.deletePodFile('web', req(EDITOR), NS, { $ne: 1 } as any),
    () => controller.execInPod('web', { command: 'ls' }, req(EDITOR), twice)
  ];
  for (const run of runs) {
    const error = await failure(run);
    assert.equal(error.getStatus(), 400, String(run));
  }
  assert.deepEqual(calls, []);
});

test('each user gets at most 8 pod file operations in flight', async () => {
  const { controller } = build();
  const podFiles = (controller as any).podFiles;
  const gates: Array<() => void> = [];
  podFiles.list = () =>
    new Promise((resolve) =>
      gates.push(() => resolve({ writable: true, truncated: false, entries: [] }))
    );
  const running = Array.from({ length: 8 }, () =>
    controller.listPodFiles('web', req(EDITOR), NS, '/data')
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gates.length, 8);
  for (const run of [
    () => controller.listPodFiles('web', req(EDITOR), NS, '/data'),
    () => controller.readPodFile('web', req(EDITOR), NS, '/data/a'),
    () => controller.downloadPodFile('web', req(EDITOR), fakeRes(), NS, '/data/a.txt'),
    () => controller.writePodFile('web', req(EDITOR), { content: 'x' }, NS, '/data/a'),
    () => controller.uploadPodFile('web', fakeUpload(EDITOR), fakeRes(), NS, '/data/a'),
    () => controller.deletePodFile('web', req(EDITOR), NS, '/data/a')
  ]) {
    const error = await failure(run);
    assert.equal(error.getStatus(), 429);
    assert.equal(error.getResponse().code, 'busy');
  }
  gates.shift()!();
  await running.shift();
  await controller.readPodFile('web', req(EDITOR), NS, '/data/a');
  podFiles.remove = async () => {
    throw new Error('boom');
  };
  await failure(() => controller.deletePodFile('web', req(EDITOR), NS, '/data/a'));
  await failure(() => controller.deletePodFile('web', req(EDITOR), NS, '/data/a'));
  podFiles.checkDownload = async () => {
    throw new Error('boom');
  };
  await failure(() => controller.downloadPodFile('web', req(EDITOR), fakeRes(), NS, '/data/a'));
  await failure(() => controller.downloadPodFile('web', req(EDITOR), fakeRes(), NS, '/data/a'));
  for (const gate of gates.splice(0)) gate();
  await Promise.all(running);
  assert.equal((controller as any).fileSlots.inUse(EDITOR), 0);
});

test('failed and uncertain mutations are still audited', async () => {
  const { controller, audits } = build();
  const podFiles = (controller as any).podFiles;
  podFiles.remove = async () => {
    throw scriptFailure({ code: 1, stdout: Buffer.from('d'), stderr: 'rm: cannot remove' }, {});
  };
  await failure(() => controller.deletePodFile('web', req(EDITOR), NS, '/data/tree'));
  const service = new PodFilesService({ kc: {}, ensureKubeConfig() {} } as any);
  podFiles.writeFile = () =>
    service.execWithInput(
      { namespace: NS, pod: 'web', container: 'app' },
      ['x'],
      new PassThrough(),
      3,
      AbortSignal.abort()
    );
  await failure(() =>
    controller.uploadPodFile('web', fakeUpload(EDITOR), fakeRes(), NS, '/data/up.bin')
  );
  podFiles.mkdir = async () => undefined;
  await controller.makePodDirectory('web', req(EDITOR), NS, '/data/d');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    audits.map((a) => [a.action, a.metadata.path, a.metadata.outcome, a.metadata.kind]),
    [
      ['deployment.pod.file.delete', '/data/tree', 'failed', undefined],
      ['deployment.pod.file.upload', '/data/up.bin', 'unknown', undefined],
      ['deployment.pod.file.mkdir', '/data/d', 'ok', undefined]
    ]
  );
});

test('the one-shot exec audit records failures and timeouts too', async () => {
  const { controller, audits } = build();
  (controller as any).k8sCnpg.runExec = async () => ({
    stdout: '',
    stderr: 'nope',
    success: false,
    container: 'app'
  });
  await controller.execInPod('web', { namespace: NS, command: 'false' }, req(EDITOR));
  (controller as any).k8sCnpg.runExec = () => new Promise(() => {});
  await failure(() =>
    controller.execInPod('web', { namespace: NS, command: 'sleep 9', timeoutMs: 1000 }, req(EDITOR))
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    audits.map((a) => [a.metadata.command, a.metadata.outcome, a.metadata.success]),
    [
      ['/bin/sh -c false', 'failed', false],
      ['/bin/sh -c sleep 9', 'unknown', false]
    ]
  );
});
