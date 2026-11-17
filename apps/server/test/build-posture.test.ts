import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { V1Container, V1Job, V1Pod, V1Secret } from '@kubernetes/client-node';
import { ImageBuilderService } from '../src/docker/image-builder.service';
import { BuildKitPoolService } from '../src/docker/buildkit-pool.service';
import {
  buildkitImageFor,
  effectiveSidecarPush,
  resolveBuildPosture,
  rootlessImageFor
} from '../src/docker/build-posture';
import { summarizeBuildFailure } from '../src/docker/build-summary';

function setEnv(t: TestContext, env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

const baseEnv = {
  BUILDKIT_LOCAL_CACHE_ENABLED: 'true',
  BUILDKIT_LOCAL_CACHE_PATH: '/cache/buildkit',
  BUILDKIT_LOCAL_CACHE_PVC: 'test-build-cache',
  BUILDKIT_S3_CACHE_ENABLED: 'false',
  BUILDER_SCRATCH_MODE: undefined,
  BUILDER_RUNTIME_CLASS: undefined,
  BUILDER_ALLOW_PRIVILEGED_ON_HOST: undefined,
  BUILDER_SIDECAR_PUSH: undefined,
  BUILDKIT_IMAGE: 'moby/buildkit:v0.34.2',
  BUILDKIT_ROOTLESS_IMAGE: undefined,
  DOCKER_REGISTRY_PUSH: 'registry.example.invalid',
  DOCKER_REGISTRY_PULL: 'registry.example.invalid',
  REGISTRY_PROJECT: 'orchard',
  REGISTRY_PULL_SECRET_NAME: 'registry-creds',
  REGISTRY_HTTP_HOSTS: 'registry.example.invalid'
};

async function createJob(t: TestContext, env: Record<string, string | undefined>) {
  setEnv(t, { ...baseEnv, ...env });
  let job: V1Job | undefined;
  const api = {
    readNamespacedSecret: async () => {
      throw { statusCode: 404 };
    },
    createNamespacedSecret: async (_ns: string, secret: V1Secret) => ({ body: secret }),
    createNamespacedJob: async (_ns: string, body: V1Job) => {
      job = body;
      return { body };
    }
  };
  t.mock.method(ImageBuilderService.prototype as any, 'initKubeConfig', () => {});
  const service = new ImageBuilderService({} as any, {} as any, undefined as any);
  Object.assign(service, { kc: { makeApiClient: () => api }, builderInfraReady: true });
  await service.createBuildJob({
    repoUrl: 'https://github.com/example/rails-app',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    imageName: 'rails-app',
    cacheTenantKey: 'test-tenant'
  });
  assert.ok(job);
  const spec = job.spec!.template.spec!;
  const buildkit = spec.containers.find((c) => c.name === 'buildkit') as V1Container;
  return { job, spec, buildkit };
}

test('posture resolves to rootless unless a runtime class or the explicit opt-in is set', () => {
  assert.equal(resolveBuildPosture({}), 'rootless');
  assert.equal(resolveBuildPosture({ BUILDER_RUNTIME_CLASS: 'kata' }), 'vm-sandbox');
  assert.equal(
    resolveBuildPosture({ BUILDER_ALLOW_PRIVILEGED_ON_HOST: 'true' }),
    'privileged-host'
  );
  assert.equal(resolveBuildPosture({ BUILDER_ALLOW_PRIVILEGED_ON_HOST: 'false' }), 'rootless');
  assert.equal(
    resolveBuildPosture({
      BUILDER_RUNTIME_CLASS: 'kata',
      BUILDER_ALLOW_PRIVILEGED_ON_HOST: 'true'
    }),
    'vm-sandbox'
  );
});

test('rootless image follows the pinned buildkit version', () => {
  assert.equal(rootlessImageFor('moby/buildkit:v0.34.2'), 'moby/buildkit:v0.34.2-rootless');
  assert.equal(
    rootlessImageFor('moby/buildkit:v0.34.2-rootless'),
    'moby/buildkit:v0.34.2-rootless'
  );
  assert.equal(rootlessImageFor('reg.example:5000/bk:v1'), 'reg.example:5000/bk:v1-rootless');
  assert.equal(rootlessImageFor('moby/buildkit:v1@sha256:abc'), 'moby/buildkit:v1-rootless');
  assert.equal(rootlessImageFor('moby/buildkit:v1', 'mirror/bk:r'), 'mirror/bk:r');
  assert.equal(
    buildkitImageFor('vm-sandbox', { BUILDKIT_IMAGE: 'moby/buildkit:v1' }),
    'moby/buildkit:v1'
  );
});

test('rootless always pushes from the sidecar so the build container never holds the registry login', () => {
  assert.equal(effectiveSidecarPush('rootless', { BUILDER_SIDECAR_PUSH: 'false' }), true);
  assert.equal(effectiveSidecarPush('vm-sandbox', { BUILDER_SIDECAR_PUSH: 'false' }), false);
});

test('default build job is rootless, unprivileged and has no registry credentials', async (t) => {
  const { spec, buildkit, job } = await createJob(t, { BUILDER_SIDECAR_PUSH: 'false' });
  assert.equal(buildkit.securityContext?.privileged, false);
  assert.equal(buildkit.securityContext?.runAsUser, 1000);
  assert.equal(buildkit.securityContext?.runAsNonRoot, true);
  assert.equal(buildkit.securityContext?.seccompProfile?.type, 'Unconfined');
  assert.equal((buildkit.securityContext as any).appArmorProfile.type, 'Unconfined');
  assert.equal(buildkit.image, 'moby/buildkit:v0.34.2-rootless');
  assert.equal(spec.runtimeClassName, undefined);
  assert.equal(
    job.spec!.template.metadata!.annotations![
      'container.apparmor.security.beta.kubernetes.io/buildkit'
    ],
    'unconfined'
  );
  const flags = buildkit.env!.find((e) => e.name === 'BUILDKITD_FLAGS')!.value!;
  assert.match(flags, /--oci-worker-no-process-sandbox/);
  assert.match(flags, /buildkitd\.rootless\.toml/);
  const script = buildkit.args![0];
  assert.match(script, /\$BUILDKITD_ENV rootlesskit buildkitd/);
  assert.ok(script.indexOf('BUILDKITD_ENV=$(mktemp') < script.indexOf('rootlesskit buildkitd'));
  assert.match(script, /ORCHARD_ROOTLESS_UNSUPPORTED/);
  assert.doesNotMatch(script, /\/usr\/bin\/buildctl-daemonless\.sh/);
  assert.equal(spawnSync('/bin/sh', ['-n', '-c', script]).status, 0);
  if (process.env.DUMP_SCRIPT) writeFileSync(process.env.DUMP_SCRIPT, script);
  assert.ok(spec.containers.some((c) => c.name === 'pusher'));
  const mountPaths = (buildkit.volumeMounts ?? []).map((m) => m.mountPath);
  assert.ok(!mountPaths.includes('/root/.docker'));
  const evict = spec.initContainers!.find((c) => c.name === 'cache-evict')!;
  assert.match(evict.args![0], /chown 1000:1000/);
  assert.ok(
    !JSON.stringify(spec).includes('"privileged":true'),
    'no container in the default build pod may be privileged'
  );
});

test('rootless build falls back from block scratch to disk, which needs no mount', async (t) => {
  const { spec, buildkit } = await createJob(t, { BUILDER_SCRATCH_MODE: 'block' });
  assert.equal(buildkit.volumeDevices, undefined);
  const state = spec.volumes!.find((v) => v.name === 'buildkit-state')!;
  assert.ok(state.emptyDir);
  assert.doesNotMatch(buildkit.args![0], /mkfs|mount /);
});

test('rootless build never passes entitlements that would grant insecure RUN steps', async (t) => {
  const { buildkit } = await createJob(t, {});
  const script = buildkit.args![0];
  assert.doesNotMatch(script, /--allow\b/);
  assert.doesNotMatch(script, /insecure-entitlements/);
});

test('privileged BuildKit on the host needs the explicit opt-in', async (t) => {
  const { buildkit, spec } = await createJob(t, { BUILDER_ALLOW_PRIVILEGED_ON_HOST: 'true' });
  assert.equal(buildkit.securityContext?.privileged, true);
  assert.equal(buildkit.image, 'moby/buildkit:v0.34.2');
  assert.equal(spec.runtimeClassName, undefined);
});

test('a configured sandbox runtime keeps the privileged-in-VM spec unchanged', async (t) => {
  const { buildkit, spec, job } = await createJob(t, { BUILDER_RUNTIME_CLASS: 'kata' });
  assert.equal(buildkit.securityContext?.privileged, true);
  assert.equal(buildkit.image, 'moby/buildkit:v0.34.2');
  assert.equal(spec.runtimeClassName, 'kata');
  assert.equal(job.spec!.template.metadata!.annotations, undefined);
  assert.match(buildkit.args![0], /> \/usr\/bin\/buildctl-daemonless\.sh/);
});

function daemonPod(t: TestContext, env: Record<string, string | undefined>): V1Pod {
  setEnv(t, { ...baseEnv, ...env });
  t.mock.method(BuildKitPoolService.prototype as any, 'initKubeConfig', () => {});
  return new BuildKitPoolService().daemonPodSpec('buildkitd-t', 't');
}

test('default persistent daemon is rootless and unprivileged', (t) => {
  const pod = daemonPod(t, {});
  const c = pod.spec!.containers[0];
  assert.equal(c.securityContext?.privileged, false);
  assert.equal(c.securityContext?.runAsUser, 1000);
  assert.equal(c.securityContext?.seccompProfile?.type, 'Unconfined');
  assert.equal(c.image, 'moby/buildkit:v0.34.2-rootless');
  assert.ok(c.args!.includes('--oci-worker-no-process-sandbox'));
  assert.equal(
    pod.metadata!.annotations!['container.apparmor.security.beta.kubernetes.io/buildkitd'],
    'unconfined'
  );
  assert.equal(pod.metadata!.annotations!['orchard.my/build-posture'], 'rootless');
  assert.equal(c.volumeMounts![0].mountPath, '/home/user/.local/share/buildkit');
  assert.equal(pod.spec!.initContainers![0].securityContext?.runAsUser, 0);
  assert.ok(!JSON.stringify(c.volumeMounts).includes('docker-config'));
  assert.ok(!JSON.stringify(pod.spec).includes('"privileged":true'));
});

test('persistent daemon stays privileged under a runtime class', (t) => {
  const vm = daemonPod(t, { BUILDER_RUNTIME_CLASS: 'kata' });
  assert.equal(vm.spec!.containers[0].securityContext?.privileged, true);
  assert.equal(vm.spec!.runtimeClassName, 'kata');
  assert.equal(vm.metadata!.annotations!['orchard.my/build-posture'], 'vm-sandbox');
});

test('persistent daemon on the host needs the explicit opt-in', (t) => {
  const pod = daemonPod(t, { BUILDER_ALLOW_PRIVILEGED_ON_HOST: 'true' });
  assert.equal(pod.spec!.containers[0].securityContext?.privileged, true);
  assert.equal(pod.metadata!.annotations!['orchard.my/build-posture'], 'privileged-host');
});

test('failure summary explains unsupported nodes and refused entitlements', () => {
  const nodes = summarizeBuildFailure('ORCHARD_ROOTLESS_UNSUPPORTED: this node does not allow');
  assert.match(nodes, /allowPrivilegedOnHost/);
  const insecure = summarizeBuildFailure(
    'error: failed to solve: entitlement security.insecure is not allowed'
  );
  assert.match(insecure, /RUN --security=insecure/);
});
