import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { IngressService } from '../src/projects/ingress.service';
import { ProtectionService, pathIsAmbiguous } from '../src/auth/protection.service';
import { parseRepoUrl } from '../src/docker/repo-url';
import { GitHubService } from '../src/github/github.service';
import { GitHubController } from '../src/github/github.controller';
import { isValidPodName } from '../src/kubernetes/pod-name';
import {
  deniedToApiToken,
  deniedToOrgScopedSession,
  deniedToOrgSsoSession,
  deniedToProjectToken,
  isPublicCredentialPost
} from '../src/auth/superadmin.guard';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { firstValueFrom, timeout } from 'rxjs';
import { SseStreamLimiter } from '../src/events/sse-stream-limiter';
import { SsoLoginService } from '../src/sso/sso-login.service';
import {
  MCP_ORG_DEVICE,
  deviceLabel,
  deviceOrgScope,
  isScopedDevice,
  orgScopedDevice,
  plainDeviceName
} from '../src/auth/org-scoped-devices';
import { AuthDoorV1 } from '../src/grafts/doors/auth.door';
import { scopeFromClaim } from '../src/mcp/mcp-scopes';
import { jwtVerify } from 'jose';
import { tenantDenyPolicy } from '../src/kubernetes/security-policies';
import { assertIngressNameFree } from '../src/projects/image-ownership';
import { ApiThrottlerGuard } from '../src/auth/api-throttler.guard';
import { traefikSelector } from '../src/metrics/ingress/traefik';
import { haproxySelector } from '../src/metrics/ingress/haproxy';
import {
  assertImageOwnedByProject,
  assertRepoNameFree,
  newImageTag,
  splitRegistryCleanup
} from '../src/projects/image-ownership';
import {
  databaseClusterName,
  platformWildcardDomains,
  truncateKeepingSuffix
} from '../src/projects/projects.utils';
import { domainProofRecordName, domainProofToken } from '../src/projects/domain-proof';
import { versionLabel } from '../src/observability/changes';
import { ProjectAccessService } from '../src/projects/project-access.service';
import { DatabaseTrashService } from '../src/projects/database-trash.service';
import { buildSafeEnv, builderContainerEnv } from '../src/env/reserved-env';
import { ImageBuilderService, dockerfileDirGuard } from '../src/docker/image-builder.service';
import { sanitizeBuildLogMessage } from '../src/docker/build-log-redaction';
import { stripOperationSecrets } from '../src/projects/strip-operation-secrets.interceptor';

test('pod names cannot carry a path', () => {
  assert.equal(isValidPodName('web-7d4b9c-x2x'), true);
  for (const name of ['../../orchard/pods/db-1', 'a/b', '..', '', 'A', '%2e%2e', undefined]) {
    assert.equal(isValidPodName(name), false, String(name));
  }
});

test('org-scoped sessions cannot reach account credentials', () => {
  for (const [method, path] of [
    ['POST', '/apiv1/auth/mcp-token'],
    ['POST', '/apiv1/auth/tokens'],
    ['POST', '/apiv1/auth/password/set'],
    ['POST', '/apiv1/auth/passkey/register/options'],
    ['POST', '/apiv1/auth/sessions/revoke-all'],
    ['POST', '/apiv1/ssh-identities'],
    ['GET', '/apiv1/github/repositories'],
    ['GET', '/apiv1/github/repositories/o/r/contents'],
    ['GET', '/apiv1/github/status'],
    ['GET', '/apiv1/github/app/installations']
  ]) {
    assert.equal(deniedToOrgScopedSession(method, path), true, path);
  }
  assert.equal(deniedToOrgScopedSession('GET', '/apiv1/auth/me'), false);
  assert.equal(deniedToOrgScopedSession('POST', '/apiv1/auth/logout'), false);
  assert.equal(deniedToOrgScopedSession('GET', '/apiv1/projects'), false);
});

test('an org SSO session may mint what carries its org, and nothing else', () => {
  for (const path of [
    '/apiv1/auth/tokens',
    '/apiv1/auth/mcp-token',
    '/apiv1/auth/protect/exchange/orchard'
  ]) {
    assert.equal(deniedToOrgSsoSession('POST', path), false, path);
    assert.equal(deniedToOrgScopedSession('POST', path), true, path);
  }
  for (const [method, path] of [
    ['GET', '/apiv1/auth/tokens'],
    ['PATCH', '/apiv1/auth/tokens/1'],
    ['DELETE', '/apiv1/auth/tokens/1']
  ]) {
    assert.equal(deniedToOrgSsoSession(method, path), false, path);
    assert.equal(deniedToOrgScopedSession(method, path), true, path);
  }
  for (const [method, path] of [
    ['POST', '/apiv1/auth/tokens/1'],
    ['DELETE', '/apiv1/auth/tokens/1/x'],
    ['DELETE', '/apiv1/auth/sessions/1'],
    ['POST', '/apiv1/auth/passkey/register'],
    ['POST', '/apiv1/ssh-identities'],
    ['GET', '/apiv1/admin/users']
  ]) {
    assert.equal(deniedToOrgSsoSession(method, path), true, path);
  }
});

test('a personal device token is not tied to an org but is still kept off account routes', () => {
  const personal = orgScopedDevice(MCP_ORG_DEVICE, null, 'x');
  assert.equal(deviceOrgScope(personal), undefined);
  assert.equal(isScopedDevice(personal), true);
  assert.equal(isScopedDevice(plainDeviceName(personal)), false);
  assert.equal(isScopedDevice('Chrome on macOS'), false);
  assert.equal(deniedToOrgScopedSession('POST', '/apiv1/ssh-identities'), true);
});

test('device tokens minted for grafts carry the deploy scope, not exec', async () => {
  const prev = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'x'.repeat(48);
  try {
    const door = Object.create(AuthDoorV1.prototype);
    Object.assign(door, {
      graft: { id: 'greenhouse', claims: {} },
      prisma: {
        user: {
          findUnique: async () => ({ email: 'a@x.dev', username: 'a', externalAuthId: null })
        },
        session: { findFirst: async () => null, create: async () => ({ id: 'sess-1' }) }
      }
    });
    const token = await door.mintDeviceToken({
      userId: 'u1',
      deviceName: 'greenhouse.machine:personal:s1',
      ttlDays: 1
    });
    const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET));
    assert.equal(payload.type, 'mcp');
    assert.equal(scopeFromClaim(payload.scope), 'deploy');
  } finally {
    process.env.JWT_SECRET = prev;
  }
});

test('an MCP client name cannot claim an org scope', () => {
  const org = '11111111-1111-4111-8111-111111111111';
  const spoof = plainDeviceName(`${MCP_ORG_DEVICE}:${org}:x`);
  assert.equal(deviceOrgScope(`${MCP_ORG_DEVICE}:${org}:x`), org);
  assert.equal(deviceOrgScope(spoof), undefined);
  const scoped = orgScopedDevice(MCP_ORG_DEVICE, org, plainDeviceName('Claude: Code'));
  assert.equal(deviceOrgScope(scoped), org);
  assert.equal(deviceLabel(scoped), 'Claude  Code');
  assert.equal(deviceLabel('Chrome on macOS'), 'Chrome on macOS');
});

test('starting SSO from a Hack Club session links the local user, not the Hack Club id', async () => {
  const login = Object.create(SsoLoginService.prototype) as any;
  const users: Record<string, { id: string } | null> = {
    'hc-1': { id: 'local-1' },
    'moved@example.com': { id: 'local-2' }
  };
  login.prisma = {
    user: {
      findUnique: async ({ where }: any) =>
        users[where.externalAuthId ?? where.email ?? where.emailScope_email?.email] ?? null
    }
  };
  login.sessionsService = { validateSession: async () => true };
  let payload: Record<string, unknown> = {};
  login.oauthService = { verifySessionToken: async () => payload };

  payload = { sub: 'hc-1', externalAuthId: 'hc-1', email: 'a@example.com', sessionId: 's' };
  assert.deepEqual(await login.signedInUser('t'), { userId: 'local-1', sessionId: 's' });
  payload = { sub: 'hc-2', externalAuthId: 'hc-2', email: 'moved@example.com', sessionId: 's' };
  assert.deepEqual(await login.signedInUser('t'), { userId: 'local-2', sessionId: 's' });
  payload = { sub: 'hc-3', externalAuthId: 'hc-3', email: 'nobody@example.com', sessionId: 's' };
  assert.equal(await login.signedInUser('t'), undefined);
  payload = { sub: 'local-3', email: 'b@example.com', sessionId: 's' };
  assert.deepEqual(await login.signedInUser('t'), { userId: 'local-3', sessionId: 's' });
  payload = { sub: 'hc-1', externalAuthId: 'hc-1', orgScope: 'o', sessionId: 's' };
  assert.equal(await login.signedInUser('t'), undefined);
});

function ownership(others: string[] = [], builtElsewhere: string[] = []) {
  return {
    project: { findMany: async () => others.map((namespace) => ({ namespace })) },
    environment: { findMany: async () => [] },
    deployment: {
      findFirst: async ({ where }: any) =>
        builtElsewhere.some((repo) => where.OR.some((c: any) => c.image.contains === `/${repo}:`))
          ? { id: 'other' }
          : null
    }
  } as any;
}

test('platform images belong to the project whose namespace built them', async () => {
  process.env.DOCKER_REGISTRY_PULL = 'registry.example';
  const mine = { id: 'p1', namespace: 'acme-a' };
  await assertImageOwnedByProject(ownership(), 'registry.example/orchard/acme-a-web:v1', mine);
  await assertImageOwnedByProject(ownership(), 'docker.io/library/redis:7', mine);
  for (const image of [
    'registry.example/orchard/other-web:v1',
    'registry.example:443/orchard/other-web:v1'
  ]) {
    await assert.rejects(
      () => assertImageOwnedByProject(ownership(), image, mine),
      ForbiddenException
    );
  }
  await assert.rejects(
    () =>
      assertImageOwnedByProject(
        ownership(['acme-a-b']),
        'registry.example/orchard/acme-a-b-web:v1',
        mine
      ),
    ForbiddenException
  );
});

test('a repo another project built stays theirs, whichever namespace is longer', async () => {
  process.env.DOCKER_REGISTRY_PULL = 'registry.example';
  const longer = { id: 'p2', namespace: 'acme-web-api' };
  const image = 'registry.example/orchard/acme-web-api-server:v1';
  await assert.rejects(
    () => assertImageOwnedByProject(ownership([], ['acme-web-api-server']), image, longer),
    ForbiddenException
  );
  await assertImageOwnedByProject(ownership(), image, longer);
});

test('other registry paths to the platform login are refused', async () => {
  process.env.DOCKER_REGISTRY_PULL = 'registry.example';
  const mine = { id: 'p1', namespace: 'acme-a' };
  for (const image of [
    '127.0.0.1:5000/orchard/acme-a-web:v1',
    'localhost:5000/orchard/other-web:v1',
    '[::1]:5000/orchard/other-web:v1',
    'registry.example/secret-project/app:v1',
    'registry.example/orchard/acme-a-web/nested:v1'
  ]) {
    await assert.rejects(
      () => assertImageOwnedByProject(ownership(), image, mine),
      ForbiddenException,
      image
    );
  }
});

test('new image tags cannot be guessed from the build time', () => {
  const [a, b] = [newImageTag(), newImageTag()];
  assert.match(a, /^v\d{8}T\d{5}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
  assert.equal(versionLabel({ tag: a, commitSha: 'abcdef123' }), 'abcdef1');
});

test('an app name is refused when its image repo splits into another project', async () => {
  let where: any;
  const prisma = {
    deployment: {
      findFirst: async (args: any) => {
        where = args.where;
        return { id: 'taken' };
      }
    }
  } as any;
  await assert.rejects(() => assertRepoNameFree(prisma, 'acme-web', 'api-server', 'p1'));
  assert.deepEqual(where.projectId, { not: 'p1' });
  assert.ok(
    where.OR.some((c: any) => c.name === 'server' && c.project?.namespace === 'acme-web-api')
  );
  assert.ok(where.OR.some((c: any) => c.image?.contains === '/acme-web-api-server:'));
});

test('env vars that steer the builder never reach a build', () => {
  for (const key of [
    'BUILDKITD',
    'BUILDCTL',
    'ROOTLESSKIT',
    'BUILDKIT_HOST',
    'HTTP_PROXY',
    'https_proxy',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'LD_AUDIT'
  ]) {
    assert.equal(buildSafeEnv({ [key]: 'x' })[key], undefined, key);
    assert.deepEqual(builderContainerEnv({ [key]: 'x' }, 's'), [], key);
  }
  assert.deepEqual(buildSafeEnv({ NODE_ENV: 'production', API_URL: 'x' }), {
    NODE_ENV: 'production',
    API_URL: 'x'
  });
});

test('a Dockerfile directory must really be inside the workspace', () => {
  assert.equal(dockerfileDirGuard('Dockerfile'), '');
  assert.equal(dockerfileDirGuard(undefined), '');
  const guard = dockerfileDirGuard('docker/app/Dockerfile');
  assert.match(guard, /cd 'docker\/app' && pwd -P/);
  assert.match(guard, /\/workspace\|\/workspace\/\*\) ;;/);
  assert.match(guard, /exit 1/);
});

test('credentials quoted from a JSON file are masked in build logs', () => {
  const out = sanitizeBuildLogMessage('{"auths":{"h":{"auth":"c2VjcmV0","password":"hunter2"}}}');
  assert.ok(!out.includes('c2VjcmV0'));
  assert.ok(!out.includes('hunter2'));
});

function hostAccess(found: { ingress?: boolean; org?: boolean; page?: boolean }) {
  const calls: any[] = [];
  const service = Object.create(ProjectAccessService.prototype) as any;
  service.instanceSettings = { isCustomDomainVerificationRequired: async () => false };
  service.prisma = {
    ingress: {
      findFirst: async (args: any) => {
        calls.push(args.where);
        return found.ingress ? { id: 'i' } : null;
      }
    },
    organization: { findUnique: async () => (found.org ? { id: 'o' } : null) },
    statusPage: { findUnique: async () => (found.page ? { id: 's' } : null) }
  };
  return { service, calls };
}

test('hostnames other parts of the platform serve cannot be claimed', async () => {
  process.env.BASE_DOMAIN = 'orchard.example';
  try {
    for (const taken of [{ org: true }, { page: true }, { ingress: true }]) {
      await assert.rejects(
        () => hostAccess(taken).service.assertHostnameAvailable('acme.orchard.example', 'p'),
        ConflictException
      );
    }
    await hostAccess({}).service.assertHostnameAvailable('acme.orchard.example', 'p');
  } finally {
    delete process.env.BASE_DOMAIN;
  }
});

test('hostname checks ignore case', async () => {
  const { service, calls } = hostAccess({});
  await service.assertHostnameAvailable('Foo.Example.COM', 'p');
  assert.deepEqual(calls[0].host, { equals: 'foo.example.com', mode: 'insensitive' });
});

function proofAccess(opts: { on?: boolean; txt?: string[]; held?: boolean; orgDomain?: boolean }) {
  const service = Object.create(ProjectAccessService.prototype) as any;
  service.instanceSettings = {
    isCustomDomainVerificationRequired: async () => opts.on ?? true
  };
  service.lookupProof = async () => opts.txt ?? [];
  let orgWhere: any;
  service.prisma = {
    ingress: {
      findFirst: async ({ where }: any) =>
        where.projectId === 'p' && opts.held ? { id: 'i' } : null
    },
    organization: { findUnique: async () => null },
    statusPage: { findUnique: async () => null },
    project: { findUnique: async () => ({ organizationId: 'org' }) },
    orgDomain: {
      findFirst: async ({ where }: any) => {
        orgWhere = where;
        return opts.orgDomain ? { id: 'd' } : null;
      }
    }
  };
  return { service, orgWhere: () => orgWhere };
}

test('with the setting off, any free domain can be added without proof', async () => {
  await proofAccess({ on: false }).service.assertHostnameAvailable('app.example.com', 'p');
});

test('with the setting on, a domain needs the TXT record for this project', async () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  try {
    const { service } = proofAccess({});
    const err: any = await service
      .assertHostnameAvailable('App.Example.com', 'p')
      .catch((e: any) => e);
    assert.ok(err instanceof BadRequestException);
    const body = err.getResponse();
    assert.equal(body.error, 'domain_proof_required');
    assert.equal(body.records[0].type, 'TXT');
    assert.equal(body.records[0].name, '_orchard-challenge.app');
    assert.match(body.message, /_orchard-challenge\.app\.example\.com/);
    const value = domainProofToken('p', 'app.example.com');
    assert.equal(body.records[0].value, value);
    await proofAccess({ txt: ['unrelated', value] }).service.assertHostnameAvailable(
      'app.example.com',
      'p'
    );
    await assert.rejects(() =>
      proofAccess({
        txt: [domainProofToken('other', 'app.example.com')]
      }).service.assertHostnameAvailable('app.example.com', 'p')
    );
  } finally {
    process.env.JWT_SECRET = previous;
  }
});

test('proof is skipped for hosts already held, verified org domains and generated URLs', async () => {
  await proofAccess({ held: true }).service.assertHostnameAvailable('app.example.com', 'p');
  const verified = proofAccess({ orgDomain: true });
  await verified.service.assertHostnameAvailable('a.b.example.com', 'p');
  assert.deepEqual(verified.orgWhere().domain.in, [
    'a.b.example.com',
    'b.example.com',
    'example.com'
  ]);
  const previous = process.env.PUBLIC_DEPLOYMENT_BASE_DOMAIN;
  process.env.PUBLIC_DEPLOYMENT_BASE_DOMAIN = 'apps.orchard.example';
  try {
    const hit = platformWildcardDomains()[0]?.suffix;
    if (hit) {
      await proofAccess({}).service.assertHostnameAvailable(`web-1${hit}`, 'p');
    }
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_DEPLOYMENT_BASE_DOMAIN;
    else process.env.PUBLIC_DEPLOYMENT_BASE_DOMAIN = previous;
  }
});

test('the TXT record name is relative to the zone', () => {
  assert.equal(domainProofRecordName('example.com'), '_orchard-challenge');
  assert.equal(domainProofRecordName('a.b.example.com'), '_orchard-challenge.a.b');
});

function trashHarness(live: boolean) {
  const updates: any[] = [];
  const purged: any[] = [];
  const service = Object.create(DatabaseTrashService.prototype) as any;
  service.logger = { log() {}, warn() {} };
  service.prisma = {
    database: { findFirst: async () => (live ? { id: 'live' } : null) },
    deletedDatabase: { update: async (args: any) => updates.push(args) },
    storageAccessKey: { deleteMany: async () => ({}) }
  };
  const dbs = {
    mintScopedR2: async () => null,
    purgeBackupObjects: async (args: any) => purged.push(args)
  };
  const row = {
    id: 't',
    name: 'foo',
    namespace: 'acme-a',
    clusterName: 'pg-foo',
    organizationId: 'o',
    project: { organization: {} }
  };
  return { run: () => service.purgeRow(dbs, row), updates, purged };
}

test('purging a deleted database spares a live one using the same backup path', async () => {
  const { run, updates, purged } = trashHarness(true);
  await run();
  assert.deepEqual(purged, []);
  assert.equal(updates.length, 1);
});

test('a deleted database with no successor still gets its backups purged', async () => {
  const { run, updates, purged } = trashHarness(false);
  await run();
  assert.equal(purged.length, 1);
  assert.equal(updates.length, 1);
});

test('app and port names are checked against other projects, in both shapes', async () => {
  let where: any;
  const prisma = {
    deployment: {
      findFirst: async (args: any) => {
        where = args.where;
        return null;
      }
    }
  } as any;
  await assertIngressNameFree(prisma, 'acme', 'labs-web', 'p1');
  const split = where.OR.find((c: any) => c.namespace === 'acme-labs');
  assert.deepEqual(split.OR, [{ name: 'web' }, { services: { some: { name: 'web' } } }]);
  await assert.rejects(
    () => assertIngressNameFree(prisma, 'acme-web-orchard', 'protection-proxy', 'p1'),
    ConflictException
  );
});

test('deleting an app keeps a repo another app still uses', async () => {
  const prisma = {
    deployment: {
      findFirst: async ({ where }: any) =>
        where.OR[0].image.contains === '/acme-shop-web:' ? { id: 'prod' } : null
    }
  } as any;
  const result = await splitRegistryCleanup(prisma, 'staging', [
    'r/orchard/acme-shop-web:v1',
    'r/orchard/acme-shop-api:v1'
  ]);
  assert.deepEqual(result.tags, ['r/orchard/acme-shop-web:v1']);
  assert.deepEqual(result.repositories, ['r/orchard/acme-shop-api:v1']);
});

test('only images Orchard built can be deleted from the registry', async () => {
  const builder = Object.create(ImageBuilderService.prototype) as any;
  Object.assign(builder, {
    harborRegistryPush: 'push.example',
    harborRegistryPull: 'pull.example',
    pusherRegistryHost: 'push.example',
    harborProject: 'orchard'
  });
  assert.equal(builder.parseImageRef('acme-web-api:latest'), null);
  assert.equal(builder.parseImageRef('orchard/acme-web-api:latest'), null);
  assert.equal(builder.parseImageRef('docker.io/orchard/acme-web-api:latest'), null);
  assert.equal(builder.parseImageRef('pull.example/other/acme-web-api:v1'), null);
  assert.deepEqual(builder.parseImageRef('pull.example/orchard/acme-web-api:v1'), {
    repoName: 'acme-web-api',
    tag: 'v1'
  });
});

test('long names keep what makes them different when they get cut', () => {
  const long = 'customer-analytics-warehouse-events-production-eu';
  assert.equal(truncateKeepingSuffix(long, '-rabc123').endsWith('-rabc123'), true);
  const first = truncateKeepingSuffix(`pg-${long}`, '-raaaaaaaa', 50);
  const second = truncateKeepingSuffix(first.replace(/-r[0-9a-z]{6,}$/, ''), '-rbbbbbbbb', 53);
  assert.notEqual(first, second);
  assert.ok(second.length <= 50);
  assert.equal(databaseClusterName('short-name'), 'pg-short-name');
  const one = databaseClusterName(`${'a'.repeat(50)}-one`);
  const two = databaseClusterName(`${'a'.repeat(50)}-two`);
  assert.notEqual(one, two);
  assert.ok(one.length <= 50);
  assert.equal(databaseClusterName('a'.repeat(47)).length, 50);
});

test('operation records never carry the stored database password', () => {
  const at = new Date();
  const out = stripOperationSecrets({
    operations: [{ id: 'op', createdAt: at, source: { dbUser: 'app', dbPassword: 'enc:v1:x' } }]
  }) as any;
  assert.deepEqual(out.operations[0].source, { dbUser: 'app' });
  assert.equal(out.operations[0].createdAt, at);
});

function ingressService(existingHost: string) {
  const checked: string[] = [];
  const service = Object.create(IngressService.prototype) as any;
  service.usersService = { findOrCreateByClerkId: async () => ({ id: 'u1' }) };
  service.authz = { requireProjectEdit: async () => {} };
  service.access = {
    assertHostnameAvailable: async (host: string) => {
      checked.push(host);
      throw new ForbiddenException('taken');
    }
  };
  const project = { id: 'p1', deployments: [] };
  service.prisma = {
    ingress: { findFirst: async () => ({ host: existingHost, project }) },
    project: { findUnique: async () => project }
  };
  return { service, checked };
}

test('moving an ingress to a new host checks that the host is free', async () => {
  const { service, checked } = ingressService('mine.example');
  await assert.rejects(
    () => service.updateProjectIngress('p1', 'i1', { host: 'victim.example' }, 'clerk'),
    ForbiddenException
  );
  assert.deepEqual(checked, ['victim.example']);
});

test('keeping the same host does not recheck it', async () => {
  const { service, checked } = ingressService('mine.example');
  await assert.rejects(
    () => service.updateProjectIngress('p1', 'i1', { host: 'mine.example' }, 'clerk'),
    /At least one route/
  );
  assert.deepEqual(checked, []);
});

test('creating a project ingress reaches its own validation', async () => {
  const { service } = ingressService('mine.example');
  await assert.rejects(
    () => service.createProjectIngress('p1', { host: 'new.example' }, 'clerk'),
    /At least one route/
  );
});

test('tokens cannot administer identity, and the CLI routes still work', () => {
  for (const path of [
    '/apiv1/organizations/o1/scim/tokens',
    '/apiv1/organizations/o1/sso/providers',
    '/apiv1/organizations/o1/sso/settings',
    '/apiv1/auth/passkeys/p1',
    '/apiv1/admin',
    '/apiv1/admin/stats',
    '/apiv1/admin/instance-settings',
    '/apiv1/admin/sso/providers',
    '/apiv1/admin/doctors',
    '/apiv1/admin/doctor-config',
    '/apiv1/admin/doctor/selftest/run-1/cancel',
    '/apiv1/admin/doctor/checks',
    '/apiv1/admin/doctor/../instance-settings'
  ]) {
    assert.equal(deniedToApiToken(path), true, path);
  }
  for (const path of [
    '/apiv1/auth/me',
    '/apiv1/auth/tokens',
    '/apiv1/auth/sessions',
    '/apiv1/auth/sessions/revoke-all',
    '/apiv1/github/repositories',
    '/apiv1/tailscale/status',
    '/apiv1/users/me/git-connections',
    '/apiv1/organizations/o1/members',
    '/apiv1/projects/p1',
    '/apiv1/admin/doctor',
    '/apiv1/admin/doctor/',
    '/apiv1/admin/doctor/selftest',
    '/apiv1/admin/doctor/selftest/run-1'
  ]) {
    assert.equal(deniedToApiToken(path), false, path);
  }
});

test('project tokens stay out of account routes but can still work on their project', () => {
  assert.equal(deniedToProjectToken('GET', '/apiv1/auth/me'), false);
  for (const path of [
    '/apiv1/auth/sessions',
    '/apiv1/auth/tokens',
    '/apiv1/github/repositories/o/r/contents',
    '/apiv1/git/oauth/gitlab/start',
    '/apiv1/users/me/git-connections',
    '/apiv1/tailscale/link',
    '/apiv1/invitations/by-id/i/accept'
  ]) {
    assert.equal(deniedToProjectToken('GET', path), true, path);
  }
  for (const path of [
    '/apiv1/projects/p1',
    '/apiv1/deployments/d1/rollout',
    '/apiv1/tailscale/deployment/d1',
    '/apiv1/tailscale/expose/d1',
    '/apiv1/projects/p1/invitations/i1'
  ]) {
    assert.equal(deniedToProjectToken('POST', path), false, path);
  }
});

test('public credential routes are named exactly', () => {
  for (const path of [
    '/apiv1/auth/password',
    '/apiv1/auth/otp/verify',
    '/apiv1/auth/passkey/authenticate/verify',
    '/apiv1/invitations/abc/sign-up'
  ]) {
    assert.equal(isPublicCredentialPost('POST', path), true, path);
  }
  assert.equal(isPublicCredentialPost('GET', '/apiv1/auth/password'), false);
  assert.equal(isPublicCredentialPost('POST', '/apiv1/github/app/webhook'), false);
  assert.equal(isPublicCredentialPost('POST', '/apiv1/webhooks/deploy'), false);
});

function egressPeers(policy: any): string[] {
  return policy.spec.egress
    .flatMap((rule: any) => rule.to ?? [])
    .map((peer: any) => peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'])
    .filter(Boolean);
}

test('tenants may be reached from the platform namespace but cannot reach it', () => {
  const policy: any = tenantDenyPolicy('acme', { ingressNamespaces: ['traefik', 'orchard'] });
  const from = policy.spec.ingress[0].from.map(
    (peer: any) => peer.namespaceSelector.matchLabels['kubernetes.io/metadata.name']
  );
  assert.deepEqual(from, ['acme', 'traefik', 'orchard']);
  const egress = egressPeers(policy);
  assert.equal(egress.includes('orchard'), false);
  assert.equal(egress.includes('traefik'), true);
  assert.equal(egress.includes('acme'), true);
});

test('the platform namespace can be named, and egress can be set by hand', () => {
  const saved = { p: process.env.PLATFORM_NAMESPACE, e: process.env.TENANT_EGRESS_NAMESPACES };
  try {
    process.env.PLATFORM_NAMESPACE = 'paas';
    delete process.env.TENANT_EGRESS_NAMESPACES;
    const named = egressPeers(tenantDenyPolicy('acme', { ingressNamespaces: ['network', 'paas'] }));
    assert.equal(named.includes('paas'), false);
    assert.equal(named.includes('network'), true);
    process.env.TENANT_EGRESS_NAMESPACES = 'network,paas';
    const manual = egressPeers(
      tenantDenyPolicy('acme', { ingressNamespaces: ['network', 'paas'] })
    );
    assert.equal(manual.includes('paas'), true);
  } finally {
    if (saved.p === undefined) delete process.env.PLATFORM_NAMESPACE;
    else process.env.PLATFORM_NAMESPACE = saved.p;
    if (saved.e === undefined) delete process.env.TENANT_EGRESS_NAMESPACES;
    else process.env.TENANT_EGRESS_NAMESPACES = saved.e;
  }
});

test('an app name that collides with another project is refused', async () => {
  const seen: any[] = [];
  const prisma = (hit: boolean) =>
    ({
      deployment: {
        findFirst: async ({ where }: any) => {
          seen.push(where);
          return hit ? { id: 'other' } : null;
        }
      }
    }) as any;
  await assert.rejects(
    () => assertIngressNameFree(prisma(true), 'acme-a', 'b-web', 'p1'),
    /clashes/
  );
  assert.deepEqual(
    seen[0].OR.map((c: any) => [c.namespace, c.OR[0].name]),
    [
      ['acme', 'a-b-web'],
      ['acme-a', 'b-web'],
      ['acme-a-b', 'web']
    ]
  );
  await assertIngressNameFree(prisma(false), 'acme-a', 'b-web', 'p1');
});

test('traefik metrics for one service do not match a longer service name', () => {
  const sel = traefikSelector({ namespace: 'acme-a', services: ['b'] } as any)!;
  const pattern = new RegExp(`^${sel.match(/service=~"([^"]*)"/)![1].replace(/\\\\/g, '\\')}$`);
  assert.equal(pattern.test('acme-a-b-80@kubernetes'), true);
  assert.equal(pattern.test('acme-a-b-web-80@kubernetes'), false);
  assert.ok(
    haproxySelector({ namespace: 'acme', services: ['web'] } as any)!.includes('acme_svc_')
  );
});

test('a made-up orch_ token shares the IP bucket, and a real one keeps its own', async () => {
  const guard = new ApiThrottlerGuard([{ ttl: 60000, limit: 200 }] as any, {} as any, {} as any);
  const real = 'orch_real';
  (guard as any).prisma = {
    apiToken: {
      findUnique: async ({ where }: any) =>
        where.tokenHash === createHash('sha256').update(real).digest('hex') ? { id: 't' } : null
    }
  };
  const req = (token: string) => ({
    headers: { authorization: `Bearer ${token}` },
    ip: '203.0.113.7'
  });
  const tracker = (r: any) => (guard as any).getTracker(r);
  assert.equal(await tracker(req('orch_junk1')), await tracker(req('orch_junk2')));
  assert.match(await tracker(req(real)), /^token:/);
});

function loginService() {
  const login = Object.create(SsoLoginService.prototype) as any;
  const secret = new TextEncoder().encode('test-secret-for-sso-start-cookie-0123456789');
  login.oauthService = {
    getJwtSecret: () => secret,
    verifySessionToken: async () => ({ sub: 'pepito', sessionId: 's1' })
  };
  login.sessionsService = { validateSession: async () => true };
  return login;
}

test('an SSO callback has to come back to the browser that started it', async () => {
  const login = loginService();
  const url = 'https://idp.example/authorize?state=abc';
  const token = await login.issueStartToken('p1', url);
  assert.deepEqual(await login.readStartToken('p1', token, 'abc'), {
    linkedUserId: undefined,
    linkedSessionId: undefined
  });
  await assert.rejects(() => login.readStartToken('p1', undefined, 'abc'), UnauthorizedException);
  await assert.rejects(() => login.readStartToken('p1', token, 'other'), UnauthorizedException);
  await assert.rejects(() => login.readStartToken('p2', token, 'abc'), UnauthorizedException);
  await assert.rejects(() => login.readStartToken('p1', 'garbage', 'abc'), UnauthorizedException);
});

test('starting SSO while signed in carries who started it', async () => {
  const login = loginService();
  const token = await login.issueStartToken('p1', 'https://idp.example/saml', 'session-cookie');
  assert.equal((await login.readStartToken('p1', token)).linkedUserId, 'pepito');
});

function limiter(valid = true, tokenExists = true) {
  return new SseStreamLimiter(
    { validateSession: async () => valid } as any,
    { apiToken: { findUnique: async () => (tokenExists ? { expiresAt: null } : null) } } as any
  );
}

const lost = (stream: any) => firstValueFrom(stream.pipe(timeout(500)));

test('a log stream ends when access is lost', async () => {
  await lost(limiter(false).untilAccessLost({ sessionId: 's' }, async () => {}, 5));
  await lost(limiter(true, false).untilAccessLost({ apiTokenId: 't' }, async () => {}, 5));
  await lost(
    limiter().untilAccessLost(
      { sessionId: 's' },
      async () => {
        throw new HttpException('gone', 403);
      },
      5
    )
  );
});

test('a log stream survives a database hiccup', async () => {
  const stream = limiter().untilAccessLost(
    { sessionId: 's' },
    async () => {
      throw new Error('connection reset');
    },
    5
  );
  await assert.rejects(() => lost(stream), /Timeout/);
});

function protectionService() {
  const service = Object.create(ProtectionService.prototype) as any;
  service.prisma = {
    ingress: {
      findUnique: async () => ({
        host: 'app.example.com',
        path: '/',
        tlsSecretName: 'tls',
        entrypoints: null
      })
    }
  };
  return service;
}

test('a protected site only sends people back to itself over its own origin', async () => {
  const service = protectionService();
  assert.equal(
    await service.validateReturnTo('i1', 'https://app.example.com/a/b?c=1#frag'),
    'https://app.example.com/a/b?c=1'
  );
  for (const target of [
    'javascript://app.example.com/%0aalert(1)',
    'data://app.example.com/x',
    'http://app.example.com/',
    'https://app.example.com:8443/',
    'https://evil.example/',
    'https://app.example.com.evil.example/',
    'not a url'
  ]) {
    await assert.rejects(() => service.validateReturnTo('i1', target), HttpException, target);
  }
});

test('bypass paths are skipped when a path could be read two ways', () => {
  for (const path of [
    '/public/%2e%2e/admin',
    '/public/..%2fadmin',
    '/public\\..\\admin',
    '/a%ff/b'
  ]) {
    assert.equal(pathIsAmbiguous(path), true, path);
  }
  for (const path of ['/public/file.css', '/health?x=%2f', '/caf%C3%A9']) {
    assert.equal(pathIsAmbiguous(path), false, path);
  }
});

test('repository URLs with dot segments never parse', () => {
  const github = Object.create(GitHubService.prototype) as GitHubService;
  for (const url of [
    'https://github.com/owner/public/../private',
    'https://github.com/owner/public/%2e%2e/private',
    'https://github.com/owner/./repo'
  ]) {
    assert.equal(parseRepoUrl(url), null, url);
    assert.equal(github.parseRepoUrl(url), null, url);
  }
  assert.deepEqual(github.parseRepoUrl('https://github.com/owner/repo.git'), {
    owner: 'owner',
    repo: 'repo'
  });
  assert.equal(
    parseRepoUrl('https://github.com/owner/my.repo.git')?.pathname,
    '/owner/my.repo.git'
  );
  assert.equal(github.parseRepoUrl('https://github.com/owner/my..repo')?.repo, 'my..repo');
});

test('listing GitHub installations never returns their access token', async () => {
  const controller = Object.create(GitHubController.prototype) as any;
  controller.usersService = { findOrCreateByClerkId: async () => ({ id: 'u1' }) };
  controller.githubService = {
    getUserInstallations: async () => [
      {
        id: 'i1',
        installationId: BigInt(1),
        accountId: BigInt(2),
        accountLogin: 'acme',
        accountType: 'Organization',
        repositorySelection: 'all',
        accessToken: 'ghs_secret',
        tokenExpiresAt: new Date()
      }
    ]
  };
  const [row] = await controller.getUserInstallations({ user: { sub: 'u1' } });
  assert.equal(JSON.stringify(row).includes('ghs_secret'), false);
  assert.equal(row.tokenExpiresAt, undefined);
  assert.equal(row.accountLogin, 'acme');
});
