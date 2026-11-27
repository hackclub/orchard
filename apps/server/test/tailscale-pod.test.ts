import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { K8sWorkloadService } from '../src/kubernetes/k8s-workload.service';
import { KubernetesService } from '../src/kubernetes/kubernetes.service';

type Call = { method: string; args: any[] };

function fakeKc(calls: Call[]) {
  return {
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
              return { body: { items: [], status: {}, spec: {}, metadata: {} } };
            };
          }
        }
      );
    },
    getCurrentCluster() {
      return { server: 'https://x' };
    }
  } as any;
}

async function proxyObjects(env: Record<string, string | undefined>, loginServer?: string) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const calls: Call[] = [];
    const kube: any = new (KubernetesService as any)({});
    kube.kc = fakeKc(calls);
    const svc = new (K8sWorkloadService as any)({}, kube, {}, {});
    await svc.addTailscaleSidecar(
      'ns',
      'app',
      'tskey-auth-X',
      'host',
      [{ port: 80, targetPort: 8080, protocol: 'TCP' }],
      loginServer
    );
    const deployment = calls.find((c) => c.method === 'createNamespacedDeployment')!.args[1];
    const netpol = calls.find((c) => c.method === 'createNamespacedNetworkPolicy')!.args[1];
    return { pod: deployment.spec.template.spec, netpol };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('the tailscale proxy pod runs sandboxed with every capability dropped', async () => {
  const { pod } = await proxyObjects({
    TENANT_RUNTIME_CLASS: 'gvisor',
    TAILSCALE_IMAGE: undefined
  });
  assert.equal(pod.runtimeClassName, 'gvisor');
  const sc = pod.containers[0].securityContext;
  assert.deepEqual(sc.capabilities, { drop: ['ALL'] });
  assert.equal(sc.allowPrivilegeEscalation, false);
  assert.equal(sc.runAsNonRoot, true);
  assert.equal(sc.seccompProfile.type, 'RuntimeDefault');
});

test('the tailscale image is configurable', async () => {
  const { pod } = await proxyObjects({
    TENANT_RUNTIME_CLASS: undefined,
    TAILSCALE_IMAGE: 'ghcr.io/tailscale/tailscale@sha256:abc'
  });
  assert.equal(pod.containers[0].image, 'ghcr.io/tailscale/tailscale@sha256:abc');
  assert.equal(pod.runtimeClassName, undefined);
});

test('the tailscale egress rule excludes link-local and CGNAT space', async () => {
  const { netpol } = await proxyObjects({ TENANT_RUNTIME_CLASS: undefined });
  const blocks = netpol.spec.egress
    .flatMap((r: any) => r.to ?? [])
    .filter((p: any) => p.ipBlock?.cidr === '0.0.0.0/0');
  assert.equal(blocks.length, 1);
  for (const cidr of ['169.254.0.0/16', '100.64.0.0/10', '10.0.0.0/8']) {
    assert.ok(blocks[0].ipBlock.except.includes(cidr), cidr);
  }
});

function externalTcpPorts(netpol: any): number[] {
  return netpol.spec.egress
    .filter((r: any) => (r.to ?? []).some((p: any) => p.ipBlock?.cidr === '0.0.0.0/0'))
    .flatMap((r: any) => r.ports)
    .filter((p: any) => p.protocol === 'TCP')
    .map((p: any) => p.port);
}

function extraArgs(pod: any): string | undefined {
  return pod.containers[0].env.find((e: any) => e.name === 'TS_EXTRA_ARGS')?.value;
}

test('the proxy uses the Tailscale control plane unless a login server is set', async () => {
  const { pod, netpol } = await proxyObjects({ TENANT_EGRESS_BLOCK_PORTS: undefined });
  assert.equal(extraArgs(pod), undefined);
  assert.deepEqual(externalTcpPorts(netpol), [443]);
});

test('a login server reaches the proxy as a tailscale up flag', async () => {
  const { pod, netpol } = await proxyObjects(
    { TENANT_EGRESS_BLOCK_PORTS: undefined },
    'https://headscale.example.com'
  );
  assert.equal(extraArgs(pod), '--login-server=https://headscale.example.com');
  assert.deepEqual(externalTcpPorts(netpol), [443]);
});

test('a login server on its own port opens that port to the public internet only', async () => {
  const { netpol } = await proxyObjects(
    { TENANT_EGRESS_BLOCK_PORTS: undefined },
    'https://headscale.example.com:8443'
  );
  assert.deepEqual(externalTcpPorts(netpol), [443, 8443]);
  const blocks = netpol.spec.egress
    .flatMap((r: any) => r.to ?? [])
    .filter((p: any) => p.ipBlock?.cidr === '0.0.0.0/0');
  assert.equal(blocks.length, 1);
  assert.ok(blocks[0].ipBlock.except.includes('10.0.0.0/8'));
});

test('a login server over plain http opens port 80', async () => {
  const { netpol } = await proxyObjects(
    { TENANT_EGRESS_BLOCK_PORTS: undefined },
    'http://headscale.example.com'
  );
  assert.deepEqual(externalTcpPorts(netpol), [443, 80]);
});

test('a login server cannot reopen a port the operator blocked', async () => {
  const { netpol } = await proxyObjects(
    { TENANT_EGRESS_BLOCK_PORTS: '25,8443' },
    'https://headscale.example.com:8443'
  );
  assert.deepEqual(externalTcpPorts(netpol), [443]);
});
