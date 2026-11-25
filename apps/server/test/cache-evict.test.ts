import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  utimesSync,
  chmodSync,
  readFileSync,
  statSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cacheEvictScript,
  cacheEvictInitContainer,
  CacheEvictOptions
} from '../src/docker/cache-evict';

const OPTS: CacheEvictOptions = {
  cacheSubPath: 'ysws-mine',
  maxAgeDays: 14,
  highPct: 80,
  targetPct: 60,
  idleMinutes: 60
};

const DAY = 86400;

/**
 * Run the real script against a throwaway directory. CACHE_ROOT is rewritten
 * because the script hard-codes the in-pod mount path, and the thresholds are
 * overridden per-case so a sweep can be exercised without filling a disk.
 */
function runScript(
  root: string,
  opts: Partial<CacheEvictOptions>,
  overrides: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env
) {
  let script = cacheEvictScript({ ...OPTS, ...opts });
  script = script.replace('CACHE_ROOT="/cache"', `CACHE_ROOT="${root}"`);
  for (const [key, value] of Object.entries(overrides)) {
    script = script.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  }
  const out = execFileSync('sh', ['-c', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  });
  return { out, survivors: readdirSync(root).sort() };
}

/** A tenant directory shaped like BuildKit's local cache, aged `ageSeconds`. */
function seedTenant(root: string, name: string, ageSeconds: number) {
  const imageDir = join(root, name, 'img');
  mkdirSync(join(imageDir, 'blobs'), { recursive: true });
  writeFileSync(join(imageDir, 'index.json'), '{}');
  const when = new Date(Date.now() - ageSeconds * 1000);
  // Depth 3 upward, so the depth-2 probe sees the intended age.
  for (const p of [
    join(imageDir, 'index.json'),
    join(imageDir, 'blobs'),
    imageDir,
    join(root, name)
  ]) {
    utimesSync(p, when, when);
  }
}

function withRoot(fn: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'evict-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('evicts tenants past the age cutoff regardless of disk pressure', () => {
  withRoot((root) => {
    seedTenant(root, 'ancient', 30 * DAY);
    seedTenant(root, 'fresh', 60);
    // HIGH=101 is unreachable, so only the age sweep can run.
    const { survivors } = runScript(root, {}, { HIGH: '101' });
    assert.deepEqual(survivors, ['fresh', 'ysws-mine']);
  });
});

test('never evicts the tenant the build belongs to, however stale it looks', () => {
  withRoot((root) => {
    seedTenant(root, 'ysws-mine', 400 * DAY);
    seedTenant(root, 'other', 400 * DAY);
    const { survivors } = runScript(root, {}, { HIGH: '0', TARGET: '0' });
    assert.ok(survivors.includes('ysws-mine'), 'own tenant must survive both sweeps');
    assert.ok(!survivors.includes('other'), 'other stale tenants should be gone');
  });
});

test('under pressure, evicts least-recently-used first and spares in-flight builds', () => {
  withRoot((root) => {
    seedTenant(root, 'oldest', 10 * DAY);
    seedTenant(root, 'middle', 5 * DAY);
    seedTenant(root, 'building-now', 30);
    // Age sweep disabled (cutoff 0 = epoch); pressure sweep forced on, and
    // TARGET=0 is unreachable so it evicts everything it is allowed to.
    const { out, survivors } = runScript(root, {}, { AGE_CUTOFF: '0', HIGH: '0', TARGET: '0' });
    assert.ok(survivors.includes('building-now'), 'a tenant inside the idle window is in flight');
    assert.ok(survivors.includes('ysws-mine'));
    assert.ok(!survivors.includes('oldest') && !survivors.includes('middle'));
    assert.ok(
      out.indexOf('Evicting tenant cache: oldest') < out.indexOf('Evicting tenant cache: middle'),
      'eviction order must be least-recently-used first'
    );
  });
});

test('leaves everything alone when there is no pressure and nothing is stale', () => {
  withRoot((root) => {
    seedTenant(root, 'a', 2 * DAY);
    seedTenant(root, 'b', 3 * DAY);
    const { survivors } = runScript(root, {}, { HIGH: '101' });
    assert.deepEqual(survivors, ['a', 'b', 'ysws-mine']);
  });
});

test("creates this build's own subPath so kubelet never has to", () => {
  withRoot((root) => {
    const { survivors } = runScript(root, {}, { HIGH: '101' });
    assert.ok(survivors.includes('ysws-mine'));
  });
});

test('fails loudly, and non-zero, when the cache directory cannot be created', () => {
  withRoot((root) => {
    // A file where the directory should go stands in for ENOSPC: mkdir -p
    // fails, and the branch that reports it has to exit non-zero so the build
    // retries without the shared cache instead of dying.
    writeFileSync(join(root, 'ysws-mine'), '');
    assert.throws(
      () => runScript(root, {}, { HIGH: '101' }),
      (err: { status: number; stdout: string }) => {
        assert.equal(err.status, 1);
        assert.match(err.stdout, /could not create this build's directory/);
        return true;
      }
    );
  });
});

test(
  'skips a tenant whose age cannot be read rather than treating it as ancient',
  {
    skip: process.getuid?.() === 0 ? 'needs a non-root uid to make a directory unreadable' : false
  },
  () => {
    withRoot((root) => {
      seedTenant(root, 'unreadable', 400 * DAY);
      chmodSync(join(root, 'unreadable'), 0o000);
      try {
        // Both sweeps wide open: the only thing that can save this tenant is the
        // guard. Without it an unreadable directory reads as epoch-old and every
        // tenant on the volume gets wiped by one bad stat.
        const { out, survivors } = runScript(root, {}, { HIGH: '0', TARGET: '0' });
        assert.ok(survivors.includes('unreadable'), 'unknown age must mean "leave it alone"');
        assert.match(out, /Skipping unreadable: could not determine age/);
      } finally {
        chmodSync(join(root, 'unreadable'), 0o755);
      }
    });
  }
);

const busybox = spawnSync('sh', ['-c', 'command -v busybox'], { encoding: 'utf8' }).stdout.trim();

for (const flavour of ['host', 'busybox'] as const) {
  test(
    `hands the tenant directory to the build uid with ${flavour} find`,
    { skip: flavour === 'busybox' && !busybox ? 'busybox is not installed' : false },
    () => {
      withRoot((root) => {
        seedTenant(root, 'ysws-mine', 60);
        const bin = mkdtempSync(join(tmpdir(), 'evict-bin-'));
        try {
          const log = join(bin, 'chown.log');
          writeFileSync(join(bin, 'chown'), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
          if (flavour === 'busybox') symlinkSync(busybox, join(bin, 'find'));
          const { out } = runScript(
            root,
            { chownUid: 4242 },
            { HIGH: '101' },
            {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`
            }
          );
          assert.doesNotMatch(out, /could not hand/);
          const chowned = readFileSync(log, 'utf8');
          assert.match(chowned, /^-h 4242:4242 /m);
          for (const path of ['ysws-mine', 'ysws-mine/img', 'ysws-mine/img/index.json']) {
            assert.ok(chowned.includes(join(root, path)), `${path} was not handed over`);
          }
          assert.equal(statSync(join(root, 'ysws-mine')).mode & 0o777, 0o770);
        } finally {
          rmSync(bin, { recursive: true, force: true });
        }
      });
    }
  );
}

test('mounts the cache at its root with no subPath, or it cannot start on a full volume', () => {
  const container = cacheEvictInitContainer(OPTS);
  const mount = container.volumeMounts[0];
  assert.equal(mount.mountPath, '/cache');
  assert.equal(mount.name, 'buildkit-cache');
  assert.ok(
    !('subPath' in mount),
    'a subPath here would reintroduce the very failure this container exists to prevent'
  );
});

test('surfaces its own failure output to the caller for the cacheless retry', () => {
  const container = cacheEvictInitContainer(OPTS);
  assert.equal(container.terminationMessagePolicy, 'FallbackToLogsOnError');
});

test('tenant key is interpolated as-is and stays shell-safe', () => {
  // cacheSubPath is sanitised to [a-z0-9-] upstream; assert the script relies
  // on that rather than on quoting it would not survive.
  const script = cacheEvictScript({ ...OPTS, cacheSubPath: 'ysws-abc-123' });
  assert.match(script, /^SELF="ysws-abc-123"$/m);
});
