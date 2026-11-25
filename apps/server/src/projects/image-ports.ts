import { createHash } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';
import { Agent, fetch as undiciFetch } from 'undici';
import { BUILD_PLATFORM } from '../docker/build-platform';
import {
  BLOCKED_HOST_SUFFIXES,
  isPublicAddress,
  parseHttpUrl
} from '../notifications/webhook-guard';
import {
  bearerTokenUrl,
  normalizeRegistryHost,
  parseBearerChallenge
} from './registry-credentials';

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TOTAL_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 5_000;
const MAX_INDEX_DEPTH = 2;
const MAX_REFERENCE_LENGTH = 512;
const MAX_REPORTED_PORTS = 256;
const DEFAULT_WEB_PORT = 80;
const FALLBACK_PLATFORM = 'linux/amd64';

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');
const CONFIG_ACCEPT = [
  'application/vnd.oci.image.config.v1+json',
  'application/vnd.docker.container.image.v1+json',
  'application/json'
].join(', ');

const PLATFORM_METADATA_ADDRESSES = new Set(['168.63.129.16']);

const REGISTRY_TOKEN_HOSTS: Record<string, readonly string[]> = {
  'docker.io': ['auth.docker.io'],
  'registry.gitlab.com': ['gitlab.com']
};

const REPOSITORY_RE =
  /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const DIGEST_RE = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[A-Za-z0-9=_-]+$/;
const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const EXPOSED_PORT_RE = /^(\d{1,5})(?:\/(tcp|udp|sctp))?$/i;

export interface ExposedPort {
  port: number;
  protocol: 'tcp' | 'udp' | 'sctp';
}

export interface ImagePorts {
  port: number | null;
  ports: ExposedPort[];
}

export interface ImageRef {
  registry: string;
  repository: string;
  reference: string;
}

export interface RegistryCredential {
  username: string;
  password: string;
}

export interface RegistryRequest {
  method?: 'GET' | 'HEAD';
  headers: Record<string, string>;
  signal: AbortSignal;
  pinned: boolean;
}

export interface RegistryNet {
  resolve(hostname: string): Promise<string[]>;
  fetch(url: URL, request: RegistryRequest): Promise<Response>;
}

export interface InspectOptions {
  credentialFor?: (registry: string) => Promise<RegistryCredential | null>;
  net?: RegistryNet;
  plainHttpHosts?: Set<string>;
  platform?: string;
  timeoutMs?: number;
  maxBytes?: number;
  onFailure?: (reason: string, registry: string | null) => void;
}

interface Session {
  ref: ImageRef;
  base: URL;
  net: RegistryNet;
  plainHttp: Set<string>;
  platform: string;
  maxBytes: number;
  signal: AbortSignal;
  credentialFor: (registry: string) => Promise<RegistryCredential | null>;
  authorization: string | null;
  challenged: boolean;
}

class InspectFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function parseImageRef(raw: string): ImageRef | null {
  const value = (raw ?? '').trim();
  if (!value || value.length > MAX_REFERENCE_LENGTH || /\s/.test(value)) return null;

  const slash = value.indexOf('/');
  const first = slash > 0 ? value.slice(0, slash) : '';
  const hasRegistry =
    slash > 0 && (first.includes('.') || first.includes(':') || first === 'localhost');
  const registry = hasRegistry ? normalizeRegistryHost(first) : 'docker.io';
  if (!registry) return null;

  let rest = hasRegistry ? value.slice(slash + 1) : value;
  let reference = 'latest';

  const at = rest.indexOf('@');
  if (at >= 0) {
    reference = rest.slice(at + 1);
    if (!DIGEST_RE.test(reference)) return null;
    rest = rest.slice(0, at);
  }

  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    const tag = rest.slice(colon + 1);
    if (!TAG_RE.test(tag)) return null;
    if (at < 0) reference = tag;
    rest = rest.slice(0, colon);
  }

  if (!REPOSITORY_RE.test(rest)) return null;
  const repository = registry === 'docker.io' && !rest.includes('/') ? `library/${rest}` : rest;
  return { registry, repository, reference };
}

export function isRoutableRegistryAddress(ip: string): boolean {
  const address = ip.toLowerCase();
  if (!isPublicAddress(address)) return false;
  if (PLATFORM_METADATA_ADDRESSES.has(address)) return false;
  if (address === process.env.KUBERNETES_SERVICE_HOST?.toLowerCase()) return false;
  if (isIP(address) === 6) {
    const lead = address.split(':')[0];
    return ((lead ? parseInt(lead, 16) : 0) & 0xe000) === 0x2000;
  }
  return true;
}

export function plainHttpHostsFrom(raw: string | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const value = entry.trim().toLowerCase();
    if (!value) continue;
    hosts.add(/:\d+$/.test(value) ? value : `${value}:80`);
  }
  return hosts;
}

function plainHttpKey(url: URL): string {
  return `${url.hostname}:${url.port || '80'}`;
}

function registryBase(registry: string, plainHttp: Set<string>): URL {
  if (registry === 'docker.io') return new URL('https://registry-1.docker.io');
  const plain = new URL(`http://${registry}`);
  return plainHttp.has(plainHttpKey(plain)) ? plain : new URL(`https://${registry}`);
}

function isOwnAuthServer(session: Session, realm: URL): boolean {
  if (realm.host === session.base.host) return true;
  return REGISTRY_TOKEN_HOSTS[session.ref.registry]?.includes(realm.host) ?? false;
}

async function vetDestination(session: Session, url: URL): Promise<{ pinned: boolean }> {
  parseHttpUrl(url, 'Registry URL');
  if (url.username || url.password) throw new InspectFailure('blocked_userinfo');
  if (url.protocol === 'http:') {
    if (!session.plainHttp.has(plainHttpKey(url))) throw new InspectFailure('blocked_scheme');
    return { pinned: false };
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!isRoutableRegistryAddress(host)) throw new InspectFailure('blocked_address');
    return { pinned: true };
  }
  if (!host.includes('.') || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new InspectFailure('blocked_hostname');
  }
  const addresses = await session.net.resolve(host);
  if (addresses.length === 0) throw new InspectFailure('unresolved');
  if (addresses.some((address) => !isRoutableRegistryAddress(address))) {
    throw new InspectFailure('blocked_address');
  }
  return { pinned: true };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

async function follow(
  session: Session,
  start: URL,
  accept: string,
  authorization: string | null,
  method: 'GET' | 'HEAD' = 'GET'
): Promise<{ res: Response; url: URL }> {
  let url = start;
  let credential = authorization;
  for (let hop = 0; ; hop++) {
    const { pinned } = await vetDestination(session, url);
    const headers: Record<string, string> = { accept };
    if (credential) headers.authorization = credential;
    const res = await session.net.fetch(url, {
      method,
      headers,
      signal: session.signal,
      pinned
    });
    if (!isRedirect(res.status)) return { res, url };
    await discard(res);
    if (hop >= MAX_REDIRECTS) throw new InspectFailure('too_many_redirects');
    const location = res.headers.get('location');
    if (!location) throw new InspectFailure('bad_redirect');
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new InspectFailure('bad_redirect');
    }
    if (url.protocol === 'https:' && next.protocol !== 'https:') {
      throw new InspectFailure('blocked_scheme');
    }
    if (next.origin !== url.origin) credential = null;
    url = next;
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  return (await readCappedBytes(res, maxBytes)).toString('utf8');
}

async function readCappedBytes(res: Response, maxBytes: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) {
    await discard(res);
    throw new InspectFailure('too_large');
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new InspectFailure('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function parseObject(text: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InspectFailure('invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InspectFailure('invalid_json');
  }
  return parsed as Record<string, any>;
}

function basicHeader(credential: RegistryCredential): string {
  const pair = `${credential.username}:${credential.password}`;
  return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
}

async function authorize(session: Session, header: string | null): Promise<string> {
  const stored = await session.credentialFor(session.ref.registry);
  const challenge = parseBearerChallenge(header);
  if (!challenge) {
    if (stored && /^basic\b/i.test(header ?? '')) return basicHeader(stored);
    throw new InspectFailure('unauthorized');
  }

  let tokenUrl: URL;
  let realm: URL;
  try {
    realm = new URL(challenge.realm);
    tokenUrl = new URL(
      bearerTokenUrl({
        realm: challenge.realm,
        service: challenge.service,
        scope: `repository:${session.ref.repository}:pull`
      })
    );
  } catch {
    throw new InspectFailure('bad_realm');
  }

  const credential = stored && isOwnAuthServer(session, realm) ? basicHeader(stored) : null;
  const { res } = await follow(session, tokenUrl, 'application/json', credential);
  if (res.status !== 200) {
    await discard(res);
    throw new InspectFailure('token_refused');
  }
  const body = parseObject(await readCapped(res, session.maxBytes));
  const token = body.token ?? body.access_token;
  if (typeof token !== 'string' || !token) throw new InspectFailure('token_refused');
  return `Bearer ${token}`;
}

async function registryRequest(
  session: Session,
  path: string,
  accept: string,
  method: 'GET' | 'HEAD' = 'GET'
): Promise<Response> {
  const target = new URL(path, session.base);
  let { res, url } = await follow(session, target, accept, session.authorization, method);
  if (res.status === 401 && url.origin === session.base.origin && !session.challenged) {
    session.challenged = true;
    const header = res.headers.get('www-authenticate');
    await discard(res);
    session.authorization = await authorize(session, header);
    ({ res, url } = await follow(session, target, accept, session.authorization, method));
  }
  if (res.status !== 200) {
    await discard(res);
    throw new InspectFailure(`http_${res.status}`);
  }
  return res;
}

async function registryGet(session: Session, path: string, accept: string): Promise<string> {
  return readCapped(await registryRequest(session, path, accept), session.maxBytes);
}

function pickManifest(manifests: unknown[], preferred: string): string | null {
  const candidates = manifests.filter((entry): entry is Record<string, any> => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, any>;
    if (typeof record.digest !== 'string' || !DIGEST_RE.test(record.digest)) return false;
    if (record.annotations?.['vnd.docker.reference.type']) return false;
    return record.platform?.os !== 'unknown';
  });
  const platformOf = (entry: Record<string, any>) =>
    `${entry.platform?.os}/${entry.platform?.architecture}`;
  const chosen =
    candidates.find((entry) => platformOf(entry) === preferred) ??
    candidates.find((entry) => platformOf(entry) === FALLBACK_PLATFORM) ??
    candidates.find((entry) => entry.platform?.os === 'linux') ??
    candidates[0];
  return chosen?.digest ?? null;
}

async function readConfig(session: Session, reference: string, depth = 0): Promise<unknown> {
  const manifest = parseObject(
    await registryGet(
      session,
      `/v2/${session.ref.repository}/manifests/${reference}`,
      MANIFEST_ACCEPT
    )
  );
  if (Array.isArray(manifest.manifests)) {
    if (depth >= MAX_INDEX_DEPTH) throw new InspectFailure('index_too_deep');
    const digest = pickManifest(manifest.manifests, session.platform);
    if (!digest) throw new InspectFailure('no_platform');
    return readConfig(session, digest, depth + 1);
  }
  const digest = manifest.config?.digest;
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
    throw new InspectFailure('no_config');
  }
  return parseObject(
    await registryGet(session, `/v2/${session.ref.repository}/blobs/${digest}`, CONFIG_ACCEPT)
  );
}

export function exposedPortsFrom(config: unknown): ExposedPort[] {
  const exposed = (config as any)?.config?.ExposedPorts;
  if (!exposed || typeof exposed !== 'object' || Array.isArray(exposed)) return [];
  const seen = new Map<string, ExposedPort>();
  for (const key of Object.keys(exposed)) {
    const match = EXPOSED_PORT_RE.exec(key.trim());
    if (!match) continue;
    const port = Number(match[1]);
    if (port < 1 || port > 65535) continue;
    const protocol = (match[2] ?? 'tcp').toLowerCase() as ExposedPort['protocol'];
    seen.set(`${port}/${protocol}`, { port, protocol });
  }
  return [...seen.values()]
    .sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol))
    .slice(0, MAX_REPORTED_PORTS);
}

export function chooseDefaultPort(ports: ExposedPort[]): number | null {
  const tcp = ports.filter((entry) => entry.protocol === 'tcp').map((entry) => entry.port);
  if (tcp.length === 0) return null;
  return tcp.includes(DEFAULT_WEB_PORT) ? DEFAULT_WEB_PORT : Math.min(...tcp);
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new InspectFailure('timeout'));
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function pinnedLookup(
  resolve: (hostname: string) => Promise<string[]>,
  allowed: (address: string) => boolean
) {
  return (
    hostname: string,
    options: any,
    callback: (err: NodeJS.ErrnoException | null, address?: any, family?: number) => void
  ) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || addresses.some((address) => !allowed(address))) {
          callback(
            Object.assign(new Error('Destination resolves to a non-public address'), {
              code: 'EBLOCKED'
            })
          );
          return;
        }
        const entries = addresses.map((address) => ({ address, family: isIP(address) }));
        if (options?.all) callback(null, entries);
        else callback(null, entries[0].address, entries[0].family);
      },
      (err) => callback(err)
    );
  };
}

async function systemResolve(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

export function createRegistryNet(
  resolve: (hostname: string) => Promise<string[]> = systemResolve,
  allowed: (address: string) => boolean = isRoutableRegistryAddress
): RegistryNet {
  const pinnedAgent = new Agent({
    connect: { lookup: pinnedLookup(resolve, allowed), timeout: CONNECT_TIMEOUT_MS }
  });
  const operatorAgent = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } });
  return {
    resolve,
    fetch: (url, request) =>
      undiciFetch(url, {
        method: request.method ?? 'GET',
        headers: request.headers,
        redirect: 'manual',
        signal: request.signal,
        dispatcher: request.pinned ? pinnedAgent : operatorAgent
      }) as unknown as Promise<Response>
  };
}

export function finalBaseImage(dockerfile: string): string | null {
  const stages = new Map<string, string>();
  let last: string | null = null;
  for (const line of dockerfile.split('\n')) {
    const match = line.match(/^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i);
    if (!match) continue;
    const base = stages.get(match[1].toLowerCase()) ?? match[1];
    if (match[2]) stages.set(match[2].toLowerCase(), base);
    last = base;
  }
  if (!last || last.includes('$') || last.toLowerCase() === 'scratch') return null;
  return last;
}

let sharedNet: RegistryNet | null = null;

async function withSession<T>(
  image: unknown,
  options: InspectOptions,
  fallback: T,
  work: (session: Session) => Promise<T>
): Promise<T> {
  const ref = typeof image === 'string' ? parseImageRef(image) : null;
  if (!ref) {
    options.onFailure?.('invalid_reference', null);
    return fallback;
  }
  const deadline = new AbortController();
  const { signal } = deadline;
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? TOTAL_TIMEOUT_MS);
  try {
    const plainHttp = options.plainHttpHosts ?? plainHttpHostsFrom(process.env.REGISTRY_HTTP_HOSTS);
    const session: Session = {
      ref,
      base: registryBase(ref.registry, plainHttp),
      net: options.net ?? (sharedNet ??= createRegistryNet()),
      plainHttp,
      platform: options.platform ?? BUILD_PLATFORM,
      maxBytes: options.maxBytes ?? MAX_RESPONSE_BYTES,
      signal,
      credentialFor: options.credentialFor ?? (async () => null),
      authorization: null,
      challenged: false
    };
    return await untilAborted(work(session), signal);
  } catch (err) {
    const reason =
      err instanceof InspectFailure ? err.reason : signal.aborted ? 'timeout' : 'network';
    options.onFailure?.(reason, ref.registry);
    return fallback;
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}

export function inspectImagePorts(
  image: unknown,
  options: InspectOptions = {}
): Promise<ImagePorts> {
  return withSession<ImagePorts>(image, options, { port: null, ports: [] }, async (session) => {
    const ports = exposedPortsFrom(await readConfig(session, session.ref.reference));
    return { port: chooseDefaultPort(ports), ports };
  });
}

function contentDigest(res: Response): string | null {
  const header = res.headers.get('docker-content-digest')?.trim();
  return header && SHA256_DIGEST_RE.test(header) ? header : null;
}

async function readManifestDigest(session: Session): Promise<string> {
  const path = `/v2/${session.ref.repository}/manifests/${session.ref.reference}`;
  const head = await registryRequest(session, path, MANIFEST_ACCEPT, 'HEAD').catch(
    (err: unknown) => {
      if (err instanceof InspectFailure && /^http_(404|401|403)$/.test(err.reason)) throw err;
      return null;
    }
  );
  if (head) {
    await discard(head);
    const digest = contentDigest(head);
    if (digest) return digest;
  }
  const res = await registryRequest(session, path, MANIFEST_ACCEPT);
  const header = contentDigest(res);
  const body = await readCappedBytes(res, session.maxBytes);
  return header ?? `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

export function resolveImageDigest(
  image: unknown,
  options: InspectOptions = {}
): Promise<string | null> {
  return withSession<string | null>(image, options, null, async (session) => {
    if (session.ref.reference.includes(':')) throw new InspectFailure('pinned_by_digest');
    return readManifestDigest(session);
  });
}
