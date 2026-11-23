import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';

export const apiBase = writable(browser ? '' : '');

export function initApiBase(base: string) {
	apiBase.set(base);
}

let unauthorizedHandler: ((path: string) => void) | null = null;

export function onUnauthorized(handler: (path: string) => void) {
	unauthorizedHandler = handler;
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
	const base = get(apiBase);
	const url = `${base}${path}`;

	const response = await fetch(url, {
		...options,
		credentials: 'include',
		headers: {
			...options.headers
		}
	});
	if (response.status === 401) unauthorizedHandler?.(path);
	return response;
}

export interface UploadResponse {
	status: number;
	body: unknown;
}

export function apiUpload(
	path: string,
	body: Blob,
	{
		method = 'PUT',
		onProgress,
		signal
	}: { method?: string; onProgress?: (sent: number) => void; signal?: AbortSignal } = {}
): Promise<UploadResponse> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(method, `${get(apiBase)}${path}`);
		xhr.withCredentials = true;
		xhr.responseType = 'text';
		xhr.setRequestHeader('Content-Type', 'application/octet-stream');
		xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
		xhr.onload = () => {
			if (xhr.status === 401) unauthorizedHandler?.(path);
			let parsed: unknown = null;
			try {
				parsed = xhr.responseText ? JSON.parse(xhr.responseText) : null;
			} catch {
				parsed = xhr.responseText;
			}
			resolve({ status: xhr.status, body: parsed });
		};
		xhr.onerror = () => reject(new Error('The upload lost its connection'));
		xhr.onabort = () => reject(new DOMException('Upload canceled', 'AbortError'));
		if (signal) {
			if (signal.aborted) return reject(new DOMException('Upload canceled', 'AbortError'));
			signal.addEventListener('abort', () => xhr.abort(), { once: true });
		}
		xhr.send(body);
	});
}
