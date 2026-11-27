import test from 'node:test';
import assert from 'node:assert/strict';
import { Logger } from '@nestjs/common';
import {
  DeviceNotOfferedError,
  deviceClasses,
  deviceResourcesPatch,
  deviceRuntimeClassName,
  deviceRuntimeClassPatch,
  isDeviceResource,
  liveDeviceQuantities,
  parseDeviceClasses,
  sameDevices,
  storedDevices,
  validateDeviceRequest,
  withDevices
} from '../src/kubernetes/devices';
import { appResourcesPatch, applySizingTo, hasLimits } from '../src/kubernetes/resource-spec';
import { blueGreenBlocker, buildGreenDeployment } from '../src/kubernetes/rollout-strategy';
import { DeploymentsService } from '../src/projects/deployments.service';
import { WorkloadConsumer } from '../src/engine/consumers/workload.consumer';
import { DeploymentsController } from '../src/projects/projects.controller';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';

const parseWarnings: string[] = [];
const classes = parseDeviceClasses(
  JSON.stringify([
    { resource: 'nvidia.com/gpu', label: 'NVIDIA GPU', runtimeClassName: 'nvidia', max: 2 },
    { resource: 'squat.ai/dri' },
    { resource: 'nvidia.com/gpu', label: 'duplicate' },
    { resource: 'cpu' },
    { resource: 'kubernetes.io/fake' },
    { resource: 'example.com/x', runtimeClassName: 'Not Valid', max: 999 },
    { resource: 'example.com/y', max: 999 },
    'nvidia.com/gpu'
  ]),
  (message) => parseWarnings.push(message)
);

test('only domain-prefixed resources outside kubernetes.io count as devices', () => {
  assert.equal(isDeviceResource('nvidia.com/gpu'), true);
  assert.equal(isDeviceResource('gpu.intel.com/i915'), true);
  assert.equal(isDeviceResource('cpu'), false);
  assert.equal(isDeviceResource('memory'), false);
  assert.equal(isDeviceResource('hugepages-2Mi'), false);
  assert.equal(isDeviceResource('kubernetes.io/batteries'), false);
  assert.equal(isDeviceResource('node.kubernetes.io/x'), false);
});

test('device classes parse leniently and drop what Kubernetes would refuse', () => {
  assert.deepEqual(classes, [
    { resource: 'nvidia.com/gpu', label: 'NVIDIA GPU', max: 2, runtimeClassName: 'nvidia' },
    { resource: 'squat.ai/dri', label: 'squat.ai/dri', max: 1 },
    { resource: 'example.com/y', label: 'example.com/y', max: 16 }
  ]);
  assert.deepEqual(parseDeviceClasses(undefined), []);
  assert.deepEqual(
    parseDeviceClasses('not json', () => undefined),
    []
  );
  assert.deepEqual(
    parseDeviceClasses('{"resource":"nvidia.com/gpu"}', () => undefined),
    []
  );
});

test('every dropped device class is reported by name', () => {
  assert.equal(parseWarnings.length, 6);
  assert.match(parseWarnings[0], /"label":"duplicate".*listed twice/);
  assert.match(parseWarnings[1], /"resource":"cpu".*domain-prefixed/);
  assert.match(parseWarnings[2], /"resource":"kubernetes.io\/fake"/);
  assert.match(parseWarnings[3], /"resource":"example.com\/x".*runtimeClassName "Not Valid"/);
  assert.match(parseWarnings[4], /"resource":"example.com\/y".*above the ceiling of 16/);
  assert.match(parseWarnings[5], /"nvidia.com\/gpu" is not an object/);

  const warned: string[] = [];
  parseDeviceClasses('[{"resource": "nvidia.com/gpu",}]', (m) => warned.push(m));
  parseDeviceClasses('{"resource":"nvidia.com/gpu"}', (m) => warned.push(m));
  assert.match(warned[0], /not valid JSON/);
  assert.match(warned[1], /must be a JSON array.*nvidia.com\/gpu/);
  assert.deepEqual(
    parseDeviceClasses('[]', (m) => warned.push(m)),
    []
  );
  assert.equal(warned.length, 2);
});

test('a broken DEVICE_CLASSES is reported once, not on every read', () => {
  const env = { DEVICE_CLASSES: `[{"resource":"typo-${Math.random()}"}]` };
  const logged: string[] = [];
  const warn = Logger.prototype.warn;
  Logger.prototype.warn = function (message: unknown) {
    logged.push(String(message));
  };
  try {
    deviceClasses(env);
    deviceClasses(env);
    deviceClasses(env);
  } finally {
    Logger.prototype.warn = warn;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0], /typo-/);
});

test('a request names only offered devices, within their max', () => {
  assert.deepEqual(validateDeviceRequest({ 'nvidia.com/gpu': 2, 'squat.ai/dri': 0 }, classes), {
    'nvidia.com/gpu': 2
  });
  assert.deepEqual(validateDeviceRequest(null, classes), {});
  assert.throws(() => validateDeviceRequest({ 'nvidia.com/gpu': 3 }, classes), /0 to 2/);
  assert.throws(() => validateDeviceRequest({ 'nvidia.com/gpu': 1.5 }, classes), /whole number/);
  assert.throws(() => validateDeviceRequest({ 'amd.com/gpu': 1 }, classes), /isn't a device/);
  assert.throws(() => validateDeviceRequest({ cpu: 1 }, classes), /isn't a device/);
  assert.throws(() => validateDeviceRequest(['nvidia.com/gpu'], classes), /object/);
});

test('a count of 0 detaches a device the instance no longer offers', () => {
  assert.deepEqual(validateDeviceRequest({ 'amd.com/gpu': 0 }, classes), {});
  assert.deepEqual(validateDeviceRequest({ 'amd.com/gpu': 0 }, classes, { 'amd.com/gpu': 1 }), {});
  assert.throws(() => validateDeviceRequest({ 'not a name': 0 }, classes), /resource name/);
});

test('a stale device already on the app can ride along while another is attached', () => {
  assert.deepEqual(
    validateDeviceRequest({ 'amd.com/gpu': 1, 'nvidia.com/gpu': 1 }, classes, {
      'amd.com/gpu': 1
    }),
    { 'amd.com/gpu': 1, 'nvidia.com/gpu': 1 }
  );
  assert.throws(
    () => validateDeviceRequest({ 'amd.com/gpu': 1, 'nvidia.com/gpu': 1 }, classes),
    /amd.com\/gpu isn't a device this instance offers/
  );
  assert.throws(
    () => validateDeviceRequest({ 'amd.com/gpu': 2 }, classes, { 'amd.com/gpu': 1 }),
    /isn't a device this instance offers/
  );
});

test('a stale device keeps the live runtime class unless an offered one names its own', () => {
  assert.deepEqual(deviceRuntimeClassPatch(['amd.com/gpu', 'squat.ai/dri'], classes), {});
  assert.deepEqual(deviceRuntimeClassPatch(['amd.com/gpu', 'nvidia.com/gpu'], classes), {
    runtimeClassName: 'nvidia'
  });
  assert.deepEqual(deviceRuntimeClassPatch(['nvidia.com/gpu'], classes), {
    runtimeClassName: 'nvidia'
  });
});

test('a count must be a real number, not a boolean, string or null', () => {
  for (const value of [true, '1', null, undefined, Number.NaN]) {
    assert.throws(
      () => validateDeviceRequest({ 'nvidia.com/gpu': value }, classes),
      /whole number/,
      String(value)
    );
  }
});

test('a device the instance stopped offering fails loudly instead of losing its runtime', () => {
  assert.throws(
    () => deviceRuntimeClassName(['amd.com/gpu'], classes),
    (e: unknown) =>
      e instanceof DeviceNotOfferedError &&
      e.resource === 'amd.com/gpu' &&
      /amd\.com\/gpu .*no longer offers it/.test(e.message)
  );
});

test('blue/green refuses an app that holds a device', () => {
  const blocker = blueGreenBlocker({
    spec: {
      selector: {},
      template: {
        spec: { containers: [{ name: 'web', resources: { limits: { 'nvidia.com/gpu': '1' } } }] }
      }
    }
  });
  assert.match(blocker ?? '', /device/);
  assert.equal(
    blueGreenBlocker({
      spec: { selector: {}, template: { spec: { containers: [{ name: 'web' }] } } }
    }),
    null
  );
});

test('a pod attaching a device runs under its class runtime, otherwise the tenant one', () => {
  const previous = process.env.TENANT_RUNTIME_CLASS;
  process.env.TENANT_RUNTIME_CLASS = 'gvisor';
  try {
    assert.equal(deviceRuntimeClassName(['nvidia.com/gpu'], classes), 'nvidia');
    assert.equal(deviceRuntimeClassName(['squat.ai/dri'], classes), 'gvisor');
    assert.equal(deviceRuntimeClassName([], classes), 'gvisor');
  } finally {
    if (previous === undefined) delete process.env.TENANT_RUNTIME_CLASS;
    else process.env.TENANT_RUNTIME_CLASS = previous;
  }
});

test('the device patch sets requests and limits together and clears removed ones', () => {
  assert.deepEqual(deviceResourcesPatch({ 'squat.ai/dri': 1 }, { 'nvidia.com/gpu': '1' }), {
    requests: { 'nvidia.com/gpu': null, 'squat.ai/dri': '1' },
    limits: { 'nvidia.com/gpu': null, 'squat.ai/dri': '1' }
  });
  assert.deepEqual(deviceResourcesPatch({}, {}), { requests: {}, limits: {} });
});

test('live devices are read from limits and stored as counts', () => {
  const live = liveDeviceQuantities({
    limits: { cpu: '1', memory: '1Gi', 'nvidia.com/gpu': '1' }
  });
  assert.deepEqual(live, { 'nvidia.com/gpu': '1' });
  assert.deepEqual(storedDevices(live), { 'nvidia.com/gpu': 1 });
  assert.deepEqual(storedDevices({ 'nvidia.com/gpu': 0, cpu: 4, junk: 'x' }), {});
  assert.equal(sameDevices({ 'nvidia.com/gpu': 1 }, { 'nvidia.com/gpu': 1 }), true);
  assert.equal(sameDevices({ 'nvidia.com/gpu': 1 }, {}), false);
});

test('devices merge into both requests and limits', () => {
  assert.deepEqual(withDevices({ requests: { cpu: '100m' } }, { 'nvidia.com/gpu': '1' }), {
    requests: { cpu: '100m', 'nvidia.com/gpu': '1' },
    limits: { 'nvidia.com/gpu': '1' }
  });
  assert.equal(withDevices(undefined, {}), undefined);
});

test('turning limits off removes cpu and memory but leaves a GPU attached', () => {
  const patch = appResourcesPatch({
    cpuMilli: 500,
    memoryBytes: 256 * 1024 * 1024,
    noLimits: { cpuMilli: 50, memoryBytes: 64 * 1024 * 1024 }
  });
  assert.deepEqual(patch.limits, { cpu: null, memory: null });
});

test('a GPU limit alone does not count as resource limits', () => {
  assert.equal(hasLimits({ limits: { 'nvidia.com/gpu': '1' } }), false);
  assert.equal(hasLimits({ limits: { cpu: '1', 'nvidia.com/gpu': '1' } }), true);
});

test('resizing a cloned deployment keeps its devices', () => {
  const deployment = {
    metadata: {},
    spec: {
      template: {
        spec: {
          containers: [{ name: 'web', resources: { limits: { cpu: '1', 'nvidia.com/gpu': '1' } } }]
        }
      }
    }
  };
  applySizingTo(deployment, { cpuMilli: 2000, memoryBytes: 512 * 1024 * 1024 });
  const resources = deployment.spec.template.spec.containers[0].resources as any;
  assert.equal(resources.limits['nvidia.com/gpu'], '1');
  assert.equal(resources.requests['nvidia.com/gpu'], '1');
  assert.equal(resources.limits.cpu, '2000m');
});

test('a blue/green clone keeps the device runtime class', () => {
  const previous = process.env.DEVICE_CLASSES;
  process.env.DEVICE_CLASSES = JSON.stringify([
    { resource: 'nvidia.com/gpu', runtimeClassName: 'nvidia' }
  ]);
  try {
    const green = buildGreenDeployment(
      {
        metadata: { name: 'web' },
        spec: {
          selector: {},
          template: {
            spec: {
              runtimeClassName: 'nvidia',
              containers: [
                { name: 'web', image: 'a', resources: { limits: { 'nvidia.com/gpu': '1' } } }
              ]
            }
          }
        }
      },
      { image: 'b' }
    );
    assert.equal(green.spec?.template.spec?.runtimeClassName, 'nvidia');
  } finally {
    if (previous === undefined) delete process.env.DEVICE_CLASSES;
    else process.env.DEVICE_CLASSES = previous;
  }
});

function gpuWorkload() {
  const patches: any[] = [];
  const api = {
    readNamespacedDeployment: async () => ({
      body: {
        spec: {
          strategy: { type: 'RollingUpdate' },
          template: {
            spec: {
              runtimeClassName: 'nvidia',
              containers: [
                {
                  name: 'web',
                  resources: {
                    requests: { 'nvidia.com/gpu': '1' },
                    limits: { 'nvidia.com/gpu': '1' }
                  }
                }
              ]
            }
          }
        }
      }
    }),
    patchNamespacedDeployment: async (_n: string, _ns: string, patch: any) => {
      patches.push(patch);
    }
  };
  const service = Object.create(K8sWorkloadService.prototype) as any;
  service.kubernetes = { kc: { makeApiClient: () => api }, ensureKubeConfig: () => undefined };
  service.prisma = {
    project: { findFirst: async () => null },
    deployment: { updateMany: async () => ({}) }
  };
  return { service, patches };
}

function withDeviceEnv(fn: () => Promise<void>) {
  return async () => {
    const previous = process.env.DEVICE_CLASSES;
    process.env.DEVICE_CLASSES = JSON.stringify([
      { resource: 'nvidia.com/gpu', runtimeClassName: 'nvidia' },
      { resource: 'squat.ai/dri' }
    ]);
    try {
      await fn();
    } finally {
      if (previous === undefined) delete process.env.DEVICE_CLASSES;
      else process.env.DEVICE_CLASSES = previous;
    }
  };
}

test(
  'a redeploy keeps the runtime class of an attached GPU',
  withDeviceEnv(async () => {
    const { service, patches } = gpuWorkload();
    await service.updateDeploymentImage('web', 'project', 'example/web:v2');
    assert.equal(patches[0].spec.template.spec.runtimeClassName, 'nvidia');
  })
);

test(
  'swapping a GPU for a DRI device clears the GPU and the runtime class',
  withDeviceEnv(async () => {
    const previous = process.env.TENANT_RUNTIME_CLASS;
    delete process.env.TENANT_RUNTIME_CLASS;
    try {
      const { service, patches } = gpuWorkload();
      await service.updateDeploymentDevices('web', 'project', { 'squat.ai/dri': 1 });
      const spec = patches[0].spec.template.spec;
      assert.equal(spec.runtimeClassName, null);
      assert.deepEqual(spec.containers, [
        {
          name: 'web',
          resources: {
            requests: { 'nvidia.com/gpu': null, 'squat.ai/dri': '1' },
            limits: { 'nvidia.com/gpu': null, 'squat.ai/dri': '1' }
          }
        }
      ]);
    } finally {
      if (previous !== undefined) process.env.TENANT_RUNTIME_CLASS = previous;
    }
  })
);

test(
  'a redeploy of a GPU app rolls out with Recreate so the old pod frees the GPU first',
  withDeviceEnv(async () => {
    const { service, patches } = gpuWorkload();
    await service.updateDeploymentImage('web', 'project', 'example/web:v2');
    assert.equal(patches[0].spec.strategy.type, 'Recreate');
  })
);

test(
  'a redeploy fails and names a device the instance stopped offering',
  withDeviceEnv(async () => {
    process.env.DEVICE_CLASSES = JSON.stringify([{ resource: 'squat.ai/dri' }]);
    const { service, patches } = gpuWorkload();
    await assert.rejects(
      service.updateDeploymentImage('web', 'project', 'example/web:v2'),
      (e: any) => /nvidia\.com\/gpu .*no longer offers it/.test(JSON.stringify(e.getResponse()))
    );
    assert.equal(patches.length, 0);
  })
);

test(
  'attaching a device switches the live object to Recreate',
  withDeviceEnv(async () => {
    const { service, patches } = gpuWorkload();
    await service.updateDeploymentDevices('web', 'project', { 'nvidia.com/gpu': 1 });
    assert.equal(patches[0].spec.strategy.type, 'Recreate');
    patches.length = 0;
    await service.updateDeploymentDevices('web', 'project', {});
    assert.equal(patches[0].spec.strategy, undefined);
  })
);

test(
  'a new app with a device is created with Recreate',
  withDeviceEnv(async () => {
    const created: any[] = [];
    const api = new Proxy(
      {},
      {
        get:
          (_t, method: string) =>
          async (...args: any[]) => {
            if (method === 'createNamespacedDeployment') created.push(args[1]);
            if (method === 'readNamespacedService') return { body: { spec: { ports: [] } } };
            return { body: {} };
          }
      }
    );
    const service = Object.create(K8sWorkloadService.prototype) as any;
    service.kubernetes = { kc: { makeApiClient: () => api }, ensureKubeConfig: () => undefined };
    service.upsertEnvSecret = async () => undefined;
    await service.createDeployment({
      namespace: 'project',
      name: 'web',
      image: 'example/web:v1',
      ports: [{ name: 'http', containerPort: 8080, servicePort: 80, protocol: 'TCP' }],
      devices: { 'nvidia.com/gpu': 1 }
    });
    assert.equal(created[0].spec.strategy.type, 'Recreate');
    assert.equal(created[0].spec.template.spec.runtimeClassName, 'nvidia');
  })
);

function deploymentsService(row: Record<string, unknown>) {
  const updates: any[] = [];
  const service = Object.create(DeploymentsService.prototype) as any;
  service.prisma = {
    deployment: {
      findUnique: async () => ({ volumes: [], ...row }),
      update: async (args: any) => {
        updates.push(args.data);
        return { ...row, ...args.data };
      }
    },
    project: { findUnique: async () => null }
  };
  service.authz = { requireProjectEdit: async () => undefined };
  service.audit = { log: async () => undefined };
  service.k8sWorkload = {
    getKubernetesDeployment: async () => ({}),
    updateDeploymentDevices: async () => undefined,
    updateDeploymentStrategy: async () => undefined
  };
  return { service, updates };
}

const ROW = { id: 'd1', name: 'web', namespace: 'project', projectId: 'p1' };

test(
  'attaching a device pins the stored strategy to Recreate',
  withDeviceEnv(async () => {
    const { service, updates } = deploymentsService({
      ...ROW,
      deployStrategy: 'blueGreen',
      devices: {}
    });
    await service.updateDeploymentDevices('d1', { 'nvidia.com/gpu': 1 }, 'u1');
    assert.deepEqual(updates[0], { devices: { 'nvidia.com/gpu': 1 }, deployStrategy: 'recreate' });
  })
);

test(
  'an app with a device cannot switch to rolling or blue/green updates',
  withDeviceEnv(async () => {
    const { service, updates } = deploymentsService({
      ...ROW,
      deployStrategy: 'recreate',
      devices: { 'nvidia.com/gpu': 1 }
    });
    for (const strategy of ['rollingUpdate', 'blueGreen']) {
      await assert.rejects(service.updateDeploymentStrategy('d1', strategy, 'u1'), /device/);
    }
    await service.updateDeploymentStrategy('d1', 'recreate', 'u1');
    assert.deepEqual(updates, [{ deployStrategy: 'recreate' }]);
  })
);

test('the devices route needs an explicit devices key, and only null detaches everything', async () => {
  const calls: unknown[] = [];
  const controller = Object.create(DeploymentsController.prototype) as any;
  controller.projectAccess = {
    assertDeploymentView: async () => ({ user: { id: 'u1' }, access: { canEdit: true } })
  };
  controller.deployments = {
    updateDeploymentDevices: async (_id: string, devices: unknown) => {
      calls.push(devices);
      return {};
    }
  };
  const req = { user: { sub: 'u1' } };
  for (const body of [{}, undefined, { device: { 'nvidia.com/gpu': 1 } }]) {
    await assert.rejects(controller.updateDeploymentDevices('d1', body, req), /Send devices/);
  }
  await controller.updateDeploymentDevices('d1', { devices: null }, req);
  assert.deepEqual(calls, [null]);
});

test(
  'a redeploy whose live read fails leaves the runtime class alone',
  withDeviceEnv(async () => {
    const previous = process.env.TENANT_RUNTIME_CLASS;
    process.env.TENANT_RUNTIME_CLASS = 'gvisor';
    try {
      const { service, patches } = gpuWorkload();
      service.kubernetes.kc.makeApiClient().readNamespacedDeployment = async () => {
        throw new Error('connection reset');
      };
      await service.updateDeploymentImage('web', 'project', 'example/web:v2');
      assert.equal('runtimeClassName' in patches[0].spec.template.spec, false);
    } finally {
      if (previous === undefined) delete process.env.TENANT_RUNTIME_CLASS;
      else process.env.TENANT_RUNTIME_CLASS = previous;
    }
  })
);

test(
  'the devices route accepts a stale device the app already has',
  withDeviceEnv(async () => {
    const { service, updates } = deploymentsService({
      ...ROW,
      deployStrategy: 'recreate',
      devices: { 'amd.com/gpu': 1 }
    });
    await service.updateDeploymentDevices('d1', { 'amd.com/gpu': 1, 'nvidia.com/gpu': 1 }, 'u1');
    assert.deepEqual(updates[0], { devices: { 'amd.com/gpu': 1, 'nvidia.com/gpu': 1 } });
    await service.updateDeploymentDevices('d1', { 'amd.com/gpu': 0 }, 'u1');
    assert.deepEqual(updates[1], { devices: {} });
  })
);

test('a max that is not a whole number of at least 1 is reported by entry', () => {
  const warned: string[] = [];
  const parsed = parseDeviceClasses(
    JSON.stringify([
      { resource: 'a.example/zero', max: 0 },
      { resource: 'b.example/neg', max: -3 },
      { resource: 'c.example/word', max: 'abc' },
      { resource: 'd.example/half', max: 1.5 },
      { resource: 'e.example/text', max: '2' },
      { resource: 'f.example/plain' }
    ]),
    (m) => warned.push(m)
  );
  assert.deepEqual(
    parsed.map((c) => [c.resource, c.max]),
    [
      ['a.example/zero', 1],
      ['b.example/neg', 1],
      ['c.example/word', 1],
      ['d.example/half', 1],
      ['e.example/text', 2],
      ['f.example/plain', 1]
    ]
  );
  assert.equal(warned.length, 4);
  assert.match(warned[0], /"a.example\/zero".*max 0,/);
  assert.match(warned[1], /"b.example\/neg".*max -3,/);
  assert.match(warned[2], /"c.example\/word".*max "abc",/);
  assert.match(warned[3], /"d.example\/half".*max 1.5,/);
});

test('an app keeps a count above a lowered max while another device changes', () => {
  const lowered = parseDeviceClasses(
    JSON.stringify([
      { resource: 'nvidia.com/gpu', max: 1 },
      { resource: 'squat.ai/dri', max: 1 }
    ])
  );
  assert.deepEqual(
    validateDeviceRequest({ 'nvidia.com/gpu': 2, 'squat.ai/dri': 1 }, lowered, {
      'nvidia.com/gpu': 2
    }),
    { 'nvidia.com/gpu': 2, 'squat.ai/dri': 1 }
  );
  assert.throws(
    () => validateDeviceRequest({ 'nvidia.com/gpu': 2 }, lowered, { 'nvidia.com/gpu': 1 }),
    /from 0 to 1/
  );
  assert.throws(
    () => validateDeviceRequest({ 'nvidia.com/gpu': 3 }, lowered, { 'nvidia.com/gpu': 2 }),
    /from 0 to 1/
  );
  assert.deepEqual(
    validateDeviceRequest({ 'nvidia.com/gpu': 1 }, lowered, { 'nvidia.com/gpu': 2 }),
    { 'nvidia.com/gpu': 1 }
  );
});

function adoptingConsumer(row: Record<string, unknown>) {
  const updates: any[] = [];
  const consumer = Object.create(WorkloadConsumer.prototype) as any;
  consumer.prisma = {
    deployment: {
      findUnique: async () => ({
        replicas: 1,
        stopped: false,
        image: 'example/web:v1',
        cpuRequestMilli: null,
        memoryRequestBytes: null,
        deployStrategy: 'recreate',
        imagePullPolicy: null,
        buildStatus: 'succeeded',
        envObservedHash: null,
        ...row
      }),
      update: async (args: any) => {
        updates.push(args.data);
      }
    },
    k8sApplyItem: { count: async () => 0 }
  };
  consumer.adoptEnv = async () => undefined;
  consumer.logger = { log: () => undefined, warn: () => undefined };
  return { consumer, updates };
}

const GPU_ROW = { name: 'web', devices: { 'nvidia.com/gpu': 1 } };

test('adoption never wipes stored devices when the app container is missing', async () => {
  const { consumer, updates } = adoptingConsumer(GPU_ROW);
  await consumer.adoptWorkloadSpec('d1', {
    spec: { replicas: 1, template: { spec: { containers: [] } } }
  });
  await consumer.adoptWorkloadSpec('d1', {
    spec: { replicas: 1, template: { spec: {} } }
  });
  await consumer.adoptWorkloadSpec('d1', {
    spec: {
      replicas: 1,
      template: { spec: { containers: [{ name: 'other', image: 'example/web:v1' }] } }
    }
  });
  assert.deepEqual(updates, []);
});

test('adoption reads devices from the app container even when it is not first', async () => {
  const { consumer, updates } = adoptingConsumer(GPU_ROW);
  await consumer.adoptWorkloadSpec('d1', {
    spec: {
      replicas: 1,
      template: {
        spec: {
          containers: [
            { name: 'sidecar', image: 'example/web:v1' },
            {
              name: 'web',
              image: 'example/web:v1',
              resources: { limits: { 'nvidia.com/gpu': '1' } }
            }
          ]
        }
      }
    }
  });
  assert.deepEqual(updates, []);

  await consumer.adoptWorkloadSpec('d1', {
    spec: {
      replicas: 1,
      template: {
        spec: {
          containers: [
            { name: 'sidecar', image: 'example/web:v1' },
            {
              name: 'web',
              image: 'example/web:v1',
              resources: { limits: { 'nvidia.com/gpu': '2' } }
            }
          ]
        }
      }
    }
  });
  assert.deepEqual(updates, [{ devices: { 'nvidia.com/gpu': 2 } }]);
});

test('devices that need different runtimes are refused together', () => {
  const classes = [
    { resource: 'nvidia.com/gpu', label: 'GPU', runtimeClassName: 'nvidia', max: 1 },
    { resource: 'squat.ai/dri', label: 'DRI', max: 1 }
  ];
  assert.throws(
    () => validateDeviceRequest({ 'nvidia.com/gpu': 1, 'squat.ai/dri': 1 }, classes),
    /different runtimes/
  );
  assert.deepEqual(validateDeviceRequest({ 'nvidia.com/gpu': 1, 'squat.ai/dri': 0 }, classes), {
    'nvidia.com/gpu': 1
  });
});
