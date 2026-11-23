import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SuperAdminGuard } from '../src/auth/superadmin.guard';
import { REQUIRES_AUTH_KEY, REQUIRES_SUPERADMIN_KEY } from '../src/auth/decorators';
import { AuthorizationService } from '../src/auth/authorization.service';
import {
  holdsSuperAdminPower,
  requestAuthStorage,
  type RequestAuthContext
} from '../src/auth/request-context';
import { AuditController } from '../src/audit/audit.controller';
import { pickBuildRequest } from '../src/docker/docker.controller';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-superadmin-confinement';
process.env.MCP_SERVICE_TOKEN = 'svc-token-for-superadmin-confinement';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function reflector(meta: Record<string, unknown> = {}) {
  return {
    get: (key: string) => meta[key],
    getAllAndOverride: (key: string) => meta[key]
  };
}

function context(request: any) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => {},
    getClass: () => class {}
  } as any;
}

type TokenShape = {
  scopes: string[];
  restrictedProjectIds?: string[];
  scopeOrganizationId?: string | null;
};

function tokenGuard(token: TokenShape, meta: Record<string, unknown> = {}, superAdmin = true) {
  const prisma = {
    apiToken: {
      findUnique: async () => ({
        id: 'tok-1',
        expiresAt: null,
        scopes: token.scopes,
        restrictedProjectIds: token.restrictedProjectIds ?? [],
        scopeOrganizationId: token.scopeOrganizationId ?? null,
        user: {
          id: USER_ID,
          email: 'root@example.com',
          username: 'root',
          firstName: null,
          lastName: null,
          externalAuthId: null,
          disabledAt: null
        }
      }),
      update: async () => ({})
    },
    user: { findFirst: async () => ({ id: USER_ID, isSuperAdmin: superAdmin }) }
  };
  const sessions = { validateSession: async () => true, touchSession: async () => {} };
  return new SuperAdminGuard(prisma as any, sessions as any, reflector(meta) as any);
}

function tokenRequest(method: string, path: string) {
  return {
    method,
    path,
    headers: { authorization: 'Bearer orch_test_token' },
    cookies: {}
  } as any;
}

function gatewayGuard(meta: Record<string, unknown>) {
  const prisma = {
    session: { findUnique: async () => ({ userId: USER_ID, deviceName: 'Claude' }) },
    user: { findFirst: async () => ({ id: USER_ID, isSuperAdmin: true }) }
  };
  const sessions = { validateSession: async () => true, touchSession: async () => {} };
  return new SuperAdminGuard(prisma as any, sessions as any, reflector(meta) as any);
}

function gatewayRequest(method: string, path: string, scope = 'exec') {
  return {
    method,
    path,
    headers: {
      authorization: 'Bearer svc-token-for-superadmin-confinement',
      'x-acting-user-sub': USER_ID,
      'x-acting-user-session-id': 'sess-1',
      'x-acting-user-scope': scope
    },
    cookies: {}
  } as any;
}

const ALL_SCOPES = ['read', 'deploy', 'exec'];
const REFUSED = /can't use superadmin access/;

test('holdsSuperAdminPower only admits unconfined principals', () => {
  const cases: Array<[RequestAuthContext | undefined, boolean]> = [
    [undefined, true],
    [{}, true],
    [{ browserSession: true, sessionId: 's' }, true],
    [{ browserSession: true, sessionOrgId: 'org-a' }, false],
    [{ apiTokenId: 't', tokenScopes: ALL_SCOPES, tokenProjectIds: [] }, true],
    [{ apiTokenId: 't', tokenScopes: ['exec'] }, true],
    [{ apiTokenId: 't', tokenScopes: ['read', 'deploy'] }, false],
    [{ apiTokenId: 't', tokenScopes: [] }, false],
    [{ apiTokenId: 't', tokenScopes: ALL_SCOPES, tokenProjectIds: ['p1'] }, false],
    [{ apiTokenId: 't', tokenScopes: ALL_SCOPES, sessionOrgId: 'org-a' }, false],
    [{ mcpGateway: true }, false],
    [{ mcpGateway: true, tokenScopes: ['exec'] }, false]
  ];
  for (const [ctx, expected] of cases) {
    assert.equal(holdsSuperAdminPower(ctx), expected, JSON.stringify(ctx));
  }
});

test('an unrestricted exec token keeps superadmin routes', async () => {
  const req = tokenRequest('POST', '/apiv1/docker/build');
  assert.equal(await tokenGuard({ scopes: ALL_SCOPES }).canActivate(context(req)), true);
  assert.equal(req.auth.userId, USER_ID);
});

const DOCTOR_ROUTES: Array<[string, string]> = [
  ['GET', '/apiv1/admin/doctor'],
  ['POST', '/apiv1/admin/doctor/selftest'],
  ['GET', '/apiv1/admin/doctor/selftest/run-1']
];
const SUPERADMIN_ROUTE = { [REQUIRES_SUPERADMIN_KEY]: true };

test('an unrestricted exec token reaches the doctor and no other admin route', async () => {
  for (const [method, path] of DOCTOR_ROUTES) {
    const req = tokenRequest(method, path);
    assert.equal(
      await tokenGuard({ scopes: ALL_SCOPES }, SUPERADMIN_ROUTE).canActivate(context(req)),
      true,
      path
    );
    assert.equal(req.auth.userId, USER_ID);
  }
  for (const path of [
    '/apiv1/admin/stats',
    '/apiv1/admin/instance-settings',
    '/apiv1/admin/sso/providers',
    '/apiv1/admin/doctor/checks'
  ]) {
    await assert.rejects(
      tokenGuard({ scopes: ALL_SCOPES }, SUPERADMIN_ROUTE).canActivate(
        context(tokenRequest('GET', path))
      ),
      /An API token can't use this/,
      path
    );
  }
});

test('the doctor still refuses confined tokens, tenants and the MCP gateway', async () => {
  for (const [method, path] of DOCTOR_ROUTES) {
    for (const scopes of [['read'], ['read', 'deploy']]) {
      await assert.rejects(
        tokenGuard({ scopes }, SUPERADMIN_ROUTE).canActivate(context(tokenRequest(method, path))),
        REFUSED,
        `${scopes.join(',')} ${path}`
      );
    }
    await assert.rejects(
      tokenGuard(
        { scopes: ALL_SCOPES, restrictedProjectIds: ['p1'] },
        SUPERADMIN_ROUTE
      ).canActivate(context(tokenRequest(method, path))),
      ForbiddenException,
      path
    );
    await assert.rejects(
      tokenGuard(
        { scopes: ALL_SCOPES, scopeOrganizationId: 'org-a' },
        SUPERADMIN_ROUTE
      ).canActivate(context(tokenRequest(method, path))),
      ForbiddenException,
      path
    );
    await assert.rejects(
      tokenGuard({ scopes: ALL_SCOPES }, SUPERADMIN_ROUTE, false).canActivate(
        context(tokenRequest(method, path))
      ),
      /You need superadmin access/,
      path
    );
    await assert.rejects(
      gatewayGuard(SUPERADMIN_ROUTE).canActivate(context(gatewayRequest(method, path))),
      ForbiddenException,
      path
    );
  }
});

test('a project-scoped superadmin token is refused on superadmin routes', async () => {
  await assert.rejects(
    tokenGuard({ scopes: ALL_SCOPES, restrictedProjectIds: ['p1'] }).canActivate(
      context(tokenRequest('POST', '/apiv1/docker/build'))
    ),
    REFUSED
  );
});

test('a superadmin token without exec is refused on superadmin routes', async () => {
  for (const scopes of [['read'], ['read', 'deploy']]) {
    await assert.rejects(
      tokenGuard({ scopes }).canActivate(context(tokenRequest('POST', '/apiv1/docker/build'))),
      REFUSED,
      scopes.join(',')
    );
    await assert.rejects(
      tokenGuard(
        { scopes },
        { [REQUIRES_AUTH_KEY]: true, [REQUIRES_SUPERADMIN_KEY]: true }
      ).canActivate(context(tokenRequest('POST', '/apiv1/templates'))),
      REFUSED,
      scopes.join(',')
    );
  }
});

test('an org-scoped superadmin token is refused on superadmin routes', async () => {
  await assert.rejects(
    tokenGuard({ scopes: ALL_SCOPES, scopeOrganizationId: 'org-a' }).canActivate(
      context(tokenRequest('POST', '/apiv1/docker/build'))
    ),
    ForbiddenException
  );
});

test('restricted superadmin tokens still reach ordinary @Auth routes', async () => {
  const req = tokenRequest('GET', '/apiv1/deployments');
  assert.equal(
    await tokenGuard(
      { scopes: ['read'], restrictedProjectIds: ['p1'] },
      { [REQUIRES_AUTH_KEY]: true }
    ).canActivate(context(req)),
    true
  );
});

test('a non-superadmin exec token is refused with the plain message', async () => {
  await assert.rejects(
    tokenGuard({ scopes: ALL_SCOPES }, {}, false).canActivate(
      context(tokenRequest('POST', '/apiv1/docker/build'))
    ),
    /You need superadmin access/
  );
});

test('the MCP gateway never gets superadmin routes, even with exec', async () => {
  await assert.rejects(
    gatewayGuard({}).canActivate(context(gatewayRequest('POST', '/apiv1/docker/build'))),
    REFUSED
  );
  await assert.rejects(
    gatewayGuard({ [REQUIRES_AUTH_KEY]: true, [REQUIRES_SUPERADMIN_KEY]: true }).canActivate(
      context(gatewayRequest('POST', '/apiv1/templates'))
    ),
    REFUSED
  );
  assert.equal(
    await gatewayGuard({ [REQUIRES_AUTH_KEY]: true }).canActivate(
      context(gatewayRequest('GET', '/apiv1/templates', 'read'))
    ),
    true
  );
});

function authz(superAdmin = true) {
  const prisma = { user: { findUnique: async () => ({ isSuperAdmin: superAdmin }) } };
  return new AuthorizationService(prisma as any, {} as any);
}

test('isUnrestrictedSuperAdmin applies the request confinement', async () => {
  const svc = authz();
  const within = (ctx: RequestAuthContext) =>
    requestAuthStorage.run(ctx, () => svc.isUnrestrictedSuperAdmin(USER_ID));
  assert.equal(await svc.isUnrestrictedSuperAdmin(USER_ID), true);
  assert.equal(await within({ browserSession: true }), true);
  assert.equal(await within({ apiTokenId: 't', tokenScopes: ALL_SCOPES }), true);
  assert.equal(await within({ apiTokenId: 't', tokenScopes: ['read'] }), false);
  assert.equal(
    await within({ apiTokenId: 't', tokenScopes: ALL_SCOPES, tokenProjectIds: ['p1'] }),
    false
  );
  assert.equal(
    await within({ apiTokenId: 't', tokenScopes: ALL_SCOPES, sessionOrgId: 'o' }),
    false
  );
  assert.equal(await within({ browserSession: true, sessionOrgId: 'o' }), false);
  assert.equal(await within({ mcpGateway: true }), false);
  assert.equal(
    await requestAuthStorage.run({ browserSession: true }, () =>
      authz(false).isUnrestrictedSuperAdmin(USER_ID)
    ),
    false
  );
});

test('the global audit ledger refuses a read-scoped superadmin token', async () => {
  let queried = 0;
  const controller = new AuditController(
    {
      query: async () => {
        queried++;
        return { items: [] };
      }
    } as any,
    {} as any,
    authz()
  );
  const req = { user: { sub: USER_ID } } as any;
  await assert.rejects(
    requestAuthStorage.run({ apiTokenId: 't', tokenScopes: ['read'] }, () =>
      controller.getGlobal(req)
    ),
    ForbiddenException
  );
  await assert.rejects(
    requestAuthStorage.run({ mcpGateway: true, tokenScopes: ['exec'] }, () =>
      controller.getGlobal(req)
    ),
    ForbiddenException
  );
  assert.equal(queried, 0);
  await requestAuthStorage.run({ browserSession: true }, () => controller.getGlobal(req));
  assert.equal(queried, 1);
});

test('POST /docker/build only forwards the expected fields', () => {
  const picked = pickBuildRequest({
    repoUrl: 'https://github.com/a/b',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    imageName: 'b',
    tag: 'v1',
    buildFromRoot: true,
    deploymentId: 'dep-of-another-tenant',
    accessToken: 'ghp_x',
    cacheTenantKey: 'victim-namespace',
    localContextUrl: 'http://169.254.169.254/',
    buildMode: 'local',
    builder: 'depot',
    buildWithDepot: true,
    persistentBuildCache: true
  });
  assert.deepEqual(picked, {
    repoUrl: 'https://github.com/a/b',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    imageName: 'b',
    tag: 'v1',
    buildFromRoot: true
  });
});

test('POST /docker/build rejects missing or mistyped fields', () => {
  const base = {
    repoUrl: 'https://github.com/a/b',
    branch: 'main',
    dockerfilePath: 'Dockerfile',
    imageName: 'b'
  };
  assert.deepEqual(pickBuildRequest(base), base);
  for (const bad of [
    undefined,
    {},
    { ...base, imageName: '' },
    { ...base, repoUrl: { toString: () => 'x' } },
    { ...base, tag: 3 },
    { ...base, buildFromRoot: 'yes' }
  ]) {
    assert.throws(() => pickBuildRequest(bad), BadRequestException, JSON.stringify(bad));
  }
});

const ORG_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const ORG_B = 'bbbbbbbb-1111-4111-8111-111111111111';
const PROJECT_A = 'aaaaaaaa-2222-4222-8222-222222222222';
const PROJECT_B = 'bbbbbbbb-2222-4222-8222-222222222222';

function tenantAuthz() {
  const projects = [
    { id: PROJECT_A, organizationId: ORG_A },
    { id: PROJECT_B, organizationId: ORG_B }
  ];
  const prisma = {
    user: { findUnique: async () => ({ isSuperAdmin: true }) },
    organization: {
      findUnique: async ({ where }: any) =>
        [ORG_A, ORG_B].includes(where.id) ? { id: where.id } : null
    },
    organizationMember: {
      findUnique: async ({ where }: any) =>
        where.organizationId_userId.organizationId === ORG_A
          ? { role: 'owner', status: 'active' }
          : null,
      findFirst: async ({ where }: any) =>
        where.organizationId === ORG_A ? { role: 'owner' } : null,
      findMany: async () => []
    },
    projectMember: { findFirst: async () => null },
    project: {
      findUnique: async ({ where }: any) => projects.find((p) => p.id === where.id) ?? null,
      findMany: async ({ where }: any) =>
        projects.filter(
          (p) => p.organizationId === where.organizationId && where.id.in.includes(p.id)
        )
    },
    orgSsoSettings: { findFirst: async () => null }
  };
  return new AuthorizationService(prisma as any, {} as any);
}

const RESTRICTED: RequestAuthContext[] = [
  { apiTokenId: 't', tokenScopes: ALL_SCOPES, tokenProjectIds: [PROJECT_A, PROJECT_B] },
  { apiTokenId: 't', tokenScopes: ['read', 'deploy'] },
  { mcpGateway: true, tokenScopes: ['exec'] }
];

test('a restricted superadmin gets only its real memberships', async () => {
  const svc = tenantAuthz();
  for (const ctx of RESTRICTED) {
    const label = JSON.stringify(ctx);
    await requestAuthStorage.run(ctx, async () => {
      assert.equal(await svc.getOrgAccess(ORG_B, USER_ID), null, label);
      assert.equal((await svc.getOrgAccess(ORG_A, USER_ID))?.source, 'membership', label);
      assert.equal(await svc.getProjectAccess(PROJECT_B, USER_ID), null, label);
      assert.equal((await svc.getProjectAccess(PROJECT_A, USER_ID))?.source, 'orgAdmin', label);
      await assert.rejects(svc.listVisibleProjectIds(ORG_B, USER_ID), /not found/i, label);
    });
  }
  const projectToken = RESTRICTED[0];
  assert.deepEqual(
    await requestAuthStorage.run(projectToken, () => svc.listVisibleProjectIds(ORG_A, USER_ID)),
    [PROJECT_A]
  );
});

test('an unrestricted superadmin keeps the cross-tenant bypass', async () => {
  const svc = tenantAuthz();
  for (const ctx of [{ browserSession: true }, { apiTokenId: 't', tokenScopes: ALL_SCOPES }]) {
    await requestAuthStorage.run(ctx, async () => {
      const org = await svc.getOrgAccess(ORG_B, USER_ID);
      assert.equal(org?.source, 'superadmin');
      assert.equal(org?.isAdmin, true);
      assert.equal((await svc.getProjectAccess(PROJECT_B, USER_ID))?.source, 'superadmin');
      assert.equal(await svc.listVisibleProjectIds(ORG_B, USER_ID), null);
    });
  }
});
