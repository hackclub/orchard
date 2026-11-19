import { BadRequestException } from '@nestjs/common';

export const POD_PATH_MAX_LENGTH = 4096;

export type PodFileKind = 'file' | 'dir' | 'symlink' | 'other';

export interface PodFileEntry {
  name: string;
  kind: PodFileKind;
  size: number | null;
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

export const LIST_SCRIPT = [
  'cd "$1" 2>/dev/null || exit 3',
  String.raw`size_batch() { stat -c %s "$@" | tr '\n' '\0'; }`,
  'set --',
  'for f in .[!.]* ..?* *; do',
  '  [ -e "$f" ] || [ -L "$f" ] || continue',
  '  if [ -L "$f" ]; then t=l',
  '  elif [ -d "$f" ]; then t=d',
  '  elif [ -f "$f" ] && [ -r "$f" ]; then t=f; set -- "$@" "./$f"',
  '  else t=o; fi',
  '  printf "%s\\t%s\\0" "$t" "$f"',
  '  [ $# -ge 500 ] && { size_batch "$@"; set --; }',
  'done',
  '[ $# -gt 0 ] && size_batch "$@"',
  'exit 0'
].join('\n');

export const STAT_FILE_SCRIPT = '[ -f "$1" ] && [ -r "$1" ] || exit 3';

const KIND_BY_CODE: Record<string, PodFileKind> = {
  f: 'file',
  d: 'dir',
  l: 'symlink',
  o: 'other'
};

export function parsePodListing(stdout: string): PodFileEntry[] {
  const entries: PodFileEntry[] = [];
  const sizes: string[] = [];
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) {
      sizes.push(record);
      continue;
    }
    const kind = KIND_BY_CODE[record.slice(0, tab)];
    const name = record.slice(tab + 1);
    if (!kind || !name) continue;
    entries.push({ name, kind, size: null });
  }
  const files = entries.filter((entry) => entry.kind === 'file');
  if (sizes.length === files.length) {
    files.forEach((entry, i) => {
      entry.size = parseFileSize(sizes[i]);
    });
  }
  return entries;
}

export function parseFileSize(stdout: string): number | null {
  const text = stdout.trim();
  if (!/^\d+$/.test(text)) return null;
  const size = Number(text);
  return Number.isSafeInteger(size) ? size : null;
}

export function joinPodPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function fileNameFromPath(path: string): string {
  const name = path.split('/').filter(Boolean).pop();
  return name || 'download';
}

export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
