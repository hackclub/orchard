import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { WorkloadConsumer } from '../src/engine/consumers/workload.consumer';
import { CnpgConsumer } from '../src/engine/consumers/cnpg.consumer';
import {
  InstanceSettingsService,
  parseResourceLimits
} from '../src/instance-settings/instance-settings.service';
import { tuningPatchFor } from '../src/kubernetes/cnpg-defaults';
import {
  clusterRestartPatch,
  clusterSpecValues,
  specColumnUpdate
} from '../src/kubernetes/cnpg-spec-sync';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import {
  containerResources,
  containerResourcesPatch,
  databaseSizing,
  liveMatchesMode,
  NO_LIMITS_ANNOTATION,
  runsWithoutLimitsOnPurpose,
  type PodSizing
} from '../src/kubernetes/resource-spec';
import { AdminResourceLimitsController } from '../src/quotas/quotas.controller';
import { QuotasService } from '../src/quotas/quotas.service';

const MiB = 1024 * 1024;
const noLimits: PodSizing = {
  cpuMilli: 500,
  memoryBytes: 1024 * MiB,
  noLimits: { cpuMilli: 50, memoryBytes: 64 * MiB }
};

afterEach(() => {
  delete process.env.INSTANCE_RESOURCE_LIMITS;
  delete process.env.INSTANCE_RESOURCE_LIMITS_CHOICE;
});

function settingsWith(initial: string | null) {
  let stored = initial;
  const writes: string[] = [];
  const prisma: any = {
    instanceSetting: {
      findUnique: async () => (stored === null ? null : { value: stored }),
      upsert: async ({ update }: any) => {
        stored = update.value;
        writes.push(update.value);
      }
    }
  };
  return { settings: new InstanceSettingsService(prisma), writes };
}

function settingsTable(initial: Record<string, string> = {}) {
  const table = new Map(Object.entries(initial));
  const prisma: any = {
    instanceSetting: {
      findUnique: async ({ where }: any) =>
        table.has(where.key) ? { value: table.get(where.key) } : null,
      upsert: async ({ where, update }: any) => {
        table.set(where.key, update.value);
      }
    }
  };
  return { settings: new InstanceSettingsService(prisma), table };
}

function quotasWith(initial: string | null, overrides: any = {}) {
  let stored = initial;
  const calls: { removed: string[]; applied: string[] } = { removed: [], applied: [] };
  const prisma: any = {
    instanceSetting: {
      findUnique: async () => (stored === null ? null : { value: stored }),
      upsert: async ({ update }: any) => {
        stored = update.value;
      }
    },
    project: {
      findUnique: async () => ({
        namespace: 'p',
        environments: [{ namespace: 'p' }, { namespace: 'p-staging' }],
        cpuLimitMilli: null,
        memoryLimitBytes: null,
        maxPods: null,
        maxServices: null,
        organization: {
          cpuLimitMilli: 1000,
          memoryLimitBytes: BigInt(1024 * MiB),
          maxPods: 1,
          maxServices: null,
          defaultPodCpuMilli: null,
          defaultPodMemoryBytes: null
        }
      }),
      findMany: async () => [
        { id: 'one', name: 'one', deployments: [], databases: [] },
        { id: 'two', name: 'two', deployments: [], databases: [] }
      ]
    },
    organization: {
      findUnique: async () => ({
        cpuLimitMilli: 1,
        memoryLimitBytes: BigInt(1),
        maxPods: 1,
        quotaGroupId: null,
        projects: []
      })
    },
    organizationMember: {
      findUnique: async () => ({
        userId: 'u',
        cpuAllowanceMilli: 1,
        memoryAllowanceBytes: BigInt(1),
        cpuAllowanceUnlimited: false,
        memoryAllowanceUnlimited: false,
        organization: { defaultMemberCpuMilli: null, defaultMemberMemoryBytes: null }
      })
    },
    ...overrides
  };
  const namespaces: any = {
    getOrgUsage: async () => ({ cpuMilli: 0, memoryBytes: 0, pods: 0, services: 0 }),
    removeNamespaceQuota: async (ns: string) => {
      calls.removed.push(ns);
    },
    applyNamespaceQuota: async ({ namespace }: any) => {
      calls.applied.push(namespace);
    }
  };
  const settings = new InstanceSettingsService(prisma);
  const lease: any = { canCoordinate: true };
  const quotas = new QuotasService(prisma, {} as any, namespaces, settings, lease);
  return { quotas, settings, calls };
}

const row = {
  projectId: 'project',
  image: 'example/app:v1',
  cpuRequestMilli: null,
  memoryRequestBytes: null
};

test('only on and off parse', () => {
  assert.equal(parseResourceLimits('on'), 'on');
  assert.equal(parseResourceLimits(' OFF '), 'off');
  assert.equal(parseResourceLimits('true'), null);
  assert.equal(parseResourceLimits(''), null);
  assert.equal(parseResourceLimits(null), null);
});

test('unset and never chosen means on, and nothing counts as a choice', async () => {
  const { settings } = settingsWith(null);
  assert.deepEqual(await settings.getResourceLimitsState(), {
    value: 'on',
    dbValue: null,
    envOverride: null
  });
});

test('the environment wins over the stored choice and locks writes', async () => {
  process.env.INSTANCE_RESOURCE_LIMITS = 'off';
  const { settings, writes } = settingsWith('on');
  const state = await settings.getResourceLimitsState();
  assert.equal(state.value, 'off');
  assert.equal(state.envOverride, 'off');
  await assert.rejects(settings.setResourceLimits('on'), /pinned by the INSTANCE_RESOURCE_LIMITS/);
  assert.deepEqual(writes, []);
});

test('nothing is written when neither variable is set', async () => {
  const { settings, table } = settingsTable();
  await settings.settleResourceLimits();
  assert.equal(table.size, 0);
  assert.deepEqual(await settings.getResourceLimitsState(), {
    value: 'on',
    dbValue: null,
    envOverride: null
  });
});

test('unsetting a pin keeps its value and unlocks the setting', async () => {
  const { settings } = settingsTable();
  process.env.INSTANCE_RESOURCE_LIMITS = 'off';
  await settings.settleResourceLimits();
  delete process.env.INSTANCE_RESOURCE_LIMITS;
  assert.deepEqual(await settings.getResourceLimitsState(), {
    value: 'off',
    dbValue: 'off',
    envOverride: null
  });
  await settings.setResourceLimits('on');
  assert.equal((await settings.getResourceLimitsState()).value, 'on');
});

test('a pin overwrites an older stored choice when the server starts', async () => {
  const { settings, table } = settingsTable({ resource_limits: 'on' });
  process.env.INSTANCE_RESOURCE_LIMITS = 'off';
  await settings.settleResourceLimits();
  assert.equal(table.get('resource_limits'), 'off');
});

test('the installer choice is stored once and stays editable', async () => {
  const { settings, table } = settingsTable();
  process.env.INSTANCE_RESOURCE_LIMITS_CHOICE = 'off';
  await settings.settleResourceLimits();
  assert.deepEqual(await settings.getResourceLimitsState(), {
    value: 'off',
    dbValue: 'off',
    envOverride: null
  });
  await settings.setResourceLimits('on');
  await settings.settleResourceLimits();
  assert.equal(table.get('resource_limits'), 'on');
});

test('a different installer choice is stored again', async () => {
  const { settings, table } = settingsTable({
    resource_limits: 'on',
    resource_limits_choice_applied: 'on'
  });
  process.env.INSTANCE_RESOURCE_LIMITS_CHOICE = 'off';
  await settings.settleResourceLimits();
  assert.equal(table.get('resource_limits'), 'off');
  assert.equal(table.get('resource_limits_choice_applied'), 'off');
});

test('a pin wins over the installer choice', async () => {
  const { settings, table } = settingsTable();
  process.env.INSTANCE_RESOURCE_LIMITS = 'on';
  process.env.INSTANCE_RESOURCE_LIMITS_CHOICE = 'off';
  await settings.settleResourceLimits();
  assert.equal(table.get('resource_limits'), 'on');
  assert.equal(table.has('resource_limits_choice_applied'), false);
});

test('a limited pod keeps the exact resources it has today', () => {
  const size = { cpuMilli: 1000, memoryBytes: 512 * MiB };
  const today = {
    requests: { cpu: '100m', memory: '512Mi' },
    limits: { cpu: '1000m', memory: '512Mi' }
  };
  assert.deepEqual(containerResources(size), today);
  assert.equal(JSON.stringify(containerResources(size)), JSON.stringify(today));
  assert.deepEqual(containerResourcesPatch(size), today);
});

test('a no-limits pod has small requests and no limits, and the patch deletes old ones', () => {
  assert.deepEqual(containerResources(noLimits), { requests: { cpu: '50m', memory: '64Mi' } });
  assert.deepEqual(containerResourcesPatch(noLimits), {
    requests: { cpu: '50m', memory: '64Mi' },
    limits: null
  });
});

test('a database memory request never falls under its shared_buffers', () => {
  const db: PodSizing = {
    cpuMilli: 500,
    memoryBytes: 8192 * MiB,
    noLimits: { cpuMilli: 100, memoryBytes: 256 * MiB }
  };
  assert.equal(databaseSizing(db, '64MB').noLimits?.memoryBytes, 256 * MiB);
  assert.equal(databaseSizing(db, '2GB').noLimits?.memoryBytes, 2560 * MiB);
  assert.equal(databaseSizing(db, null).noLimits?.memoryBytes, 256 * MiB);
  const limited = { cpuMilli: 500, memoryBytes: 1024 * MiB };
  assert.deepEqual(databaseSizing(limited, '2GB'), limited);
});

test('with limits off the cap checks pass and with limits unset they still bite', async () => {
  const off = quotasWith('off').quotas;
  await off.enforceOrgCapForNewPod('o', { cpuMilli: 99999, memoryBytes: 99999 });
  await off.enforceMemberAllowanceForNewPod('o', 'u', { cpuMilli: 99999, memoryBytes: 99999 });
  await off.enforceMemberAllowanceForProjectTransfer('o', 'u', 'p');

  const unset = quotasWith(null).quotas;
  await assert.rejects(
    unset.enforceOrgCapForNewPod('o', { cpuMilli: 99999, memoryBytes: 1 }),
    /Organization CPU quota exceeded/
  );
  await assert.rejects(
    unset.enforceMemberAllowanceForNewPod('o', 'u', { cpuMilli: 99999, memoryBytes: 1 }, undefined),
    /allowance exceeded/
  );
});

test('prepareRollout leaves every workload alone until somebody has chosen a mode', async () => {
  const { quotas, calls } = quotasWith(null);
  assert.equal(await quotas.prepareRollout(row), undefined);
  assert.deepEqual(calls, { removed: [], applied: [] });
});

test('prepareRollout with limits off drops the quota first and returns no limits', async () => {
  const { quotas, calls } = quotasWith('off');
  const size = await quotas.prepareRollout(row);
  assert.deepEqual(size?.noLimits, { cpuMilli: 50, memoryBytes: 64 * MiB });
  assert.deepEqual(calls.removed.sort(), ['p', 'p-staging']);
  const db = await quotas.prepareRollout({ ...row, image: 'postgres' });
  assert.deepEqual(db?.noLimits, { cpuMilli: 100, memoryBytes: 256 * MiB });
});

test('prepareRollout refuses to go on when an old quota would reject the new pod', async () => {
  const { quotas } = quotasWith('off');
  (quotas as any).k8sNamespace.removeNamespaceQuota = async () => {
    throw new Error('forbidden');
  };
  await assert.rejects(quotas.prepareRollout(row), /Could not remove the old resource limits/);
});

test('prepareRollout with limits chosen on returns the size and restores the quota', async () => {
  const { quotas, calls } = quotasWith('on');
  const size = await quotas.prepareRollout({ ...row, cpuRequestMilli: 250 });
  assert.equal(size?.noLimits, undefined);
  assert.equal(size?.cpuMilli, 250);
  assert.equal(size?.memoryBytes, 128 * MiB);
  assert.deepEqual(calls.applied.sort(), ['p', 'p-staging']);
});

test('an app already set to unlimited stays that way when limits are on', async () => {
  const { quotas } = quotasWith('on');
  const unlimited = { ...row, cpuRequestMilli: 0, memoryRequestBytes: BigInt(0) };
  assert.equal(await quotas.prepareRollout(unlimited), undefined);
});

test('flipping the setting touches nothing but the quota objects', async () => {
  const { quotas, settings, calls } = quotasWith('on');
  const controller = new AdminResourceLimitsController(quotas, settings);
  (quotas as any).resourceLimitsView = async () => ({ ok: true });
  await controller.set({ value: 'on' });
  assert.deepEqual(calls, { removed: [], applied: [] });

  await controller.set({ value: 'off' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.applied.length, 0);
  assert.ok(calls.removed.every((ns) => ['p', 'p-staging'].includes(ns)));

  await assert.rejects(controller.set({ value: 'maybe' }), /value must be on or off/);
});

test('a sweep is not run from a process that is not a cluster member', async () => {
  const { quotas, calls } = quotasWith('off');
  (quotas as any).lease = { canCoordinate: false };
  quotas.sweepQuotasInBackground();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.removed, []);
});

test('applyProjectQuota removes the objects with limits off and writes them otherwise', async () => {
  const off = quotasWith('off');
  await off.quotas.applyProjectQuota('p');
  assert.deepEqual(off.calls.applied, []);
  assert.equal(off.calls.removed.length, 2);

  const unset = quotasWith(null);
  await unset.quotas.applyProjectQuota('p');
  assert.deepEqual(unset.calls.removed, []);
  assert.equal(unset.calls.applied.length, 2);
});

function capturingQuotas(stored: string | null, workloads: any[] | Error) {
  const applied: any[] = [];
  const { quotas } = quotasWith(stored, {
    k8sObject: {
      findMany: async () => {
        if (workloads instanceof Error) throw workloads;
        return workloads;
      }
    }
  });
  (quotas as any).k8sNamespace.applyNamespaceQuota = async (options: any) => {
    applied.push(options);
  };
  return { quotas, applied };
}

const bareRow = (namespace: string, replicas: number) => ({
  kind: 'Deployment',
  namespace,
  manifest: {
    metadata: { annotations: { [NO_LIMITS_ANNOTATION]: 'true' } },
    spec: {
      replicas,
      template: {
        spec: { containers: [{ resources: { requests: { cpu: '50m', memory: '64Mi' } } }] }
      }
    }
  }
});

test('apps that already run without limits still fit under a smaller cap', async () => {
  const { quotas, applied } = capturingQuotas('on', [bareRow('p', 20)]);
  await quotas.applyProjectQuota('p');
  const main = applied.find((a) => a.namespace === 'p');
  const staging = applied.find((a) => a.namespace === 'p-staging');
  assert.equal(main.memoryLimitBytes, Math.ceil(20 * 128 * MiB * 1.25));
  assert.equal(main.cpuLimitMilli, Math.ceil(20 * 100 * 1.25));
  assert.equal(staging.memoryLimitBytes, Math.ceil(1024 * MiB * 1.25));
  assert.equal(staging.cpuLimitMilli, 1250);
  assert.deepEqual(main.defaultLimit, { cpuMilli: 100, memoryBytes: 128 * MiB });
});

test('with nothing chosen the cap is the same as it always was', async () => {
  const { quotas, applied } = capturingQuotas(null, [bareRow('p', 20)]);
  await quotas.applyProjectQuota('p');
  const main = applied.find((a) => a.namespace === 'p');
  assert.equal(main.memoryLimitBytes, Math.ceil(1024 * MiB * 1.25));
  assert.equal(main.cpuLimitMilli, 1250);
  assert.deepEqual(main.defaultLimit, { cpuMilli: 100, memoryBytes: 128 * MiB });
});

test('a mirror that cannot be read leaves the quota applied with a safe default', async () => {
  const { quotas, applied } = capturingQuotas('on', new Error('database is down'));
  await quotas.applyProjectQuota('p');
  assert.equal(applied.length, 2);
  assert.equal(applied[0].memoryLimitBytes, Math.ceil(1024 * MiB * 1.25));
  assert.equal(applied[0].defaultLimit.memoryBytes, 512 * MiB);
});

function cappedProject(
  caps: { cpu?: number; memory?: number; pods?: number },
  rows: { deployments?: any[]; databases?: any[]; live?: any } = {},
  stored: string | null = null
) {
  const { quotas } = quotasWith(stored, {
    project: {
      findUnique: async () => ({
        cpuLimitMilli: caps.cpu ?? null,
        memoryLimitBytes: caps.memory ? BigInt(caps.memory) : null,
        maxPods: caps.pods ?? null,
        namespace: 'p',
        environments: [{ namespace: 'p' }],
        organization: { defaultPodCpuMilli: 200, defaultPodMemoryBytes: BigInt(200 * MiB) },
        deployments: rows.deployments ?? [],
        databases: rows.databases ?? []
      })
    }
  });
  (quotas as any).k8sNamespace.getOrgUsage = async () =>
    rows.live ?? { cpuMilli: 0, memoryBytes: 0, pods: 0, services: 0 };
  return quotas;
}

const defaultSizedApp = {
  id: 'w1',
  image: 'example/app:v1',
  cpuRequestMilli: null,
  memoryRequestBytes: null,
  replicas: 1,
  stopped: false
};
const need = (memoryMiB: number, pods = 1, cpuMilli = 1) => ({
  cpuMilli,
  memoryBytes: memoryMiB * MiB,
  pods
});

test('a second app over the project cap is refused with a clear message', async () => {
  const quotas = cappedProject({ memory: 300 * MiB }, { deployments: [defaultSizedApp] });
  await assert.rejects(
    quotas.enforceProjectCapForNewPod('p', need(200)),
    (err: any) =>
      err.getStatus() === 403 &&
      /Project memory quota exceeded: need 400MiB, limit 300MiB/.test(err.message)
  );
});

test('an app that fits under the project cap is allowed', async () => {
  const quotas = cappedProject({ memory: 500 * MiB }, { deployments: [defaultSizedApp] });
  await quotas.enforceProjectCapForNewPod('p', need(200));
});

test('a project with no cap of its own is not checked here', async () => {
  const quotas = cappedProject({});
  (quotas as any).k8sNamespace.getOrgUsage = async () => {
    throw new Error('should not be read');
  };
  await quotas.enforceProjectCapForNewPod('p', need(99999));
});

test('live pods count when they use more than the rows say', async () => {
  const quotas = cappedProject(
    { memory: 300 * MiB },
    { live: { cpuMilli: 0, memoryBytes: 250 * MiB, pods: 1, services: 0 } }
  );
  await assert.rejects(quotas.enforceProjectCapForNewPod('p', need(100)), /need 350MiB/);
});

test('a CPU cap and a pod cap are checked too', async () => {
  const cpu = cappedProject({ cpu: 300 }, { deployments: [defaultSizedApp] });
  await assert.rejects(
    cpu.enforceProjectCapForNewPod('p', need(1, 1, 200)),
    /Project CPU quota exceeded: need 400m, limit 300m/
  );
  const pods = cappedProject({ pods: 2 }, { deployments: [{ ...defaultSizedApp, replicas: 2 }] });
  await assert.rejects(
    pods.enforceProjectCapForNewPod('p', need(1)),
    /Project pod count quota exceeded: 3\/2/
  );
});

test('a stopped app takes no room, and a rebuild does not count the app twice', async () => {
  const stopped = cappedProject(
    { memory: 300 * MiB },
    { deployments: [{ ...defaultSizedApp, stopped: true }] }
  );
  await stopped.enforceProjectCapForNewPod('p', need(200));
  const rebuilt = cappedProject({ memory: 300 * MiB }, { deployments: [defaultSizedApp] });
  await rebuilt.enforceProjectCapForNewPod('p', need(200), 'w1');
});

test('a database counts at its floor, and a stopped one takes no room', async () => {
  const database = {
    status: 'ready',
    cpuRequestMilli: null,
    memoryRequestBytes: null,
    replicas: 1
  };
  const running = cappedProject({ memory: 600 * MiB }, { databases: [database] });
  await assert.rejects(running.enforceProjectCapForNewPod('p', need(200)), /need 712MiB/);
  const stopped = cappedProject(
    { memory: 600 * MiB },
    { databases: [{ ...database, status: 'stopped' }] }
  );
  await stopped.enforceProjectCapForNewPod('p', need(200));
});

test('a project already over its cap can still shrink and restart', async () => {
  const quotas = cappedProject(
    { memory: 100 * MiB, pods: 1 },
    { deployments: [{ ...defaultSizedApp, replicas: 3 }] }
  );
  await quotas.enforceProjectCapForNewPod('p', { cpuMilli: 0, memoryBytes: 0, pods: 0 });
});

test('with limits off a project cap is not checked', async () => {
  const quotas = cappedProject({ memory: 1 }, { deployments: [defaultSizedApp] }, 'off');
  await quotas.enforceProjectCapForNewPod('p', need(99999));
});

function workloadService() {
  const patches: any[] = [];
  const api = {
    readNamespacedDeployment: async () => ({
      body: { spec: { strategy: { type: 'RollingUpdate' }, template: { spec: {} } } }
    }),
    patchNamespacedDeployment: async (_n: string, _ns: string, patch: any) => {
      patches.push(patch);
    }
  };
  const service = Object.create(K8sWorkloadService.prototype) as any;
  service.kubernetes = { kc: { makeApiClient: () => api }, ensureKubeConfig: () => undefined };
  service.prisma = { project: { findFirst: async () => null } };
  return { service, patches };
}

test('a restart with no sizing is the same annotation patch it always was', async () => {
  const { service, patches } = workloadService();
  await service.restartDeployment('web', 'project');
  assert.deepEqual(Object.keys(patches[0]), ['spec']);
  assert.deepEqual(Object.keys(patches[0].spec.template), ['metadata']);
});

test('a restart with limits off drops them in the same patch as the restart', async () => {
  const { service, patches } = workloadService();
  await service.restartDeployment('web', 'project', noLimits);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].metadata.annotations[NO_LIMITS_ANNOTATION], 'true');
  assert.ok(patches[0].spec.template.metadata.annotations['kubectl.kubernetes.io/restartedAt']);
  assert.deepEqual(patches[0].spec.template.spec.containers, [
    {
      name: 'web',
      resources: { requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: null, memory: null } }
    }
  ]);
});

test('a restart with limits on puts them back in the same patch', async () => {
  const { service, patches } = workloadService();
  await service.restartDeployment('web', 'project', { cpuMilli: 500, memoryBytes: 256 * MiB });
  assert.equal(patches[0].metadata, undefined);
  assert.deepEqual(patches[0].spec.template.spec.containers[0].resources.limits, {
    cpu: '500m',
    memory: '256Mi'
  });
});

test('a new image with no sizing leaves resources out of the patch', async () => {
  const { service, patches } = workloadService();
  await service.updateDeploymentImage('web', 'project', 'example/web:v2');
  const container = patches[0].spec.template.spec.containers[0];
  assert.equal(container.resources, undefined);
  assert.equal(patches[0].metadata, undefined);
});

test('a new image with limits off drops them in the same patch', async () => {
  const { service, patches } = workloadService();
  await service.updateDeploymentImage(
    'web',
    'project',
    'example/web:v2',
    undefined,
    undefined,
    noLimits
  );
  assert.deepEqual(patches[0].spec.template.spec.containers[0].resources.limits, {
    cpu: null,
    memory: null
  });
});

test('a create with limits off marks the object and sets no limits', () => {
  assert.equal(containerResources(noLimits).limits, undefined);
  assert.equal(
    runsWithoutLimitsOnPurpose(
      { [NO_LIMITS_ANNOTATION]: 'true' },
      { requests: { cpu: '50m', memory: '64Mi' } }
    ),
    true
  );
  assert.equal(
    runsWithoutLimitsOnPurpose({ [NO_LIMITS_ANNOTATION]: 'true' }, { limits: { cpu: '1' } }),
    false
  );
  assert.equal(runsWithoutLimitsOnPurpose({}, { requests: { cpu: '50m' } }), false);
});

function adopter() {
  const updates: any[] = [];
  const consumer = Object.create(WorkloadConsumer.prototype) as any;
  consumer.logger = { log: () => undefined, warn: () => undefined };
  consumer.prisma = {
    deployment: {
      findUnique: async () => ({
        replicas: 1,
        stopped: false,
        image: 'example/app:v1',
        cpuRequestMilli: null,
        memoryRequestBytes: null,
        deployStrategy: 'rollingUpdate',
        imagePullPolicy: 'IfNotPresent',
        buildStatus: 'succeeded'
      }),
      update: async (args: any) => updates.push(args)
    },
    k8sApplyItem: { count: async () => 0 }
  };
  return { consumer, updates };
}

const liveWithRequestsOnly = (annotations: Record<string, string>) => ({
  metadata: { annotations },
  spec: {
    replicas: 1,
    template: {
      spec: {
        containers: [
          {
            image: 'example/app:v1',
            imagePullPolicy: 'IfNotPresent',
            resources: { requests: { cpu: '50m', memory: '64Mi' } }
          }
        ]
      }
    }
  }
});

test('adoption does not pin the small requests of an app running without limits', async () => {
  const { consumer, updates } = adopter();
  await consumer.adoptWorkloadSpec('d', liveWithRequestsOnly({ [NO_LIMITS_ANNOTATION]: 'true' }));
  assert.deepEqual(updates, []);
});

test('adoption of an object Orchard did not mark works as it always has', async () => {
  const { consumer, updates } = adopter();
  await consumer.adoptWorkloadSpec('d', liveWithRequestsOnly({}));
  assert.equal(updates[0].data.cpuRequestMilli, 50);
  assert.equal(updates[0].data.memoryRequestBytes, BigInt(64 * MiB));
});

test('adoption takes limits somebody added by hand to a no-limits app', async () => {
  const { consumer, updates } = adopter();
  const live: any = liveWithRequestsOnly({ [NO_LIMITS_ANNOTATION]: 'true' });
  live.spec.template.spec.containers[0].resources.limits = { cpu: '2', memory: '1Gi' };
  await consumer.adoptWorkloadSpec('d', live);
  assert.equal(updates[0].data.cpuRequestMilli, 2000);
});

test('the database spec sync writes no sizes from a cluster with no limits', () => {
  const cluster = { spec: { resources: { requests: { cpu: '100m', memory: '256Mi' } } } };
  const live = clusterSpecValues(cluster);
  assert.equal(live.cpuMilli, null);
  assert.equal(live.memoryBytes, null);
  const update = specColumnUpdate(
    {
      storageSize: null,
      replicas: 1,
      pgMajor: 17,
      sharedPreloadLibs: [],
      cpuRequestMilli: null,
      memoryRequestBytes: null
    },
    live,
    {
      current: { cpuMilli: 500, memoryBytes: 1024 * MiB },
      defaults: { cpuMilli: 500, memoryBytes: 1024 * MiB }
    }
  );
  assert.equal(update.cpuRequestMilli, undefined);
  assert.equal(update.memoryRequestBytes, undefined);
});

test('the database defaults reconciler never adds limits to a cluster with none', () => {
  const cluster = {
    spec: {
      resources: { requests: { cpu: '100m', memory: '256Mi' } },
      postgresql: { parameters: { shared_buffers: '8GB' } }
    }
  };
  assert.equal(tuningPatchFor(cluster, {}), null);
  assert.equal(tuningPatchFor(cluster, {}, { backupOomLooping: true }), null);
});

test('the database spec sync still reads a running limit, so a flip changes nothing', async () => {
  const consumer = Object.create(CnpgConsumer.prototype) as any;
  assert.equal(typeof consumer.resolvedResources, 'function');
  const live = clusterSpecValues({
    spec: { resources: { limits: { cpu: '1', memory: '2Gi' } } }
  });
  const update = specColumnUpdate(
    {
      storageSize: null,
      replicas: 1,
      pgMajor: 17,
      sharedPreloadLibs: [],
      cpuRequestMilli: 1000,
      memoryRequestBytes: BigInt(2048 * MiB)
    },
    live,
    {
      current: { cpuMilli: 1000, memoryBytes: 2048 * MiB },
      defaults: { cpuMilli: 500, memoryBytes: 1024 * MiB }
    }
  );
  assert.deepEqual(update, {});
});

const limitedCluster = {
  spec: {
    resources: {
      requests: { cpu: '100m', memory: '2Gi' },
      limits: { cpu: '1', memory: '2Gi' }
    },
    postgresql: { parameters: { shared_buffers: '512MB' } }
  }
};
const tuning = { sharedBuffers: '256MB', dataCompression: 'gzip' as const };

test('a database restart with limits off removes them and keeps its tuning', () => {
  const size: PodSizing = {
    cpuMilli: 1000,
    memoryBytes: 2048 * MiB,
    noLimits: { cpuMilli: 100, memoryBytes: 256 * MiB }
  };
  const patch = clusterRestartPatch(limitedCluster, size, null, new Date(0));
  assert.equal(patch.metadata.annotations['cnpg.io/restartedAt'], '1970-01-01T00:00:00.000Z');
  assert.deepEqual(patch.spec.resources, {
    requests: { cpu: '100m', memory: '640Mi' },
    limits: null
  });
  assert.equal(patch.spec.postgresql, undefined);
});

test('a database restart that changes nothing only restarts', () => {
  const same = clusterRestartPatch(
    limitedCluster,
    { cpuMilli: 1000, memoryBytes: 2048 * MiB },
    tuning
  );
  assert.equal(same.spec, undefined);
  const unlimited = { spec: { resources: { requests: { cpu: '100m', memory: '256Mi' } } } };
  const again = clusterRestartPatch(unlimited, { ...noLimits }, null);
  assert.equal(again.spec, undefined);
});

test('a database restart with limits back on applies them and retunes in one patch', () => {
  const unlimited = {
    spec: {
      resources: { requests: { cpu: '100m', memory: '256Mi' } },
      postgresql: { parameters: { shared_buffers: '1GB' } },
      backup: { barmanObjectStore: {} }
    }
  };
  const patch = clusterRestartPatch(unlimited, { cpuMilli: 500, memoryBytes: 1024 * MiB }, tuning);
  assert.deepEqual(patch.spec.resources.limits, { cpu: '500m', memory: '1024Mi' });
  assert.equal(patch.spec.postgresql.parameters.shared_buffers, '256MB');
  assert.deepEqual(patch.spec.backup.barmanObjectStore.data, { compression: 'gzip' });
});

test('live pods are compared with the current mode', () => {
  assert.equal(liveMatchesMode('off', { requests: { cpu: '50m' } }), true);
  assert.equal(liveMatchesMode('off', { limits: { cpu: '1' } }), false);
  assert.equal(liveMatchesMode('off', { limits: {} }), true);
  assert.equal(liveMatchesMode('on', { limits: { cpu: '1' } }), true);
  assert.equal(liveMatchesMode('on', undefined), false);
});

test('the restart hint stays quiet until a mode has been chosen', async () => {
  const deployment = {
    id: 'd',
    name: 'web',
    namespace: 'p',
    cpuRequestMilli: null,
    memoryRequestBytes: null
  };
  const k8sObject = {
    findFirst: async () => ({
      manifest: { spec: { template: { spec: { containers: [{ resources: {} }] } } } }
    })
  };
  assert.equal(await quotasWith(null, { k8sObject }).quotas.restartPending(deployment), false);
  assert.equal(await quotasWith('off', { k8sObject }).quotas.restartPending(deployment), false);
  assert.equal(await quotasWith('on', { k8sObject }).quotas.restartPending(deployment), true);
  assert.equal(
    await quotasWith('on', { k8sObject }).quotas.restartPending({ ...deployment, stopped: true }),
    false
  );
});
