import { ALPINE_IMAGE } from './helper-images';

/**
 * Tenant-level eviction for the shared BuildKit cache PVC.
 *
 * BuildKit's own GC bounds a single worker's root, and every build gets its own
 * worker rooted in its own subPath of the shared volume, so nothing in
 * BuildKit bounds the *sum* across tenants. Left alone the volume fills, and
 * once it does kubelet can no longer mkdir the next tenant's subPath and every
 * build on the node dies with an opaque CreateContainerConfigError.
 *
 * Kept out of image-builder.service.ts so it can be tested without dragging in
 * the Nest module graph, the same way build-config.ts is.
 */

export interface CacheEvictOptions {
  /** Sanitised tenant key: this build's subPath on the shared PVC. */
  cacheSubPath: string;
  /** Name of the pod volume holding the cache PVC. */
  volumeName?: string;
  /** Evict any tenant untouched for longer than this, pressure or not. */
  maxAgeDays: number;
  /** Above this disk usage, start evicting least-recently-used tenants. */
  highPct: number;
  /** Stop evicting once usage is at or below this. */
  targetPct: number;
  /** Never evict a tenant touched this recently: assume a build is in flight. */
  idleMinutes: number;
  maxGiB?: number | null;
  /** Hand the tenant directory to this uid, for a build that does not run as root. */
  chownUid?: number;
}

/**
 * Shell run by the `cache-evict` init container. POSIX sh, BusyBox utilities.
 *
 * Freshness is the newest mtime at depth <= 2 rather than the tenant
 * directory's own mtime: BuildKit rewrites `<tenant>/<image>/index.json` on
 * every cache export but rarely touches the tenant directory itself, so its
 * mtime reads as ancient on a project that is actively building.
 */
export function cacheEvictScript(opts: CacheEvictOptions): string {
  return `set -u
CACHE_ROOT="/cache"
SELF="${opts.cacheSubPath}"
HIGH=${opts.highPct}
TARGET=${opts.targetPct}
MAX_KB=${opts.maxGiB ? Math.floor(opts.maxGiB) * 1024 * 1024 : 0}
AGE_CUTOFF=$(( $(date +%s) - ${opts.maxAgeDays} * 86400 ))
IDLE_CUTOFF=$(( $(date +%s) - ${opts.idleMinutes} * 60 ))

usage() { df -P "$CACHE_ROOT" 2>/dev/null | awk 'NR==2 {sub(/%/,"",$5); print $5+0}'; }
total_kb() { du -sk "$CACHE_ROOT" 2>/dev/null | awk '{print $1+0}'; }

# BusyBox and GNU stat take -c, BSD takes -f. Probe once instead of assuming
# the base image, because guessing wrong means every mtime reads as empty.
if stat -c%Y "$CACHE_ROOT" >/dev/null 2>&1; then STAT_FMT=-c%Y; else STAT_FMT=-f%m; fi

echo "=== Shared build cache at $(usage)% ==="

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

: > "$WORK/tenants"
for dir in "$CACHE_ROOT"/*/; do
  [ -d "$dir" ] || continue
  name=\${dir#"$CACHE_ROOT"/}
  name=\${name%/}
  [ "$name" = "$SELF" ] && continue
  stamps=$(find "$dir" -maxdepth 2 -exec stat $STAT_FMT {} + 2>/dev/null) || stamps=
  newest=$(printf '%s\n' "$stamps" | sort -rn | head -1)
  # An age we could not read must never be treated as "infinitely old" — that
  # would turn one broken stat into a full wipe of every tenant's cache. find
  # always reports at least the directory itself, so an empty answer means
  # something is wrong. GNU find still stats a directory it cannot open and
  # then exits non-zero, so a failed walk counts as unknown too; leave the
  # tenant alone and let a later build retry.
  if [ -z "$newest" ]; then
    echo "Skipping $name: could not determine age"
    continue
  fi
  echo "$newest $name" >> "$WORK/tenants"
done
sort -n "$WORK/tenants" > "$WORK/tenants.lru"

while read -r ts name; do
  [ "$ts" -lt "$AGE_CUTOFF" ] || continue
  echo "Evicting stale tenant cache: $name (idle $(( ($(date +%s) - ts) / 86400 ))d)"
  rm -rf "\${CACHE_ROOT:?}/$name"
done < "$WORK/tenants.lru"

if [ -d "$CACHE_ROOT/$SELF" ]; then
  for dir in "$CACHE_ROOT/$SELF"/*/; do
    [ -f "\${dir}index.json" ] || continue
    stamps=$(find "$dir" -maxdepth 1 -exec stat $STAT_FMT {} + 2>/dev/null) || continue
    newest=$(printf '%s\n' "$stamps" | sort -rn | head -1)
    [ -n "$newest" ] || continue
    [ "$newest" -lt "$AGE_CUTOFF" ] || continue
    echo "Evicting stale image cache: \${dir%/}"
    rm -rf "\${dir:?}"
  done
fi

if [ "$MAX_KB" -gt 0 ] && [ "$(total_kb)" -gt "$MAX_KB" ]; then
  echo "=== Over the $((MAX_KB / 1048576))GiB budget, evicting least-recently-used tenants ==="
  while read -r ts name; do
    [ -d "$CACHE_ROOT/$name" ] || continue
    [ "$ts" -gt "$IDLE_CUTOFF" ] && continue
    [ "$(total_kb)" -le "$MAX_KB" ] && break
    echo "Evicting tenant cache: $name"
    rm -rf "\${CACHE_ROOT:?}/$name"
  done < "$WORK/tenants.lru"
fi

if [ "$(usage)" -gt "$HIGH" ]; then
  echo "=== Above \${HIGH}%, evicting least-recently-used tenants ==="
  while read -r ts name; do
    [ -d "$CACHE_ROOT/$name" ] || continue
    [ "$ts" -gt "$IDLE_CUTOFF" ] && continue
    U=$(usage)
    [ "$U" -le "$TARGET" ] && break
    echo "Evicting tenant cache: $name (disk at \${U}%)"
    rm -rf "\${CACHE_ROOT:?}/$name"
  done < "$WORK/tenants.lru"
fi

# Create our own subPath here rather than leaving it to kubelet, which hides
# the errno behind "failed to create subPath directory". mkdir's own stderr
# keeps it ("No space left on device", when every remaining tenant was in
# flight and none could be evicted) — which is both what makes the build log
# readable and what the retry-without-shared-cache check matches on.
if ! mkdir -p "$CACHE_ROOT/$SELF"; then
  echo "FATAL: could not create this build's directory in the shared cache"
  exit 1
fi

${
  opts.chownUid === undefined
    ? ''
    : `if ! find "$CACHE_ROOT/$SELF" \\( ! -user ${opts.chownUid} -o ! -group ${opts.chownUid} \\) -exec chown -h ${opts.chownUid}:${opts.chownUid} {} + || ! chmod 0770 "$CACHE_ROOT/$SELF"; then
  echo "WARNING: could not hand this build's cache directory to uid ${opts.chownUid}"
fi
`
}
echo "=== Shared build cache at $(usage)% after eviction ==="
`;
}

/**
 * Init container spec for the eviction sweep.
 *
 * The cache volume is mounted at its **root, with no subPath**, and that is the
 * whole point: kubelet only has to mkdir a subPath for containers that ask for
 * one, so this container still starts when the volume is 100% full: the exact
 * state in which the buildkit container cannot. Scheduled ahead of every other
 * init container, so by the time kubelet creates the buildkit container there
 * is room for its subPath.
 */
export function cacheEvictInitContainer(opts: CacheEvictOptions) {
  return {
    name: 'cache-evict',
    image: ALPINE_IMAGE,
    command: ['/bin/sh', '-c'],
    args: [cacheEvictScript(opts)],
    // Puts the tail of this container's output in terminated.message when it
    // exits non-zero, which is what carries "no space left on device" up to the
    // retry-without-shared-cache check in buildAndPush.
    terminationMessagePolicy: 'FallbackToLogsOnError',
    volumeMounts: [{ name: opts.volumeName ?? 'buildkit-cache', mountPath: '/cache' }],
    resources: {
      requests: { cpu: '50m', memory: '64Mi' },
      limits: { cpu: '500m', memory: '256Mi' }
    }
  };
}
