import {
  registerOwnedClasses,
  setGraftRecords,
  type GraftRecord
} from '../src/grafts/graft-registry';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitCloneScript } from '../src/docker/clone-script';
import { injectBuildArgsScript } from '../src/docker/build-args';
import {
  assertSafeBuildInputs,
  isSafeDockerfilePath,
  isSafeGitRef,
  shellQuote
} from '../src/docker/build-input';
import { localBuildRefusal, localGitEnv } from '../src/docker/local-build';
import { ProjectsDoorV1 } from '../src/grafts/doors/projects.door';

const HOSTILE = [
  'x$(touch pwned)',
  'x`touch pwned`',
  'x"; touch pwned; echo "',
  "x'; touch pwned; echo '",
  'x\ntouch pwned',
  'x$(touch${IFS}pwned)',
  '$HOME',
  '-u'
];

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'orchard-inject-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runClone(branch: string, dir: string) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'git.argv');
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = "-c" ] && [ "$3" = "clone" ]; then printf '%s\\0' "$@" > "${log}"; fi\nexit 0\n`
  );
  chmodSync(join(bin, 'git'), 0o755);
  const result = spawnSync('/bin/sh', ['-c', gitCloneScript(branch)], {
    cwd: dir,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CLONE_URL: 'https://x-access-token:secret@github.com/acme/app'
    },
    encoding: 'utf8'
  });
  const argv = existsSync(log) ? readFileSync(log, 'utf8').split('\0').slice(0, -1) : [];
  return { stdout: result.stdout, argv };
}

for (const branch of HOSTILE) {
  test(`the clone script passes ${JSON.stringify(branch)} to git as one literal argument`, () => {
    withDir((dir) => {
      const { stdout, argv } = runClone(branch, dir);
      assert.equal(existsSync(join(dir, 'pwned')), false, 'the branch executed as shell');
      const at = argv.indexOf('--branch');
      assert.ok(at > 0, `git clone never ran: ${stdout}`);
      assert.equal(argv[at + 1], branch);
      assert.ok(stdout.includes(`Branch: ${branch}`));
    });
  });
}

test('the clone script still clones an ordinary branch', () => {
  withDir((dir) => {
    const { argv } = runClone('feature/new-thing', dir);
    assert.equal(argv[argv.indexOf('--branch') + 1], 'feature/new-thing');
  });
});

const HOSTILE_PATHS = [
  'x$(touch pwned)/Dockerfile',
  'x`touch pwned`/Dockerfile',
  'x"; touch pwned; echo "/Dockerfile',
  "x'; touch pwned; echo '/Dockerfile",
  'x\ntouch pwned/Dockerfile'
];

for (const dockerfilePath of HOSTILE_PATHS) {
  test(`build-arg injection treats ${JSON.stringify(dockerfilePath)} as a path`, () => {
    withDir((workspace) => {
      const file = join(workspace, dockerfilePath);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, 'FROM alpine\nRUN true\n');
      execFileSync('/bin/sh', ['-c', injectBuildArgsScript({ dockerfilePath, keys: ['TOKEN'] })], {
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin', WORKSPACE: workspace },
        stdio: 'pipe'
      });
      assert.equal(existsSync(join(workspace, 'pwned')), false, 'the path executed as shell');
      assert.ok(readFileSync(file, 'utf8').includes('ARG TOKEN'));
    });
  });
}

test('shellQuote round-trips anything through sh', () => {
  for (const value of [...HOSTILE, ...HOSTILE_PATHS, '', ' ', "'", "''", '\\', 'plain']) {
    const out = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(value)}`], {
      encoding: 'utf8'
    });
    assert.equal(out, value);
  }
});

test('hostile refs and paths are refused at the build boundary', () => {
  for (const branch of HOSTILE) {
    assert.equal(isSafeGitRef(branch), false, branch);
    assert.throws(() => assertSafeBuildInputs({ branch }), /Invalid branch name/);
  }
  for (const dockerfilePath of HOSTILE_PATHS) {
    assert.equal(isSafeDockerfilePath(dockerfilePath), false, dockerfilePath);
    assert.throws(
      () => assertSafeBuildInputs({ branch: 'main', dockerfilePath }),
      /Invalid Dockerfile path/
    );
  }
  assert.throws(
    () => assertSafeBuildInputs({ branch: 'main', target: 'prod"; id; "' }),
    /Invalid Dockerfile target/
  );
  assertSafeBuildInputs({
    branch: 'release/v1.2.3',
    dockerfilePath: 'apps/api/Dockerfile.prod',
    target: 'runtime'
  });
  assertSafeBuildInputs({ branch: 'local', dockerfilePath: 'my app/Dockerfile' });
});

test('the graft door refuses to store a hostile branch', async () => {
  const updates: unknown[] = [];
  class Parent {}
  setGraftRecords([
    {
      id: 'g',
      dir: '/tmp/g',
      status: 'loaded',
      warnings: [],
      manifest: { capabilities: ['projects.read', 'projects.write'] }
    } as unknown as GraftRecord
  ]);
  registerOwnedClasses('g', [Parent]);
  const prisma = { deployment: { update: async (args: unknown) => updates.push(args) } };
  const door = new ProjectsDoorV1(new Parent(), {} as never, prisma as never);
  for (const branch of HOSTILE) {
    await assert.rejects(() => door.setDeploymentBranch('dep', branch), /Invalid branch name/);
  }
  assert.equal(updates.length, 0);
  await door.setDeploymentBranch('dep', 'main');
  assert.equal(updates.length, 1);
});

test('a local clone does not inherit the server environment', () => {
  const env = localGitEnv({
    PATH: '/opt/bin',
    HOME: '/home/orchard',
    HTTPS_PROXY: 'http://proxy:3128',
    DATABASE_URL: 'postgres://u:p@db/orchard',
    JWT_SECRET: 'jwt',
    GITHUB_APP_PRIVATE_KEY: 'key',
    GIT_SSH_COMMAND: 'touch pwned'
  });
  assert.deepEqual(env, {
    PATH: '/opt/bin',
    HOME: '/home/orchard',
    HTTPS_PROXY: 'http://proxy:3128',
    GIT_TERMINAL_PROMPT: '0'
  });
});

test('local builds are refused in production without the opt-in', () => {
  assert.equal(localBuildRefusal({ NODE_ENV: 'development' }), null);
  assert.match(
    localBuildRefusal({ NODE_ENV: 'production' }) ?? '',
    /ALLOW_LOCAL_BUILD_IN_PRODUCTION/
  );
  assert.equal(
    localBuildRefusal({ NODE_ENV: 'production', ALLOW_LOCAL_BUILD_IN_PRODUCTION: 'true' }),
    null
  );
});
