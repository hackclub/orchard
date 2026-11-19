import { Injectable, Optional } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import {
  SessionsService,
  MCP_SESSION_AUTH_METHOD,
  MCP_SESSION_TTL_MS
} from '../auth/sessions.service';
import { PrismaService } from '../prisma/prisma.service';
import { hashApiToken } from '../auth/api-tokens.service';
import { MCP_ORG_DEVICE, orgScopedDevice, plainDeviceName } from '../auth/org-scoped-devices';
import {
  checkRefreshGeneration,
  hashClientSecret,
  isHashedClientSecret,
  oauthCodeKey,
  verifyClientSecret
} from './mcp-oauth.helpers';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import type { McpScope } from './client';
import {
  MCP_SCOPES_SUPPORTED,
  mcpScopeClaim,
  grantedScope,
  parseRequestedScope,
  scopeFromApiTokenScopes,
  scopeFromClaim
} from './mcp-scopes';

interface OAuthClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  name: string;
}

interface AuthCodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  orchardToken: string;
  expiresAt: number;
}

interface McpTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  externalAuthId?: string;
  authMethod?: string;
  sessionId: string;
  scope: McpScope;
}

export const MAX_CLIENT_NAME_LENGTH = 100;
export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 512;
export const MAX_CACHED_CLIENTS = 5000;
export const CLIENT_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const ACCESS_TOKEN_TTL = '1d';
const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
// Refresh tokens rotate on every use, so an actively-used client stays
// authorized indefinitely while an idle one dies after 30 days.
const REFRESH_TOKEN_TTL = '30d';
const TOKEN_ENDPOINT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

@Injectable()
export class McpOAuthService {
  private readonly oauthClients = new Map<string, OAuthClient>();
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
    @Optional() private readonly crypto?: SecretCryptoService
  ) {}

  private seal(value: string): string {
    if (!value || !this.crypto?.enabled) return value;
    return this.crypto.seal(value);
  }

  private unseal(value: string): string {
    if (!value || !this.crypto) return value;
    try {
      return this.crypto.open(value);
    } catch {
      return '';
    }
  }

  // Auth codes and pending-authorize state live in Postgres (mcp_oauth_codes)
  // rather than process memory so the `/authorize` -> `/authorize/complete` ->
  // `/token` flow survives restarts and works across replicas. Rows are keyed
  // by the sha256 of the one-time auth code (or of `pending_<state>` /
  // `client_state_<state>` for the in-flight handshake), so a database read
  // cannot yield a redeemable code.
  private async getCode(id: string): Promise<AuthCodeEntry | undefined> {
    const row = await this.prisma.mcpOauthCode.findUnique({ where: { id: oauthCodeKey(id) } });
    if (!row) return undefined;
    return {
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge ?? undefined,
      codeChallengeMethod: row.codeChallengeMethod ?? undefined,
      orchardToken: this.unseal(row.orchardToken),
      expiresAt: row.expiresAt.getTime()
    };
  }

  private async putCode(id: string, entry: AuthCodeEntry): Promise<void> {
    const data = {
      clientId: entry.clientId,
      redirectUri: entry.redirectUri,
      codeChallenge: entry.codeChallenge ?? null,
      codeChallengeMethod: entry.codeChallengeMethod ?? null,
      orchardToken: this.seal(entry.orchardToken),
      expiresAt: new Date(entry.expiresAt)
    };
    const key = oauthCodeKey(id);
    await this.prisma.mcpOauthCode.upsert({
      where: { id: key },
      create: { id: key, ...data },
      update: data
    });
  }

  // deleteMany so a missing row is a no-op rather than a throw.
  private async deleteCode(id: string): Promise<void> {
    await this.prisma.mcpOauthCode.deleteMany({ where: { id: oauthCodeKey(id) } });
  }

  private pruneExpiredCodes(): void {
    this.prisma.mcpOauthCode
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(() => {});
  }

  private cacheClient(clientId: string, client: OAuthClient): void {
    this.oauthClients.delete(clientId);
    this.oauthClients.set(clientId, client);
    while (this.oauthClients.size > MAX_CACHED_CLIENTS) {
      const oldest = this.oauthClients.keys().next().value;
      if (oldest === undefined) break;
      this.oauthClients.delete(oldest);
    }
  }

  private touchClient(clientId: string): void {
    const now = Date.now();
    const last = this.lastTouched.get(clientId);
    if (last !== undefined && now - last < CLIENT_TOUCH_INTERVAL_MS) return;
    if (this.lastTouched.size >= MAX_CACHED_CLIENTS) this.lastTouched.clear();
    this.lastTouched.set(clientId, now);
    Promise.resolve()
      .then(() =>
        this.prisma.mcpOauthClient.updateMany({
          where: { id: clientId },
          data: { lastUsedAt: new Date(now) }
        })
      )
      .catch(() => {});
  }

  private async getClient(clientId: string): Promise<OAuthClient | null> {
    if (!clientId) return null;
    const cached = this.oauthClients.get(clientId);
    if (cached) {
      this.touchClient(clientId);
      return cached;
    }
    const row = await this.prisma.mcpOauthClient.findUnique({ where: { id: clientId } });
    if (!row) return null;
    this.touchClient(clientId);
    const client: OAuthClient = {
      clientId: row.id,
      clientSecret: row.clientSecret ?? undefined,
      redirectUris: Array.isArray(row.redirectUris) ? (row.redirectUris as string[]) : [],
      name: row.name
    };
    this.cacheClient(clientId, client);
    return client;
  }

  private get baseUrl(): string {
    return process.env.MCP_BASE_URL || 'http://localhost:3100';
  }

  private get frontendUrl(): string {
    return process.env.FRONTEND_URL || 'http://localhost:5173';
  }

  private getJwtSecret(): Uint8Array {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET is required');
    return new TextEncoder().encode(secret);
  }

  get resourceMetadataUrl(): string {
    return `${this.baseUrl}/.well-known/oauth-protected-resource`;
  }

  getProtectedResourceMetadata() {
    return {
      resource: this.baseUrl,
      authorization_servers: [this.baseUrl],
      scopes_supported: MCP_SCOPES_SUPPORTED,
      bearer_methods_supported: ['header']
    };
  }

  getAuthorizationServerMetadata() {
    return {
      issuer: this.baseUrl,
      authorization_endpoint: `${this.baseUrl}/authorize`,
      token_endpoint: `${this.baseUrl}/token`,
      registration_endpoint: `${this.baseUrl}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: TOKEN_ENDPOINT_AUTH_METHODS,
      code_challenge_methods_supported: ['S256'],
      scopes_supported: MCP_SCOPES_SUPPORTED
    };
  }

  /**
   * Accept any https redirect URI, plus loopback http per RFC 8252. Safety
   * relies on PKCE S256, per-client redirect_uri binding at registration,
   * single-use auth codes, and the consent screen showing the full URI,
   * not on a host allowlist.
   */
  private isAllowedRedirectUri(uri: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return false;
    }
    if (parsed.username || parsed.password) return false;
    if (parsed.hash) return false;
    if (parsed.protocol === 'http:') {
      const h = parsed.hostname;
      return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
    }
    return parsed.protocol === 'https:';
  }

  async registerClient(body: {
    client_name?: string;
    redirect_uris?: string[];
    grant_types?: string[];
    response_types?: string[];
    token_endpoint_auth_method?: string;
  }): Promise<{ error?: string; error_description?: string; registration?: any }> {
    console.error(
      `[MCP OAuth] Register client: name=${body.client_name}, redirect_uris=${JSON.stringify(body.redirect_uris)}`
    );
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (
      (body.client_name !== undefined &&
        (typeof body.client_name !== 'string' ||
          body.client_name.length > MAX_CLIENT_NAME_LENGTH)) ||
      redirectUris.length > MAX_REDIRECT_URIS ||
      redirectUris.some((uri) => typeof uri === 'string' && uri.length > MAX_REDIRECT_URI_LENGTH)
    ) {
      return {
        error: 'invalid_client_metadata',
        error_description: `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters and redirect_uris at most ${MAX_REDIRECT_URIS} entries of ${MAX_REDIRECT_URI_LENGTH} characters`
      };
    }
    if (redirectUris.length === 0) {
      return {
        error: 'invalid_redirect_uri',
        error_description: 'at least one redirect_uri is required'
      };
    }
    for (const uri of redirectUris) {
      if (typeof uri !== 'string' || !this.isAllowedRedirectUri(uri)) {
        return {
          error: 'invalid_redirect_uri',
          error_description:
            'redirect_uri must be https or loopback http (no userinfo, no fragment)'
        };
      }
    }

    const authMethod = body.token_endpoint_auth_method || 'none';
    if (!TOKEN_ENDPOINT_AUTH_METHODS.includes(authMethod)) {
      return {
        error: 'invalid_client_metadata',
        error_description: 'unsupported token_endpoint_auth_method'
      };
    }

    const clientId = `mcp_${randomBytes(16).toString('hex')}`;
    const clientSecret =
      authMethod === 'client_secret_post' || authMethod === 'client_secret_basic'
        ? randomBytes(32).toString('hex')
        : undefined;

    const name = body.client_name || 'MCP Client';
    const storedSecret = clientSecret ? hashClientSecret(clientSecret) : undefined;
    await this.prisma.mcpOauthClient.create({
      data: {
        id: clientId,
        clientSecret: storedSecret ?? null,
        name,
        redirectUris
      }
    });
    this.cacheClient(clientId, {
      clientId,
      clientSecret: storedSecret,
      redirectUris,
      name
    });

    return {
      registration: {
        client_id: clientId,
        client_secret: clientSecret,
        client_name: body.client_name || 'MCP Client',
        redirect_uris: redirectUris,
        grant_types: body.grant_types || ['authorization_code'],
        response_types: body.response_types || ['code'],
        token_endpoint_auth_method: authMethod
      }
    };
  }

  async buildAuthorizeRedirect(query: {
    client_id: string;
    redirect_uri: string;
    response_type: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    scope?: string;
  }): Promise<{ error?: string; error_description?: string; redirectUrl?: string }> {
    console.error(
      `[MCP OAuth] Authorize: client_id=${query.client_id}, redirect_uri=${query.redirect_uri}, state=${query.state}`
    );
    if (query.response_type !== 'code') {
      console.error(
        `[MCP OAuth] Authorize failed: unsupported_response_type=${query.response_type}`
      );
      return { error: 'unsupported_response_type' };
    }

    // Require PKCE with S256. Plain or missing challenges leave the auth code
    // exchangeable by anyone who intercepts the redirect: the authorization
    // server metadata only advertises S256, but the request shape must be
    // enforced here too so a malicious client can't downgrade.
    if (!query.code_challenge || query.code_challenge_method !== 'S256') {
      console.error(`[MCP OAuth] Authorize failed: PKCE S256 required`);
      return { error: 'invalid_request' };
    }

    // Reject unknown client_id and any redirect_uri not pre-registered. Without
    // this, an attacker registers (or guesses) a client and points the
    // redirect_uri at attacker.example, harvesting the victim's auth code.
    const client = await this.getClient(query.client_id);
    if (!client) {
      console.error(`[MCP OAuth] Authorize failed: unknown client_id=${query.client_id}`);
      return {
        error: 'invalid_client',
        error_description:
          'Unknown client_id. This client was never registered with this server, or its registration was issued by a different one. Clear any manually configured OAuth Client ID and let the client register itself.'
      };
    }
    if (!client.redirectUris.includes(query.redirect_uri)) {
      console.error(`[MCP OAuth] Authorize failed: redirect_uri not registered for client`);
      return { error: 'invalid_redirect_uri' };
    }

    // Opportunistically sweep expired rows so single-use codes and abandoned
    // authorize handshakes don't accumulate.
    this.pruneExpiredCodes();

    const mcpState = randomBytes(16).toString('hex');
    await this.putCode(`pending_${mcpState}`, {
      clientId: query.client_id,
      redirectUri: query.redirect_uri,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method,
      orchardToken: '',
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    await this.putCode(`client_state_${mcpState}`, {
      clientId: query.state || '',
      redirectUri: '',
      orchardToken: '',
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    const scope = parseRequestedScope(query.scope);
    await this.putCode(`scope_${mcpState}`, {
      clientId: scope,
      redirectUri: '',
      orchardToken: '',
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    // Redirect to Orchard frontend login page with MCP state. client_name and
    // redirect_uri are passed for the consent screen to display. The page echoes
    // them back on approval and completeAuthorization refuses a mismatch, so a
    // tampered link cannot show one destination and grant another.
    const params = new URLSearchParams({
      mcp_state: mcpState,
      mcp_server: this.baseUrl,
      client_name: client.name,
      redirect_uri: query.redirect_uri,
      scope: mcpScopeClaim(scope)
    });

    return {
      redirectUrl: `${this.frontendUrl}/mcp/authorize?${params.toString()}`
    };
  }

  async completeAuthorization(body: {
    mcp_state: string;
    session_token: string;
    scope?: unknown;
    redirect_uri?: unknown;
    client_name?: unknown;
  }): Promise<{ error?: string; redirectUrl?: string }> {
    const { mcp_state, session_token } = body;
    console.error(`[MCP OAuth] Complete authorization: mcp_state=${mcp_state}`);

    const pending = await this.getCode(`pending_${mcp_state}`);
    const clientStateEntry = await this.getCode(`client_state_${mcp_state}`);
    const scopeEntry = await this.getCode(`scope_${mcp_state}`);

    if (!pending || pending.expiresAt < Date.now()) {
      console.error(`[MCP OAuth] Complete auth failed: pending not found or expired`);
      return { error: 'Authorization request expired' };
    }

    const scope = grantedScope(scopeFromClaim(scopeEntry?.clientId), body.scope);
    if (!scope) {
      return { error: 'Invalid scope' };
    }

    // Validate the Orchard session token (same JWT_SECRET)
    let payload: any;
    try {
      const result = await jwtVerify(session_token, this.getJwtSecret());
      payload = result.payload;
      console.error(`[MCP OAuth] Session token valid: sub=${payload.sub}, email=${payload.email}`);
    } catch (err) {
      console.error(
        `[MCP OAuth] Session token invalid: ${err instanceof Error ? err.message : err}`
      );
      return { error: 'Invalid session token' };
    }

    // H6: consent may only be granted from a real, live login.
    if (!payload.sessionId) {
      return { error: 'Session token missing session binding' };
    }
    if (payload.type) {
      return { error: 'Consent needs a browser session, not a derived token' };
    }
    if (!(await this.sessions.validateSession(payload.sessionId))) {
      return { error: 'Session expired, sign in again' };
    }

    const client = await this.getClient(pending.clientId);
    if (body.redirect_uri !== pending.redirectUri || !client || body.client_name !== client.name) {
      return {
        error:
          "What this page showed doesn't match the request, so nothing was granted. Start again from your MCP client."
      };
    }

    const deviceName = plainDeviceName(client.name);
    const mcpSessionId = await this.sessions.createSession({
      userId: payload.sub,
      authMethod: MCP_SESSION_AUTH_METHOD,
      deviceName: payload.orgScope
        ? orgScopedDevice(MCP_ORG_DEVICE, payload.orgScope, deviceName)
        : deviceName,
      ttlMs: MCP_SESSION_TTL_MS
    });

    const orchardToken = await this.mintAccessToken({
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      externalAuthId: payload.externalAuthId ?? payload.hackClubId,
      authMethod: payload.authMethod,
      sessionId: mcpSessionId,
      scope
    });

    const mcpAuthCode = randomBytes(32).toString('hex');
    console.error(`[MCP OAuth] MCP auth code created, redirecting to ${pending.redirectUri}`);
    await this.putCode(mcpAuthCode, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      codeChallengeMethod: pending.codeChallengeMethod,
      orchardToken,
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    await this.deleteCode(`pending_${mcp_state}`);
    await this.deleteCode(`client_state_${mcp_state}`);
    await this.deleteCode(`scope_${mcp_state}`);

    const redirectUrl = new URL(pending.redirectUri);
    redirectUrl.searchParams.set('code', mcpAuthCode);
    if (clientStateEntry?.clientId) {
      redirectUrl.searchParams.set('state', clientStateEntry.clientId);
    }

    return { redirectUrl: redirectUrl.toString() };
  }

  // M-2: stamp `type: 'mcp'` so SuperAdminGuard can reject MCP-issued tokens
  // when they're replayed at the main Orchard API. Both JWTs use the same
  // HS256 secret, so without a type discriminator a leaked MCP access token
  // is indistinguishable from a first-party browser session JWT.
  private mintAccessToken(claims: McpTokenClaims): Promise<string> {
    return new SignJWT({
      type: 'mcp',
      email: claims.email,
      name: claims.name,
      externalAuthId: claims.externalAuthId,
      authMethod: claims.authMethod || 'otp',
      sessionId: claims.sessionId,
      scope: mcpScopeClaim(claims.scope)
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(ACCESS_TOKEN_TTL)
      .sign(this.getJwtSecret());
  }

  // Refresh tokens are stateless JWTs rather than DB/in-memory entries so
  // they survive server restarts (the client registry and auth-code maps do
  // not). type='mcp_refresh' means validateBearerTokenWithSub rejects them
  // as bearer credentials, and the embedded clientId binds the token to the
  // client it was issued to. Session revocation is still honored because the
  // refresh grant re-validates sessionId against the DB before minting.
  private mintRefreshToken(claims: McpTokenClaims, clientId: string, gen: number): Promise<string> {
    return new SignJWT({
      type: 'mcp_refresh',
      email: claims.email,
      name: claims.name,
      externalAuthId: claims.externalAuthId,
      authMethod: claims.authMethod || 'otp',
      sessionId: claims.sessionId,
      scope: mcpScopeClaim(claims.scope),
      clientId,
      gen
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setExpirationTime(REFRESH_TOKEN_TTL)
      .sign(this.getJwtSecret());
  }

  private async buildTokenResponse(
    claims: McpTokenClaims,
    clientId: string,
    gen: number,
    accessToken?: string
  ) {
    return {
      access_token: accessToken ?? (await this.mintAccessToken(claims)),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: await this.mintRefreshToken(claims, clientId, gen),
      scope: mcpScopeClaim(claims.scope)
    };
  }

  private claimsFromPayload(payload: any): McpTokenClaims {
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      externalAuthId: payload.externalAuthId ?? payload.hackClubId,
      authMethod: payload.authMethod,
      sessionId: payload.sessionId,
      scope: scopeFromClaim(payload.scope)
    };
  }

  private async authenticateClient(
    clientId: string,
    presentedSecret: string | undefined
  ): Promise<OAuthClient | null> {
    const client = await this.getClient(clientId);
    if (!client) return null;
    if (!client.clientSecret) return client;
    if (!verifyClientSecret(client.clientSecret, presentedSecret)) return null;
    if (!isHashedClientSecret(client.clientSecret)) {
      const upgraded = hashClientSecret(presentedSecret as string);
      await this.prisma.mcpOauthClient
        .update({ where: { id: clientId }, data: { clientSecret: upgraded } })
        .then(() => this.cacheClient(clientId, { ...client, clientSecret: upgraded }))
        .catch(() => {});
    }
    return client;
  }

  private async refreshAccessToken(body: {
    refresh_token?: string;
    client_id: string;
    client_secret?: string;
  }): Promise<{ error?: string; error_description?: string; token_response?: any }> {
    if (!body.refresh_token) {
      return { error: 'invalid_request', error_description: 'refresh_token required' };
    }

    let payload: any;
    try {
      payload = (await jwtVerify(body.refresh_token, this.getJwtSecret())).payload;
    } catch (err) {
      console.error(`[MCP OAuth] Refresh failed: ${err instanceof Error ? err.message : err}`);
      return { error: 'invalid_grant', error_description: 'refresh token expired or invalid' };
    }

    if (payload.type !== 'mcp_refresh') {
      console.error('[MCP OAuth] Refresh failed: wrong token type');
      return { error: 'invalid_grant', error_description: 'not a refresh token' };
    }
    if (!body.client_id || payload.clientId !== body.client_id) {
      console.error('[MCP OAuth] Refresh failed: client_id mismatch');
      return { error: 'invalid_client' };
    }
    if (!payload.sessionId || !payload.sub) {
      return { error: 'invalid_grant', error_description: 'malformed refresh token' };
    }
    if (!(await this.getClient(body.client_id))) {
      console.error('[MCP OAuth] Refresh failed: client no longer registered, revoking session');
      await this.sessions.revokeSession(payload.sub, payload.sessionId);
      return { error: 'invalid_client', error_description: 'client is no longer registered' };
    }
    if (!(await this.authenticateClient(body.client_id, body.client_secret))) {
      console.error('[MCP OAuth] Refresh failed: client authentication failed');
      return { error: 'invalid_client', error_description: 'client authentication failed' };
    }

    const currentGen = await this.sessions.refreshGeneration(payload.sessionId);
    if (currentGen === null) {
      console.error('[MCP OAuth] Refresh failed: session revoked or expired');
      return { error: 'invalid_grant', error_description: 'session revoked or expired' };
    }
    const check = checkRefreshGeneration(payload.gen, currentGen);
    if (check.ok === false) {
      console.error(`[MCP OAuth] Refresh failed: ${check.reason}, revoking session`);
      await this.sessions.revokeSession(payload.sub, payload.sessionId);
      return { error: 'invalid_grant', error_description: check.reason };
    }
    const nextGen = await this.sessions.rotateRefreshGeneration(payload.sessionId, check.gen);
    if (nextGen === null) {
      console.error('[MCP OAuth] Refresh failed: lost the rotation race');
      return { error: 'invalid_grant', error_description: 'refresh token already rotated' };
    }
    // Sliding window: an actively-refreshing MCP client keeps its underlying
    // session alive instead of dying at the fixed 7-day mark.
    await this.sessions.extendSession(payload.sessionId, MCP_SESSION_TTL_MS);

    console.error(`[MCP OAuth] Refresh succeeded for sub=${payload.sub}`);
    return {
      token_response: await this.buildTokenResponse(
        this.claimsFromPayload(payload),
        body.client_id,
        nextGen
      )
    };
  }

  async exchangeToken(body: {
    grant_type: string;
    code?: string;
    redirect_uri?: string;
    client_id: string;
    client_secret?: string;
    code_verifier?: string;
    refresh_token?: string;
  }): Promise<{ error?: string; error_description?: string; token_response?: any }> {
    console.error(
      `[MCP OAuth] Token exchange: grant_type=${body.grant_type}, client_id=${body.client_id}, code_length=${body.code?.length}, redirect_uri=${body.redirect_uri}`
    );
    if (body.grant_type === 'refresh_token') {
      return this.refreshAccessToken(body);
    }
    if (body.grant_type !== 'authorization_code') {
      console.error(`[MCP OAuth] Token exchange failed: unsupported_grant_type`);
      return { error: 'unsupported_grant_type' };
    }

    const authCode = body.code ? await this.getCode(body.code) : undefined;
    console.error(`[MCP OAuth] Token exchange: authCode found=${!!authCode}`);
    if (!body.code || !authCode || authCode.expiresAt < Date.now()) {
      console.error(`[MCP OAuth] Token exchange failed: invalid_grant (not found or expired)`);
      if (body.code) await this.deleteCode(body.code);
      return { error: 'invalid_grant' };
    }

    if (authCode.clientId !== body.client_id) {
      console.error(
        `[MCP OAuth] Token exchange failed: invalid_client (expected=${authCode.clientId}, got=${body.client_id})`
      );
      return { error: 'invalid_client' };
    }

    // Re-check both that the exchange request's redirect_uri matches the one
    // bound to the auth code AND that it is still in the client's registered
    // list (defense against the registered list being mutated after authorize).
    const client = await this.authenticateClient(body.client_id, body.client_secret);
    if (!client) {
      return { error: 'invalid_client', error_description: 'client authentication failed' };
    }
    if (authCode.redirectUri && authCode.redirectUri !== body.redirect_uri) {
      console.error(
        `[MCP OAuth] Token exchange failed: redirect_uri mismatch (expected=${authCode.redirectUri}, got=${body.redirect_uri})`
      );
      return { error: 'invalid_grant', error_description: 'redirect_uri mismatch' };
    }
    if (!client.redirectUris.includes(body.redirect_uri ?? '')) {
      return { error: 'invalid_redirect_uri' };
    }

    // PKCE is mandatory: /authorize already rejects challenge-less requests,
    // but enforce again here so the token endpoint cannot be bypassed even if
    // an auth code somehow lands without a stored challenge.
    if (!authCode.codeChallenge || authCode.codeChallengeMethod !== 'S256') {
      console.error(`[MCP OAuth] Token exchange failed: PKCE S256 required on stored code`);
      return { error: 'invalid_grant', error_description: 'PKCE required' };
    }
    if (!body.code_verifier) {
      console.error(`[MCP OAuth] Token exchange failed: code_verifier required`);
      return { error: 'invalid_grant', error_description: 'code_verifier required' };
    }
    const expectedChallenge = createHash('sha256').update(body.code_verifier).digest('base64url');
    if (expectedChallenge !== authCode.codeChallenge) {
      console.error(`[MCP OAuth] Token exchange failed: code_verifier mismatch`);
      return { error: 'invalid_grant', error_description: 'code_verifier mismatch' };
    }

    const orchardToken = authCode.orchardToken;
    await this.deleteCode(body.code);

    // Recover the identity claims from the access token minted at
    // authorization time so the refresh token carries the same identity.
    let payload: any;
    try {
      payload = (await jwtVerify(orchardToken, this.getJwtSecret())).payload;
    } catch {
      // The access token minted minutes ago should always verify; if it
      // doesn't (e.g. JWT_SECRET rotated mid-flow), the code is unusable.
      return { error: 'invalid_grant', error_description: 'authorization expired' };
    }

    const gen = await this.sessions.refreshGeneration(payload.sessionId);
    if (gen === null) {
      return { error: 'invalid_grant', error_description: 'session revoked or expired' };
    }

    return {
      token_response: await this.buildTokenResponse(
        this.claimsFromPayload(payload),
        body.client_id,
        gen,
        orchardToken
      )
    };
  }

  async validateBearerToken(authHeader?: string): Promise<string | null> {
    const result = await this.validateBearerTokenWithSub(authHeader);
    return result?.token ?? null;
  }

  async validateApiToken(
    authHeader?: string
  ): Promise<{ token: string; sub: string; scope: McpScope } | null> {
    if (!authHeader?.startsWith('Bearer orch_')) return null;
    const token = authHeader.substring(7);
    const apiToken = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashApiToken(token) },
      select: { userId: true, expiresAt: true, scopes: true }
    });
    if (!apiToken) {
      console.error('[MCP OAuth] API token rejected: unknown token');
      return null;
    }
    if (apiToken.expiresAt && apiToken.expiresAt < new Date()) {
      console.error('[MCP OAuth] API token rejected: expired');
      return null;
    }
    return { token, sub: apiToken.userId, scope: scopeFromApiTokenScopes(apiToken.scopes) };
  }

  /**
   * Same checks as `validateBearerToken` but also returns the JWT `sub`
   * claim so callers can bind a long-lived stateful resource (MCP transport
   * sessions) to the user who created it. Without this binding, a leaked
   * `mcp-session-id` lets any other authenticated MCP user dispatch tool
   * calls against the original creator's `OrchardClient` (i.e. their
   * orchard token), running as that user against the first-party API.
   */
  async validateBearerTokenWithSub(authHeader?: string): Promise<{
    token: string;
    sub: string;
    email?: string;
    externalAuthId?: string;
    sessionId: string;
    scope: McpScope;
  } | null> {
    if (!authHeader?.startsWith('Bearer ')) {
      console.error('[MCP OAuth] No Bearer token in header');
      return null;
    }
    const token = authHeader.substring(7);
    console.error(
      `[MCP OAuth] Token length: ${token.length}, prefix: ${token.substring(0, 20)}...`
    );
    try {
      const result = await jwtVerify(token, this.getJwtSecret());

      // M-2: MCP must only accept tokens this service minted. A first-party
      // browser-session JWT (issued by oauth.service / passwordless / SSO) is
      // signed with the same secret and therefore passes jwtVerify, but it
      // is not the credential the user consented to share with the MCP client.
      // Reject anything that isn't type='mcp'.
      if (result.payload.type !== 'mcp') {
        console.error('[MCP OAuth] Token rejected: wrong token type');
        return null;
      }

      // MCP runs in its own Nest app and does NOT pass through SuperAdminGuard,
      // so the session check has to happen here. Without this, "sign out
      // everywhere" / session revocation / role downgrade does not invalidate
      // an MCP access token until its 1-day expiry: the originating sessionId
      // is carried in the JWT precisely so we can honor revocation.
      const sessionId = result.payload.sessionId as string | undefined;
      if (!sessionId) {
        console.error('[MCP OAuth] Token rejected: missing sessionId binding');
        return null;
      }
      const sessionValid = await this.sessions.validateSession(sessionId);
      if (!sessionValid) {
        console.error('[MCP OAuth] Token rejected: session has been revoked');
        return null;
      }
      this.sessions.touchSession(sessionId).catch(() => {});

      const sub = result.payload.sub as string | undefined;
      if (!sub) {
        console.error('[MCP OAuth] Token rejected: missing sub claim');
        return null;
      }

      console.error(`[MCP OAuth] Token valid, sub: ${sub}, exp: ${result.payload.exp}`);
      return {
        token,
        sub,
        email: result.payload.email as string | undefined,
        externalAuthId: (result.payload.externalAuthId ?? result.payload.hackClubId) as
          | string
          | undefined,
        sessionId,
        scope: scopeFromClaim(result.payload.scope)
      };
    } catch (err) {
      console.error(
        `[MCP OAuth] Token verification failed: ${err instanceof Error ? err.message : err}`
      );
      return null;
    }
  }
}
