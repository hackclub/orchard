import type { SyntaxLanguage } from './syntax';

export type PodFileKind = 'file' | 'dir' | 'symlink' | 'other';

export interface PodFileEntry {
	name: string;
	kind: PodFileKind;
	size: number | null;
	mtime?: number | null;
	mode?: string | null;
	owner?: string | null;
	group?: string | null;
	target?: 'file' | 'dir' | null;
	linkTo?: string | null;
}

export type PodMountType = 'persistent' | 'temporary' | 'config' | 'secret' | 'other';

export interface PodMount {
	path: string;
	volume: string;
	type: PodMountType;
	readOnly: boolean;
	claim: string | null;
}

export interface PodListing {
	path: string;
	writable: boolean;
	truncated?: boolean;
	entries: PodFileEntry[];
	mounts: PodMount[];
}

export interface PodFileContent {
	path: string;
	size: number | null;
	mtime: number | null;
	binary: boolean;
	truncated: boolean;
	content: string | null;
}

export interface PodFileStat {
	path: string;
	size: number | null;
	mtime: number | null;
}

export function opensAsFolder(entry: PodFileEntry): boolean {
	return entry.kind === 'dir' || (entry.kind === 'symlink' && entry.target === 'dir');
}

export function isDownloadable(entry: PodFileEntry): boolean {
	return entry.kind === 'file' || (entry.kind === 'symlink' && entry.target === 'file');
}

export function isDanglingLink(entry: PodFileEntry): boolean {
	return entry.kind === 'symlink' && !entry.target;
}

export type PodFileSortKey = 'name' | 'size' | 'modified';

export interface PodFileSort {
	key: PodFileSortKey;
	dir: 'asc' | 'desc';
}

const naturalName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortPodEntries(entries: PodFileEntry[], sort: PodFileSort | null): PodFileEntry[] {
	const folders = entries.filter(opensAsFolder);
	const files = entries.filter((e) => !opensAsFolder(e));
	if (!sort) return [...folders, ...files];
	const direction = sort.dir === 'asc' ? 1 : -1;
	const byName = (a: PodFileEntry, b: PodFileEntry) =>
		direction * naturalName.compare(a.name, b.name);
	if (sort.key === 'size') {
		return [
			...files.sort((a, b) => direction * ((a.size ?? 0) - (b.size ?? 0)) || byName(a, b)),
			...folders.sort(byName)
		];
	}
	if (sort.key === 'modified') {
		const known = entries.filter((e) => e.mtime != null);
		const unknown = entries.filter((e) => e.mtime == null);
		return [
			...known.sort((a, b) => direction * ((a.mtime ?? 0) - (b.mtime ?? 0)) || byName(a, b)),
			...unknown.sort(byName)
		];
	}
	return [...entries].sort(byName);
}

export function isHiddenName(name: string): boolean {
	return name.startsWith('.');
}

export function filterPodEntries(
	entries: PodFileEntry[],
	{ query = '', showHidden = false }: { query?: string; showHidden?: boolean }
): PodFileEntry[] {
	const needle = query.trim().toLowerCase();
	return entries.filter((e) => {
		if (!showHidden && isHiddenName(e.name) && !needle.startsWith('.')) return false;
		return !needle || e.name.toLowerCase().includes(needle);
	});
}

export function hiddenCount(entries: PodFileEntry[]): number {
	return entries.reduce((n, e) => n + (isHiddenName(e.name) ? 1 : 0), 0);
}

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

export function joinPath(dir: string, name: string): string {
	return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentPath(path: string): string {
	const parts = path.split('/').filter(Boolean);
	parts.pop();
	return '/' + parts.join('/');
}

export function baseName(path: string): string {
	const parts = path.split('/').filter(Boolean);
	return parts[parts.length - 1] ?? '/';
}

export function resolvePath(input: string, cwd = '/'): string | null {
	const raw = input.trim();
	if (raw.includes('\0')) return null;
	const start = raw.startsWith('/') ? [] : cwd.split('/').filter(Boolean);
	for (const part of raw.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') start.pop();
		else start.push(part);
	}
	return '/' + start.join('/');
}

export function pathFromUrl(value: string | null): string {
	if (!value) return '/';
	return resolvePath(value, '/') ?? '/';
}

export interface PathSegment {
	name: string;
	path: string;
}

export function pathSegments(path: string): PathSegment[] {
	const parts = path.split('/').filter(Boolean);
	return parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }));
}

export function isWithin(path: string, root: string): boolean {
	if (root === '/') return true;
	return path === root || path.startsWith(root + '/');
}

export function mountFor(path: string, mounts: PodMount[]): PodMount | null {
	let best: PodMount | null = null;
	for (const m of mounts) {
		if (!isWithin(path, m.path)) continue;
		if (!best || m.path.length > best.path.length) best = m;
	}
	return best;
}

export function holdsMount(path: string, mounts: PodMount[]): boolean {
	return mounts.some((m) => isWithin(m.path, path));
}

export function mountRootAt(path: string, mounts: PodMount[]): PodMount | null {
	return mounts.find((m) => m.path === path) ?? null;
}

const MOUNT_LABELS: Record<PodMountType, string> = {
	persistent: 'Persistent volume',
	temporary: 'Temporary',
	config: 'Config',
	secret: 'Secret',
	other: 'Volume'
};

export function mountLabel(type: PodMountType): string {
	return MOUNT_LABELS[type] ?? 'Volume';
}

export type FolderStorage =
	| { kind: 'volume'; mount: PodMount }
	| { kind: 'temporary'; mount: PodMount }
	| { kind: 'read-only'; mount: PodMount | null }
	| { kind: 'mounted'; mount: PodMount }
	| { kind: 'container' };

export function folderStorage(path: string, mounts: PodMount[], writable: boolean): FolderStorage {
	const mount = mountFor(path, mounts);
	if (mount?.readOnly || (mount && (mount.type === 'config' || mount.type === 'secret'))) {
		return { kind: 'read-only', mount };
	}
	if (!writable) return { kind: 'read-only', mount };
	if (!mount) return { kind: 'container' };
	if (mount.type === 'persistent') return { kind: 'volume', mount };
	if (mount.type === 'temporary') return { kind: 'temporary', mount };
	return { kind: 'mounted', mount };
}

const LANGUAGE_BY_EXTENSION: Record<string, SyntaxLanguage> = {
	js: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	jsx: 'javascript',
	ts: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	tsx: 'typescript',
	svelte: 'html',
	vue: 'html',
	json: 'json',
	jsonc: 'json',
	map: 'json',
	lock: 'json',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'toml',
	ini: 'toml',
	conf: 'shell',
	cfg: 'toml',
	sh: 'shell',
	bash: 'shell',
	zsh: 'shell',
	py: 'python',
	rb: 'ruby',
	go: 'go',
	rs: 'rust',
	css: 'css',
	scss: 'css',
	html: 'html',
	htm: 'html',
	xml: 'html',
	svg: 'html',
	md: 'markdown',
	markdown: 'markdown',
	sql: 'sql',
	env: 'dotenv',
	prisma: 'prisma'
};

const LANGUAGE_BY_NAME: Record<string, SyntaxLanguage> = {
	dockerfile: 'dockerfile',
	containerfile: 'dockerfile',
	makefile: 'shell',
	procfile: 'shell',
	gemfile: 'ruby',
	rakefile: 'ruby',
	'.bashrc': 'shell',
	'.profile': 'shell',
	'.bash_profile': 'shell',
	'.npmrc': 'toml',
	'.gitignore': 'shell',
	'.dockerignore': 'shell',
	'.editorconfig': 'toml'
};

export function languageFor(name: string): SyntaxLanguage | null {
	const lower = name.toLowerCase();
	if (LANGUAGE_BY_NAME[lower]) return LANGUAGE_BY_NAME[lower];
	if (lower === '.env' || lower.startsWith('.env.')) return 'dotenv';
	if (lower.startsWith('dockerfile.')) return 'dockerfile';
	const dot = lower.lastIndexOf('.');
	if (dot <= 0) return null;
	return LANGUAGE_BY_EXTENSION[lower.slice(dot + 1)] ?? null;
}

const LANGUAGE_NAMES: Record<SyntaxLanguage, string> = {
	javascript: 'JavaScript',
	typescript: 'TypeScript',
	json: 'JSON',
	yaml: 'YAML',
	toml: 'TOML',
	shell: 'Shell',
	python: 'Python',
	ruby: 'Ruby',
	go: 'Go',
	rust: 'Rust',
	css: 'CSS',
	html: 'HTML',
	markdown: 'Markdown',
	sql: 'SQL',
	dotenv: 'Env',
	dockerfile: 'Dockerfile',
	prisma: 'Prisma'
};

export function languageName(language: SyntaxLanguage | null): string {
	return language ? LANGUAGE_NAMES[language] : 'Text';
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico']);

export function isPreviewableImage(name: string): boolean {
	const dot = name.lastIndexOf('.');
	if (dot <= 0) return false;
	return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export interface UploadSource {
	relativePath: string;
	size: number;
}

export interface PlannedUpload {
	relativePath: string;
	target: string;
	size: number;
}

export interface UploadPlan {
	files: PlannedUpload[];
	folders: string[];
	skipped: string[];
}

function cleanRelative(path: string): string | null {
	const parts = path.split(/[\\/]+/).filter((p) => p && p !== '.');
	if (!parts.length || parts.some((p) => p === '..' || p.includes('\0'))) return null;
	return parts.join('/');
}

export function planUploads(
	sources: UploadSource[],
	dir: string,
	emptyFolders: string[] = []
): UploadPlan {
	const files: PlannedUpload[] = [];
	const skipped: string[] = [];
	const seen = new Set<string>();
	const coveredDirs = new Set<string>();
	for (const source of sources) {
		const rel = cleanRelative(source.relativePath);
		if (!rel) {
			skipped.push(source.relativePath);
			continue;
		}
		const target = joinPath(dir, rel);
		if (seen.has(target)) continue;
		seen.add(target);
		files.push({ relativePath: rel, target, size: source.size });
		const parts = rel.split('/');
		for (let i = 1; i < parts.length; i++) coveredDirs.add(parts.slice(0, i).join('/'));
	}
	const folders: string[] = [];
	for (const folder of emptyFolders) {
		const rel = cleanRelative(folder);
		if (!rel) {
			skipped.push(folder);
			continue;
		}
		if (coveredDirs.has(rel)) continue;
		const target = joinPath(dir, rel);
		if (folders.includes(target)) continue;
		folders.push(target);
	}
	folders.sort((a, b) => a.length - b.length);
	return { files, folders, skipped };
}

export function uploadProgress(items: { size: number; sent: number }[]): number {
	const total = items.reduce((n, i) => n + i.size, 0);
	if (!total) return items.length ? 1 : 0;
	return Math.min(1, items.reduce((n, i) => n + Math.min(i.sent, i.size), 0) / total);
}

export interface PodFileError {
	status: number;
	code: string | null;
	message: string;
	tool: string | null;
}

export function parseFileError(status: number, body: unknown, fallback = ''): PodFileError {
	const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
	const message =
		typeof b.message === 'string'
			? b.message
			: Array.isArray(b.message)
				? b.message.join(', ')
				: fallback || `Request failed (${status})`;
	return {
		status,
		code: typeof b.code === 'string' ? b.code : null,
		message,
		tool: typeof b.tool === 'string' ? b.tool : null
	};
}

export type FileAction =
	| 'list'
	| 'read'
	| 'download'
	| 'download-folder'
	| 'write'
	| 'upload'
	| 'mkdir'
	| 'move'
	| 'delete';

const ACTION_WORDS: Record<FileAction, string> = {
	list: 'list this folder',
	read: 'read files',
	download: 'download files',
	'download-folder': 'download folders',
	write: 'save files',
	upload: 'upload files',
	mkdir: 'create folders',
	move: 'rename files',
	delete: 'delete files'
};

export function missingToolMessage(tool: string | null, action: FileAction): string {
	const what = ACTION_WORDS[action];
	if (!tool) return `This image is missing a tool Orchard needs to ${what}.`;
	return `This image has no ${tool}, which Orchard needs to ${what}.`;
}

export function describeFileError(error: PodFileError, action: FileAction): string {
	switch (error.code) {
		case 'missing_tool':
			return missingToolMessage(error.tool, action);
		case 'read_only':
			return 'This folder is read-only.';
		case 'too_large':
			return 'This file is too large.';
		case 'mount_root':
			return 'Mounted volumes, folders that hold one and system folders stay put.';
		case 'exists':
			return 'Something with that name is already there.';
		case 'modified':
			return 'The file changed since you opened it.';
		default:
			if (error.status === 411) return 'The upload had no size, so it was refused.';
			return error.message;
	}
}

export function validFileName(name: string): string | null {
	const trimmed = name.trim();
	if (!trimmed) return 'Enter a name';
	if (trimmed === '.' || trimmed === '..') return 'Pick another name';
	if (trimmed.includes('/')) return 'Names cannot contain /';
	if (trimmed.includes('\0')) return 'Names cannot contain NUL';
	return null;
}
