import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  loginServerArgs,
  loginServerHost,
  loginServerPort,
  normalizeLoginServer
} from '../src/kubernetes/tailscale-login-server';
import { TailscaleService } from '../src/tailscale/tailscale.service';

test('an empty login server means the Tailscale control plane', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.equal(normalizeLoginServer(value), null);
  }
});

test('a login server is stored as its origin', () => {
  assert.equal(
    normalizeLoginServer('  https://Headscale.Example.com/  '),
    'https://headscale.example.com'
  );
  assert.equal(
    normalizeLoginServer('https://headscale.example.com:443'),
    'https://headscale.example.com'
  );
  assert.equal(
    normalizeLoginServer('https://headscale.example.com:8443'),
    'https://headscale.example.com:8443'
  );
  assert.equal(normalizeLoginServer('http://hs.example.com'), 'http://hs.example.com');
});

test('a login server that is not a bare http(s) base URL is rejected', () => {
  for (const value of [
    'headscale.example.com',
    'ftp://headscale.example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://user:pass@headscale.example.com',
    'https://headscale.example.com/admin',
    'https://headscale.example.com/?next=1',
    'https://headscale.example.com/#x',
    'https://',
    'https://headscale.example.com:0',
    'https://headscale.example.com:70000',
    `https://${'a'.repeat(260)}.example.com`,
    42,
    { url: 'https://headscale.example.com' }
  ]) {
    assert.throws(() => normalizeLoginServer(value), BadRequestException, String(value));
  }
});

test('a stored login server can never smuggle a second tailscale up flag', () => {
  for (const value of [
    'https://headscale.example.com --advertise-exit-node',
    'https://headscale.example.com\t--ssh',
    'https://headscale.example.com\n--accept-routes'
  ]) {
    let stored: string | null = null;
    try {
      stored = normalizeLoginServer(value);
    } catch (error) {
      assert.ok(error instanceof BadRequestException, value);
      continue;
    }
    assert.ok(stored);
    assert.equal(loginServerArgs(stored).split(/\s+/).length, 1, value);
  }
});

test('the login server port follows the scheme unless it is explicit', () => {
  assert.equal(loginServerPort('https://headscale.example.com'), 443);
  assert.equal(loginServerPort('http://headscale.example.com'), 80);
  assert.equal(loginServerPort('https://headscale.example.com:8443'), 8443);
  assert.equal(loginServerHost('https://headscale.example.com:8443'), 'headscale.example.com:8443');
});

function service() {
  const writes: any[] = [];
  const sidecars: any[][] = [];
  let row: any = null;
  const prisma = {
    tailscaleConnection: {
      upsert: async (args: any) => {
        writes.push(args);
        row = { ...args.create };
        return row;
      },
      findUnique: async () => row
    },
    deployment: {
      findUnique: async () => ({
        id: 'd1',
        name: 'app',
        namespace: 'ns',
        tailscaleExposed: false,
        services: [{ port: 80, targetPort: 8080, protocol: 'TCP' }]
      }),
      update: async () => ({})
    }
  };
  const k8sWorkload = {
    addTailscaleSidecar: async (...args: any[]) => {
      sidecars.push(args);
    }
  };
  const crypto = { seal: (v: string) => `sealed:${v}`, open: (v: string) => v.slice(7) };
  const svc = new (TailscaleService as any)(prisma, {}, k8sWorkload, crypto);
  return { svc: svc as TailscaleService, writes, sidecars };
}

test('linking without a login server still requires a Tailscale auth key', async () => {
  const { svc, writes } = service();
  await assert.rejects(() => svc.linkAccount('u1', 'deadbeef'), BadRequestException);
  assert.equal(writes.length, 0);

  const linked = await svc.linkAccount('u1', 'tskey-auth-kABCDEF1CNTRL-secretsecret');
  assert.equal(linked.loginServer, null);
  assert.equal(writes[0].create.loginServer, null);
  assert.equal(writes[0].update.loginServer, null);
});

test('linking with a login server accepts its key and never echoes it', async () => {
  const { svc, writes } = service();
  const key = '0123456789abcdef0123456789abcdef0123456789abcdef';
  const linked = await svc.linkAccount('u1', key, 'https://headscale.example.com/');

  assert.deepEqual(linked, {
    tailnet: 'headscale.example.com',
    loginServer: 'https://headscale.example.com'
  });
  assert.equal(writes[0].create.accessToken, `sealed:${key}`);
  assert.equal(writes[0].create.loginServer, 'https://headscale.example.com');
  assert.equal(writes[0].update.loginServer, 'https://headscale.example.com');
  assert.ok(!JSON.stringify(linked).includes(key.slice(0, 8)));

  const status = await svc.getStatus('u1');
  assert.ok(!JSON.stringify(status).includes(key.slice(0, 8)));
  assert.equal(status.loginServer, 'https://headscale.example.com');
});

test('a bad login server is rejected before anything is stored', async () => {
  const { svc, writes } = service();
  await assert.rejects(
    () => svc.linkAccount('u1', 'deadbeef', 'https://headscale.example.com/path'),
    BadRequestException
  );
  assert.equal(writes.length, 0);
});

test('exposing an app hands the linked login server to the proxy', async () => {
  const { svc, sidecars } = service();
  await svc.linkAccount('u1', 'deadbeef', 'https://headscale.example.com:8443');
  await svc.exposeDeployment('d1', 'u1');
  assert.equal(sidecars.length, 1);
  assert.equal(sidecars[0][2], 'deadbeef');
  assert.equal(sidecars[0][5], 'https://headscale.example.com:8443');
});
