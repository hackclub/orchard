import { describeFileError, uploadProgress, type UploadPlan } from '$lib/utils/pod-files';
import { fileErrorOf, makeFolder, uploadFile, type PodTarget } from './pod-files-client';

export const UPLOAD_LIMIT = 512 * 1024 * 1024;
const PARALLEL = 3;

export type UploadStatus = 'waiting' | 'uploading' | 'done' | 'failed' | 'conflict' | 'canceled';

export interface UploadItem {
	id: number;
	name: string;
	target: string;
	size: number;
	sent: number;
	status: UploadStatus;
	error: string | null;
	overwrite: boolean;
	file: File;
}

export interface UploadBatch {
	plan: UploadPlan;
	files: Map<string, File>;
	dir: string;
}

let nextId = 1;

export class UploadQueue {
	items = $state<UploadItem[]>([]);
	dir = $state('/');
	private folders: string[] = [];
	private controllers = new Map<number, AbortController>();
	private running = 0;
	private busy = false;
	private target: () => PodTarget;
	private onSettled: (queue: UploadQueue) => void;
	private onUploaded: () => void;

	constructor(
		target: () => PodTarget,
		onSettled: (queue: UploadQueue) => void,
		onUploaded: () => void = () => {}
	) {
		this.target = target;
		this.onSettled = onSettled;
		this.onUploaded = onUploaded;
	}

	get active() {
		return this.items.some((i) => i.status === 'waiting' || i.status === 'uploading');
	}

	get progress() {
		return uploadProgress(
			this.items
				.filter((i) => i.status !== 'canceled')
				.map((i) => ({ size: i.size, sent: i.status === 'done' ? i.size : i.sent }))
		);
	}

	get conflicts() {
		return this.items.filter((i) => i.status === 'conflict');
	}

	count(status: UploadStatus) {
		return this.items.reduce((n, i) => n + (i.status === status ? 1 : 0), 0);
	}

	add({ plan, files, dir }: UploadBatch) {
		if (!this.active) {
			this.items = this.items.filter((i) => i.status !== 'done' && i.status !== 'canceled');
		}
		this.dir = dir;
		this.folders.push(...plan.folders);
		for (const p of plan.files) {
			const file = files.get(p.relativePath);
			if (!file) continue;
			const tooBig = p.size > UPLOAD_LIMIT;
			this.items.push({
				id: nextId++,
				name: p.relativePath,
				target: p.target,
				size: p.size,
				sent: 0,
				status: tooBig ? 'failed' : 'waiting',
				error: tooBig ? 'Over the 512 MB upload limit' : null,
				overwrite: false,
				file
			});
		}
		this.busy = true;
		this.pump();
	}

	replace(ids: number[]) {
		for (const item of this.items) {
			if (!ids.includes(item.id)) continue;
			item.status = 'waiting';
			item.overwrite = true;
			item.sent = 0;
			item.error = null;
		}
		this.busy = true;
		this.pump();
	}

	skip(ids: number[]) {
		for (const item of this.items) if (ids.includes(item.id)) item.status = 'canceled';
	}

	cancel() {
		for (const item of this.items) {
			if (item.status === 'waiting') item.status = 'canceled';
		}
		for (const controller of this.controllers.values()) controller.abort();
		this.folders = [];
	}

	retry(id: number) {
		const item = this.items.find((i) => i.id === id);
		if (!item || item.size > UPLOAD_LIMIT) return;
		item.status = 'waiting';
		item.sent = 0;
		item.error = null;
		this.busy = true;
		this.pump();
	}

	clear() {
		if (this.active) return;
		this.items = [];
	}

	private pump() {
		while (this.running < PARALLEL) {
			const next = this.items.find((i) => i.status === 'waiting');
			if (!next) break;
			void this.send(next);
		}
		this.finishIfIdle();
	}

	private async send(item: UploadItem) {
		this.running += 1;
		item.status = 'uploading';
		const controller = new AbortController();
		this.controllers.set(item.id, controller);
		try {
			await uploadFile(this.target(), item.target, item.file, {
				overwrite: item.overwrite,
				signal: controller.signal,
				onProgress: (sent) => (item.sent = sent)
			});
			item.sent = item.size;
			item.status = 'done';
			this.onUploaded();
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') {
				item.status = 'canceled';
			} else {
				const info = fileErrorOf(err);
				if (info.code === 'exists') {
					item.status = 'conflict';
				} else {
					item.status = 'failed';
					item.error = describeFileError(info, 'upload');
				}
			}
		} finally {
			this.controllers.delete(item.id);
			this.running -= 1;
			this.pump();
		}
	}

	private settling = false;

	private async finishIfIdle() {
		if (!this.busy || this.settling) return;
		if (this.running > 0 || this.items.some((i) => i.status === 'waiting')) return;
		this.settling = true;
		const folders = this.folders.splice(0);
		for (const folder of folders) {
			try {
				await makeFolder(this.target(), folder);
			} catch (err) {
				if (fileErrorOf(err).code !== 'exists') break;
			}
		}
		this.settling = false;
		this.busy = false;
		this.onSettled(this);
	}
}
