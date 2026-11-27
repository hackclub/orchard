import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { K8sNetworkService } from '../src/kubernetes/k8s-network.service';
import { KubernetesService } from '../src/kubernetes/kubernetes.service';
import { snapshotPublicPortState } from '../src/kubernetes/port-utils';

type Call = { method: string; args: any[] };

function network(calls: Call[]) {
  const kube: any = new (KubernetesService as any)({});
  kube.kc = {
    makeApiClient() {
      return new Proxy(
        {},
        {
          get(_t, method: string) {
            return async (...args: any[]) => {
              calls.push({ method, args });
              if (method.startsWith('read')) {
                const e: any = new Error('nf');
                e.response = { statusCode: 404 };
                throw e;
              }
              return { body: { items: [] } };
            };
          }
        }
      );
    },
    getCurrentCluster() {
      return { server: 'https://x' };
    }
  };
  return new (K8sNetworkService as any)({}, kube, { onAcquired() {} }) as K8sNetworkService;
}

async function exposedPolicy(preserveClientIp?: boolean) {
  const calls: Call[] = [];
  await network(calls).exposeDeploymentPortPublic({
    namespace: 'ns',
    deploymentName: 'mail',
    loadBalancerIp: '203.0.113.7',
    publicPort: 30025,
    targetPort: 25,
    protocol: 'TCP',
    preserveClientIp
  });
  const created = calls.find((c) => c.method === 'createNamespacedService');
  assert.ok(created, 'the public Service is created');
  return created.args[1].spec.externalTrafficPolicy;
}

test('a public port keeps the Cluster traffic policy by default', async () => {
  assert.equal(await exposedPolicy(), 'Cluster');
  assert.equal(await exposedPolicy(false), 'Cluster');
});

test('a public port that keeps client addresses uses the Local traffic policy', async () => {
  assert.equal(await exposedPolicy(true), 'Local');
});

test('rewriting ports carries the client address setting forward', () => {
  const snapshot = snapshotPublicPortState([
    { port: 25, protocol: 'TCP', publicEnabled: true, publicPort: 30025, preserveClientIp: true },
    { port: 80, protocol: 'TCP', publicEnabled: true, publicPort: 30080, preserveClientIp: false },
    { port: 993, protocol: 'TCP', publicEnabled: true, publicPort: 30993 },
    { port: 465, protocol: 'TCP', publicEnabled: false, publicPort: null, preserveClientIp: true }
  ]);
  assert.equal(snapshot.get('25:TCP')?.preserveClientIp, true);
  assert.equal(snapshot.get('80:TCP')?.preserveClientIp, false);
  assert.equal(snapshot.get('993:TCP')?.preserveClientIp, false);
  assert.equal(snapshot.has('465:TCP'), false);
});
