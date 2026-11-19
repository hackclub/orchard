import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFileSize, sortPodEntries, type PodFileEntry } from './pod-files';

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
