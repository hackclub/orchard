import test from 'node:test';
import assert from 'node:assert/strict';
import {
	baseName,
	describeFileError,
	filterPodEntries,
	folderStorage,
	formatFileSize,
	hiddenCount,
	holdsMount,
	isDownloadable,
	isPreviewableImage,
	joinPath,
	languageFor,
	languageName,
	mountFor,
	mountLabel,
	mountRootAt,
	opensAsFolder,
	parentPath,
	parseFileError,
	pathFromUrl,
	pathSegments,
	planUploads,
	resolvePath,
	sortPodEntries,
	uploadProgress,
	validFileName,
	type PodFileEntry,
	type PodMount
} from './pod-files';

const entries: PodFileEntry[] = [
	{ name: 'file10.txt', kind: 'file', size: 300 },
	{ name: 'Zeta', kind: 'dir', size: null },
	{ name: 'file2.txt', kind: 'file', size: 4000 },
	{ name: 'alpha', kind: 'dir', size: null },
	{ name: 'link', kind: 'symlink', size: null },
	{ name: 'file1.txt', kind: 'file', size: 300 }
];

const names = (list: PodFileEntry[]) => list.map((e) => e.name);

test('unsorted lists folders first, then files, in container order', () => {
	assert.deepEqual(names(sortPodEntries(entries, null)), [
		'Zeta',
		'alpha',
		'file10.txt',
		'file2.txt',
		'link',
		'file1.txt'
	]);
});

test('name sort is natural and mixes files and folders', () => {
	assert.deepEqual(names(sortPodEntries(entries, { key: 'name', dir: 'asc' })), [
		'alpha',
		'file1.txt',
		'file2.txt',
		'file10.txt',
		'link',
		'Zeta'
	]);
	assert.deepEqual(names(sortPodEntries(entries, { key: 'name', dir: 'desc' })), [
		'Zeta',
		'link',
		'file10.txt',
		'file2.txt',
		'file1.txt',
		'alpha'
	]);
});

test('size sort keeps folders last in both directions', () => {
	assert.deepEqual(names(sortPodEntries(entries, { key: 'size', dir: 'asc' })), [
		'link',
		'file1.txt',
		'file10.txt',
		'file2.txt',
		'alpha',
		'Zeta'
	]);
	assert.deepEqual(names(sortPodEntries(entries, { key: 'size', dir: 'desc' })), [
		'file2.txt',
		'file10.txt',
		'file1.txt',
		'link',
		'Zeta',
		'alpha'
	]);
});

test('formatFileSize keeps one decimal so close sizes read apart', () => {
	assert.equal(formatFileSize(0), '0 B');
	assert.equal(formatFileSize(1023), '1023 B');
	assert.equal(formatFileSize(1460), '1.4 KB');
	assert.equal(formatFileSize(1.4 * 1024 * 1024), '1.4 MB');
	assert.equal(formatFileSize(3 * 1024 ** 3), '3.0 GB');
});

test('symlinks to folders sort and open as folders, others download only when they reach a file', () => {
	const linked: PodFileEntry[] = [
		{ name: 'notes.txt', kind: 'file', size: 1 },
		{ name: 'bin', kind: 'symlink', size: null, target: 'dir' },
		{ name: 'latest', kind: 'symlink', size: null, target: 'file' },
		{ name: 'gone', kind: 'symlink', size: null, target: null }
	];
	assert.deepEqual(names(sortPodEntries(linked, null)), ['bin', 'notes.txt', 'latest', 'gone']);
	assert.deepEqual(
		linked.filter(opensAsFolder).map((e) => e.name),
		['bin']
	);
	assert.deepEqual(
		linked.filter(isDownloadable).map((e) => e.name),
		['notes.txt', 'latest']
	);
});

test('modified sort orders by mtime and keeps unknown times last', () => {
	const timed: PodFileEntry[] = [
		{ name: 'b', kind: 'file', size: 1, mtime: 200 },
		{ name: 'a', kind: 'dir', size: null, mtime: 100 },
		{ name: 'c', kind: 'file', size: 1, mtime: null },
		{ name: 'd', kind: 'file', size: 1, mtime: 300 }
	];
	assert.deepEqual(names(sortPodEntries(timed, { key: 'modified', dir: 'asc' })), [
		'a',
		'b',
		'd',
		'c'
	]);
	assert.deepEqual(names(sortPodEntries(timed, { key: 'modified', dir: 'desc' })), [
		'd',
		'b',
		'a',
		'c'
	]);
});

test('filter hides dotfiles unless asked, and a dot query finds them anyway', () => {
	const list: PodFileEntry[] = [
		{ name: '.env', kind: 'file', size: 1 },
		{ name: 'env.ts', kind: 'file', size: 1 },
		{ name: 'README.md', kind: 'file', size: 1 }
	];
	assert.deepEqual(names(filterPodEntries(list, {})), ['env.ts', 'README.md']);
	assert.deepEqual(names(filterPodEntries(list, { showHidden: true })), [
		'.env',
		'env.ts',
		'README.md'
	]);
	assert.deepEqual(names(filterPodEntries(list, { query: 'ENV' })), ['env.ts']);
	assert.deepEqual(names(filterPodEntries(list, { query: '.en' })), ['.env']);
	assert.equal(hiddenCount(list), 1);
});

test('paths join, split and resolve like a shell', () => {
	assert.equal(joinPath('/', 'app'), '/app');
	assert.equal(joinPath('/app', 'src'), '/app/src');
	assert.equal(parentPath('/app/src'), '/app');
	assert.equal(parentPath('/app'), '/');
	assert.equal(parentPath('/'), '/');
	assert.equal(baseName('/app/src/index.ts'), 'index.ts');
	assert.equal(resolvePath('/etc//nginx/'), '/etc/nginx');
	assert.equal(resolvePath('src/../lib', '/app'), '/app/lib');
	assert.equal(resolvePath('../../..', '/app'), '/');
	assert.equal(resolvePath('./', '/app'), '/app');
	assert.equal(resolvePath('a\0b'), null);
	assert.equal(pathFromUrl(null), '/');
	assert.equal(pathFromUrl('/data/../etc'), '/etc');
	assert.deepEqual(pathSegments('/app/src'), [
		{ name: 'app', path: '/app' },
		{ name: 'src', path: '/app/src' }
	]);
	assert.deepEqual(pathSegments('/'), []);
});

const mounts: PodMount[] = [
	{ path: '/data', volume: 'data', type: 'persistent', readOnly: false, claim: 'app-data' },
	{ path: '/data/cache', volume: 'cache', type: 'temporary', readOnly: false, claim: null },
	{ path: '/etc/config', volume: 'cfg', type: 'config', readOnly: true, claim: null },
	{ path: '/tmp', volume: 'tmp', type: 'temporary', readOnly: false, claim: null }
];

test('the containing mount is the longest path prefix on a segment boundary', () => {
	assert.equal(mountFor('/data', mounts)?.volume, 'data');
	assert.equal(mountFor('/data/uploads/a.png', mounts)?.volume, 'data');
	assert.equal(mountFor('/data/cache/x', mounts)?.volume, 'cache');
	assert.equal(mountFor('/database', mounts), null);
	assert.equal(mountFor('/app', mounts), null);
	assert.equal(mountRootAt('/tmp', mounts)?.type, 'temporary');
	assert.equal(mountRootAt('/tmp/x', mounts), null);
	assert.equal(holdsMount('/etc', mounts), true);
	assert.equal(holdsMount('/data', mounts), true);
	assert.equal(holdsMount('/data/uploads', mounts), false);
	assert.equal(holdsMount('/et', mounts), false);
	assert.equal(mountLabel('persistent'), 'Persistent volume');
});

test('folder storage says where a change lands', () => {
	assert.equal(folderStorage('/data/uploads', mounts, true).kind, 'volume');
	assert.equal(folderStorage('/tmp', mounts, true).kind, 'temporary');
	assert.equal(folderStorage('/etc/config', mounts, true).kind, 'read-only');
	assert.equal(folderStorage('/app', mounts, true).kind, 'container');
	assert.equal(folderStorage('/app', mounts, false).kind, 'read-only');
});

test('languages come from names and extensions', () => {
	assert.equal(languageFor('index.ts'), 'typescript');
	assert.equal(languageFor('package.json'), 'json');
	assert.equal(languageFor('Dockerfile'), 'dockerfile');
	assert.equal(languageFor('.env'), 'dotenv');
	assert.equal(languageFor('.env.production'), 'dotenv');
	assert.equal(languageFor('README.MD'), 'markdown');
	assert.equal(languageFor('LICENSE'), null);
	assert.equal(languageFor('.gitkeep'), null);
	assert.equal(languageName('yaml'), 'YAML');
	assert.equal(languageName(null), 'Text');
	assert.equal(isPreviewableImage('logo.PNG'), true);
	assert.equal(isPreviewableImage('icon.svg'), false);
	assert.equal(isPreviewableImage('.png'), false);
});

test('upload plans map relative paths under the folder and keep only empty folders', () => {
	const plan = planUploads(
		[
			{ relativePath: 'site/index.html', size: 10 },
			{ relativePath: 'site/img/a.png', size: 20 },
			{ relativePath: 'notes.txt', size: 5 },
			{ relativePath: 'site/index.html', size: 10 },
			{ relativePath: '../escape', size: 1 }
		],
		'/data',
		['site', 'site/img', 'site/empty', 'site/empty/deeper', '..']
	);
	assert.deepEqual(
		plan.files.map((f) => f.target),
		['/data/site/index.html', '/data/site/img/a.png', '/data/notes.txt']
	);
	assert.deepEqual(plan.folders, ['/data/site/empty', '/data/site/empty/deeper']);
	assert.deepEqual(plan.skipped, ['../escape', '..']);
	assert.equal(planUploads([{ relativePath: 'a', size: 1 }], '/').files[0].target, '/a');
	assert.equal(
		uploadProgress([
			{ size: 100, sent: 50 },
			{ size: 100, sent: 100 }
		]),
		0.75
	);
	assert.equal(uploadProgress([{ size: 0, sent: 0 }]), 1);
});

test('file errors keep the code and tool and read in plain words', () => {
	const tar = parseFileError(422, {
		statusCode: 422,
		message: 'x',
		code: 'missing_tool',
		tool: 'tar'
	});
	assert.equal(tar.code, 'missing_tool');
	assert.equal(
		describeFileError(tar, 'download-folder'),
		'This image has no tar, which Orchard needs to download folders.'
	);
	assert.equal(parseFileError(500, null, 'Bad gateway').message, 'Bad gateway');
	assert.equal(parseFileError(400, { message: ['a', 'b'] }).message, 'a, b');
	assert.equal(validFileName(''), 'Enter a name');
	assert.equal(validFileName('a/b'), 'Names cannot contain /');
	assert.equal(validFileName('..'), 'Pick another name');
	assert.equal(validFileName('ok.txt'), null);
});
