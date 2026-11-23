import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import {
  CONTENT_SCRIPT,
  DELETE_SCRIPT,
  DOWNLOAD_CHECK_SCRIPT,
  LIST_SCRIPT,
  MKDIR_SCRIPT,
  MOVE_SCRIPT,
  PREVIEW_MAX_BYTES,
  WRITE_SCRIPT,
  attachmentDisposition,
  classifyExecStatus,
  contentDisposition,
  fileNameFromPath,
  isProtectedPath,
  LISTING_MAX_ENTRIES,
  PodFileSlots,
  queryString,
  inlineImageType,
  isNoShellMessage,
  mountFor,
  normalizePodPath,
  parentPodPath,
  parseFileSize,
  parsePodListing,
  parsePreview,
  podMounts
} from '../src/kubernetes/pod-files';

const SYSTEM_PATH = process.env.PATH ?? '/usr/bin:/bin';
const ODD_NAMES = ['-rf', '$(id)', 'a b', 'two\nlines', 'tab\there', "it's"];

function findBusybox(): string | null {
  const candidates = [
    process.env.BUSYBOX,
    ...SYSTEM_PATH.split(delimiter).map((d) => join(d, 'busybox'))
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    if (spawnSync(candidate, ['sh', '-c', 'exit 0']).status === 0) return candidate;
  }
  return null;
}

const BUSYBOX = findBusybox();

interface Shell {
  label: string;
  run(script: string, args: string[], opts?: { input?: Buffer; path?: string }): RunResult;
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function runWith(file: string, prefix: string[]): Shell['run'] {
  return (script, args, opts = {}) => {
    const result = spawnSync(file, [...prefix, '-c', script, 'sh', ...args], {
      input: opts.input ?? Buffer.alloc(0),
      env: { PATH: opts.path ?? SYSTEM_PATH, LC_ALL: 'C' }
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? Buffer.alloc(0),
      stderr: result.stderr?.toString('utf-8') ?? ''
    };
  };
}

const SHELLS: Shell[] = [{ label: '/bin/sh', run: runWith('/bin/sh', []) }];
if (BUSYBOX) SHELLS.push({ label: 'busybox sh', run: runWith(BUSYBOX, ['sh']) });
for (const dash of ['/usr/bin/dash', '/bin/dash']) {
  if (existsSync(dash)) {
    SHELLS.push({ label: 'dash', run: runWith(dash, []) });
    break;
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pod-files-'));
}

const PERMISSIONS_ENFORCED = (() => {
  const dir = tempDir();
  try {
    chmodSync(dir, 0o555);
    writeFileSync(join(dir, 'probe'), '');
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
})();

function withDir(fn: (dir: string) => void) {
  const dir = tempDir();
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function toolDir(tools: string[]): string {
  const dir = tempDir();
  for (const tool of tools) {
    const found = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', tool], {
      env: { PATH: SYSTEM_PATH }
    })
      .stdout.toString()
      .trim();
    if (found.startsWith('/')) symlinkSync(found, join(dir, tool));
  }
  return dir;
}

const ALL_TOOLS = [
  'stat',
  'tr',
  'readlink',
  'head',
  'wc',
  'cat',
  'mv',
  'rm',
  'mkdir',
  'tar',
  'gzip'
];
const without = (...missing: string[]) => ALL_TOOLS.filter((t) => !missing.includes(t));

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
  assert.throws(() => normalizePodPath('-rf'));
  assert.throws(() => normalizePodPath('/usr/../etc'));
  assert.throws(() => normalizePodPath('/etc/\0passwd'));
  assert.throws(() => normalizePodPath(`/${'a'.repeat(5000)}`));
});

test('parentPodPath walks one level up and stops at the root', () => {
  assert.equal(parentPodPath('/usr/share/nginx'), '/usr/share');
  assert.equal(parentPodPath('/usr'), '/');
  assert.equal(parentPodPath('/'), '/');
});

const stat = (size: number, kind = '-rw-r--r--', user = 'node') =>
  [size, 1763900000, kind, 1000, user, 1000, user].join('\t');

test('parsePodListing reads entries, link records and the stat batch', () => {
  const stdout = [
    'w',
    'f\tnginx.conf',
    'd\tconf.d',
    'l\tlatest',
    '>nginx.conf',
    '=12',
    'L\tbin',
    '>usr/bin',
    'b\tdangling',
    '>missing',
    'o\tfifo',
    stat(12),
    stat(4096, 'drwxr-xr-x'),
    stat(10, 'lrwxrwxrwx', 'root'),
    stat(7, 'lrwxrwxrwx', 'root'),
    stat(7, 'lrwxrwxrwx', 'root'),
    stat(0, 'prw-r--r--'),
    '#',
    ''
  ].join('\0');
  const listing = parsePodListing(stdout);
  assert.equal(listing.writable, true);
  const base = { mtime: 1763900000, group: 'node', owner: 'node', target: null, linkTo: null };
  assert.deepEqual(listing.entries, [
    { ...base, name: 'nginx.conf', kind: 'file', size: 12, mode: '-rw-r--r--' },
    { ...base, name: 'conf.d', kind: 'dir', size: null, mode: 'drwxr-xr-x' },
    {
      ...base,
      name: 'latest',
      kind: 'symlink',
      size: 12,
      mode: 'lrwxrwxrwx',
      owner: 'root',
      group: 'root',
      target: 'file',
      linkTo: 'nginx.conf'
    },
    {
      ...base,
      name: 'bin',
      kind: 'symlink',
      size: null,
      mode: 'lrwxrwxrwx',
      owner: 'root',
      group: 'root',
      target: 'dir',
      linkTo: 'usr/bin'
    },
    {
      ...base,
      name: 'dangling',
      kind: 'symlink',
      size: null,
      mode: 'lrwxrwxrwx',
      owner: 'root',
      group: 'root',
      target: null,
      linkTo: 'missing'
    },
    { ...base, name: 'fifo', kind: 'other', size: null, mode: 'prw-r--r--' }
  ]);
});

test('parsePodListing leaves every stat field null when stat is missing', () => {
  const stdout = ['r', 'f\ta', 'd\tb', 'l\tc', '>a', '#', ''].join('\0');
  const listing = parsePodListing(stdout);
  assert.equal(listing.writable, false);
  assert.deepEqual(
    listing.entries.map((e) => [e.name, e.kind, e.size, e.mtime, e.mode, e.owner, e.group]),
    [
      ['a', 'file', null, null, null, null, null],
      ['b', 'dir', null, null, null, null, null],
      ['c', 'symlink', null, null, null, null, null]
    ]
  );
  assert.equal(listing.entries[2].linkTo, 'a');
});

test('parsePodListing keeps tabs and newlines inside file names', () => {
  const stdout = ['w', 'f\ta\tb\nc', stat(3), '#', ''].join('\0');
  assert.deepEqual(
    parsePodListing(stdout).entries.map((e) => [e.name, e.size]),
    [['a\tb\nc', 3]]
  );
});

test('parsePodListing only drops stats for a batch whose count does not line up', () => {
  const stdout = ['w', 'f\ta', 'f\tb', stat(10), '#', 'f\tc', stat(30), '#', ''].join('\0');
  assert.deepEqual(
    parsePodListing(stdout).entries.map((e) => [e.name, e.size]),
    [
      ['a', null],
      ['b', null],
      ['c', 30]
    ]
  );
});

test('parsePodListing falls back to numeric ids for unknown owners', () => {
  const line = ['1', '2', '-rw-------', '1234', 'UNKNOWN', '99', 'UNKNOWN'].join('\t');
  const [entry] = parsePodListing(['w', 'f\tx', line, '#', ''].join('\0')).entries;
  assert.equal(entry.owner, '1234');
  assert.equal(entry.group, '99');
});

test('parsePodListing skips malformed records', () => {
  assert.deepEqual(parsePodListing('w\0garbage\0x\ty\0#\0').entries, []);
});

test('parseFileSize accepts only non-negative integers', () => {
  assert.equal(parseFileSize('42\n'), 42);
  assert.equal(parseFileSize('0'), 0);
  assert.equal(parseFileSize(''), null);
  assert.equal(parseFileSize('-1'), null);
  assert.equal(parseFileSize('1.5'), null);
});

test('content dispositions keep ASCII names and encode others', () => {
  assert.equal(
    attachmentDisposition('report.txt'),
    `attachment; filename="report.txt"; filename*=UTF-8''report.txt`
  );
  const header = attachmentDisposition('a"b;é.txt');
  assert.match(header, /filename="a_b__\.txt"/);
  assert.match(header, /filename\*=UTF-8''a%22b%3B%C3%A9\.txt$/);
  assert.match(contentDisposition('cat.png', 'inline'), /^inline; filename="cat\.png"/);
  assert.equal(fileNameFromPath('/var/lib/data/'), 'data');
  assert.equal(fileNameFromPath('/'), 'download');
});

test('inlineImageType allows raster images only', () => {
  assert.equal(inlineImageType('a.png'), 'image/png');
  assert.equal(inlineImageType('a.JPG'), 'image/jpeg');
  assert.equal(inlineImageType('a.jpeg'), 'image/jpeg');
  assert.equal(inlineImageType('a.gif'), 'image/gif');
  assert.equal(inlineImageType('a.webp'), 'image/webp');
  assert.equal(inlineImageType('a.avif'), 'image/avif');
  assert.equal(inlineImageType('a.bmp'), 'image/bmp');
  assert.equal(inlineImageType('favicon.ico'), 'image/x-icon');
  for (const name of [
    'a.svg',
    'a.SVG',
    'a.svgz',
    'a.html',
    'a.xml',
    'a.xhtml',
    'a.png.html',
    'png',
    '.png',
    'a.constructor',
    'a.toString',
    'a.__proto__'
  ]) {
    assert.equal(inlineImageType(name), null, name);
  }
});

const pod = {
  spec: {
    containers: [
      {
        name: 'app',
        volumeMounts: [
          { name: 'data', mountPath: '/data' },
          { name: 'cfg', mountPath: '/etc/config', readOnly: false },
          { name: 'tmp', mountPath: '/tmp' },
          { name: 'creds', mountPath: '/run/creds' },
          {
            name: 'kube-api-access-x',
            mountPath: '/var/run/secrets/kubernetes.io/serviceaccount',
            readOnly: true
          },
          { name: 'info', mountPath: '/etc/podinfo' },
          { name: 'mixed', mountPath: '/etc/mixed' },
          { name: 'scratch', mountPath: '/scratch' },
          { name: 'host', mountPath: '/host', readOnly: true },
          { name: 'ghost', mountPath: '/ghost' }
        ]
      },
      { name: 'sidecar', volumeMounts: [{ name: 'tmp', mountPath: '/side' }] }
    ],
    volumes: [
      { name: 'data', persistentVolumeClaim: { claimName: 'app-data' } },
      { name: 'cfg', configMap: { name: 'cfg' } },
      { name: 'tmp', emptyDir: {} },
      { name: 'creds', secret: { secretName: 'creds' } },
      {
        name: 'kube-api-access-x',
        projected: {
          sources: [{ serviceAccountToken: { path: 'token' } }, { configMap: { name: 'ca' } }]
        }
      },
      { name: 'info', downwardAPI: { items: [] } },
      {
        name: 'mixed',
        projected: { sources: [{ configMap: { name: 'a' } }, { downwardAPI: {} }] }
      },
      { name: 'scratch', ephemeral: { volumeClaimTemplate: {} } },
      { name: 'host', hostPath: { path: '/var/log' } }
    ]
  }
};

test('podMounts classifies every mount of the chosen container', () => {
  assert.deepEqual(podMounts(pod, 'app'), [
    { path: '/data', volume: 'data', type: 'persistent', readOnly: false, claim: 'app-data' },
    { path: '/etc/config', volume: 'cfg', type: 'config', readOnly: true, claim: null },
    { path: '/etc/mixed', volume: 'mixed', type: 'config', readOnly: true, claim: null },
    { path: '/etc/podinfo', volume: 'info', type: 'config', readOnly: true, claim: null },
    { path: '/ghost', volume: 'ghost', type: 'other', readOnly: false, claim: null },
    { path: '/host', volume: 'host', type: 'other', readOnly: true, claim: null },
    { path: '/run/creds', volume: 'creds', type: 'secret', readOnly: true, claim: null },
    { path: '/scratch', volume: 'scratch', type: 'temporary', readOnly: false, claim: null },
    { path: '/tmp', volume: 'tmp', type: 'temporary', readOnly: false, claim: null },
    {
      path: '/var/run/secrets/kubernetes.io/serviceaccount',
      volume: 'kube-api-access-x',
      type: 'secret',
      readOnly: true,
      claim: null
    }
  ]);
  assert.deepEqual(
    podMounts(pod, 'sidecar').map((m) => m.path),
    ['/side']
  );
  assert.deepEqual(podMounts(undefined, 'app'), []);
  assert.deepEqual(podMounts({ spec: { containers: [{ name: 'app' }] } }, 'app'), []);
});

test('mountFor picks the deepest mount and isProtectedPath guards mounts and system folders', () => {
  const mounts = podMounts(pod, 'app');
  assert.equal(mountFor(mounts, '/data/x/y')?.volume, 'data');
  assert.equal(mountFor(mounts, '/database'), null);
  assert.equal(
    mountFor(mounts, '/var/run/secrets/kubernetes.io/serviceaccount/token')?.type,
    'secret'
  );
  for (const path of [
    '/',
    '/data',
    '/etc',
    '/var',
    '/proc',
    '/proc/1/root',
    '/dev/null',
    '/sys/fs'
  ]) {
    assert.equal(isProtectedPath(mounts, path), true, path);
  }
  for (const path of ['/data/file', '/database', '/app', '/devices', '/system']) {
    assert.equal(isProtectedPath(mounts, path), false, path);
  }
});

test('PodFileSlots caps work per user and releases once', () => {
  const slots = new PodFileSlots(2);
  const a = slots.acquire('u1');
  const b = slots.acquire('u1');
  const other = slots.acquire('u2');
  assert.throws(
    () => slots.acquire('u1'),
    (err: any) => err.getStatus() === 429 && err.getResponse().code === 'busy'
  );
  a();
  a();
  assert.equal(slots.inUse('u1'), 1);
  const c = slots.acquire('u1');
  b();
  c();
  other();
  assert.equal(slots.inUse('u1'), 0);
  assert.equal(slots.inUse('u2'), 0);
});

test('queryString rejects repeated or structured query values', () => {
  assert.equal(queryString(undefined, 'path'), undefined);
  assert.equal(queryString('/a', 'path'), '/a');
  assert.throws(() => queryString(['/a', '/b'], 'path'), /path must be a single value/);
  assert.throws(() => queryString({ a: 1 }, 'namespace'), /namespace/);
});

test('parsePodListing stops at the entry cap', () => {
  const records = ['w'];
  for (let i = 0; i < LISTING_MAX_ENTRIES + 5; i++) records.push(`f\tf${i}`);
  records.push('#', '');
  const listing = parsePodListing(records.join('\0'));
  assert.equal(listing.entries.length, LISTING_MAX_ENTRIES);
  assert.equal(listing.truncated, true);
  assert.equal(parsePodListing(['w', 'f\ta', '#', 'T', ''].join('\0')).truncated, true);
  assert.equal(parsePodListing(['w', 'f\ta', '#', ''].join('\0')).truncated, false);
});

test('classifyExecStatus spots a missing shell across runtimes', () => {
  const failures = [
    'OCI runtime exec failed: exec failed: unable to start container process: exec: "/bin/sh": stat /bin/sh: no such file or directory: unknown',
    'OCI runtime exec failed: exec failed: container_linux.go:380: starting container process caused: exec: "/bin/sh": stat /bin/sh: no such file or directory: unknown',
    'failed to exec in container: failed to start exec "abc": OCI runtime exec failed: exec failed: unable to start container process: exec: "/bin/sh": stat /bin/sh: no such file or directory: unknown',
    'command error: exec: "sh": executable file not found in $PATH',
    'executable file `/bin/sh` not found in $PATH: No such file or directory',
    'crun: executable file `/bin/sh` not found: No such file or directory'
  ];
  for (const message of failures) {
    assert.equal(isNoShellMessage(message), true, message);
    assert.deepEqual(
      classifyExecStatus({ status: 'Failure', message, reason: 'InternalError' }),
      { kind: 'no_shell' },
      message
    );
  }
  assert.deepEqual(
    classifyExecStatus({
      status: 'Failure',
      reason: 'InternalError',
      message: 'Internal error occurred: error executing command in container',
      details: { causes: [{ message: failures[0] }] }
    }),
    { kind: 'no_shell' }
  );
});

test('classifyExecStatus reads exit codes and does not mistake other failures for no_shell', () => {
  assert.deepEqual(classifyExecStatus({ status: 'Success' }), { kind: 'exit', code: 0 });
  assert.deepEqual(
    classifyExecStatus({
      status: 'Failure',
      reason: 'NonZeroExitCode',
      message:
        'command terminated with non-zero exit code: error executing command [/bin/sh -c ...], exit code 4',
      details: { causes: [{ reason: 'ExitCode', message: '4' }] }
    }),
    { kind: 'exit', code: 4 }
  );
  assert.deepEqual(
    classifyExecStatus({
      status: 'Failure',
      reason: 'NonZeroExitCode',
      message: 'command terminated with non-zero exit code: exit code 127'
    }),
    { kind: 'exit', code: 127 }
  );
  for (const message of [
    'container not found ("app")',
    'cannot exec in a stopped state: unknown',
    'exec: "tar": executable file not found in $PATH'
  ]) {
    const outcome = classifyExecStatus({ status: 'Failure', reason: 'InternalError', message });
    assert.deepEqual(outcome, { kind: 'error' }, message);
  }
  assert.deepEqual(
    classifyExecStatus({
      status: 'Failure',
      reason: 'NonZeroExitCode',
      message: 'sh: /bin/sh: not found',
      details: { causes: [{ reason: 'ExitCode', message: '127' }] }
    }),
    { kind: 'exit', code: 127 }
  );
  assert.deepEqual(classifyExecStatus(null), { kind: 'error' });
});

test('parsePreview decodes text and reports binary files', () => {
  const text = parsePreview(Buffer.concat([Buffer.from('5 1763900000\0'), Buffer.from('héllo')]));
  assert.deepEqual(text, {
    size: 5,
    mtime: 1763900000,
    binary: false,
    truncated: false,
    content: 'héllo'
  });
  const nul = parsePreview(Buffer.concat([Buffer.from('3 1\0'), Buffer.from([0x61, 0, 0x62])]));
  assert.equal(nul.binary, true);
  assert.equal(nul.content, null);
  const latin1 = parsePreview(Buffer.concat([Buffer.from('2 1\0'), Buffer.from([0xe9, 0x41])]));
  assert.equal(latin1.binary, true);
  const noStat = parsePreview(Buffer.from('\0plain'));
  assert.deepEqual([noStat.size, noStat.mtime, noStat.content], [null, null, 'plain']);
});

test('parsePreview truncates at the limit without splitting a character', () => {
  const body = Buffer.from('a'.repeat(9) + 'é' + 'b');
  const preview = parsePreview(Buffer.concat([Buffer.from('99 1\0'), body]), 10);
  assert.equal(preview.truncated, true);
  assert.equal(preview.binary, false);
  assert.equal(preview.content, 'a'.repeat(9));
  const exact = parsePreview(
    Buffer.concat([Buffer.from('10 1\0'), Buffer.from('a'.repeat(10))]),
    10
  );
  assert.equal(exact.truncated, false);
});

for (const shell of SHELLS) {
  const run = shell.run;

  test(`[${shell.label}] the listing script lists a real directory with odd names`, () => {
    withDir((dir) => {
      mkdirSync(join(dir, 'conf.d'));
      writeFileSync(join(dir, 'nginx.conf'), 'hello');
      writeFileSync(join(dir, '.hidden'), '');
      for (const name of ODD_NAMES) writeFileSync(join(dir, name), 'xyz');
      symlinkSync('nginx.conf', join(dir, 'link'));
      symlinkSync(join(dir, 'conf.d'), join(dir, 'linked.d'));
      symlinkSync(join(dir, 'missing'), join(dir, 'dangling'));
      utimesSync(join(dir, 'nginx.conf'), 1763900000, 1763900000);
      const result = run(LIST_SCRIPT, [dir]);
      assert.equal(result.code, 0, result.stderr);
      const listing = parsePodListing(result.stdout.toString('utf-8'));
      assert.equal(listing.writable, true);
      const rows = listing.entries
        .map((e) => [e.name, e.kind, e.size, e.target, e.linkTo])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      const expected = [
        ['.hidden', 'file', 0, null, null],
        ['conf.d', 'dir', null, null, null],
        ['dangling', 'symlink', null, null, join(dir, 'missing')],
        ['link', 'symlink', 5, 'file', 'nginx.conf'],
        ['linked.d', 'symlink', null, 'dir', join(dir, 'conf.d')],
        ['nginx.conf', 'file', 5, null, null],
        ...ODD_NAMES.map((name) => [name, 'file', 3, null, null])
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      assert.deepEqual(rows, expected);
      const conf = listing.entries.find((e) => e.name === 'nginx.conf')!;
      assert.equal(conf.mtime, 1763900000);
      assert.match(conf.mode ?? '', /^-rw/);
      assert.ok(conf.owner);
      assert.ok(conf.group);
      assert.match(listing.entries.find((e) => e.name === 'link')!.mode ?? '', /^l/);
      assert.match(listing.entries.find((e) => e.name === 'conf.d')!.mode ?? '', /^d/);
    });
  });

  test(`[${shell.label}] the listing script batches stat across many entries`, () => {
    withDir((dir) => {
      for (let i = 0; i < 1203; i++) writeFileSync(join(dir, `f${i}`), 'x'.repeat(i % 7));
      const result = run(LIST_SCRIPT, [dir]);
      const entries = parsePodListing(result.stdout.toString('utf-8')).entries;
      assert.equal(entries.length, 1203);
      for (const entry of entries) {
        assert.equal(entry.size, Number(entry.name.slice(1)) % 7, entry.name);
        assert.ok(entry.mtime);
      }
    });
  });

  test(`[${shell.label}] the listing script fails with exit 3 for a missing directory`, () => {
    assert.equal(run(LIST_SCRIPT, ['/definitely/not/here']).code, 3);
  });

  test(`[${shell.label}] the content script prints a header then the head of the file`, () => {
    withDir((dir) => {
      const file = join(dir, 'notes.txt');
      writeFileSync(file, 'hello world');
      utimesSync(file, 1763900000, 1763900000);
      const ok = run(CONTENT_SCRIPT, [file, '6']);
      assert.equal(ok.code, 0, ok.stderr);
      const preview = parsePreview(ok.stdout, 5);
      assert.deepEqual(preview, {
        size: 11,
        mtime: 1763900000,
        binary: false,
        truncated: true,
        content: 'hello'
      });
      assert.equal(run(CONTENT_SCRIPT, [dir, '6']).code, 6);
      assert.equal(run(CONTENT_SCRIPT, [join(dir, 'nope'), '6']).code, 3);
      const full = parsePreview(run(CONTENT_SCRIPT, [file, String(PREVIEW_MAX_BYTES + 1)]).stdout);
      assert.equal(full.content, 'hello world');
      assert.equal(full.truncated, false);
    });
  });

  test(`[${shell.label}] the download check tells files from folders`, () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'a'), 'x');
      assert.equal(run(DOWNLOAD_CHECK_SCRIPT, [join(dir, 'a')]).stdout.toString(), 'f');
      assert.equal(run(DOWNLOAD_CHECK_SCRIPT, [dir]).stdout.toString(), 'd');
      assert.equal(run(DOWNLOAD_CHECK_SCRIPT, [join(dir, 'b')]).code, 3);
    });
  });

  test(`[${shell.label}] the write script writes exactly N bytes and cleans up`, () => {
    withDir((dir) => {
      const target = join(dir, 'up', 'nested', '-rf');
      const data = Buffer.from('0123456789');
      const extra = Buffer.concat([data, Buffer.from('EXTRA')]);
      const ok = run(WRITE_SCRIPT, [target, '10', '.orchard-upload-t1', 'create', ''], {
        input: extra
      });
      assert.equal(ok.code, 0, ok.stderr);
      assert.deepEqual(readFileSync(target), data);
      assert.match(ok.stdout.toString(), /^10 \d+/);
      assert.deepEqual(readdirSync(join(dir, 'up', 'nested')), ['-rf']);

      const exists = run(WRITE_SCRIPT, [target, '3', '.orchard-upload-t2', 'create', ''], {
        input: Buffer.from('abc')
      });
      assert.equal(exists.code, 4);
      assert.deepEqual(readFileSync(target), data);

      const shortFile = join(dir, 'short.bin');
      const short = run(WRITE_SCRIPT, [shortFile, '100', '.orchard-upload-t3', 'create', ''], {
        input: Buffer.from('only a few')
      });
      assert.equal(short.code, 9);
      assert.equal(existsSync(shortFile), false);
      assert.deepEqual(
        readdirSync(dir).filter((n) => n.startsWith('.orchard-upload')),
        []
      );

      const empty = join(dir, 'empty');
      assert.equal(run(WRITE_SCRIPT, [empty, '0', '.orchard-upload-t4', 'create', '']).code, 0);
      assert.equal(readFileSync(empty).length, 0);

      assert.equal(
        run(WRITE_SCRIPT, [dir, '1', '.orchard-upload-t5', 'overwrite', ''], {
          input: Buffer.from('x')
        }).code,
        6
      );
    });
  });

  test(`[${shell.label}] overwriting keeps the inode and mode of the old file`, () => {
    withDir((dir) => {
      const target = join(dir, 'run.sh');
      writeFileSync(target, 'old contents');
      chmodSync(target, 0o751);
      const before = statSync(target);
      const result = run(WRITE_SCRIPT, [target, '3', '.orchard-upload-t6', 'overwrite', ''], {
        input: Buffer.from('new')
      });
      assert.equal(result.code, 0, result.stderr);
      const after = statSync(target);
      assert.equal(readFileSync(target, 'utf-8'), 'new');
      assert.equal(after.ino, before.ino);
      assert.equal(after.mode & 0o777, 0o751);
      assert.deepEqual(readdirSync(dir), ['run.sh']);
    });
  });

  test(`[${shell.label}] edits refuse a file that changed since it was opened`, () => {
    withDir((dir) => {
      const target = join(dir, 'app.conf');
      writeFileSync(target, 'v1');
      utimesSync(target, 1763900000, 1763900000);
      const stale = run(WRITE_SCRIPT, [target, '2', '.orchard-upload-t7', 'edit', '1700000000'], {
        input: Buffer.from('v2')
      });
      assert.equal(stale.code, 7);
      assert.equal(readFileSync(target, 'utf-8'), 'v1');
      const fresh = run(WRITE_SCRIPT, [target, '2', '.orchard-upload-t8', 'edit', '1763900000'], {
        input: Buffer.from('v2')
      });
      assert.equal(fresh.code, 0, fresh.stderr);
      assert.equal(readFileSync(target, 'utf-8'), 'v2');
      const created = run(
        WRITE_SCRIPT,
        [join(dir, 'new.txt'), '2', '.orchard-upload-t9', 'edit', ''],
        {
          input: Buffer.from('hi')
        }
      );
      assert.equal(created.code, 0, created.stderr);
      const orphan = run(
        WRITE_SCRIPT,
        [join(dir, 'no', 'such.txt'), '2', '.orchard-upload-ta', 'edit', ''],
        {
          input: Buffer.from('hi')
        }
      );
      assert.equal(orphan.code, 3);
    });
  });

  test(`[${shell.label}] the write check runs every check without writing`, () => {
    withDir((dir) => {
      writeFileSync(join(dir, 'taken'), 'x');
      assert.equal(
        run(WRITE_SCRIPT, [join(dir, 'taken'), '0', '.t', 'check', '', 'create']).code,
        4
      );
      assert.equal(
        run(WRITE_SCRIPT, [join(dir, 'taken'), '0', '.t', 'check', '', 'overwrite']).code,
        0
      );
      assert.equal(
        run(WRITE_SCRIPT, [join(dir, 'a', 'b'), '0', '.t', 'check', '', 'create']).code,
        0
      );
      assert.equal(
        run(WRITE_SCRIPT, [join(dir, 'taken', 'b'), '0', '.t', 'check', '', 'create']).code,
        6
      );
      assert.deepEqual(readdirSync(dir), ['taken']);
    });
  });

  if (PERMISSIONS_ENFORCED) {
    test(`[${shell.label}] writes into a read-only folder exit with the read-only code`, () => {
      withDir((dir) => {
        const locked = join(dir, 'locked');
        mkdirSync(locked);
        chmodSync(locked, 0o555);
        try {
          const target = join(locked, 'x');
          assert.equal(
            run(WRITE_SCRIPT, [target, '1', '.t', 'create', ''], { input: Buffer.from('x') }).code,
            5
          );
          assert.equal(run(WRITE_SCRIPT, [target, '0', '.t', 'check', '', 'create']).code, 5);
          assert.equal(run(MKDIR_SCRIPT, [join(locked, 'sub', 'deeper')]).code, 5);
        } finally {
          chmodSync(locked, 0o755);
        }
      });
    });
  }

  test(`[${shell.label}] mkdir creates parents and refuses an existing path`, () => {
    withDir((dir) => {
      for (const name of ODD_NAMES) {
        const target = join(dir, 'p', name);
        assert.equal(run(MKDIR_SCRIPT, [target]).code, 0, name);
        assert.ok(statSync(target).isDirectory(), name);
        assert.equal(run(MKDIR_SCRIPT, [target]).code, 4, name);
      }
      writeFileSync(join(dir, 'file'), '');
      assert.equal(run(MKDIR_SCRIPT, [join(dir, 'file')]).code, 4);
      assert.equal(run(MKDIR_SCRIPT, [join(dir, 'file', 'sub')]).code, 6);
    });
  });

  test(`[${shell.label}] move renames and refuses to replace a destination`, () => {
    withDir((dir) => {
      for (const name of ODD_NAMES) writeFileSync(join(dir, name), name);
      mkdirSync(join(dir, 'into'));
      for (const name of ODD_NAMES) {
        const result = run(MOVE_SCRIPT, [join(dir, name), join(dir, 'into', `${name}.moved`)]);
        assert.equal(result.code, 0, `${name}: ${result.stderr}`);
        assert.equal(readFileSync(join(dir, 'into', `${name}.moved`), 'utf-8'), name);
      }
      writeFileSync(join(dir, 'a'), 'a');
      writeFileSync(join(dir, 'b'), 'b');
      assert.equal(run(MOVE_SCRIPT, [join(dir, 'a'), join(dir, 'b')]).code, 4);
      assert.equal(run(MOVE_SCRIPT, [join(dir, 'a'), join(dir, 'into')]).code, 4);
      assert.equal(readFileSync(join(dir, 'b'), 'utf-8'), 'b');
      assert.equal(run(MOVE_SCRIPT, [join(dir, 'gone'), join(dir, 'c')]).code, 3);
      assert.equal(run(MOVE_SCRIPT, [join(dir, 'a'), join(dir, 'no', 'c')]).code, 3);
    });
  });

  test(`[${shell.label}] delete removes files and folders and refuses the root`, () => {
    withDir((dir) => {
      assert.equal(run(DELETE_SCRIPT, ['/']).code, 10);
      for (const name of ODD_NAMES) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, 'inner'), 'x');
      }
      writeFileSync(join(dir, 'keep'), 'x');
      for (const name of ODD_NAMES) {
        const result = run(DELETE_SCRIPT, [join(dir, name)]);
        assert.equal(result.code, 0, `${name}: ${result.stderr}`);
        assert.equal(result.stdout.toString(), 'd');
      }
      assert.deepEqual(readdirSync(dir), ['keep']);
      mkdirSync(join(dir, 'real'));
      writeFileSync(join(dir, 'real', 'precious'), 'x');
      symlinkSync(join(dir, 'real'), join(dir, 'link'));
      const link = run(DELETE_SCRIPT, [join(dir, 'link')]);
      assert.equal(link.stdout.toString(), 'f');
      assert.ok(existsSync(join(dir, 'real', 'precious')));
      assert.equal(run(DELETE_SCRIPT, [join(dir, 'keep')]).stdout.toString(), 'f');
      assert.equal(run(DELETE_SCRIPT, [join(dir, 'keep')]).code, 3);
    });
  });
}

for (const shell of SHELLS) {
  const run = shell.run;

  test(`[${shell.label}] delete and move resolve symlinked parents before acting`, () => {
    withDir((dir) => {
      const pvc = join(dir, 'pvc');
      mkdirSync(join(pvc, 'nested'), { recursive: true });
      writeFileSync(join(pvc, 'precious'), 'x');
      mkdirSync(join(dir, 'app'));
      symlinkSync(dir, join(dir, 'app', 'l'));
      symlinkSync('/dev', join(dir, 'devlink'));
      symlinkSync('/proc', join(dir, 'proclink'));
      mkdirSync(join(dir, 'run', 'secrets'), { recursive: true });
      symlinkSync(join(dir, 'run'), join(dir, 'varrun'));
      const mounts = [pvc, join(dir, 'varrun', 'secrets')];

      assert.equal(run(DELETE_SCRIPT, [join(dir, 'app', 'l', 'pvc'), ...mounts]).code, 10);
      assert.equal(run(DELETE_SCRIPT, [pvc, ...mounts]).code, 10);
      assert.equal(run(DELETE_SCRIPT, [join(dir, 'devlink', 'null'), ...mounts]).code, 10);
      assert.equal(run(DELETE_SCRIPT, [join(dir, 'proclink', 'self'), ...mounts]).code, 10);
      assert.equal(run(DELETE_SCRIPT, [join(dir, 'run'), ...mounts]).code, 10);
      assert.equal(run(DELETE_SCRIPT, [dir, ...mounts]).code, 10);
      assert.equal(
        run(MOVE_SCRIPT, [join(dir, 'app', 'l', 'pvc'), join(dir, 'stolen'), ...mounts]).code,
        10
      );
      assert.equal(
        run(MOVE_SCRIPT, [join(dir, 'app', 'l', 'run'), join(dir, 'gone'), ...mounts]).code,
        10
      );
      assert.equal(
        run(MOVE_SCRIPT, [join(pvc, 'precious'), join(dir, 'devlink', 'x'), ...mounts]).code,
        10
      );
      assert.ok(existsSync(join(pvc, 'precious')));
      assert.ok(existsSync(join(pvc, 'nested')));
      assert.ok(existsSync(join(dir, 'run', 'secrets')));

      const nested = run(DELETE_SCRIPT, [join(dir, 'app', 'l', 'pvc', 'nested'), ...mounts]);
      assert.equal(nested.code, 0, nested.stderr);
      assert.equal(existsSync(join(pvc, 'nested')), false);
      const link = run(DELETE_SCRIPT, [join(dir, 'app', 'l'), ...mounts]);
      assert.equal(link.code, 0, link.stderr);
      assert.equal(link.stdout.toString(), 'f');
      assert.ok(existsSync(join(pvc, 'precious')));
    });
  });

  test(`[${shell.label}] the listing script stops at the entry cap`, () => {
    withDir((dir) => {
      for (let i = 0; i < LISTING_MAX_ENTRIES + 3; i++) writeFileSync(join(dir, `f${i}`), '');
      const result = run(LIST_SCRIPT, [dir]);
      assert.equal(result.code, 0, result.stderr);
      const listing = parsePodListing(result.stdout.toString('utf-8'));
      assert.equal(listing.truncated, true);
      assert.equal(listing.entries.length, LISTING_MAX_ENTRIES);
      assert.ok(listing.entries.every((e) => e.size === 0));
    });
  });
}

test('delete falls back to the textual guard without realpath or readlink', () => {
  withDir((dir) => {
    const pvc = join(dir, 'pvc');
    mkdirSync(pvc);
    mkdirSync(join(dir, 'other'));
    const tools = toolDir(without('readlink'));
    try {
      const run = SHELLS[0].run;
      assert.equal(run(DELETE_SCRIPT, [pvc, pvc], { path: tools }).code, 10);
      assert.equal(run(DELETE_SCRIPT, [dir, pvc], { path: tools }).code, 10);
      assert.equal(run(DELETE_SCRIPT, ['/dev/null', pvc], { path: tools }).code, 10);
      const ok = run(DELETE_SCRIPT, [join(dir, 'other'), pvc], { path: tools });
      assert.equal(ok.code, 0, ok.stderr);
    } finally {
      rmSync(tools, { recursive: true, force: true });
    }
  });
});

test('the listing script still lists with only shell builtins', () => {
  withDir((dir) => {
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'file'), 'abc');
    symlinkSync('file', join(dir, 'link'));
    const bare = tempDir();
    const readlinkOnly = toolDir(['readlink']);
    try {
      const run = SHELLS[0].run;
      const none = parsePodListing(run(LIST_SCRIPT, [dir], { path: bare }).stdout.toString());
      assert.deepEqual(
        none.entries
          .map((e) => [e.name, e.kind, e.size, e.mtime, e.mode, e.owner, e.target, e.linkTo])
          .sort(),
        [
          ['file', 'file', null, null, null, null, null, null],
          ['link', 'symlink', null, null, null, null, 'file', null],
          ['sub', 'dir', null, null, null, null, null, null]
        ]
      );
      const links = parsePodListing(
        run(LIST_SCRIPT, [dir], { path: readlinkOnly }).stdout.toString()
      );
      assert.equal(links.entries.find((e) => e.name === 'link')?.linkTo, 'file');
      assert.equal(links.entries.find((e) => e.name === 'file')?.size, null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
      rmSync(readlinkOnly, { recursive: true, force: true });
    }
  });
});

test('scripts report a missing tool by name', () => {
  withDir((dir) => {
    const run = SHELLS[0].run;
    const noTar = toolDir(without('tar'));
    const noHead = toolDir(without('head'));
    const noStat = toolDir(without('stat'));
    try {
      const tar = run(DOWNLOAD_CHECK_SCRIPT, [dir], { path: noTar });
      assert.deepEqual([tar.code, tar.stdout.toString()], [8, 'tar']);
      const head = run(CONTENT_SCRIPT, [__filename, '10'], { path: noHead });
      assert.deepEqual([head.code, head.stdout.toString()], [8, 'head']);
      const upload = run(WRITE_SCRIPT, [join(dir, 'f'), '1', '.t', 'create', ''], {
        path: noHead,
        input: Buffer.from('x')
      });
      assert.deepEqual([upload.code, upload.stdout.toString()], [8, 'head']);
      const statless = run(WRITE_SCRIPT, [join(dir, 'g'), '2', '.t', 'create', ''], {
        path: noStat,
        input: Buffer.from('hi')
      });
      assert.equal(statless.code, 0, statless.stderr);
      assert.equal(statless.stdout.toString(), '');
      const preview = parsePreview(
        run(CONTENT_SCRIPT, [join(dir, 'g'), '10'], { path: noStat }).stdout
      );
      assert.deepEqual([preview.size, preview.mtime, preview.content], [null, null, 'hi']);
    } finally {
      for (const d of [noTar, noHead, noStat]) rmSync(d, { recursive: true, force: true });
    }
  });
});

test('the folder download command archives names that look like flags', () => {
  withDir((dir) => {
    mkdirSync(join(dir, '-rf'));
    writeFileSync(join(dir, '-rf', 'inner'), 'x');
    const archive = execFileSync('tar', ['-czf', '-', '-C', dir, '--', '-rf']);
    const names = execFileSync('tar', ['-tzf', '-'], { input: archive })
      .toString()
      .trim()
      .split('\n');
    assert.deepEqual(names.sort(), ['-rf/', '-rf/inner']);
  });
});
