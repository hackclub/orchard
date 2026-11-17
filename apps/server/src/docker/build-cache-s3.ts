import * as crypto from 'crypto';

export const PROXIED_CACHE_PREFIX = '_build-cache/';
export const BUILD_CACHE_KEY_TTL_MS = 2 * 60 * 60 * 1000;
export const BUILD_CACHE_PURPOSE = 'build-cache';
export const S3_TOUCH_REFRESH = '2000000h';
export const S3_CACHE_KEY_ENV = 'ORCHARD_S3_CACHE_KEY_ID';
export const S3_CACHE_SECRET_ENV = 'ORCHARD_S3_CACHE_SECRET';
export const BUILDKITD_ENV_WRAPPER = 'BUILDKITD_ENV';

export interface S3CacheEnv {
  [key: string]: string | undefined;
  BUILDKIT_S3_VIA_PROXY?: string;
  BUILDKIT_S3_BUCKET?: string;
  BUILDKIT_S3_CACHE_PREFIX?: string;
  BUILDKIT_S3_SHARED_KEY?: string;
  BACKUP_PROXY_ENABLED?: string;
  BACKUP_PROXY_ENDPOINT?: string;
}

export type S3CacheRoute =
  | { via: 'proxy'; endpoint: string; bucket: string; basePrefix: string }
  | { via: 'direct'; reason: string };

export interface S3CacheTarget {
  endpoint: string;
  bucket: string;
  region: string;
  basePrefix: string;
  scoped: boolean;
}

export function s3CacheRoute(env: S3CacheEnv, platformBucket: string | null): S3CacheRoute {
  const mode = (env.BUILDKIT_S3_VIA_PROXY || 'auto').trim().toLowerCase();
  const endpoint = (env.BACKUP_PROXY_ENDPOINT || '').trim();
  if (mode === 'false') return { via: 'direct', reason: 'BUILDKIT_S3_VIA_PROXY=false' };
  if (env.BACKUP_PROXY_ENABLED !== 'true' || !endpoint) {
    return { via: 'direct', reason: 'the r2-proxy is not enabled' };
  }
  const explicitBucket = (env.BUILDKIT_S3_BUCKET || '').trim();
  const bucket = explicitBucket || platformBucket || '';
  if (!bucket) return { via: 'direct', reason: 'no bucket is known to the r2-proxy' };
  if (mode !== 'true' && explicitBucket && explicitBucket !== platformBucket) {
    return {
      via: 'direct',
      reason: `bucket ${explicitBucket} is not the proxy's platform bucket; set BUILDKIT_S3_VIA_PROXY=true and add it to r2Proxy.allowedBuckets`
    };
  }
  const prefix = (env.BUILDKIT_S3_CACHE_PREFIX || '').trim();
  return {
    via: 'proxy',
    endpoint,
    bucket,
    basePrefix: prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : PROXIED_CACHE_PREFIX
  };
}

export function sharedS3KeyAllowed(env: S3CacheEnv): boolean {
  return (env.BUILDKIT_S3_SHARED_KEY || '').trim().toLowerCase() === 'true';
}

export function s3CacheRouteNotice(
  route: S3CacheRoute,
  env: S3CacheEnv
): { level: 'log' | 'warn' | 'error'; message: string } {
  if (route.via === 'proxy') {
    return {
      level: 'log',
      message: `S3 build cache: per-tenant keys scoped to ${route.basePrefix}<tenant>/ through the r2-proxy`
    };
  }
  if (sharedS3KeyAllowed(env)) {
    return {
      level: 'warn',
      message: `S3 build cache uses the instance-wide key because BUILDKIT_S3_SHARED_KEY=true (${route.reason}). Any build can read that key and overwrite every project's cache, so only use this on a single-tenant instance`
    };
  }
  return {
    level: 'error',
    message: `S3 build cache is OFF: ${route.reason}, and the instance-wide key would let any build read and overwrite every project's cache. Serve the cache bucket through the r2-proxy, or set BUILDKIT_S3_SHARED_KEY=true on a single-tenant instance`
  };
}

const BUILDKITD_ENV_SCRIPT = [
  '#!/bin/sh',
  `for name in $(env | sed -n 's/^\\(AWS_[A-Za-z0-9_]*\\)=.*/\\1/p'); do unset "$name"; done`,
  `if [ -n "\${${S3_CACHE_KEY_ENV}:-}" ] && [ -n "\${${S3_CACHE_SECRET_ENV}:-}" ]; then`,
  `  export AWS_ACCESS_KEY_ID="$${S3_CACHE_KEY_ENV}" AWS_SECRET_ACCESS_KEY="$${S3_CACHE_SECRET_ENV}"`,
  'fi',
  `unset ${S3_CACHE_KEY_ENV} ${S3_CACHE_SECRET_ENV}`,
  'exec "$@"'
].join('\n');

export function buildkitdEnvPreamble(): string {
  const wrapper = BUILDKITD_ENV_WRAPPER;
  return `if [ -z "\${${wrapper}:-}" ]; then
${wrapper}=$(mktemp /tmp/buildkitd-env.XXXXXX)
cat > "$${wrapper}" <<'ORCHARD_BUILDKITD_ENV'
${BUILDKITD_ENV_SCRIPT}
ORCHARD_BUILDKITD_ENV
chmod 755 "$${wrapper}"
export ${wrapper} BUILDKITD="$${wrapper} buildkitd"
fi
`;
}

export function tenantCacheSegment(tenantKey: string | undefined): string | null {
  const segment = (tenantKey || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 63);
  return segment || null;
}

export function tenantWritePrefix(
  basePrefix: string,
  tenantKey: string | undefined
): string | null {
  const segment = tenantCacheSegment(tenantKey);
  return segment ? `${basePrefix}${segment}/` : null;
}

export function mintBuildCacheKey(): { accessKey: string; secret: string } {
  return {
    accessKey: `orch-${crypto.randomBytes(8).toString('hex')}`,
    secret: crypto.randomBytes(32).toString('hex')
  };
}
