export type TimelineKind = 'audit' | 'build' | 'release' | 'pod' | 'error';

export const TIMELINE_KINDS: readonly TimelineKind[] = [
  'audit',
  'build',
  'release',
  'pod',
  'error'
];

export type TimelineStatus = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'progress';

export interface TimelineActor {
  id: string;
  username: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
}

export interface TimelineEntry {
  id: string;
  at: string;
  kind: TimelineKind;
  actor: TimelineActor | null;
  title: string;
  detail: string | null;
  status: TimelineStatus | null;
  href: string | null;
  meta: Record<string, unknown>;
}

export interface TimelineCursor {
  at: number;
  id: string;
}

export interface TimelinePage {
  entries: TimelineEntry[];
  nextCursor: string | null;
}

interface Described {
  title: string;
  detail: string | null;
  status: TimelineStatus | null;
}

const DETAIL_MAX = 240;

export function entryId(kind: TimelineKind, rowId: string): string {
  return `${kind}:${rowId}`;
}

export function encodeCursor(cursor: TimelineCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | null | undefined): TimelineCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.at !== 'number' ||
      !Number.isFinite(parsed.at) ||
      typeof parsed.id !== 'string' ||
      !parsed.id
    ) {
      return null;
    }
    return { at: parsed.at, id: parsed.id };
  } catch {
    return null;
  }
}

export function parseKinds(raw: string | string[] | undefined): TimelineKind[] {
  const list = Array.isArray(raw) ? raw : raw ? raw.split(',') : [];
  const out: TimelineKind[] = [];
  for (const item of list) {
    const k = item.trim() as TimelineKind;
    if (TIMELINE_KINDS.includes(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

export function compareEntries(
  a: { at: string | number; id: string },
  b: { at: string | number; id: string }
): number {
  const ta = typeof a.at === 'number' ? a.at : Date.parse(a.at);
  const tb = typeof b.at === 'number' ? b.at : Date.parse(b.at);
  if (ta !== tb) return tb - ta;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export function isBeforeCursor(entry: { at: string; id: string }, cursor: TimelineCursor): boolean {
  const t = Date.parse(entry.at);
  if (t < cursor.at) return true;
  if (t > cursor.at) return false;
  return entry.id < cursor.id;
}

export function mergeTimeline(
  sources: TimelineEntry[][],
  opts: { limit: number; cursor?: TimelineCursor | null }
): TimelinePage {
  const { limit } = opts;
  const cursor = opts.cursor ?? null;
  let anySourceOverflowed = false;
  const merged: TimelineEntry[] = [];
  for (const source of sources) {
    if (source.length > limit) anySourceOverflowed = true;
    for (const entry of source) {
      if (cursor && !isBeforeCursor(entry, cursor)) continue;
      merged.push(entry);
    }
  }
  merged.sort(compareEntries);
  const page = merged.slice(0, limit);
  const hasMore = merged.length > limit || anySourceOverflowed;
  const last = page[page.length - 1];
  return {
    entries: page,
    nextCursor: hasMore && last ? encodeCursor({ at: Date.parse(last.at), id: last.id }) : null
  };
}

function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text.split('\n')[0].trim();
  return line || null;
}

function clip(text: string | null): string | null {
  if (!text) return null;
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;
}

function humanize(action: string): string {
  const words = action
    .replace(/^deployment\./, '')
    .split(/[._]/)
    .filter(Boolean)
    .join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const AUDIT_TITLES: Record<string, string> = {
  'deployment.created': 'App created',
  'deployment.deleted': 'App deleted',
  'deployment.renamed': 'Renamed',
  'deployment.env.updated': 'Environment variables updated',
  'deployment.scaled': 'Scaled',
  'deployment.restarted': 'Restarted',
  'deployment.redeployed': 'Redeploy requested',
  'deployment.rolled_back': 'Rolled back',
  'deployment.started': 'Started',
  'deployment.stopped': 'Stopped',
  'deployment.push_held': 'Push held while stopped',
  'deployment.build_cancelled': 'Build cancelled',
  'deployment.build_options.updated': 'Build settings updated',
  'deployment.health_check.updated': 'Health check updated',
  'deployment.github_repo.updated': 'Repository changed',
  'deployment.autodeploy.enabled': 'Auto deploy enabled',
  'deployment.autodeploy.disabled': 'Auto deploy disabled',
  'deployment.volumes.updated': 'Volumes updated',
  'deployment.resources.updated': 'Resources changed',
  'deployment.image.updated': 'Image changed',
  'deployment.image.pulled': 'Image updated',
  'deployment.image_auto_update.enabled': 'Image auto-update enabled',
  'deployment.image_auto_update.disabled': 'Image auto-update disabled',
  'deployment.strategy.updated': 'Deploy strategy changed',
  'deployment.pull_policy.updated': 'Pull policy changed',
  'deployment.devices.updated': 'Devices changed',
  'deployment.placement.updated': 'Placement changed',
  'deployment.disruption_budget.updated': 'Disruption budget changed',
  'deployment.volume.rejected': 'Volume rejected',
  'deployment.webhook_triggered': 'Deploy webhook triggered',
  'ingress.created': 'Domain added',
  'ingress.updated': 'Domain updated',
  'ingress.deleted': 'Domain removed',
  'service.port.public_enabled': 'Public port enabled',
  'service.port.public_disabled': 'Public port disabled',
  'webhook_token.created': 'Webhook token created',
  'webhook_token.deleted': 'Webhook token deleted'
};

const NEGATIVE_SUFFIX = /(deleted|removed|rejected|cancelled|canceled|disabled|stopped|failed)$/;

function formatMetaValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'none';
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const NOISY_META_KEYS = new Set(['repo', 'repoUrl', 'githubRepo', 'namespace', 'deploymentId']);

function unitOf(key: string): { name: string; format: (v: unknown) => string } {
  if (key.endsWith('Bytes')) {
    return {
      name: key.replace(/Bytes$/, ''),
      format: (v) => {
        if (v == null) return 'default';
        if (typeof v !== 'number') return formatMetaValue(v);
        if (v === 0) return 'unlimited';
        const mb = v / (1024 * 1024);
        return mb >= 1024
          ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB`
          : `${Math.round(mb)} MB`;
      }
    };
  }
  if (key.endsWith('Milli')) {
    return {
      name: key.replace(/Milli$/, ''),
      format: (v) => {
        if (v == null) return 'default';
        if (typeof v !== 'number') return formatMetaValue(v);
        if (v === 0) return 'unlimited';
        return v >= 1000 ? `${v / 1000} CPU` : `${v}m`;
      }
    };
  }
  return { name: key, format: formatMetaValue };
}

export function describeAuditMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (NOISY_META_KEYS.has(key)) continue;
    const { name, format } = unitOf(key);
    if (Array.isArray(value) && value.length === 2) {
      if (value[0] === value[1]) continue;
      parts.push(`${name} ${format(value[0])} → ${format(value[1])}`);
    } else if (value !== null && value !== undefined && value !== '') {
      parts.push(`${name} ${format(value)}`);
    }
  }
  return parts.length ? clip(parts.join(' · ')) : null;
}

export function describeAudit(row: {
  action: string;
  targetType?: string | null;
  targetLabel: string | null;
  metadata: unknown;
}): Described {
  const title = AUDIT_TITLES[row.action] ?? humanize(row.action);
  const meta = describeAuditMetadata(row.metadata);
  const ownTarget = row.targetType === 'deployment' || row.action.startsWith('deployment.');
  const label = !ownTarget && row.targetLabel && row.targetLabel !== title ? row.targetLabel : null;
  const detail = clip([label, meta].filter(Boolean).join(' · ')) || null;
  const status: TimelineStatus = NEGATIVE_SUFFIX.test(row.action) ? 'warning' : 'info';
  return { title, detail, status };
}

export function describeBuildRun(run: {
  status: string;
  detail: string | null;
  commitMessage: string | null;
}): Described {
  const commit = firstLine(run.commitMessage);
  switch (run.status) {
    case 'scheduled':
      return {
        title: 'Build queued',
        detail: commit ?? 'Waiting for a build slot',
        status: 'info'
      };
    case 'building':
      return { title: 'Building', detail: commit, status: 'progress' };
    case 'failed':
      return {
        title: 'Build failed',
        detail: clip(firstLine(run.detail) ?? commit),
        status: 'error'
      };
    case 'skipped':
      return {
        title: 'Build skipped',
        detail: clip(firstLine(run.detail) ?? 'Superseded by a newer build'),
        status: 'neutral'
      };
    case 'canceled':
      return {
        title: 'Build canceled',
        detail: clip(firstLine(run.detail) ?? commit),
        status: 'neutral'
      };
    case 'succeeded':
      return { title: 'Build succeeded', detail: commit, status: 'success' };
    default:
      return { title: humanize(`build.${run.status}`), detail: commit, status: 'neutral' };
  }
}

export function describeRelease(history: {
  tag: string;
  image: string;
  branch: string | null;
  commitSha: string | null;
  commitMessage: string | null;
}): Described {
  const commit = firstLine(history.commitMessage);
  const title = commit ?? history.tag;
  const sha = history.commitSha ? history.commitSha.slice(0, 7) : null;
  const detail = [history.branch, sha].filter(Boolean).join(' · ') || history.image;
  return { title: clip(title) ?? title, detail: clip(detail), status: 'success' };
}

const POD_TITLES: Record<string, [string, TimelineStatus]> = {
  crashing: ['Pod crashing', 'error'],
  failed: ['Pod failed', 'error'],
  ready: ['Pod ready', 'success'],
  starting: ['Pod starting', 'progress'],
  scheduled: ['Pod scheduled', 'info'],
  pending: ['Pod pending', 'info'],
  terminating: ['Pod terminating', 'neutral'],
  deleted: ['Pod removed', 'neutral'],
  succeeded: ['Pod completed', 'neutral'],
  unknown: ['Pod unknown', 'warning']
};

export function describePodTransition(t: {
  podName: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string | null;
  exitCode: number | null;
}): Described {
  const [title, status] = POD_TITLES[t.toStatus] ?? [`Pod ${t.toStatus}`, 'neutral'];
  const bits = [t.podName];
  if (t.reason && (t.toStatus === 'crashing' || t.toStatus === 'failed')) bits.push(t.reason);
  if (
    t.exitCode !== null &&
    t.exitCode !== undefined &&
    (t.toStatus === 'crashing' || t.toStatus === 'failed')
  ) {
    bits.push(`exit ${t.exitCode}`);
  }
  return { title, detail: clip(bits.join(' · ')), status };
}

const GENERIC_ERROR_TYPES = new Set(['error', 'exception', 'unknown', '']);

export function describeErrorGroup(g: { type: string; message: string }): Described {
  const generic = GENERIC_ERROR_TYPES.has(g.type.trim().toLowerCase());
  const message = firstLine(g.message);
  if (generic) {
    return { title: clip(message ?? 'New error') ?? 'New error', detail: null, status: 'error' };
  }
  return { title: clip(`New error: ${g.type}`) ?? g.type, detail: clip(message), status: 'error' };
}

export function commitHref(repoUrl: string | null, sha: string | null): string | null {
  if (!repoUrl || !sha) return null;
  return `${repoUrl.replace(/\.git$/, '')}/commit/${sha}`;
}
