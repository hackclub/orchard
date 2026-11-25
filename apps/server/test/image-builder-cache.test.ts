import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { V1Container, V1Job, V1Secret } from '@kubernetes/client-node';
import { ImageBuilderService } from '../src/docker/image-builder.service';

type JobOptions = Parameters<ImageBuilderService['createBuildJob']>[0];
type BuildCall = {
  args: string[];
  cwd: string;
  done: boolean;
  awsKey?: string;
};
type ProcessCall = { command: string; args: string[]; env: Record<string, string> };

const SHARED_KEY_ID = 'AKIASHAREDCACHEKEY';
const SHARED_SECRET = 'shared/cache+secret=value';

async function createJob(
  t: TestContext,
  options: {
    backend?: 'local' | 's3' | 'none';
    posture?: 'vm-sandbox' | 'rootless';
    sidecar?: boolean;
    daemon?: 'ready' | 'unavailable' | 'absent';
    sourceCpuLimit?: string;
    build?: Partial<JobOptions>;
  } = {}
) {
  const env = {
    BUILDKIT_LOCAL_CACHE_ENABLED: String((options.backend ?? 'local') === 'local'),
    BUILDKIT_LOCAL_CACHE_PATH: '/cache/buildkit',
    BUILDKIT_LOCAL_CACHE_PVC: 'test-build-cache',
    BUILDKIT_S3_CACHE_ENABLED: String(options.backend === 's3'),
    BUILDKIT_S3_ENDPOINT: 'https://cache.example.invalid',
    BUILDKIT_S3_BUCKET: 'test-build-cache',
    BUILDKIT_S3_REGION: 'auto',
    BUILDKIT_S3_CACHE_PREFIX: 'buildkit-cache/',
    BUILDKIT_S3_SHARED_KEY: options.backend === 's3' ? 'true' : undefined,
    BACKUP_PROXY_ENABLED: undefined,
    BUILDER_SIDECAR_PUSH: String(options.sidecar !== false),
    BUILDER_RUNTIME_CLASS: options.posture === 'rootless' ? undefined : 'kata',
    BUILDER_ALLOW_PRIVILEGED_ON_HOST: undefined,
    BUILDER_SCRATCH_MODE: 'tmpfs',
    BUILDER_WORKSPACE_TMPFS: 'false',
    BUILDER_SOURCE_CPU_LIMIT: options.sourceCpuLimit,
    DOCKER_REGISTRY_PUSH: 'registry.example.invalid',
    DOCKER_REGISTRY_PULL: 'registry.example.invalid',
    REGISTRY_PROJECT: 'orchard',
    REGISTRY_PULL_SECRET_NAME: 'registry-creds',
    REGISTRY_HTTP_HOSTS: 'registry.example.invalid'
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  let job: V1Job | undefined;
  let daemonRequests = 0;
  const secrets = new Map<string, V1Secret>();
  const api = {
    readNamespacedSecret: async () => {
      throw { statusCode: 404 };
    },
    createNamespacedSecret: async (_namespace: string, secret: V1Secret) => {
      secrets.set(secret.metadata!.name!, secret);
      return { body: secret };
    },
    createNamespacedJob: async (_namespace: string, body: V1Job) => {
      job = body;
      return { body };
    }
  };
  const pool =
    options.daemon === 'absent'
      ? undefined
      : {
          getOrCreateDaemon: async () => {
            daemonRequests++;
            if (options.daemon !== 'ready') throw new Error('daemon unavailable');
            return { podIp: '192.0.2.42', podName: 'test-daemon' };
          }
        };
  t.mock.method(ImageBuilderService.prototype as any, 'initKubeConfig', () => {});
  const service = new ImageBuilderService({} as any, {} as any, pool as any);
  Object.assign(service, {
    kc: { makeApiClient: () => api },
    builderInfraReady: true
  });
  await service.createBuildJob({
    repoUrl: 'https://github.com/example/rails-app',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    imageName: 'rails-app',
    cacheTenantKey: 'test-tenant',
    ...options.build
  });
  assert.ok(job);
  return { job, secrets, daemonRequests };
}

function executeBuilder(
  t: TestContext,
  generated: Awaited<ReturnType<typeof createJob>>,
  options: { failBuild?: boolean; failCache?: boolean; railpackDirectory?: string } = {}
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'buildjob-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  const workspace = join(directory, 'workspace');
  const output = join(directory, 'output');
  const meta = join(directory, 'meta');
  const cache = join(directory, 'cache');
  for (const path of [bin, workspace, output, meta, cache]) mkdirSync(path);
  execFileSync('git', ['init', '-q', workspace]);
  execFileSync('git', [
    '-C',
    workspace,
    '-c',
    'user.name=Orchard Test',
    '-c',
    'user.email=orchard@example.invalid',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture'
  ]);
  const sha = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
  if (options.railpackDirectory) {
    mkdirSync(join(workspace, options.railpackDirectory), { recursive: true });
    writeFileSync(join(meta, 'dir'), join(workspace, options.railpackDirectory));
  }
  const callsFile = join(directory, 'calls.jsonl');
  const processFile = join(directory, 'processes.jsonl');
  writeFileSync(callsFile, '');
  writeFileSync(processFile, '');
  const recorder = join(directory, 'record.js');
  writeFileSync(
    recorder,
    `require('node:fs').appendFileSync(process.env.PROCESS_FILE, JSON.stringify({ command: process.argv[2], args: process.argv.slice(3), env: process.env }) + '\\n');\n`
  );
  writeFileSync(
    join(bin, 'buildctl'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROCESS_FILE, JSON.stringify({ command: 'buildctl', args, env: process.env }) + '\\n');
if (args[0] === 'debug') process.exit(0);
fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ args, cwd: process.cwd(), done: fs.existsSync(process.env.OUTPUT_DIR + '/.done'), awsKey: process.env.AWS_ACCESS_KEY_ID }) + '\\n');
const outputAt = args.indexOf('--output');
if (process.env.FAIL_BUILD === 'true' && outputAt !== -1) process.exit(23);
if (process.env.FAIL_CACHE === 'true' && outputAt === -1) process.exit(42);
if (outputAt !== -1) {
  const dest = args[outputAt + 1].match(/(?:^|,)dest=([^,]+)/)?.[1];
  if (dest && /(?:^|,)tar=false(?:,|$)/.test(args[outputAt + 1])) {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(dest + '/index.json', '{}');
  } else if (dest) fs.writeFileSync(dest, 'test-image');
}
const exportAt = args.indexOf('--export-cache');
if (exportAt !== -1 && args[exportAt + 1].startsWith('type=local,')) {
  const dest = args[exportAt + 1].match(/(?:^|,)dest=([^,]+)/)[1];
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(dest + '/index.json', '{}');
}
`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, 'buildctl-daemonless.sh'),
    '#!/bin/sh\n${BUILDKITD:-buildkitd} $BUILDKITD_FLAGS >/dev/null 2>&1 &\npid=$!\nbuildctl "$@"\nrc=$?\nkill $pid\nwait $pid\nexit $rc\n',
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, 'buildkitd'),
    `#!/bin/sh\ntrap 'kill $child 2>/dev/null; exit 0' TERM\nnode '${recorder}' buildkitd "$@"\nsleep 30 >/dev/null 2>&1 &\nchild=$!\nwait $child\n`,
    { mode: 0o755 }
  );
  writeFileSync(join(bin, 'rootlesskit'), '#!/bin/sh\nROOTLESSKIT_PARENT=1 exec "$@"\n', {
    mode: 0o755
  });
  writeFileSync(join(bin, 'unshare'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const builder = generated.job.spec!.template.spec!.containers.find(
    (container) => container.name === 'buildkit'
  )!;
  const environment: Record<string, string> = {};
  for (const entry of builder.env ?? []) {
    if (entry.value !== undefined) environment[entry.name] = entry.value;
    const ref = entry.valueFrom?.secretKeyRef;
    if (ref) {
      const value = generated.secrets.get(ref.name!)?.stringData?.[ref.key];
      if (value !== undefined) environment[entry.name] = value;
    }
  }
  let script = builder.args![0];
  for (const [source, destination] of [
    ['/usr/bin/buildctl-daemonless.sh', join(bin, 'buildctl-daemonless.sh')],
    ['/tmp/buildkitd-env', join(directory, 'buildkitd-env')],
    ['/tmp/orchard-run', join(directory, 'run')],
    ['/tmp/orchard-bin', bin],
    ['/tmp/cache-export.tar', join(directory, 'cache-export.tar')],
    ['/cache/buildkit', cache],
    ['/orchard-build', meta],
    ['/workspace', workspace],
    ['/output', output]
  ]) {
    script = script.replaceAll(source, destination);
  }
  const result = spawnSync('/bin/sh', ['-c', script], {
    cwd: workspace,
    env: {
      ...process.env,
      ...environment,
      PATH: `${bin}:${process.env.PATH}`,
      CALLS_FILE: callsFile,
      PROCESS_FILE: processFile,
      OUTPUT_DIR: output,
      FAIL_BUILD: String(options.failBuild ?? false),
      FAIL_CACHE: String(options.failCache ?? false)
    },
    encoding: 'utf8',
    timeout: 10000
  });
  const calls: BuildCall[] = readFileSync(callsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const processes: ProcessCall[] = readFileSync(processFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { result, calls, processes, sha, workspace, output, cache };
}

function values(call: BuildCall, option: string): string[] {
  return call.args.filter((_, index, args) => index > 0 && args[index - 1] === option);
}

function mount(container: V1Container, name: string) {
  return container.volumeMounts?.find((volume) => volume.name === name);
}

for (const sourceCpuLimit of [undefined, '500m']) {
  for (const localContextUrl of [undefined, 'https://context.example.invalid/source.tar.gz']) {
    const sourceName = localContextUrl ? 'context-fetch' : 'git-clone';
    test(`${sourceName} uses ${sourceCpuLimit ?? 'the default 2'} CPU limit with unchanged requests and memory`, async (t) => {
      const generated = await createJob(t, {
        sourceCpuLimit,
        build: { localContextUrl }
      });
      const source = generated.job.spec!.template.spec!.initContainers!.find(
        (container) => container.name === sourceName
      );
      assert.deepEqual(source?.resources, {
        requests: { cpu: '100m', memory: '256Mi' },
        limits: { cpu: sourceCpuLimit ?? '2', memory: '512Mi' }
      });
    });
  }
}

test('the pusher pushes the OCI layout in place instead of untarring an archive', async (t) => {
  const generated = await createJob(t);
  const pod = generated.job.spec!.template.spec!;
  const pusher = pod.containers.find((container) => container.name === 'pusher')!;
  const script = pusher.args![0];
  assert.match(script, /skopeo copy --retry-times 3 .* oci:\/output\/image '/);
  assert.doesNotMatch(script, /oci-archive:/);
  const execution = executeBuilder(t, generated);
  assert.match(values(execution.calls[0], '--output')[0], /,dest=[^,]*\/output\/image,tar=false,/);
  assert.ok(existsSync(join(execution.output, 'image', 'index.json')));
});

test('Super Builds still push the tarball Depot writes', async (t) => {
  const generated = await createJob(t, { daemon: 'absent', build: { buildWithDepot: true } });
  const pusher = generated.job.spec!.template.spec!.containers.find((c) => c.name === 'pusher')!;
  assert.match(
    pusher.args![0],
    /skopeo copy --retry-times 3 .* oci-archive:\/output\/image\.tar '/
  );
});

test('local sidecar build exports its image and reusable cache in a single solve', async (t) => {
  const generated = await createJob(t);
  const execution = executeBuilder(t, generated);
  assert.equal(execution.result.status, 0, execution.result.stderr);
  assert.equal(execution.calls.length, 1);
  assert.ok(existsSync(join(execution.output, 'image', 'index.json')));
  assert.ok(existsSync(join(execution.output, '.done')));
  assert.ok(existsSync(join(execution.cache, 'rails-app', 'index.json')));
  assert.deepEqual(
    values(execution.calls[0], '--opt').filter((arg) => arg.startsWith('build-arg:GIT_SHA=')),
    [`build-arg:GIT_SHA=${execution.sha}`]
  );
  assert.equal(values(execution.calls[0], '--export-cache').length, 1);
});

for (const daemon of ['ready', 'unavailable', 'absent'] as const) {
  test(`persistent daemon ${daemon} produces a usable output and matching cache configuration`, async (t) => {
    const generated = await createJob(t, { daemon, build: { persistentBuildCache: true } });
    const execution = executeBuilder(t, generated);
    assert.equal(execution.result.status, 0, execution.result.stderr);
    assert.equal(execution.calls.length, 1);
    const pod = generated.job.spec!.template.spec!;
    const call = execution.calls[0];
    if (daemon === 'ready') {
      assert.deepEqual(values(call, '--addr'), ['tcp://192.0.2.42:1234']);
      assert.match(values(call, '--output')[0], /^type=oci,/);
      assert.ok(existsSync(join(execution.output, '.done')));
      assert.deepEqual(values(call, '--export-cache'), []);
      assert.deepEqual(
        pod.containers.map((container) => container.name),
        ['buildkit', 'pusher']
      );
      assert.equal(mount(pod.containers[0], 'buildkit-cache'), undefined);
      assert.ok(mount(pod.containers[0], 'output'));
      assert.equal(mount(pod.containers[0], 'docker-config'), undefined);
      assert.equal(
        pod.containers[0].env?.some((e) => e.name === 'DOCKER_CONFIG'),
        false
      );
      assert.equal(pod.containers[0].args![0].includes('tcp://192.0.2.42:1234'), true);
      assert.equal(
        generated.job.spec!.template.metadata!.labels!['orchard.my/tenant-key'],
        'test-tenant'
      );
    } else {
      assert.deepEqual(values(call, '--addr'), []);
      assert.match(values(call, '--output')[0], /^type=oci,/);
      assert.match(values(call, '--export-cache')[0], /^type=local,/);
      assert.ok(existsSync(join(execution.output, '.done')));
      assert.ok(pod.containers.some((container) => container.name === 'pusher'));
      assert.ok(mount(pod.containers[0], 'buildkit-cache'));
    }
  });
}

test('app pull credentials bypass the daemon and retain sidecar push isolation and cache', async (t) => {
  const generated = await createJob(t, {
    daemon: 'ready',
    build: {
      persistentBuildCache: true,
      envVars: { DHI_USERNAME: 'app-user', DHI_TOKEN: 'app-token' }
    }
  });
  assert.equal(generated.daemonRequests, 0);
  const pod = generated.job.spec!.template.spec!;
  const builder = pod.containers.find((container) => container.name === 'buildkit')!;
  const pusher = pod.containers.find((container) => container.name === 'pusher')!;
  assert.ok(mount(builder, 'buildkit-auth'));
  assert.equal(mount(builder, 'docker-config'), undefined);
  assert.ok(mount(pusher, 'docker-config'));
  const authSecret = [...generated.secrets.values()].find(
    (secret) => secret.type === 'kubernetes.io/dockerconfigjson'
  )!;
  const auth = JSON.parse(Buffer.from(authSecret.data!['.dockerconfigjson'], 'base64').toString());
  assert.deepEqual(Object.keys(auth.auths), ['dhi.io']);
  const execution = executeBuilder(t, generated);
  assert.equal(execution.result.status, 0, execution.result.stderr);
  assert.match(values(execution.calls[0], '--output')[0], /^type=oci,/);
  assert.match(values(execution.calls[0], '--export-cache')[0], /^type=local,/);
});

for (const gitSha of [undefined, 'app-supplied-sha']) {
  test(`S3 sidecar exports cache without a second image and preserves ${gitSha ? 'app' : 'repository'} GIT_SHA`, async (t) => {
    const generated = await createJob(t, {
      backend: 's3',
      daemon: 'unavailable',
      build: { persistentBuildCache: true, envVars: gitSha ? { GIT_SHA: gitSha } : {} }
    });
    const execution = executeBuilder(t, generated);
    assert.equal(execution.result.status, 0, execution.result.stderr);
    assert.equal(execution.calls.length, 2);
    const [build, cache] = execution.calls;
    assert.match(values(build, '--output')[0], /^type=oci,/);
    assert.match(values(build, '--import-cache')[0], /^type=s3,/);
    assert.deepEqual(values(build, '--export-cache'), []);
    assert.deepEqual(values(cache, '--output'), []);
    assert.deepEqual(values(cache, '--import-cache'), []);
    assert.match(values(cache, '--export-cache')[0], /^type=s3,/);
    assert.equal(cache.done, true);
    for (const call of [build, cache]) {
      assert.deepEqual(
        values(call, '--opt').filter((arg) => arg.startsWith('build-arg:GIT_SHA=')),
        [`build-arg:GIT_SHA=${gitSha ?? execution.sha}`]
      );
    }
  });
}

test('Railpack deferred export solves from the same app directory', async (t) => {
  const generated = await createJob(t, {
    backend: 's3',
    build: { buildType: 'railpack', rootDirectory: 'apps/web' }
  });
  const execution = executeBuilder(t, generated, { railpackDirectory: 'apps/web' });
  assert.equal(execution.result.status, 0, execution.result.stderr);
  assert.equal(execution.calls.length, 2);
  for (const call of execution.calls) {
    assert.equal(call.cwd, join(execution.workspace, 'apps/web'));
    assert.deepEqual(values(call, '--frontend'), ['gateway.v0']);
  }
});

test('deferred cache failure preserves the successful image and exit status', async (t) => {
  const generated = await createJob(t, { backend: 's3' });
  const execution = executeBuilder(t, generated, { failCache: true });
  assert.equal(execution.result.status, 0, execution.result.stderr);
  assert.match(execution.result.stdout, /Cache export failed \(non-critical\)/);
  assert.ok(existsSync(join(execution.output, '.done')));
  assert.ok(existsSync(join(execution.output, 'image', 'index.json')));
});

test('build failure never starts deferred export or releases the pusher', async (t) => {
  const generated = await createJob(t, { backend: 's3' });
  const execution = executeBuilder(t, generated, { failBuild: true });
  assert.equal(execution.result.status, 23, execution.result.stderr);
  assert.equal(execution.calls.length, 1);
  assert.ok(existsSync(join(execution.output, '.failed')));
  assert.equal(existsSync(join(execution.output, '.done')), false);
});

test('daemon fallback without a sidecar keeps direct push and external cache', async (t) => {
  const generated = await createJob(t, {
    sidecar: false,
    daemon: 'unavailable',
    build: { persistentBuildCache: true }
  });
  const execution = executeBuilder(t, generated);
  assert.equal(execution.result.status, 0, execution.result.stderr);
  assert.match(values(execution.calls[0], '--output')[0], /^type=image,.*push=true/);
  assert.match(values(execution.calls[0], '--export-cache')[0], /^type=local,/);
  assert.ok(mount(generated.job.spec!.template.spec!.containers[0], 'buildkit-auth'));
});

for (const scenario of ['preinstalled', 'install', 'unavailable', 'pull-failure'] as const) {
  test(`source checkout preserves best-effort LFS behavior when ${scenario}`, async (t) => {
    const generated = await createJob(t, { backend: 'none' });
    const directory = mkdtempSync(join(tmpdir(), 'orchard-clone-job-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const bin = join(directory, 'bin');
    const workspace = join(directory, 'workspace');
    const callsFile = join(directory, 'calls.jsonl');
    mkdirSync(bin);
    writeFileSync(callsFile, '');
    writeFileSync(
      join(bin, 'git'),
      `#!/usr/bin/env node
const fs = require('node:fs');
const raw = process.argv.slice(2);
const args = raw[0] === '-c' ? raw.slice(2) : raw;
fs.appendFileSync(process.env.CALLS_FILE, JSON.stringify({ command: 'git', args, skipSmudge: process.env.GIT_LFS_SKIP_SMUDGE, prompt: process.env.GIT_TERMINAL_PROMPT }) + '\\n');
if (args[0] === 'lfs' && args[1] === 'version') process.exit(process.env.PREINSTALLED === 'true' ? 0 : 1);
if (args[0] === 'clone') fs.mkdirSync(args.at(-1));
if (args[2] === 'lfs' && args[3] === 'ls-files') process.stdout.write('oid asset.png');
if (args[2] === 'lfs' && args[3] === 'pull' && process.env.FAIL_PULL === 'true') process.exit(1);
if (args[2] === 'rev-parse') process.stdout.write('abcdef');
`,
      { mode: 0o755 }
    );
    writeFileSync(
      join(bin, 'apk'),
      `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.CALLS_FILE, JSON.stringify({ command: 'apk', args: process.argv.slice(2) }) + '\\n');
process.exit(process.env.FAIL_INSTALL === 'true' ? 1 : 0);
`,
      { mode: 0o755 }
    );
    const source = generated.job.spec!.template.spec!.initContainers!.find(
      (container) => container.name === 'git-clone'
    )!;
    const result = spawnSync(
      '/bin/sh',
      ['-c', source.args![0].replaceAll('/workspace', workspace)],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CALLS_FILE: callsFile,
          CLONE_URL: 'https://github.com/example/rails-app.git',
          PREINSTALLED: String(scenario === 'preinstalled' || scenario === 'pull-failure'),
          FAIL_INSTALL: String(scenario === 'unavailable'),
          FAIL_PULL: String(scenario === 'pull-failure')
        },
        encoding: 'utf8',
        timeout: 10000
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(callsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.filter((call) => call.command === 'apk').length,
      scenario === 'preinstalled' || scenario === 'pull-failure' ? 0 : 1
    );
    const clone = calls.find((call) => call.args[0] === 'clone');
    assert.ok(clone);
    assert.equal(clone.skipSmudge, '1');
    assert.equal(clone.prompt, '0');
    assert.ok(clone.args.includes('--depth'));
    assert.ok(clone.args.includes('--shallow-submodules'));
    const pulls = calls.filter((call) => call.args[2] === 'lfs' && call.args[3] === 'pull');
    assert.equal(pulls.length, scenario === 'unavailable' ? 0 : 1);
    if (scenario === 'pull-failure') assert.match(result.stdout, /those files stay as pointers/);
    if (scenario === 'unavailable')
      assert.match(result.stdout, /unavailable, continuing without it/);
  });
}

test('the S3 cache key reaches buildkitd through its environment, never a command line', async (t) => {
  const generated = await createJob(t, { backend: 's3' });
  const builder = generated.job.spec!.template.spec!.containers.find((c) => c.name === 'buildkit')!;
  const names = (builder.env ?? []).map((e) => e.name);
  assert.equal(
    names.some((n) => n.startsWith('AWS_')),
    false
  );
  assert.ok(names.includes('ORCHARD_S3_CACHE_KEY_ID'));
  assert.ok(names.includes('ORCHARD_S3_CACHE_SECRET'));
  const script = builder.args![0];
  assert.doesNotMatch(script, /access_key_id|secret_access_key|session_token/);
  assert.match(script, /type=s3,/);
});

const credentialPostures = [
  { name: 'rootless', options: { posture: 'rootless' as const } },
  { name: 'sandboxed with sidecar push', options: { posture: 'vm-sandbox' as const } },
  {
    name: 'sandboxed with direct push',
    options: { posture: 'vm-sandbox' as const, sidecar: false }
  }
];

for (const { name, options } of credentialPostures) {
  for (const buildType of ['dockerfile', 'railpack'] as const) {
    test(`${name} ${buildType} build keeps the S3 cache key out of every process argv`, async (t) => {
      const generated = await createJob(t, {
        backend: 's3',
        ...options,
        build: {
          buildType,
          envVars: {
            AWS_ACCESS_KEY_ID: 'user-asset-key',
            AWS_SESSION_TOKEN: 'user-session-token',
            AWS_PROFILE: 'user-profile'
          }
        }
      });
      generated.secrets.set('buildkit-s3-cache-creds', {
        stringData: { AWS_ACCESS_KEY_ID: SHARED_KEY_ID, AWS_SECRET_ACCESS_KEY: SHARED_SECRET }
      });
      const execution = executeBuilder(t, generated);
      assert.equal(execution.result.status, 0, execution.result.stderr);

      const daemons = execution.processes.filter((p) => p.command === 'buildkitd');
      assert.equal(daemons.length, 1);
      assert.equal(daemons[0].env.AWS_ACCESS_KEY_ID, SHARED_KEY_ID);
      assert.equal(daemons[0].env.AWS_SECRET_ACCESS_KEY, SHARED_SECRET);
      assert.equal(daemons[0].env.AWS_SESSION_TOKEN, undefined);
      assert.equal(daemons[0].env.AWS_PROFILE, undefined);
      assert.equal(daemons[0].env.ORCHARD_S3_CACHE_KEY_ID, undefined);
      assert.equal(daemons[0].env.ORCHARD_S3_CACHE_SECRET, undefined);
      assert.equal(
        daemons[0].env.ROOTLESSKIT_PARENT,
        options.posture === 'rootless' ? '1' : undefined
      );

      const builds = execution.calls.filter((call) => values(call, '--import-cache').length > 0);
      assert.ok(builds.length > 0);
      assert.match(values(builds[0], '--import-cache')[0], /^type=s3,/);
      for (const call of execution.calls) assert.equal(call.awsKey, 'user-asset-key');

      assert.ok(execution.processes.length > 0);
      for (const proc of execution.processes) {
        const argv = proc.args.join(' ');
        assert.equal(argv.includes(SHARED_KEY_ID), false, `${proc.command} argv: ${argv}`);
        assert.equal(argv.includes(SHARED_SECRET), false, `${proc.command} argv: ${argv}`);
        assert.doesNotMatch(argv, /access_key_id|secret_access_key|session_token/);
      }
    });
  }
}

test('Super Builds with sidecar push hand the Dockerfile session no Harbor login', async (t) => {
  const previous = process.env.HARBOR_PASSWORD;
  process.env.HARBOR_PASSWORD = 'harbor-admin-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.HARBOR_PASSWORD;
    else process.env.HARBOR_PASSWORD = previous;
  });
  const generated = await createJob(t, {
    daemon: 'absent',
    build: { buildWithDepot: true }
  });
  const pod = generated.job.spec!.template.spec!;
  const depot = pod.containers.find((c) => c.name === 'depot-build')!;
  const pusher = pod.containers.find((c) => c.name === 'pusher')!;
  assert.ok(pusher);
  assert.ok(mount(pusher, 'docker-config'));
  assert.equal(mount(depot, 'docker-config'), undefined);
  assert.ok(mount(depot, 'output'));
  const script = depot.args![0];
  assert.match(script, /--output "type=oci,dest=\/output\/image\.tar"/);
  assert.doesNotMatch(script, /--push/);
  assert.match(script, /touch \/output\/\.done/);
  const adminAuth = Buffer.from('admin:harbor-admin-secret').toString('base64');
  for (const secret of generated.secrets.values()) {
    const blob = JSON.stringify(secret.stringData ?? secret.data ?? {});
    assert.equal(blob.includes('harbor-admin-secret'), false);
    assert.equal(blob.includes(adminAuth), false);
  }
});

test('Super Builds without sidecar push keep pushing from the session as before', async (t) => {
  const generated = await createJob(t, {
    daemon: 'absent',
    sidecar: false,
    build: { buildWithDepot: true }
  });
  const pod = generated.job.spec!.template.spec!;
  assert.equal(
    pod.containers.some((c) => c.name === 'pusher'),
    false
  );
  const depot = pod.containers.find((c) => c.name === 'depot-build')!;
  assert.match(depot.args![0], /--push/);
});
