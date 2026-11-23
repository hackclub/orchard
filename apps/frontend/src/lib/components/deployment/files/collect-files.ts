import { planUploads, type UploadSource } from '$lib/utils/pod-files';
import type { UploadBatch } from './upload-queue.svelte';

interface Collected {
	files: Map<string, File>;
	folders: string[];
}

function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
	return new Promise((resolve, reject) => {
		const out: FileSystemEntry[] = [];
		const next = () =>
			reader.readEntries((batch) => {
				if (!batch.length) return resolve(out);
				out.push(...batch);
				next();
			}, reject);
		next();
	});
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
	return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, into: Collected) {
	const rel = entry.fullPath.replace(/^\/+/, '');
	if (entry.isFile) {
		into.files.set(rel, await fileOf(entry as FileSystemFileEntry));
		return;
	}
	if (entry.isDirectory) {
		into.folders.push(rel);
		const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
		for (const child of children) await walk(child, into);
	}
}

function batchOf(collected: Collected, dir: string): UploadBatch {
	const sources: UploadSource[] = [...collected.files].map(([relativePath, file]) => ({
		relativePath,
		size: file.size
	}));
	return { plan: planUploads(sources, dir, collected.folders), files: collected.files, dir };
}

export async function collectDrop(data: DataTransfer, dir: string): Promise<UploadBatch> {
	const collected: Collected = { files: new Map(), folders: [] };
	const entries = [...data.items]
		.filter((item) => item.kind === 'file')
		.map((item) => item.webkitGetAsEntry?.() ?? null);
	if (entries.some(Boolean)) {
		for (const entry of entries) if (entry) await walk(entry, collected);
	} else {
		for (const file of data.files) collected.files.set(file.name, file);
	}
	return batchOf(collected, dir);
}

export function collectInput(list: FileList, dir: string): UploadBatch {
	const collected: Collected = { files: new Map(), folders: [] };
	for (const file of list) collected.files.set(file.webkitRelativePath || file.name, file);
	return batchOf(collected, dir);
}

export function carriesFiles(e: DragEvent): boolean {
	return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
}
