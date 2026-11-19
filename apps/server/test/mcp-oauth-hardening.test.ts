import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SignJWT, decodeJwt } from 'jose';
import { McpOAuthService } from '../src/mcp/mcp-oauth.service';
import {
  hashClientSecret,
  isHashedClientSecret,
  oauthCodeKey,
  verifyClientSecret
} from '../src/mcp/mcp-oauth.helpers';
import {
  capScope,
  grantedScope,
  parseRequestedScope,
  scopeFromApiTokenScopes,
  scopeFromClaim,
  scopeFromHeader
} from '../src/mcp/mcp-scopes';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-mcp-oauth-hardening';
const secret = () => new TextEncoder().encode(process.env.JWT_SECRET);

function memoryPrisma(clients: Record<string, any> = {}) {
  const codes = new Map<string, any>();
  const updates: any[] = [];
  return {
    codes,
    updates,
    clients,
    mcpOauthCode: {
      findUnique: async ({ where }: any) => codes.get(where.id) ?? null,
      upsert: async ({ where, create, update }: any) => {
        codes.set(where.id, { ...(codes.get(where.id) ?? create), ...update });
      },
      deleteMany: async ({ where }: any) => {
        if (where.id) codes.delete(where.id);
        return { count: 1 };
      }
    },
    mcpOauthClient: {
      findUnique: async ({ where }: any) => clients[where.id] ?? null,
      create: async ({ data }: any) => {
        clients[data.id] = data;
      },
      update: async ({ where, data }: any) => {
        updates.push({ where, data });
        clients[where.id] = { ...clients[where.id], ...data };
      }
    }
  };
}

const sessions = {
  validateSession: async () => true,
  touchSession: async () => {},
  refreshGeneration: async () => 0,
  rotateRefreshGeneration: async (_: string, gen: number) => gen + 1,
  extendSession: async () => {},
  revokeSession: async () => true,
  createSession: async () => 'mcp-session'
};

const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function issueCode(svc: McpOAuthService, clientId: string) {
  const token = await new SignJWT({ type: 'mcp', sessionId: 'mcp-session', scope: 'mcp:read' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setExpirationTime('1h')
    .sign(secret());
  await (svc as any).putCode('the-code', {
    clientId,
    redirectUri: 'https://client.example/cb',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    orchardToken: token,
    expiresAt: Date.now() + 60_000
  });
  return token;
}

const exchange = (svc: McpOAuthService, clientId: string, clientSecret?: string) =>
  svc.exchangeToken({
    grant_type: 'authorization_code',
    code: 'the-code',
    redirect_uri: 'https://client.example/cb',
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: verifier
  });

test('client secrets are stored hashed and compared in constant time', () => {
  const stored = hashClientSecret('s3cret');
  assert.ok(isHashedClientSecret(stored));
  assert.ok(!stored.includes('s3cret'));
  assert.equal(verifyClientSecret(stored, 's3cret'), true);
  assert.equal(verifyClientSecret(stored, 'nope'), false);
  assert.equal(verifyClientSecret(stored, undefined), false);
  assert.equal(verifyClientSecret('legacy-plain', 'legacy-plain'), true);
  assert.equal(verifyClientSecret('legacy-plain', 'other'), false);
});

test('registration hands out the secret once and stores only its hash', async () => {
  const prisma = memoryPrisma();
  const svc = new McpOAuthService(sessions as any, prisma as any);
  const { registration } = await svc.registerClient({
    redirect_uris: ['https://client.example/cb'],
    token_endpoint_auth_method: 'client_secret_post'
  });
  const row = prisma.clients[registration.client_id];
  assert.ok(registration.client_secret);
  assert.equal(row.clientSecret, hashClientSecret(registration.client_secret));
});

test('client_secret_basic is advertised, mints a hashed secret, and unsupported auth methods are rejected', async () => {
  const prisma = memoryPrisma();
  const svc = new McpOAuthService(sessions as any, prisma as any);
  assert.ok(
    svc
      .getAuthorizationServerMetadata()
      .token_endpoint_auth_methods_supported.includes('client_secret_basic')
  );
  const { registration } = await svc.registerClient({
    redirect_uris: ['https://client.example/cb'],
    token_endpoint_auth_method: 'client_secret_basic'
  });
  assert.ok(registration.client_secret);
  assert.equal(registration.token_endpoint_auth_method, 'client_secret_basic');
  assert.equal(
    prisma.clients[registration.client_id].clientSecret,
    hashClientSecret(registration.client_secret)
  );
  const bad = await svc.registerClient({
    redirect_uris: ['https://client.example/cb'],
    token_endpoint_auth_method: 'private_key_jwt'
  });
  assert.equal(bad.error, 'invalid_client_metadata');
});

test('client_secret_post clients must present their secret at the token endpoint', async () => {
  const prisma = memoryPrisma({
    c1: {
      id: 'c1',
      name: 'c',
      clientSecret: hashClientSecret('right'),
      redirectUris: ['https://client.example/cb']
    }
  });
  const svc = new McpOAuthService(sessions as any, prisma as any);
  await issueCode(svc, 'c1');
  assert.equal((await exchange(svc, 'c1')).error, 'invalid_client');
  assert.equal((await exchange(svc, 'c1', 'wrong')).error, 'invalid_client');
  const ok = await exchange(svc, 'c1', 'right');
  assert.ok(ok.token_response, JSON.stringify(ok));
  assert.equal(ok.token_response.scope, 'mcp:read');

  const refreshed = await svc.exchangeToken({
    grant_type: 'refresh_token',
    refresh_token: ok.token_response.refresh_token,
    client_id: 'c1'
  });
  assert.equal(refreshed.error, 'invalid_client', 'refresh without the secret is refused');
  const refreshedOk = await svc.exchangeToken({
    grant_type: 'refresh_token',
    refresh_token: ok.token_response.refresh_token,
    client_id: 'c1',
    client_secret: 'right'
  });
  assert.ok(refreshedOk.token_response);
  assert.equal(decodeJwt(refreshedOk.token_response.access_token).scope, 'mcp:read');
});

test('a legacy plaintext client secret still works and is upgraded to a hash', async () => {
  const prisma = memoryPrisma({
    c2: { id: 'c2', name: 'c', clientSecret: 'plain', redirectUris: ['https://client.example/cb'] }
  });
  const svc = new McpOAuthService(sessions as any, prisma as any);
  await issueCode(svc, 'c2');
  const ok = await exchange(svc, 'c2', 'plain');
  assert.ok(ok.token_response);
  assert.deepEqual(prisma.updates, [
    { where: { id: 'c2' }, data: { clientSecret: hashClientSecret('plain') } }
  ]);
});

test('public clients (no secret) keep working without one', async () => {
  const prisma = memoryPrisma({
    c3: { id: 'c3', name: 'c', clientSecret: null, redirectUris: ['https://client.example/cb'] }
  });
  const svc = new McpOAuthService(sessions as any, prisma as any);
  await issueCode(svc, 'c3');
  assert.ok((await exchange(svc, 'c3')).token_response);
});

test('auth codes store the minted token sealed, and old plaintext rows still redeem', async () => {
  process.env.SECRETS_ENCRYPTION_KEY = 'test-key-for-mcp-oauth-hardening';
  const crypto = new SecretCryptoService();
  const prisma = memoryPrisma({
    c4: { id: 'c4', name: 'c', clientSecret: null, redirectUris: ['https://client.example/cb'] }
  });
  const svc = new McpOAuthService(sessions as any, prisma as any, crypto);
  const token = await issueCode(svc, 'c4');
  const row = prisma.codes.get(oauthCodeKey('the-code'));
  assert.ok(crypto.isEncrypted(row.orchardToken));
  assert.ok(!row.orchardToken.includes(token));
  assert.ok((await exchange(svc, 'c4')).token_response);

  const plainRow = await issueCode(new McpOAuthService(sessions as any, prisma as any), 'c4');
  assert.equal(prisma.codes.get(oauthCodeKey('the-code')).orchardToken, plainRow);
  const redeemed = await exchange(svc, 'c4');
  assert.equal(redeemed.token_response.access_token, plainRow);
  delete process.env.SECRETS_ENCRYPTION_KEY;
});

test('requested scopes map onto read/deploy/exec, and a client that asks for nothing specific gets everything', () => {
  assert.equal(parseRequestedScope(undefined), 'exec');
  assert.equal(parseRequestedScope('mcp:access'), 'exec');
  assert.equal(parseRequestedScope('mcp:read'), 'read');
  assert.equal(parseRequestedScope('mcp:deploy'), 'deploy');
  assert.equal(parseRequestedScope('mcp:read mcp:exec'), 'exec');
  assert.equal(parseRequestedScope('openid profile'), 'exec');
  assert.equal(scopeFromClaim(undefined), 'exec');
  assert.equal(scopeFromClaim('mcp:exec'), 'exec');
  assert.equal(scopeFromApiTokenScopes(['read', 'deploy']), 'deploy');
  assert.equal(scopeFromApiTokenScopes([]), 'read');
  assert.equal(scopeFromHeader(undefined), 'deploy');
  assert.equal(scopeFromHeader('read'), 'read');
  assert.equal(scopeFromHeader('admin'), 'deploy');
});

test('authorize records the requested scope and the consent completes with it', async () => {
  const prisma = memoryPrisma({
    c5: {
      id: 'c5',
      name: 'Claude',
      clientSecret: null,
      redirectUris: ['https://client.example/cb']
    }
  });
  const svc = new McpOAuthService(sessions as any, prisma as any);
  const { redirectUrl } = await svc.buildAuthorizeRedirect({
    client_id: 'c5',
    redirect_uri: 'https://client.example/cb',
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp:read'
  });
  const url = new URL(redirectUrl!);
  assert.equal(url.searchParams.get('scope'), 'mcp:read');
  const browser = await new SignJWT({ sessionId: 'browser' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setExpirationTime('1h')
    .sign(secret());
  const done = await svc.completeAuthorization({
    mcp_state: url.searchParams.get('mcp_state')!,
    session_token: browser,
    redirect_uri: url.searchParams.get('redirect_uri'),
    client_name: url.searchParams.get('client_name')
  });
  const code = new URL(done.redirectUrl!).searchParams.get('code')!;
  const exchanged = await svc.exchangeToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://client.example/cb',
    client_id: 'c5',
    code_verifier: verifier
  });
  assert.equal(decodeJwt(exchanged.token_response.access_token).scope, 'mcp:read');
});

test('consent refuses a page that showed a different client or destination', async () => {
  const prisma = memoryPrisma({
    c6: {
      id: 'c6',
      name: 'Real name',
      clientSecret: null,
      redirectUris: ['https://evil.example/cb']
    }
  });
  const svc = new McpOAuthService(sessions as any, prisma as any);
  const { redirectUrl } = await svc.buildAuthorizeRedirect({
    client_id: 'c6',
    redirect_uri: 'https://evil.example/cb',
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'mcp:exec'
  });
  const url = new URL(redirectUrl!);
  const mcp_state = url.searchParams.get('mcp_state')!;
  const session_token = await new SignJWT({ sessionId: 'browser' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setExpirationTime('1h')
    .sign(secret());

  for (const shown of [
    {},
    { redirect_uri: 'http://127.0.0.1:1234/cb', client_name: 'Real name' },
    { redirect_uri: 'https://evil.example/cb', client_name: 'Claude Code' },
    { redirect_uri: 'https://evil.example/cb' }
  ]) {
    const refused = await svc.completeAuthorization({ mcp_state, session_token, ...shown });
    assert.match(refused.error ?? '', /nothing was granted/);
    assert.equal(refused.redirectUrl, undefined);
  }

  const done = await svc.completeAuthorization({
    mcp_state,
    session_token,
    redirect_uri: 'https://evil.example/cb',
    client_name: 'Real name',
    scope: 'mcp:deploy'
  });
  assert.ok(new URL(done.redirectUrl!).searchParams.get('code'));
});

test('granted scope never exceeds the requested one and exec needs an explicit grant', () => {
  assert.equal(grantedScope('exec', undefined), 'deploy');
  assert.equal(grantedScope('exec', ''), 'deploy');
  assert.equal(grantedScope('exec', 'mcp:deploy'), 'deploy');
  assert.equal(grantedScope('exec', 'mcp:exec'), 'exec');
  assert.equal(grantedScope('exec', 'read'), 'read');
  assert.equal(grantedScope('deploy', 'mcp:exec'), 'deploy');
  assert.equal(grantedScope('deploy', undefined), 'deploy');
  assert.equal(grantedScope('read', 'mcp:exec'), 'read');
  assert.equal(grantedScope('read', 'mcp:deploy'), 'read');
  assert.equal(grantedScope('read', undefined), 'read');
  assert.equal(grantedScope('exec', 'admin'), null);
  assert.equal(grantedScope('exec', ['mcp:exec']), null);
  assert.equal(grantedScope('exec', 42), null);
});

async function consent(scope: string | undefined, granted: unknown) {
  const prisma = memoryPrisma({
    c6: {
      id: 'c6',
      name: 'Claude',
      clientSecret: null,
      redirectUris: ['https://client.example/cb']
    }
  });
  const svc = new McpOAuthService(sessions as any, prisma as any);
  const { redirectUrl } = await svc.buildAuthorizeRedirect({
    client_id: 'c6',
    redirect_uri: 'https://client.example/cb',
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope
  });
  const url = new URL(redirectUrl!);
  const browser = await new SignJWT({ sessionId: 'browser' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setExpirationTime('1h')
    .sign(secret());
  const done = await svc.completeAuthorization({
    mcp_state: url.searchParams.get('mcp_state')!,
    session_token: browser,
    scope: granted,
    redirect_uri: url.searchParams.get('redirect_uri'),
    client_name: url.searchParams.get('client_name')
  });
  if (done.error) return { requested: url.searchParams.get('scope'), error: done.error };
  const code = new URL(done.redirectUrl!).searchParams.get('code')!;
  const exchanged = await svc.exchangeToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://client.example/cb',
    client_id: 'c6',
    code_verifier: verifier
  });
  return {
    requested: url.searchParams.get('scope'),
    scope: decodeJwt(exchanged.token_response.access_token).scope
  };
}

test('a client asking for every scope gets deploy unless the user ticks exec', async () => {
  const all = 'mcp:read mcp:deploy mcp:exec mcp:access';
  assert.deepEqual(await consent(all, undefined), { requested: 'mcp:exec', scope: 'mcp:deploy' });
  assert.deepEqual(await consent(all, 'mcp:deploy'), {
    requested: 'mcp:exec',
    scope: 'mcp:deploy'
  });
  assert.deepEqual(await consent(all, 'mcp:exec'), { requested: 'mcp:exec', scope: 'mcp:exec' });
  assert.deepEqual(await consent(all, 'mcp:read'), { requested: 'mcp:exec', scope: 'mcp:read' });
});

test('consent cannot escalate past what the client requested', async () => {
  assert.deepEqual(await consent('mcp:read', 'mcp:exec'), {
    requested: 'mcp:read',
    scope: 'mcp:read'
  });
  assert.deepEqual(await consent(undefined, 'mcp:exec'), {
    requested: 'mcp:exec',
    scope: 'mcp:exec'
  });
  assert.deepEqual(await consent(undefined, undefined), {
    requested: 'mcp:exec',
    scope: 'mcp:deploy'
  });
  assert.deepEqual(await consent('mcp:deploy', 'mcp:exec'), {
    requested: 'mcp:deploy',
    scope: 'mcp:deploy'
  });
  assert.deepEqual(await consent('mcp:exec', 'root'), {
    requested: 'mcp:exec',
    error: 'Invalid scope'
  });
});

test('existing MCP tokens without a scope claim keep everything they had before scopes', async () => {
  const svc = new McpOAuthService(sessions as any, {} as any);
  const legacy = await new SignJWT({ type: 'mcp', sessionId: 's1' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setExpirationTime('1h')
    .sign(secret());
  const auth = await svc.validateBearerTokenWithSub(`Bearer ${legacy}`);
  assert.equal(auth?.scope, 'exec');
});

test('metadata advertises the new scopes', () => {
  const svc = new McpOAuthService(sessions as any, {} as any);
  for (const doc of [svc.getProtectedResourceMetadata(), svc.getAuthorizationServerMetadata()]) {
    assert.deepEqual(doc.scopes_supported, ['mcp:read', 'mcp:deploy', 'mcp:exec', 'mcp:access']);
  }
});

test('a scope on the MCP URL only ever lowers what the connection gets', () => {
  assert.equal(capScope('exec', 'read'), 'read');
  assert.equal(capScope('exec', 'mcp:deploy'), 'deploy');
  assert.equal(capScope('read', 'exec'), 'read');
  assert.equal(capScope('deploy', null), 'deploy');
  assert.equal(capScope('deploy', 'nonsense'), 'deploy');
});
