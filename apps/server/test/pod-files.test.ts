import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  LIST_SCRIPT,
  STAT_FILE_SCRIPT,
  attachmentDisposition,
  fileNameFromPath,
  normalizePodPath,
  parentPodPath,
  parseFileSize,
  parsePodListing
} from '../src/kubernetes/pod-files';

test('normalizePodPath accepts absolute paths and collapses them', () => {
  assert.equal(normalizePodPath(undefined), '/');
  assert.equal(normalizePodPath(''), '/');
  assert.equal(normalizePodPath('/usr//share/./nginx/'), '/usr/share/nginx');
  assert.equal(normalizePodPath('/dir '), '/dir ');
  assert.equal(normalizePodPath('/etc/notes.txt '), '/etc/notes.txt ');
});

test('normalizePodPath rejects leading whitespace before the root slash', () => {
  assert.throws(() => normalizePodPath('  /etc'));
});

test('normalizePodPath rejects relative paths, parent segments and NUL bytes', () => {
  assert.throws(() => normalizePodPath('etc/passwd'));
  assert.throws(() => normalizePodPath('/usr/../etc'));
  assert.throws(() => normalizePodPath('/etc/\0passwd'));
  assert.throws(() => normalizePodPath(`/${'a'.repeat(5000)}`));
});

test('parentPodPath walks one level up and stops at the root', () => {
  assert.equal(parentPodPath('/usr/share/nginx'), '/usr/share');
  assert.equal(parentPodPath('/usr'), '/');
  assert.equal(parentPodPath('/'), '/');
});

test('parsePodListing reads NUL-separated records in the order the container lists them', () => {
  const stdout = ['f\tnginx.conf', 'd\tconf.d', 'l\tlatest', 'o\tfifo', '12', ''].join('\0');
  assert.deepEqual(parsePodListing(stdout), [
    { name: 'nginx.conf', kind: 'file', size: 12 },
    { name: 'conf.d', kind: 'dir', size: null },
    { name: 'latest', kind: 'symlink', size: null },
    { name: 'fifo', kind: 'other', size: null }
  ]);
});

test('parsePodListing keeps tabs and newlines inside file names', () => {
  const stdout = ['f\ta\tb\nc', '3', ''].join('\0');
  assert.deepEqual(parsePodListing(stdout), [{ name: 'a\tb\nc', kind: 'file', size: 3 }]);
});

test('parsePodListing pairs sizes with files in order', () => {
  const stdout = ['f\ta', 'd\tdir', 'f\tb', '10', '20', ''].join('\0');
  assert.deepEqual(parsePodListing(stdout), [
    { name: 'a', kind: 'file', size: 10 },
    { name: 'dir', kind: 'dir', size: null },
    { name: 'b', kind: 'file', size: 20 }
  ]);
});

test('parsePodListing leaves sizes empty when the counts do not line up', () => {
  const stdout = ['f\ta', 'f\tb', '10', ''].join('\0');
  assert.deepEqual(parsePodListing(stdout), [
    { name: 'a', kind: 'file', size: null },
    { name: 'b', kind: 'file', size: null }
  ]);
});

test('parsePodListing skips malformed records', () => {
  assert.deepEqual(parsePodListing('garbage\0x\ty\0'), []);
});

test('parseFileSize accepts only non-negative integers', () => {
  assert.equal(parseFileSize('42\n'), 42);
  assert.equal(parseFileSize('0'), 0);
  assert.equal(parseFileSize(''), null);
  assert.equal(parseFileSize('-1'), null);
  assert.equal(parseFileSize('1.5'), null);
});

test('attachmentDisposition keeps ASCII names and encodes others', () => {
  assert.equal(
    attachmentDisposition('report.txt'),
    `attachment; filename="report.txt"; filename*=UTF-8''report.txt`
  );
  const header = attachmentDisposition('a"b;é.txt');
  assert.match(header, /filename="a_b__\.txt"/);
  assert.match(header, /filename\*=UTF-8''a%22b%3B%C3%A9\.txt$/);
  assert.equal(fileNameFromPath('/var/lib/data/'), 'data');
  assert.equal(fileNameFromPath('/'), 'download');
});

test('the listing script lists a real directory through POSIX sh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pod-files-'));
  try {
    mkdirSync(join(dir, 'conf.d'));
    writeFileSync(join(dir, 'nginx.conf'), 'hello');
    writeFileSync(join(dir, '.hidden'), '');
    symlinkSync(join(dir, 'nginx.conf'), join(dir, 'link'));
    const out = execFileSync('/bin/sh', ['-c', LIST_SCRIPT, 'sh', dir]).toString('utf8');
    const entries = parsePodListing(out);
    assert.deepEqual(entries.map((e) => [e.name, e.kind, e.size]).sort(), [
      ['.hidden', 'file', 0],
      ['conf.d', 'dir', null],
      ['link', 'symlink', null],
      ['nginx.conf', 'file', 5]
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the listing script sizes names that look like wc output or hold newlines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pod-files-'));
  try {
    writeFileSync(join(dir, 'backup total'), 'aaa');
    writeFileSync(join(dir, 'two\nlines'), 'bb');
    writeFileSync(join(dir, 'plain.txt'), 'c');
    mkdirSync(join(dir, 'sub dir'));
    const out = execFileSync('/bin/sh', ['-c', LIST_SCRIPT, 'sh', dir]).toString('utf8');
    const entries = parsePodListing(out);
    assert.deepEqual(
      entries.map((e) => [e.name, e.kind, e.size]).sort(),
      [
        ['backup total', 'file', 3],
        ['plain.txt', 'file', 1],
        ['sub dir', 'dir', null],
        ['two\nlines', 'file', 2]
      ].sort()
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the listing script fails with exit 3 for a missing directory', () => {
  assert.throws(() =>
    execFileSync('/bin/sh', ['-c', LIST_SCRIPT, 'sh', '/definitely/not/here'], { stdio: 'pipe' })
  );
});

test('the file check script accepts a readable regular file only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pod-files-'));
  try {
    const file = join(dir, 'data.bin');
    writeFileSync(file, Buffer.alloc(1234));
    assert.doesNotThrow(() =>
      execFileSync('/bin/sh', ['-c', STAT_FILE_SCRIPT, 'sh', file], { stdio: 'pipe' })
    );
    assert.throws(() =>
      execFileSync('/bin/sh', ['-c', STAT_FILE_SCRIPT, 'sh', dir], { stdio: 'pipe' })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
