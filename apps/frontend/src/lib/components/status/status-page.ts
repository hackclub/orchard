export type ComponentStatus = 'operational' | 'degraded' | 'down' | 'maintenance' | 'unknown';
export type OverallStatus = 'operational' | 'degraded' | 'down';

export interface PublicComponent {
	id: string;
	kind: 'deployment' | 'database';
	name: string;
	status: ComponentStatus;
	detail: string | null;
	since: string | null;
	uptime: number;
	days: { day: string; status: 'operational' | 'degraded' | 'down' | 'none' }[];
}

export interface PublicIncident {
	componentId: string;
	componentName: string;
	startedAt: string;
	endedAt: string | null;
}

export interface PublicStatusPage {
	slug: string;
	title: string;
	description: string | null;
	organization: string;
	overall: OverallStatus;
	updatedAt: string;
	components: PublicComponent[];
	incidents: PublicIncident[];
}

export type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral' | 'progress';

export function overallCopy(overall: OverallStatus): { label: string; tone: Tone } {
	switch (overall) {
		case 'down':
			return { label: 'Major outage', tone: 'error' };
		case 'degraded':
			return { label: 'Partial outage', tone: 'warning' };
		default:
			return { label: 'All systems operational', tone: 'success' };
	}
}

export function componentCopy(status: ComponentStatus): { label: string; tone: Tone } {
	switch (status) {
		case 'down':
			return { label: 'Outage', tone: 'error' };
		case 'degraded':
			return { label: 'Degraded', tone: 'warning' };
		case 'maintenance':
			return { label: 'Maintenance', tone: 'info' };
		case 'unknown':
			return { label: 'No data', tone: 'neutral' };
		default:
			return { label: 'Operational', tone: 'success' };
	}
}

export function statusApiUrl(
	slug: string,
	hostname: string,
	baseDomain: string,
	platformOrigin = ''
): string {
	const path = `/apiv1/status/${encodeURIComponent(slug)}`;
	if (baseDomain && hostname !== baseDomain && hostname.endsWith(`.${baseDomain}`)) {
		return `${platformOrigin || `https://${baseDomain}`}${path}`;
	}
	return path;
}

export function durationLabel(startedAt: string, endedAt: string | null, now: number): string {
	const end = endedAt ? Date.parse(endedAt) : now;
	const mins = Math.max(1, Math.round((end - Date.parse(startedAt)) / 60_000));
	if (mins < 60) return `${mins} min`;
	const hours = Math.floor(mins / 60);
	const rest = mins % 60;
	if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
	const days = Math.floor(hours / 24);
	return `${days} d ${hours % 24} h`;
}

export function uptimeLabel(pct: number): string {
	return pct >= 99.995 ? '100%' : `${pct.toFixed(2)}%`;
}

export const STATUS_UNREACHABLE = "Couldn't reach the status service, retrying…";
export const STATUS_FAILING = 'The status service had a problem, retrying…';
export const STATUS_MISSING = 'There is no status page here.';
export const STATUS_RETRY_DELAYS_MS = [1_000, 3_000];
export const STATUS_ATTEMPT_TIMEOUT_MS = 10_000;

export class StatusHttpError extends Error {
	constructor(readonly status: number) {
		super(`status ${status}`);
	}
}

export type StatusLoadResult =
	| { kind: 'ok'; page: PublicStatusPage }
	| { kind: 'missing' }
	| { kind: 'failed'; message: string };

export function isTransientStatusError(e: unknown): boolean {
	if (!(e instanceof StatusHttpError)) return true;
	return e.status >= 500 || e.status === 429;
}

function isUnreachable(e: unknown): boolean {
	if (e instanceof TypeError) return true;
	const name = (e as { name?: unknown } | null)?.name;
	return name === 'TimeoutError' || name === 'AbortError';
}

export function statusErrorMessage(e: unknown): string {
	return isUnreachable(e) ? STATUS_UNREACHABLE : STATUS_FAILING;
}

export async function loadStatusPage(
	url: string,
	opts: {
		fetch?: typeof fetch;
		sleep?: (ms: number) => Promise<void>;
		delays?: readonly number[];
		timeoutMs?: number;
	} = {}
): Promise<StatusLoadResult> {
	const doFetch = opts.fetch ?? fetch;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const delays = opts.delays ?? STATUS_RETRY_DELAYS_MS;
	const timeoutMs = opts.timeoutMs ?? STATUS_ATTEMPT_TIMEOUT_MS;
	let last: unknown;
	for (let attempt = 0; attempt <= delays.length; attempt++) {
		try {
			const res = await doFetch(url, {
				credentials: 'omit',
				signal: AbortSignal.timeout(timeoutMs)
			});
			if (res.status === 404) return { kind: 'missing' };
			if (!res.ok) throw new StatusHttpError(res.status);
			return { kind: 'ok', page: (await res.json()) as PublicStatusPage };
		} catch (e) {
			last = e;
			if (!isTransientStatusError(e) || attempt === delays.length) break;
			await sleep(delays[attempt]);
		}
	}
	return { kind: 'failed', message: statusErrorMessage(last) };
}
