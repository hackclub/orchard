import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';

export const POD_PATH_MAX_LENGTH = 4096;
export const PREVIEW_MAX_BYTES = 1024 * 1024;
export const EDIT_MAX_BYTES = 1024 * 1024;
export const BINARY_SNIFF_BYTES = 8 * 1024;
export const LISTING_MAX_ENTRIES = 10_000;

export type PodFileKind = 'file' | 'dir' | 'symlink' | 'other';

export type PodFileLinkTarget = 'file' | 'dir' | null;

export interface PodFileEntry {
  name: string;
  kind: PodFileKind;
  size: number | null;
  mtime: number | null;
  mode: string | null;
  owner: string | null;
  group: string | null;
  target: PodFileLinkTarget;
  linkTo: string | null;
}

export interface PodListing {
  writable: boolean;
  truncated: boolean;
  entries: PodFileEntry[];
}

export type PodMountType = 'persistent' | 'temporary' | 'config' | 'secret' | 'other';

export interface PodMount {
  path: string;
  volume: string;
  type: PodMountType;
  readOnly: boolean;
  claim: string | null;
}

export function normalizePodPath(input: unknown): string {
  const raw = typeof input === 'string' && input.trim() ? input : '/';
  if (raw.length > POD_PATH_MAX_LENGTH) throw new BadRequestException('path is too long');
  if (raw.includes('\0')) throw new BadRequestException('path contains a NUL byte');
  if (!raw.startsWith('/')) throw new BadRequestException('path must be absolute');
  const parts = raw.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) throw new BadRequestException('path must not contain ..');
  return '/' + parts.join('/');
}

export function parentPodPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

export function isWithinPodPath(path: string, root: string): boolean {
  return root === '/' || path === root || path.startsWith(`${root}/`);
}

const STAT_FORMAT = ['%s', '%Y', '%A', '%u', '%U', '%g', '%G'].join('\t');

export const LIST_SCRIPT = [
  'cd -- "$1" 2>/dev/null || exit 3',
  String.raw`if [ -w . ]; then printf 'w\0'; else printf 'r\0'; fi`,
  'S=',
  'command -v stat >/dev/null 2>&1 && command -v tr >/dev/null 2>&1 && S=1',
  'R=',
  'command -v readlink >/dev/null 2>&1 && R=1',
  'flush() {',
  `  if [ -n "$S" ] && [ $# -gt 0 ]; then stat -c '${STAT_FORMAT}' -- "$@" 2>/dev/null | tr '\\n' '\\0'; fi`,
  String.raw`  printf '#\0'`,
  '}',
  'set --',
  'n=0',
  'for f in .[!.]* ..?* *; do',
  '  [ -e "$f" ] || [ -L "$f" ] || continue',
  `  if [ "$n" -ge ${LISTING_MAX_ENTRIES} ]; then flush "$@"; printf 'T\\0'; exit 0; fi`,
  '  n=$((n + 1))',
  '  if [ -L "$f" ]; then',
  '    if [ -d "$f" ]; then t=L',
  '    elif [ -f "$f" ]; then t=l',
  '    else t=b; fi',
  '  elif [ -d "$f" ]; then t=d',
  '  elif [ -f "$f" ]; then t=f',
  '  else t=o; fi',
  String.raw`  printf '%s\t%s\0' "$t" "$f"`,
  '  case $t in',
  '    [lLb])',
  String.raw`      [ -n "$R" ] && printf '>%s\0' "$(readlink -- "./$f" 2>/dev/null)"`,
  String.raw`      [ "$t" = l ] && [ -n "$S" ] && printf '=%s\0' "$(stat -L -c %s -- "./$f" 2>/dev/null)"`,
  '      ;;',
  '  esac',
  '  set -- "$@" "./$f"',
  '  [ $# -ge 500 ] && { flush "$@"; set --; }',
  'done',
  'flush "$@"',
  'exit 0'
].join('\n');

export const DOWNLOAD_CHECK_SCRIPT = [
  'if [ -d "$1" ]; then',
  '  for t in tar gzip; do',
  `    command -v "$t" >/dev/null 2>&1 || { printf '%s' "$t"; exit 8; }`,
  '  done',
  '  [ -r "$1" ] && [ -x "$1" ] || exit 3',
  '  printf d',
  '  exit 0',
  'fi',
  '[ -f "$1" ] && [ -r "$1" ] || exit 3',
  'printf f'
].join('\n');

export const CONTENT_SCRIPT = [
  '[ -e "$1" ] || exit 3',
  '[ -d "$1" ] && exit 6',
  '[ -f "$1" ] && [ -r "$1" ] || exit 3',
  `command -v head >/dev/null 2>&1 || { printf '%s' head; exit 8; }`,
  'm=',
  `command -v stat >/dev/null 2>&1 && m=$(stat -L -c '%s %Y' -- "$1" 2>/dev/null)`,
  String.raw`printf '%s\0' "$m"`,
  'exec head -c "$2" -- "$1"'
].join('\n');

const NEAREST_DIR = [
  'while [ ! -e "$a" ] && [ ! -L "$a" ]; do',
  '  a=${a%/*}',
  '  [ -n "$a" ] || a=/',
  'done',
  '[ -d "$a" ] || exit 6',
  '[ -w "$a" ] || exit 5'
];

export const WRITE_SCRIPT = [
  'p=$1',
  'n=$2',
  'mode=$4',
  'want=$5',
  'only=',
  '[ "$mode" = check ] && { only=1; mode=$6; }',
  'd=${p%/*}',
  '[ -n "$d" ] || d=/',
  'e=',
  'if [ -e "$p" ] || [ -L "$p" ]; then',
  '  [ -d "$p" ] && exit 6',
  '  [ "$mode" = create ] && exit 4',
  '  [ -f "$p" ] || exit 6',
  '  [ -w "$p" ] || exit 5',
  '  if [ -n "$want" ] && command -v stat >/dev/null 2>&1; then',
  '    m=$(stat -L -c %Y -- "$p" 2>/dev/null)',
  '    [ -n "$m" ] && [ "$m" != "$want" ] && exit 7',
  '  fi',
  '  e=1',
  'else',
  '  [ "$mode" = edit ] && [ ! -d "$d" ] && exit 3',
  '  a=$d',
  ...NEAREST_DIR.map((line) => `  ${line}`),
  'fi',
  '[ -n "$only" ] && exit 0',
  'for c in head wc; do',
  `  command -v "$c" >/dev/null 2>&1 || { printf '%s' "$c"; exit 8; }`,
  'done',
  'mkdir -p -- "$d" 2>/dev/null || exit 5',
  'if [ -w "$d" ]; then t=$d/$3; else t=${TMPDIR:-/tmp}/$3; fi',
  '(set -C; : > "$t") 2>/dev/null || exit 5',
  `trap 'rm -f -- "$t"' EXIT`,
  `trap 'exit 1' HUP INT TERM PIPE`,
  'head -c "$n" > "$t" || exit 1',
  's=$(($(wc -c < "$t")))',
  '[ "$s" = "$n" ] || exit 9',
  'if [ -n "$e" ]; then cat -- "$t" > "$p" || exit 1; else mv -- "$t" "$p" || exit 1; fi',
  `command -v stat >/dev/null 2>&1 && stat -L -c '%s %Y' -- "$p" 2>/dev/null`,
  'exit 0'
].join('\n');

export const MKDIR_SCRIPT = [
  '[ -e "$1" ] || [ -L "$1" ] && exit 4',
  'a=${1%/*}',
  '[ -n "$a" ] || a=/',
  ...NEAREST_DIR,
  'mkdir -p -- "$1" || exit 1'
].join('\n');

const GUARD = [
  'real() {',
  '  _r=',
  '  if command -v realpath >/dev/null 2>&1; then _r=$(realpath "$1" 2>/dev/null)',
  '  elif command -v readlink >/dev/null 2>&1; then _r=$(readlink -f "$1" 2>/dev/null); fi',
  '  [ -n "$_r" ] || _r=$1',
  `  printf '%s' "$_r"`,
  '}',
  'leaf() {',
  '  _d=${1%/*}',
  '  [ -n "$_d" ] || _d=/',
  '  _d=$(real "$_d")',
  `  if [ "$_d" = / ]; then printf '/%s' "\${1##*/}"; else printf '%s/%s' "$_d" "\${1##*/}"; fi`,
  '}',
  'guard() {',
  '  _x=$1',
  '  shift',
  '  [ "$_x" = / ] && return 1',
  '  case $_x in /proc|/proc/*|/sys|/sys/*|/dev|/dev/*) return 1 ;; esac',
  '  for _m in "$@"; do',
  '    for _n in "$_m" "$(real "$_m")"; do',
  '      case $_n/ in "$_x"/*) return 1 ;; esac',
  '    done',
  '  done',
  '  return 0',
  '}'
];

export const MOVE_SCRIPT = [
  ...GUARD,
  'src=$1',
  'dst=$2',
  'shift 2',
  '[ -e "$src" ] || [ -L "$src" ] || exit 3',
  '[ -e "$dst" ] || [ -L "$dst" ] && exit 4',
  '{ guard "$src" "$@" && guard "$(leaf "$src")" "$@" && guard "$dst" && guard "$(leaf "$dst")"; } || exit 10',
  's=${src%/*}',
  '[ -n "$s" ] || s=/',
  'd=${dst%/*}',
  '[ -n "$d" ] || d=/',
  '[ -d "$d" ] || exit 3',
  '[ -w "$s" ] && [ -w "$d" ] || exit 5',
  'mv -- "$src" "$dst" || exit 1'
].join('\n');

export const DELETE_SCRIPT = [
  ...GUARD,
  'p=$1',
  'shift',
  '[ "$p" = / ] && exit 10',
  '[ -e "$p" ] || [ -L "$p" ] || exit 3',
  '{ guard "$p" "$@" && guard "$(leaf "$p")" "$@"; } || exit 10',
  'a=${p%/*}',
  '[ -n "$a" ] || a=/',
  '[ -w "$a" ] || exit 5',
  'if [ -d "$p" ] && [ ! -L "$p" ]; then',
  '  printf d',
  '  rm -rf -- "$p" || exit 1',
  'else',
  '  printf f',
  '  rm -f -- "$p" || exit 1',
  'fi'
].join('\n');

export const SCRIPT_EXIT = {
  notFound: 3,
  exists: 4,
  readOnly: 5,
  wrongKind: 6,
  modified: 7,
  missingTool: 8,
  short: 9,
  refused: 10
} as const;

const KIND_BY_CODE: Record<string, PodFileKind> = {
  f: 'file',
  d: 'dir',
  l: 'symlink',
  L: 'symlink',
  b: 'symlink',
  o: 'other'
};

const LINK_TARGET_BY_CODE: Record<string, PodFileLinkTarget> = {
  l: 'file',
  L: 'dir',
  b: null
};

const ENTRY_RECORD = /^[fdlLbo]\t/;

function applyStat(entry: PodFileEntry, line: string) {
  const [size, mtime, mode, uid, user, gid, group] = line.split('\t');
  if (entry.kind === 'file') entry.size = parseFileSize(size ?? '');
  entry.mtime = parseFileSize(mtime ?? '');
  entry.mode = mode && /^[-a-zA-Z?][-rwxsStTl?]{9}[.+@]?$/.test(mode) ? mode : null;
  entry.owner = ownerName(user, uid);
  entry.group = ownerName(group, gid);
}

function ownerName(name: string | undefined, id: string | undefined): string | null {
  if (name && name !== 'UNKNOWN') return name;
  return id && /^\d+$/.test(id) ? id : null;
}

export function parsePodListing(stdout: string): PodListing {
  const entries: PodFileEntry[] = [];
  let writable = false;
  let truncated = false;
  let batch: PodFileEntry[] = [];
  let stats: string[] = [];
  let first = true;
  for (const record of stdout.split('\0')) {
    if (first) {
      first = false;
      if (record === 'w' || record === 'r') {
        writable = record === 'w';
        continue;
      }
    }
    if (!record) continue;
    if (record === 'T') {
      truncated = true;
      continue;
    }
    if (ENTRY_RECORD.test(record)) {
      if (entries.length >= LISTING_MAX_ENTRIES) {
        truncated = true;
        continue;
      }
      const code = record[0];
      const name = record.slice(2);
      if (!name) continue;
      const kind = KIND_BY_CODE[code];
      const entry: PodFileEntry = {
        name,
        kind,
        size: null,
        mtime: null,
        mode: null,
        owner: null,
        group: null,
        target: kind === 'symlink' ? LINK_TARGET_BY_CODE[code] : null,
        linkTo: null
      };
      entries.push(entry);
      batch.push(entry);
      continue;
    }
    const last = batch[batch.length - 1];
    if (record[0] === '>') {
      if (last?.kind === 'symlink' && !stats.length) last.linkTo = record.slice(1) || null;
      continue;
    }
    if (record[0] === '=') {
      if (last?.kind === 'symlink' && last.target === 'file' && !stats.length) {
        last.size = parseFileSize(record.slice(1));
      }
      continue;
    }
    if (record === '#') {
      if (stats.length === batch.length) batch.forEach((entry, i) => applyStat(entry, stats[i]));
      batch = [];
      stats = [];
      continue;
    }
    stats.push(record);
  }
  return { writable, truncated, entries };
}

export function parseFileSize(stdout: string): number | null {
  const text = stdout.trim();
  if (!/^\d+$/.test(text)) return null;
  const size = Number(text);
  return Number.isSafeInteger(size) ? size : null;
}

export function parseSizeAndMtime(text: string): { size: number | null; mtime: number | null } {
  const [size, mtime] = text.trim().split(/\s+/);
  return { size: parseFileSize(size ?? ''), mtime: parseFileSize(mtime ?? '') };
}

export interface PodFilePreview {
  size: number | null;
  mtime: number | null;
  binary: boolean;
  truncated: boolean;
  content: string | null;
}

export function parsePreview(stdout: Buffer, limit = PREVIEW_MAX_BYTES): PodFilePreview {
  const nul = stdout.indexOf(0);
  const header = nul < 0 ? '' : stdout.subarray(0, nul).toString('utf-8');
  const body = nul < 0 ? stdout : stdout.subarray(nul + 1);
  const meta = parseSizeAndMtime(header);
  const truncated = body.length > limit;
  const bytes = truncated ? body.subarray(0, limit) : body;
  const content = bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)
    ? null
    : decodeUtf8(bytes, truncated);
  return { ...meta, binary: content === null, truncated, content };
}

function decodeUtf8(bytes: Buffer, truncated: boolean): string | null {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const tries = truncated ? Math.min(4, bytes.length + 1) : 1;
  for (let cut = 0; cut < tries; cut++) {
    try {
      return decoder.decode(bytes.subarray(0, bytes.length - cut));
    } catch {
      continue;
    }
  }
  return null;
}

export function joinPodPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function fileNameFromPath(path: string): string {
  const name = path.split('/').filter(Boolean).pop();
  return name || 'download';
}

export function contentDisposition(name: string, type: 'attachment' | 'inline'): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function attachmentDisposition(name: string): string {
  return contentDisposition(name, 'attachment');
}

const INLINE_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
};

export function inlineImageType(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(INLINE_IMAGE_TYPES, ext) ? INLINE_IMAGE_TYPES[ext] : null;
}

export const FILE_RESPONSE_CSP = "default-src 'none'; sandbox";

interface VolumeLike {
  name?: string;
  persistentVolumeClaim?: { claimName?: string } | null;
  ephemeral?: unknown;
  emptyDir?: unknown;
  configMap?: unknown;
  downwardAPI?: unknown;
  secret?: unknown;
  projected?: {
    sources?: Array<{ secret?: unknown; serviceAccountToken?: unknown } | null> | null;
  } | null;
}

interface PodLike {
  spec?: {
    volumes?: VolumeLike[] | null;
    containers?: Array<{
      name?: string;
      volumeMounts?: Array<{ name?: string; mountPath?: string; readOnly?: boolean }> | null;
    }> | null;
  } | null;
}

function classifyVolume(volume: VolumeLike | undefined): {
  type: PodMountType;
  claim: string | null;
  alwaysReadOnly: boolean;
} {
  if (!volume) return { type: 'other', claim: null, alwaysReadOnly: false };
  if (volume.persistentVolumeClaim) {
    return {
      type: 'persistent',
      claim: volume.persistentVolumeClaim.claimName ?? null,
      alwaysReadOnly: false
    };
  }
  if (volume.emptyDir || volume.ephemeral) {
    return { type: 'temporary', claim: null, alwaysReadOnly: false };
  }
  if (volume.secret) return { type: 'secret', claim: null, alwaysReadOnly: true };
  if (volume.projected) {
    const sources = volume.projected.sources ?? [];
    const secret = sources.some((s) => s?.secret || s?.serviceAccountToken);
    return { type: secret ? 'secret' : 'config', claim: null, alwaysReadOnly: true };
  }
  if (volume.configMap || volume.downwardAPI) {
    return { type: 'config', claim: null, alwaysReadOnly: true };
  }
  return { type: 'other', claim: null, alwaysReadOnly: false };
}

export function podMounts(pod: PodLike | undefined, container: string): PodMount[] {
  const spec = pod?.spec;
  const target = spec?.containers?.find((c) => c.name === container);
  const volumes = new Map((spec?.volumes ?? []).map((v) => [v.name, v]));
  const mounts: PodMount[] = [];
  for (const mount of target?.volumeMounts ?? []) {
    if (!mount.mountPath || !mount.name) continue;
    let path: string;
    try {
      path = normalizePodPath(mount.mountPath);
    } catch {
      continue;
    }
    const kind = classifyVolume(volumes.get(mount.name));
    mounts.push({
      path,
      volume: mount.name,
      type: kind.type,
      readOnly: !!mount.readOnly || kind.alwaysReadOnly,
      claim: kind.claim
    });
  }
  return mounts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function mountFor(mounts: PodMount[], path: string): PodMount | null {
  let best: PodMount | null = null;
  for (const mount of mounts) {
    if (!isWithinPodPath(path, mount.path)) continue;
    if (!best || mount.path.length > best.path.length) best = mount;
  }
  return best;
}

export const PROTECTED_ROOTS = ['/proc', '/sys', '/dev'];

export function isProtectedPath(mounts: PodMount[], path: string): boolean {
  if (path === '/') return true;
  if (PROTECTED_ROOTS.some((root) => isWithinPodPath(path, root))) return true;
  return mounts.some((mount) => isWithinPodPath(mount.path, path));
}

export interface ExecStatusLike {
  status?: string;
  message?: string;
  reason?: string;
  details?: { causes?: Array<{ reason?: string; message?: string }> | null } | null;
}

export type ExecOutcome = { kind: 'exit'; code: number } | { kind: 'no_shell' } | { kind: 'error' };

const NO_SHELL_SUBJECT = /(?:\/bin\/sh\b|["'`]sh["'`])/;
const NO_SHELL_PROBLEM =
  /no such file or directory|executable file not found|not found in \$PATH|failed to load|ENOENT/i;

export function isNoShellMessage(text: string): boolean {
  return NO_SHELL_SUBJECT.test(text) && NO_SHELL_PROBLEM.test(text);
}

export function classifyExecStatus(status: ExecStatusLike | null | undefined): ExecOutcome {
  if (status?.status === 'Success') return { kind: 'exit', code: 0 };
  const causes = status?.details?.causes ?? [];
  if (status?.reason === 'NonZeroExitCode') {
    const cause = causes.find((c) => c?.reason === 'ExitCode');
    const raw = cause?.message ?? /exit code (\d+)/.exec(status.message ?? '')?.[1];
    const code = Number(raw);
    return Number.isInteger(code) && code > 0 ? { kind: 'exit', code } : { kind: 'error' };
  }
  const text = [status?.message ?? '', ...causes.map((c) => c?.message ?? '')].join('\n');
  return isNoShellMessage(text) ? { kind: 'no_shell' } : { kind: 'error' };
}

export const POD_FILE_SLOTS_PER_USER = 8;

export class PodFileSlots {
  private readonly inFlight = new Map<string, number>();

  constructor(private readonly limit = POD_FILE_SLOTS_PER_USER) {}

  acquire(key: string): () => void {
    const used = this.inFlight.get(key) ?? 0;
    if (used >= this.limit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many file operations are running at once; try again in a moment',
          code: 'busy'
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    this.inFlight.set(key, used + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.inFlight.get(key) ?? 1) - 1;
      if (left <= 0) this.inFlight.delete(key);
      else this.inFlight.set(key, left);
    };
  }

  inUse(key: string): number {
    return this.inFlight.get(key) ?? 0;
  }
}

export function queryString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${name} must be a single value`);
  return value;
}
