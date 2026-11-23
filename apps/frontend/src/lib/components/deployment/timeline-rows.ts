import type { ImageHistory } from '$lib/types/deployment';

export type TimelineKind = 'audit' | 'build' | 'release' | 'pod' | 'error';
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

export interface TimelinePage {
	entries: TimelineEntry[];
	nextCursor: string | null;
}

export type TimelineFilter = 'all' | 'deploys' | 'changes' | 'pods' | 'errors';

export const TIMELINE_FILTERS: { value: TimelineFilter; label: string; hint: string }[] = [
	{ value: 'deploys', label: 'Deploys', hint: 'Releases and builds' },
	{ value: 'all', label: 'Everything', hint: 'Everything that happened to this app' },
	{ value: 'changes', label: 'Changes', hint: 'Settings and actions by people' },
	{ value: 'pods', label: 'Pods', hint: 'Pod lifecycle from Kubernetes' },
	{ value: 'errors', label: 'Errors', hint: 'New error groups' }
];

export const DEFAULT_FILTER: TimelineFilter = 'deploys';

export interface DayGroup<T> {
	key: string;
	label: string;
	entries: T[];
}

function sameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

function dayKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dayLabel(at: string, now: number = Date.now()): string {
	const d = new Date(at);
	const n = new Date(now);
	if (sameDay(d, n)) return 'Today';
	const y = new Date(n);
	y.setDate(n.getDate() - 1);
	if (sameDay(d, y)) return 'Yesterday';
	const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
	if (d.getFullYear() !== n.getFullYear()) opts.year = 'numeric';
	return d.toLocaleDateString('en-GB', opts);
}

export function groupByDay<T extends { at: string }>(
	entries: readonly T[],
	now: number = Date.now()
): DayGroup<T>[] {
	const groups = new Map<string, DayGroup<T>>();
	for (const entry of entries) {
		const key = dayKey(new Date(entry.at));
		const group = groups.get(key);
		if (group) group.entries.push(entry);
		else groups.set(key, { key, label: dayLabel(entry.at, now), entries: [entry] });
	}
	return [...groups.values()];
}

export function monthLabel(at: string, now: number = Date.now()): string {
	const d = new Date(at);
	const n = new Date(now);
	if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth()) return 'This month';
	const opts: Intl.DateTimeFormatOptions = { month: 'long' };
	if (d.getFullYear() !== n.getFullYear()) opts.year = 'numeric';
	return d.toLocaleDateString('en-GB', opts);
}

export function groupByMonth<T extends { at: string }>(
	entries: readonly T[],
	now: number = Date.now()
): DayGroup<T>[] {
	const groups = new Map<string, DayGroup<T>>();
	for (const entry of entries) {
		const d = new Date(entry.at);
		const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
		const group = groups.get(key);
		if (group) group.entries.push(entry);
		else groups.set(key, { key, label: monthLabel(entry.at, now), entries: [entry] });
	}
	return [...groups.values()];
}

export type Granularity = 'day' | 'month';

export function granularityFor(filter: TimelineFilter): Granularity {
	return filter === 'changes' ? 'month' : 'day';
}

export function groupEntries<T extends { at: string }>(
	entries: readonly T[],
	granularity: Granularity,
	now: number = Date.now()
): DayGroup<T>[] {
	return granularity === 'month' ? groupByMonth(entries, now) : groupByDay(entries, now);
}

export type DisplayEntry = TimelineEntry & {
	steps?: string[];
	count?: number;
	folded?: DisplayEntry[];
};

export function headline(entry: TimelineEntry): string {
	if (entry.kind !== 'build' && entry.kind !== 'release') return entry.title;
	const message = entry.meta.commitMessage;
	if (typeof message !== 'string') return entry.title;
	return message.split('\n')[0].trim() || entry.title;
}

function foldable(entry: DisplayEntry): string | null {
	if (entry.kind !== 'build') return null;
	const status = entry.meta.buildStatus;
	if (status === 'failed') return 'failed';
	if (status === 'skipped' || status === 'canceled') return 'skipped';
	return null;
}

export function foldBuildRuns(entries: readonly DisplayEntry[], min = 3): DisplayEntry[] {
	const out: DisplayEntry[] = [];
	let run: DisplayEntry[] = [];
	const flush = () => {
		if (run.length >= min) out.push({ ...run[0], id: `fold:${run[0].id}`, folded: run });
		else out.push(...run);
		run = [];
	};
	for (const entry of entries) {
		const kind = foldable(entry);
		if (run.length && (!kind || kind !== foldable(run[0]))) flush();
		if (kind) run.push(entry);
		else out.push(entry);
	}
	flush();
	return out;
}

export function foldTitle(entry: DisplayEntry): string {
	const n = entry.folded?.length ?? 0;
	return foldable(entry) === 'failed' ? `${n} builds failed` : `${n} builds skipped`;
}

export function collapsePodRuns(entries: readonly TimelineEntry[]): DisplayEntry[] {
	const out: DisplayEntry[] = [];
	for (const entry of entries) {
		const prev = out[out.length - 1];
		if (
			entry.kind === 'pod' &&
			prev?.kind === 'pod' &&
			typeof entry.meta.podName === 'string' &&
			prev.meta.podName === entry.meta.podName
		) {
			prev.steps = [String(entry.meta.toStatus), ...(prev.steps ?? [String(prev.meta.toStatus)])];
			prev.count = (prev.count ?? 1) + 1;
			continue;
		}
		out.push({ ...entry });
	}
	return out;
}

export function releaseEnds(entries: readonly TimelineEntry[]): {
	live: TimelineEntry | null;
	previous: TimelineEntry | null;
} {
	const releases = entries.filter((e) => e.kind === 'release');
	const liveIdx = releases.findIndex((r) => r.meta.isActive === true);
	const idx = liveIdx >= 0 ? liveIdx : releases.length ? 0 : -1;
	if (idx < 0) return { live: null, previous: null };
	return { live: releases[idx], previous: releases[idx + 1] ?? null };
}

export function buildStartedAt(
	timestamps: Record<string, number> | null | undefined
): string | null {
	const values = Object.values(timestamps ?? {}).filter(
		(v): v is number => typeof v === 'number' && v > 0
	);
	if (values.length === 0) return null;
	return new Date(Math.min(...values)).toISOString();
}

export function humanizeStep(step: string | null | undefined): string {
	if (!step) return 'Starting';
	const words = step.replace(/[_-]+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

export function shortRef(entry: TimelineEntry | null): string | null {
	if (!entry) return null;
	const sha = entry.meta.commitSha;
	if (typeof sha === 'string' && sha) return sha.slice(0, 7);
	const tag = entry.meta.tag;
	if (typeof tag === 'string' && tag) return tag;
	const image = entry.meta.image;
	if (typeof image === 'string' && image) return image.split(':').pop() ?? image;
	return null;
}

const FILTER_KINDS: Record<TimelineFilter, TimelineKind[]> = {
	all: [],
	deploys: ['release', 'build'],
	changes: ['audit'],
	pods: ['pod'],
	errors: ['error']
};

export function filterKinds(filter: TimelineFilter): string {
	return FILTER_KINDS[filter].join(',');
}

export function flattenPages(pages: readonly TimelinePage[] | undefined): TimelineEntry[] {
	if (!pages) return [];
	const seen = new Set<string>();
	const out: TimelineEntry[] = [];
	for (const page of pages) {
		for (const entry of page.entries) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			out.push(entry);
		}
	}
	return out;
}

function firstLine(text: string | null | undefined): string | null {
	if (!text) return null;
	const line = text.split('\n')[0].trim();
	return line || null;
}

export function seedFromImageHistory(
	history: readonly ImageHistory[] | undefined,
	repoUrl: string | null | undefined
): TimelinePage {
	const repo = repoUrl?.replace(/\.git$/, '') ?? null;
	const entries = (history ?? []).map((h): TimelineEntry => {
		const commit = firstLine(h.commitMessage);
		const sha = h.commitSha ? h.commitSha.slice(0, 7) : null;
		return {
			id: `release:${h.id}`,
			at: h.createdAt,
			kind: 'release',
			actor: h.triggeredBy
				? {
						id: h.triggeredBy.id,
						username: h.triggeredBy.username,
						email: null,
						firstName: h.triggeredBy.firstName ?? null,
						lastName: h.triggeredBy.lastName ?? null,
						imageUrl: null
					}
				: null,
			title: commit ?? h.image.split(':').pop() ?? h.image,
			detail: [h.branch, sha].filter(Boolean).join(' · ') || h.image,
			status: 'success',
			href: repo && h.commitSha ? `${repo}/commit/${h.commitSha}` : null,
			meta: {
				imageHistoryId: h.id,
				image: h.image,
				commitSha: h.commitSha ?? null,
				commitMessage: h.commitMessage ?? null,
				commitAuthorName: h.commitAuthorName ?? null,
				commitAuthorUsername: h.commitAuthorUsername ?? null,
				branch: h.branch ?? null,
				triggerType: h.triggerType ?? null,
				isActive: h.isActive,
				buildStartedAt: h.buildStartedAt ?? null,
				buildCompletedAt: h.buildCompletedAt ?? null
			}
		};
	});
	entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
	return { entries, nextCursor: null };
}

export function newlyArrived(
	previous: ReadonlySet<string> | null,
	entries: readonly TimelineEntry[],
	notBefore: number
): string[] {
	if (!previous) return [];
	return entries
		.filter((e) => !previous.has(e.id) && Date.parse(e.at) >= notBefore)
		.map((e) => e.id);
}

export function newestAt(entries: readonly TimelineEntry[]): number {
	let max = 0;
	for (const e of entries) {
		const t = Date.parse(e.at);
		if (t > max) max = t;
	}
	return max;
}

const AUDIT_CATEGORIES: [string, string][] = [
	['deployment.env', 'Env'],
	['deployment.volume', 'Storage'],
	['deployment.health_check', 'Health'],
	['deployment.build', 'Build'],
	['deployment.autodeploy', 'Build'],
	['deployment.github_repo', 'Source'],
	['deployment.pod.file', 'Files'],
	['deployment.pod.exec', 'Terminal'],
	['deployment.webhook', 'Webhook'],
	['webhook_token', 'Webhook'],
	['ingress', 'Domain'],
	['service', 'Network'],
	['environment', 'Env'],
	['deployment', 'App']
];

export function auditCategory(action: unknown): string {
	if (typeof action !== 'string') return 'Change';
	for (const [prefix, label] of AUDIT_CATEGORIES) {
		if (action === prefix || action.startsWith(`${prefix}.`) || action.startsWith(`${prefix}_`)) {
			return label;
		}
	}
	return 'Change';
}

export interface EntryBadge {
	kind: TimelineStatus;
	label: string;
	pulse: boolean;
}

export function entryBadge(entry: TimelineEntry): EntryBadge {
	const tone = entry.status ?? 'neutral';
	switch (entry.kind) {
		case 'release':
			return entry.meta.isActive
				? { kind: 'success', label: 'Live', pulse: false }
				: { kind: 'neutral', label: 'Ready', pulse: false };
		case 'build':
			switch (entry.meta.buildStatus) {
				case 'scheduled':
					return { kind: 'info', label: 'Queued', pulse: true };
				case 'building':
					return { kind: 'progress', label: 'Building', pulse: true };
				case 'failed':
					return { kind: 'error', label: 'Failed', pulse: false };
				case 'canceled':
					return { kind: 'neutral', label: 'Canceled', pulse: false };
				case 'skipped':
				default:
					return { kind: 'neutral', label: 'Superseded', pulse: false };
			}
		case 'audit':
			return { kind: tone, label: auditCategory(entry.meta.action), pulse: false };
		case 'pod': {
			const word = entry.title.replace(/^Pod\s+/, '');
			return {
				kind: tone,
				label: word.charAt(0).toUpperCase() + word.slice(1),
				pulse: false
			};
		}
		case 'error':
			return { kind: 'error', label: 'Error', pulse: false };
		default:
			return { kind: tone, label: entry.kind, pulse: false };
	}
}

export function actorLabel(entry: TimelineEntry): string | null {
	const a = entry.actor;
	if (a) {
		if (a.username) return `@${a.username}`;
		const name = [a.firstName, a.lastName].filter(Boolean).join(' ');
		if (name) return name;
		if (a.email) return a.email;
	}
	const gitUser = entry.meta.commitAuthorUsername;
	if (typeof gitUser === 'string' && gitUser) return `@${gitUser}`;
	const gitName = entry.meta.commitAuthorName;
	if (typeof gitName === 'string' && gitName) return gitName;
	const actorEmail = entry.meta.actorEmail;
	if (typeof actorEmail === 'string' && actorEmail) return actorEmail;
	return null;
}

export function originLabel(entry: TimelineEntry): string {
	const who = actorLabel(entry);
	if (entry.kind === 'pod') return 'from Kubernetes';
	if (entry.kind === 'error') return 'first seen';
	if (entry.kind === 'release' || entry.kind === 'build') {
		if (entry.meta.triggerType === 'auto') return who ? `push by ${who}` : 'via GitHub';
		if (entry.meta.triggerType === 'initial') return who ? `by ${who}` : 'first deploy';
		return who ? `by ${who}` : 'manual';
	}
	return who ? `by ${who}` : 'by the platform';
}

export function hasBuildEntry(
	entries: readonly TimelineEntry[],
	status: 'building' | 'failed' | 'scheduled'
): boolean {
	return entries.some((e) => e.kind === 'build' && e.meta.buildStatus === status);
}

export function newestBuildEntryId(
	entries: readonly TimelineEntry[],
	status: 'building' | 'failed'
): string | null {
	const found = entries.find((e) => e.kind === 'build' && e.meta.buildStatus === status);
	return found?.id ?? null;
}
