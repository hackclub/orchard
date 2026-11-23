import { get } from 'svelte/store';
import { apiBase, apiFetch, apiUpload } from '$lib/stores/api';
import {
	parseFileError,
	type PodFileContent,
	type PodFileError,
	type PodFileStat,
	type PodListing
} from '$lib/utils/pod-files';

export interface PodTarget {
	pod: string;
	namespace: string;
	container: string;
}

export class PodFileRequestError extends Error {
	readonly info: PodFileError;

	constructor(info: PodFileError) {
		super(info.message);
		this.info = info;
	}
}

export function fileErrorOf(error: unknown): PodFileError {
	if (error instanceof PodFileRequestError) return error.info;
	const message = error instanceof Error ? error.message : 'Something went wrong';
	return { status: 0, code: null, message, tool: null };
}

type Route = '' | '/content' | '/download' | '/upload' | '/mkdir' | '/move';

function filesPath(target: PodTarget, route: Route, params: Record<string, string>): string {
	const query = new URLSearchParams({ namespace: target.namespace });
	if (target.container) query.set('container', target.container);
	for (const [key, value] of Object.entries(params)) query.set(key, value);
	return `/apiv1/pods/${encodeURIComponent(target.pod)}/files${route}?${query.toString()}`;
}

async function readBody(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

async function call<T>(
	method: string,
	route: Route,
	target: PodTarget,
	params: Record<string, string>,
	json?: unknown
): Promise<T> {
	const res = await apiFetch(filesPath(target, route, params), {
		method,
		...(json === undefined
			? {}
			: { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) })
	});
	const body = await readBody(res);
	if (!res.ok) throw new PodFileRequestError(parseFileError(res.status, body, res.statusText));
	return body as T;
}

export function listFolder(target: PodTarget, path: string) {
	return call<PodListing>('GET', '', target, { path });
}

export function readFile(target: PodTarget, path: string) {
	return call<PodFileContent>('GET', '/content', target, { path });
}

export function writeFile(
	target: PodTarget,
	path: string,
	content: string,
	expectedMtime: number | null
) {
	return call<PodFileStat>('PUT', '/content', target, { path }, { content, expectedMtime });
}

export function makeFolder(target: PodTarget, path: string) {
	return call<unknown>('POST', '/mkdir', target, { path });
}

export function moveEntry(target: PodTarget, path: string, to: string) {
	return call<unknown>('POST', '/move', target, { path, to });
}

export function deleteEntry(target: PodTarget, path: string) {
	return call<unknown>('DELETE', '', target, { path });
}

export async function downloadArchive(target: PodTarget, path: string): Promise<Blob> {
	const res = await apiFetch(filesPath(target, '/download', { path }));
	if (!res.ok) {
		throw new PodFileRequestError(parseFileError(res.status, await readBody(res), res.statusText));
	}
	return res.blob();
}

export function downloadUrl(target: PodTarget, path: string, inline = false): string {
	return `${get(apiBase)}${filesPath(target, '/download', inline ? { path, inline: '1' } : { path })}`;
}

export async function uploadFile(
	target: PodTarget,
	path: string,
	file: Blob,
	{
		overwrite,
		onProgress,
		signal
	}: { overwrite: boolean; onProgress?: (sent: number) => void; signal?: AbortSignal }
): Promise<PodFileStat> {
	const res = await apiUpload(
		filesPath(target, '/upload', { path, overwrite: overwrite ? '1' : '0' }),
		file,
		{ onProgress, signal }
	);
	if (res.status < 200 || res.status >= 300) {
		throw new PodFileRequestError(parseFileError(res.status, res.body));
	}
	return res.body as PodFileStat;
}
