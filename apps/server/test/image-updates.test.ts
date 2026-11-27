import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolveImageDigest, type RegistryNet } from '../src/projects/image-ports';
import {
  IMAGE_CHECK_INTERVAL_MS,
  imageTrackingBlocker,
  imageUpdateStatus,
  isUpdateAvailable,
  needsCheck,
  runningDigestAgainst,
  shouldAutoUpdate,
  type ImageUpdateRow
} from '../src/projects/image-updates';
import { ImageUpdatesService } from '../src/projects/image-updates.service';

const OLD = `sha256:${'a'.repeat(64)}`;
const NEW = `sha256:${'b'.repeat(64)}`;

type Handler = (method: string, headers: Record<string, string>) => Response;

function fakeNet(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; authorization?: string }[] = [];
  const net: RegistryNet = {
    resolve: async () => ['93.184.216.34'],
    fetch: async (url, request) => {
      const method = request.method ?? 'GET';
      calls.push({ method, url: url.href, authorization: request.headers.authorization });
      const handler = routes[`${url.origin}${url.pathname}`];
      if (!handler) return new Response(null, { status: 404 });
      return handler(method, request.headers);
    }
  };
  return { net, calls };
}

function resolve(image: string, net: RegistryNet) {
  const failures: string[] = [];
  return resolveImageDigest(image, {
    net,
    plainHttpHosts: new Set(),
    onFailure: (reason) => failures.push(reason)
  }).then((digest) => ({ digest, failures }));
}

function row(overrides: Partial<ImageUpdateRow> = {}): ImageUpdateRow {
  return {
    image: 'n8nio/n8n:latest',
    imagePullPolicy: null,
    githubRepo: null,
    buildContextKey: null,
    gitConnectionId: null,
    stopped: false,
    imageAutoUpdate: false,
    imageCheckedRef: 'n8nio/n8n:latest',
    imageRunningDigest: OLD,
    imageLatestDigest: NEW,
    imageAttemptedDigest: null,
    imageCheckedAt: new Date(),
    imageCheckError: null,
    imageUpdatedAt: null,
    ...overrides
  };
}

test('the tag digest comes from a HEAD, after the docker hub token dance', async () => {
  const { net, calls } = fakeNet({
    'https://registry-1.docker.io/v2/n8nio/n8n/manifests/1': (method, headers) => {
      assert.equal(method, 'HEAD');
      if (headers.authorization !== 'Bearer anon') {
        return new Response(null, {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"'
          }
        });
      }
      return new Response(null, { status: 200, headers: { 'docker-content-digest': NEW } });
    },
    'https://auth.docker.io/token': () => Response.json({ token: 'anon' })
  });
  const { digest, failures } = await resolve('n8nio/n8n:1', net);
  assert.equal(digest, NEW);
  assert.deepEqual(failures, []);
  assert.ok(
    calls.every((call) => call.method === 'HEAD' || new URL(call.url).hostname === 'auth.docker.io')
  );
});

test('a registry that refuses HEAD falls back to hashing the manifest body', async () => {
  const body = JSON.stringify({ schemaVersion: 2, manifests: [] });
  const { net } = fakeNet({
    'https://ghcr.io/v2/acme/app/manifests/latest': (method) =>
      method === 'HEAD' ? new Response(null, { status: 405 }) : new Response(body)
  });
  const { digest } = await resolve('ghcr.io/acme/app', net);
  assert.equal(digest, `sha256:${createHash('sha256').update(body).digest('hex')}`);
});

test('a missing tag, a digest reference and a private host all resolve to nothing', async () => {
  const { net } = fakeNet({});
  assert.deepEqual(await resolve('ghcr.io/acme/app:gone', net), {
    digest: null,
    failures: ['http_404']
  });
  assert.deepEqual(await resolve(`ghcr.io/acme/app@${OLD}`, net), {
    digest: null,
    failures: ['pinned_by_digest']
  });
  const privateNet: RegistryNet = { ...net, resolve: async () => ['10.0.0.4'] };
  assert.deepEqual(await resolve('registry.internal.example/app:latest', privateNet), {
    digest: null,
    failures: ['blocked_address']
  });
});

test('only image-source apps on a tag that is pulled every time are tracked', () => {
  assert.equal(imageTrackingBlocker(row()), null);
  assert.equal(imageTrackingBlocker(row({ image: 'grafana/grafana-oss:12' })), null);
  assert.equal(imageTrackingBlocker(row({ image: 'nginx:1.27.3' })), 'pull_policy');
  assert.equal(
    imageTrackingBlocker(row({ image: 'nginx:1.27.3', imagePullPolicy: 'Always' })),
    null
  );
  assert.equal(imageTrackingBlocker(row({ imagePullPolicy: 'IfNotPresent' })), 'pull_policy');
  assert.equal(imageTrackingBlocker(row({ image: `nginx@${OLD}` })), 'digest');
  assert.equal(imageTrackingBlocker(row({ githubRepo: 'acme/app' })), 'source');
  assert.equal(imageTrackingBlocker(row({ buildContextKey: 'ctx/abc' })), 'source');
  assert.equal(imageTrackingBlocker(row({ image: null })), 'no_image');
});

test('the running digest reported is the one that lags, if any pod lags', () => {
  assert.equal(runningDigestAgainst([], NEW), null);
  assert.equal(runningDigestAgainst([NEW], NEW), NEW);
  assert.equal(runningDigestAgainst([NEW, OLD], NEW), OLD);
  assert.equal(runningDigestAgainst([OLD], null), OLD);
});

test('an update is only offered for the image that was checked, while running', () => {
  assert.equal(isUpdateAvailable(row()), true);
  assert.equal(isUpdateAvailable(row({ imageRunningDigest: NEW })), false);
  assert.equal(isUpdateAvailable(row({ image: 'n8nio/n8n:stable' })), false);
  assert.equal(isUpdateAvailable(row({ stopped: true })), false);
  assert.equal(isUpdateAvailable(row({ imageLatestDigest: null })), false);
  const status = imageUpdateStatus(row({ image: 'n8nio/n8n:stable' }));
  assert.equal(status.latestDigest, null);
  assert.equal(status.checkedAt, null);
});

test('auto-update rolls a new digest out once, not again after a failed attempt', () => {
  assert.equal(shouldAutoUpdate(row()), false);
  assert.equal(shouldAutoUpdate(row({ imageAutoUpdate: true })), true);
  assert.equal(shouldAutoUpdate(row({ imageAutoUpdate: true, imageAttemptedDigest: NEW })), false);
  assert.equal(shouldAutoUpdate(row({ imageAutoUpdate: true, imageAttemptedDigest: OLD })), true);
});

test('checks come due on a new image or after the interval', () => {
  const now = Date.now();
  assert.equal(needsCheck(row(), now), false);
  assert.equal(needsCheck(row({ imageCheckedAt: null }), now), true);
  assert.equal(needsCheck(row({ image: 'n8nio/n8n:stable' }), now), true);
  assert.equal(
    needsCheck(row({ imageCheckedAt: new Date(now - IMAGE_CHECK_INTERVAL_MS) }), now),
    true
  );
  assert.equal(needsCheck(row({ imageCheckedAt: null, stopped: true }), now), false);
});

type FakeRow = ImageUpdateRow & {
  id: string;
  name: string;
  namespace: string;
  projectId: string;
  replicas: number;
  cpuRequestMilli: number | null;
  memoryRequestBytes: bigint | null;
};

function matches(value: Record<string, any>, where: Record<string, any> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as any[]).every((c) => matches(value, c));
    if (key === 'OR') return (cond as any[]).some((c) => matches(value, c));
    if (key === 'NOT') return ![cond].flat().some((c) => matches(value, c));
    const field = value[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
      return cond instanceof Date ? field?.getTime() === cond.getTime() : field === cond;
    }
    if ('not' in cond && (cond.not === null ? field == null : field === cond.not)) return false;
    if ('in' in cond && !cond.in.includes(field)) return false;
    if ('notIn' in cond && cond.notIn.includes(field)) return false;
    if ('contains' in cond && !(typeof field === 'string' && field.includes(cond.contains)))
      return false;
    if ('lt' in cond && !(field != null && field < cond.lt)) return false;
    return true;
  });
}

function fakePrisma(rows: FakeRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    deployment: {
      findMany: async ({ where, orderBy, take }: any) => {
        let found = rows.filter((r) => matches(r, where));
        if (orderBy?.imageCheckedAt) {
          found = found.sort(
            (a, b) => (a.imageCheckedAt?.getTime() ?? -1) - (b.imageCheckedAt?.getTime() ?? -1)
          );
        }
        return (take ? found.slice(0, take) : found).map((r) => ({ ...r }));
      },
      findUnique: async ({ where }: any) => {
        const r = byId.get(where.id);
        return r ? { ...r } : null;
      },
      update: async ({ where, data }: any) => {
        const r = byId.get(where.id)!;
        Object.assign(r, data);
        return { ...r };
      },
      updateMany: async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      }
    },
    project: { findUnique: async () => ({ organizationId: 'org' }) }
  };
}

function fakeRow(id: string, overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    ...row({
      imageCheckedRef: null,
      imageRunningDigest: null,
      imageLatestDigest: null,
      imageCheckedAt: null
    }),
    id,
    name: id,
    namespace: 'ns',
    projectId: 'p',
    replicas: 1,
    cpuRequestMilli: null,
    memoryRequestBytes: null,
    ...overrides
  };
}

class TestImageUpdates extends ImageUpdatesService {
  resolved: string[] = [];
  protected override async resolveDigest(image: string): Promise<string | null> {
    this.resolved.push(image);
    return NEW;
  }
}

function service(rows: FakeRow[], restart: () => Promise<unknown> = async () => ({})) {
  const restarts: string[] = [];
  const svc = new TestImageUpdates(
    fakePrisma(rows) as any,
    { canCoordinate: true, isHolder: () => true } as any,
    {
      runningImageDigests: async () => [OLD],
      restartDeployment: async (name: string) => {
        restarts.push(name);
        return restart();
      }
    } as any,
    { prepareRollout: async () => undefined } as any,
    { pullCredential: async () => null } as any,
    { log: async () => undefined } as any
  );
  return { svc, restarts };
}

test('hundreds of pinned apps ahead of a tracked one do not starve it', async () => {
  const rows: FakeRow[] = [];
  for (let i = 0; i < 250; i++) rows.push(fakeRow(`pinned-${i}`, { image: `nginx:1.27.${i}` }));
  for (let i = 0; i < 30; i++) {
    rows.push(fakeRow(`digest-${i}`, { image: `nginx@${OLD}`, imageAutoUpdate: true }));
  }
  for (let i = 0; i < 30; i++) {
    rows.push(fakeRow(`cached-${i}`, { imagePullPolicy: 'IfNotPresent', imageAutoUpdate: true }));
  }
  const tracked = fakeRow('tracked', { imageCheckedAt: new Date(0) });
  rows.push(tracked);
  const { svc } = service(rows);
  await svc.sweep();
  assert.deepEqual(svc.resolved, ['n8nio/n8n:latest']);
  assert.equal(tracked.imageLatestDigest, NEW);
  assert.equal(tracked.imageRunningDigest, OLD);
  assert.ok(rows.filter((r) => r.id.startsWith('pinned')).every((r) => r.imageCheckedAt));
  assert.ok(rows.filter((r) => r.id !== 'tracked').every((r) => !r.imageAutoUpdate));
});

test('auto-update restarts once per new digest and skips a rollout already running', async () => {
  const tracked = fakeRow('tracked', { imageAutoUpdate: true });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { svc, restarts } = service([tracked], () => gate);
  const manual = svc.updateNow('tracked', 'user');
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(svc.updateNow('tracked', 'user'), /already pulling/);
  await svc.sweep();
  release();
  await manual;
  assert.deepEqual(restarts, ['tracked']);
  assert.equal(tracked.imageAttemptedDigest, NEW);
  tracked.imageRunningDigest = OLD;
  await svc.sweep();
  assert.deepEqual(restarts, ['tracked']);
});

test('a failed auto-update restart is not retried until the tag moves or a manual update', async () => {
  const tracked = fakeRow('tracked', { imageAutoUpdate: true });
  let fail = true;
  const { svc, restarts } = service([tracked], async () => {
    if (fail) throw new Error('quota exceeded');
  });
  await svc.sweep();
  assert.deepEqual(restarts, ['tracked']);
  assert.equal(tracked.imageAttemptedDigest, null);
  assert.match(tracked.imageCheckError ?? '', /^restart_failed: quota exceeded/);
  await svc.sweep();
  tracked.imageCheckedAt = new Date(0);
  await svc.sweep();
  assert.deepEqual(restarts, ['tracked']);
  const status = await svc.status('tracked');
  assert.match(status.error ?? '', /^restart_failed/);
  fail = false;
  await svc.updateNow('tracked', 'user');
  assert.deepEqual(restarts, ['tracked', 'tracked']);
  assert.equal(tracked.imageCheckError, null);
});

test('a check that keeps failing moves to the back of the sweep', async () => {
  const broken = fakeRow('broken', { imageCheckedAt: new Date(0) });
  const { svc } = service([broken]);
  (svc as any).check = async () => {
    throw new Error('registry down');
  };
  await svc.sweep();
  assert.ok(broken.imageCheckedAt && broken.imageCheckedAt.getTime() > 0);
  assert.equal(broken.imageCheckError, 'registry down');
});

test('after a pull the running digest is observed, not assumed', async () => {
  const tracked = fakeRow('tracked');
  const { svc } = service([tracked]);
  const status = await svc.updateNow('tracked', 'user');
  assert.equal(status.pending, true);
  assert.equal(status.updateAvailable, false);
  assert.equal(tracked.imageRunningDigest, OLD);
  assert.equal(tracked.imageCheckedAt, null);
  await svc.sweep();
  const after = await svc.status('tracked');
  assert.equal(after.pending, false);
  assert.equal(after.runningDigest, OLD);
  assert.equal(after.updateAvailable, true);
});

test('a check that started before a rollout does not overwrite it', async () => {
  const tracked = fakeRow('tracked', { imageCheckedRef: 'n8nio/n8n:latest' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { svc } = service([tracked]);
  (svc as any).resolveDigest = async () => {
    await gate;
    return NEW;
  };
  const slow = svc.checkNow('tracked');
  await new Promise((resolve) => setImmediate(resolve));
  tracked.imageUpdatedAt = new Date();
  tracked.imageCheckedAt = null;
  release();
  const status = await slow;
  assert.equal(status.pending, true);
  assert.equal(tracked.imageCheckedAt, null);
});

test('a long error still fits the column in both the sweep and a rollout', async () => {
  const long = 'x'.repeat(300);
  const broken = fakeRow('broken', { imageCheckedAt: new Date(0) });
  const swept = service([broken]);
  (swept.svc as any).check = async () => {
    throw new Error(long);
  };
  await swept.svc.sweep();
  assert.ok(broken.imageCheckedAt && broken.imageCheckedAt.getTime() > 0);
  assert.equal(broken.imageCheckError?.length, 100);

  const tracked = fakeRow('tracked', { imageAutoUpdate: true });
  const { svc } = service([tracked], async () => {
    throw new Error(long);
  });
  await svc.sweep();
  assert.equal(tracked.imageAttemptedDigest, null);
  assert.equal(tracked.imageCheckError?.length, 100);
  assert.match(tracked.imageCheckError ?? '', /^restart_failed: x+$/);
});

test('a restart failure clears once the pods run the latest digest', async () => {
  const tracked = fakeRow('tracked', { imageAutoUpdate: true });
  const { svc } = service([tracked], async () => {
    throw new Error('quota exceeded');
  });
  await svc.sweep();
  assert.match(tracked.imageCheckError ?? '', /^restart_failed/);
  (svc as any).k8sWorkload.runningImageDigests = async () => [NEW];
  const status = await svc.checkNow('tracked');
  assert.equal(status.error, null);
  assert.equal(status.updateAvailable, false);
});
