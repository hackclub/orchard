import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import type { MockContext } from '../plugin.ts';
import { STREAMING, reply, type Router } from '../router.ts';

const MIB = 1024 ** 2;
const READ_LIMIT = MIB;
const UPLOAD_LIMIT = 512 * MIB;
const UPLOAD_BYTES_PER_SECOND = 3 * MIB;
const LIST_CAP = 1000;

type Owner = 'root' | 'node';

interface Base {
	mtime: number;
	mode: string;
	owner: Owner;
}

type FsNode =
	| (Base & { kind: 'file'; data: Buffer | null; size: number })
	| (Base & { kind: 'dir' })
	| (Base & { kind: 'symlink'; to: string });

type MountType = 'persistent' | 'temporary' | 'config' | 'secret' | 'other';

interface Mount {
	path: string;
	volume: string;
	type: MountType;
	readOnly: boolean;
	claim: string | null;
}

const MOUNTS: Mount[] = [
	{ path: '/data', volume: 'data', type: 'persistent', readOnly: false, claim: 'app-data' },
	{ path: '/etc/config', volume: 'config', type: 'config', readOnly: true, claim: null },
	{ path: '/run/secrets/app', volume: 'app-secrets', type: 'secret', readOnly: true, claim: null },
	{ path: '/tmp', volume: 'tmp', type: 'temporary', readOnly: false, claim: null }
];

function fail(status: number, message: string, code?: string, extra: Record<string, unknown> = {}) {
	return reply(status, { statusCode: status, message, ...(code ? { code } : {}), ...extra });
}

function pngChunk(type: string, data: Buffer) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body) >>> 0);
	return Buffer.concat([len, body, crc]);
}

function png(width: number, height: number, paint: (x: number, y: number) => number[]) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const raw = Buffer.alloc((width * 3 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 3 + 1)] = 0;
		for (let x = 0; x < width; x++) {
			const [r, g, b] = paint(x, y);
			const at = y * (width * 3 + 1) + 1 + x * 3;
			raw[at] = r;
			raw[at + 1] = g;
			raw[at + 2] = b;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

const ORCHARD_PNG = () =>
	png(480, 300, (x, y) => {
		const t = y / 300;
		const sky = [mix(255, 236, t), mix(214, 120, t), mix(170, 120, t)];
		const hill = Math.sin(x / 60) * 18 + 210 + Math.cos(x / 23) * 6;
		if (y > hill) return [mix(70, 40, (y - hill) / 90), mix(130, 90, (y - hill) / 90), 72];
		const dx = x - 360;
		const dy = y - 90;
		if (dx * dx + dy * dy < 34 * 34) return [255, 244, 214];
		return sky;
	});

const AVATAR_PNG = () =>
	png(96, 96, (x, y) => {
		const cell = (Math.floor(x / 24) * 7 + Math.floor(y / 24) * 3) % 5;
		const left = Math.floor(x / 24) < 2 ? Math.floor(x / 24) : 3 - Math.floor(x / 24);
		const on = ((left * 5 + Math.floor(y / 24) * 3) % 4) % 2 === 0 || cell === 3;
		return on ? [236, 55, 80] : [250, 240, 242];
	});

const text = (s: string) => Buffer.from(s.replace(/^\n/, ''), 'utf8');

const PACKAGE_JSON = `{
  "name": "web",
  "version": "1.4.2",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node dist/server.js",
    "build": "tsc -p .",
    "migrate": "node dist/migrate.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "fastify": "^5.1.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.3"
  }
}
`;

const SERVER_TS = `
import Fastify from 'fastify';
import { z } from 'zod';
import { openDatabase } from './db.js';
import { routes } from './routes.js';

const Env = z.object({
	PORT: z.coerce.number().default(3000),
	DATABASE_PATH: z.string().default('/data/app.sqlite')
});

/* Read once at boot; a change needs a restart. */
const env = Env.parse(process.env);
const db = openDatabase(env.DATABASE_PATH);

export async function main() {
	const app = Fastify({ logger: true });
	app.decorate('db', db);
	await app.register(routes, { prefix: '/api' });
	app.get('/healthz', async () => ({ ok: true, uptime: process.uptime() }));
	await app.listen({ host: '0.0.0.0', port: env.PORT });
	return app;
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
`;

const DB_TS = `
import Database from 'better-sqlite3';

export function openDatabase(path: string) {
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.exec(\`
		CREATE TABLE IF NOT EXISTS uploads (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL
		)
	\`);
	return db;
}
`;

const ROUTES_TS = `
import type { FastifyInstance } from 'fastify';

export async function routes(app: FastifyInstance) {
	app.get('/uploads', async () => {
		return app.db.prepare('SELECT * FROM uploads ORDER BY created_at DESC LIMIT 50').all();
	});
}
`;

const README = `
# web

The Hack Club site API. Runs on Fastify with SQLite on the \`/data\` volume.

## Running

\`\`\`sh
npm run build && npm start
\`\`\`

Uploads land in \`/data/uploads\`.
`;

const ENV = `
NODE_ENV=production
PORT=3000
DATABASE_PATH=/data/app.sqlite
# rotated 2026-10-02
SESSION_SECRET="9f2c1e7a54b3d8a0"
`;

const NGINX = `
server {
  listen 8080;
  location /api/ { proxy_pass http://127.0.0.1:3000; }
  location / { root /app/public; try_files $uri /index.html; }
}
`;

const PACKAGES = [
	'@fastify/ajv-compiler',
	'@fastify/error',
	'@fastify/fast-json-stringify-compiler',
	'@fastify/merge-json-schemas',
	'abstract-logging',
	'ajv',
	'ajv-formats',
	'atomic-sleep',
	'avvio',
	'base64-js',
	'better-sqlite3',
	'bindings',
	'bl',
	'buffer',
	'chownr',
	'cookie',
	'decompress-response',
	'deep-extend',
	'detect-libc',
	'end-of-stream',
	'expand-template',
	'fast-decode-uri-component',
	'fast-deep-equal',
	'fast-json-stringify',
	'fast-querystring',
	'fast-redact',
	'fast-uri',
	'fastify',
	'fastq',
	'file-uri-to-path',
	'find-my-way',
	'fs-constants',
	'github-from-package',
	'ieee754',
	'inherits',
	'ini',
	'json-schema-ref-resolver',
	'json-schema-traverse',
	'light-my-request',
	'mimic-response',
	'minimist',
	'mkdirp-classic',
	'napi-build-utils',
	'node-abi',
	'on-exit-leak-free',
	'once',
	'pino',
	'pino-abstract-transport',
	'pino-std-serializers',
	'prebuild-install',
	'process-warning',
	'pump',
	'quick-format-unescaped',
	'rc',
	'readable-stream',
	'real-require',
	'require-from-string',
	'ret',
	'reusify',
	'rfdc',
	'safe-buffer',
	'safe-regex2',
	'safe-stable-stringify',
	'secure-json-parse',
	'semver',
	'set-cookie-parser',
	'simple-concat',
	'simple-get',
	'sonic-boom',
	'split2',
	'string_decoder',
	'strip-json-comments',
	'tar-fs',
	'tar-stream',
	'thread-stream',
	'toad-cache',
	'tunnel-agent',
	'typescript',
	'util-deprecate',
	'wrappy',
	'zod'
];

class MockFs {
	nodes = new Map<string, FsNode>();
	now = Math.floor(Date.now() / 1000);

	constructor() {
		const ago = (minutes: number) => this.now - Math.round(minutes * 60);
		const dir = (path: string, owner: Owner = 'root', minutes = 60 * 24 * 30) =>
			this.nodes.set(path, { kind: 'dir', mtime: ago(minutes), mode: 'drwxr-xr-x', owner });
		const file = (
			path: string,
			data: Buffer,
			owner: Owner = 'node',
			minutes = 60 * 5,
			mode = '-rw-r--r--'
		) =>
			this.nodes.set(path, {
				kind: 'file',
				data,
				size: data.length,
				mtime: ago(minutes),
				mode,
				owner
			});
		const link = (path: string, to: string, minutes = 60 * 24 * 30) =>
			this.nodes.set(path, {
				kind: 'symlink',
				to,
				mtime: ago(minutes),
				mode: 'lrwxrwxrwx',
				owner: 'root'
			});

		dir('/', 'root');
		for (const d of [
			'/usr',
			'/usr/bin',
			'/usr/lib',
			'/etc',
			'/run',
			'/run/secrets',
			'/var',
			'/var/log',
			'/home'
		])
			dir(d);
		link('/bin', 'usr/bin');
		link('/lib', 'usr/lib');
		file(
			'/usr/bin/node',
			Buffer.from('\x7fELF\x02\x01\x01\0node'),
			'root',
			60 * 24 * 30,
			'-rwxr-xr-x'
		);
		file(
			'/usr/bin/sh',
			Buffer.from('\x7fELF\x02\x01\x01\0busybox'),
			'root',
			60 * 24 * 30,
			'-rwxr-xr-x'
		);
		file('/etc/hostname', text('web-6f9c8d7b5-36e8d\n'), 'root', 60 * 3);
		file('/etc/os-release', text('NAME="Alpine Linux"\nVERSION_ID=3.20.3\n'), 'root', 60 * 24 * 30);
		dir('/etc/nginx');
		file('/etc/nginx/nginx.conf', text(NGINX), 'root', 60 * 24 * 9);

		dir('/etc/config', 'root', 60 * 2);
		file(
			'/etc/config/app.yaml',
			text('log:\n  level: info\nfeatures:\n  uploads: true\n  signups: false\n'),
			'root',
			60 * 2
		);
		file('/etc/config/limits.toml', text('[uploads]\nmax_mb = 25\n'), 'root', 60 * 2);
		dir('/run/secrets/app', 'root', 60 * 2);
		file('/run/secrets/app/session-secret', text('••••\n'), 'root', 60 * 2, '-r--------');

		dir('/app', 'node', 60 * 3);
		file('/app/package.json', text(PACKAGE_JSON), 'node', 60 * 3);
		file('/app/package-lock.json', text('{\n  "lockfileVersion": 3\n}\n'), 'node', 60 * 3);
		file('/app/README.md', text(README), 'node', 60 * 24 * 2);
		file(
			'/app/tsconfig.json',
			text('{\n  "compilerOptions": { "outDir": "dist", "strict": true }\n}\n'),
			'node',
			60 * 24 * 12
		);
		file(
			'/app/Dockerfile',
			text(
				'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nCMD ["npm", "start"]\n'
			),
			'node',
			60 * 24 * 12
		);
		file('/app/.env', text(ENV), 'node', 60 * 3, '-rw-------');
		file('/app/.dockerignore', text('node_modules\n.git\n'), 'node', 60 * 24 * 12);
		dir('/app/.cache', 'node', 60 * 3);
		dir('/app/src', 'node', 60 * 3);
		file('/app/src/server.ts', text(SERVER_TS), 'node', 60 * 3);
		file('/app/src/db.ts', text(DB_TS), 'node', 60 * 26);
		file('/app/src/routes.ts', text(ROUTES_TS), 'node', 60 * 26);
		dir('/app/dist', 'node', 60 * 3);
		file('/app/dist/server.js', text(SERVER_TS.replace(/: string/g, '')), 'node', 60 * 3);
		dir('/app/public', 'node', 60 * 3);
		file(
			'/app/public/index.html',
			text(
				'<!doctype html>\n<html lang="en">\n  <head><title>web</title></head>\n  <body><div id="app"></div></body>\n</html>\n'
			),
			'node',
			60 * 3
		);
		dir('/app/node_modules', 'node', 60 * 3);
		PACKAGES.forEach((name, i) => {
			const base = `/app/node_modules/${name}`;
			if (name.includes('/')) dir(`/app/node_modules/${name.split('/')[0]}`, 'node', 60 * 3);
			dir(base, 'node', 60 * 3 + i);
			file(
				`${base}/package.json`,
				text(`{ "name": "${name}", "version": "1.${i}.0" }\n`),
				'node',
				60 * 3 + i
			);
		});
		link('/app/uploads', '/data/uploads', 60 * 3);
		link('/app/logs', '/var/log/web', 60 * 3);
		link('/app/config.yaml', '/etc/config/app.yaml', 60 * 3);
		this.nodes.set('/app/core.dump', {
			kind: 'file',
			data: null,
			size: 48 * MIB + 312_448,
			mtime: ago(60 * 7),
			mode: '-rw-------',
			owner: 'node'
		});

		dir('/data', 'node', 12);
		this.nodes.set('/data/app.sqlite', {
			kind: 'file',
			data: Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096 * 24 - 16, 1)]),
			size: 4096 * 24,
			mtime: ago(1),
			mode: '-rw-r--r--',
			owner: 'node'
		});
		file('/data/app.sqlite-wal', Buffer.alloc(8240, 0), 'node', 1);
		dir('/data/uploads', 'node', 40);
		file('/data/uploads/orchard-sunset.png', ORCHARD_PNG(), 'node', 40);
		file('/data/uploads/avatar.png', AVATAR_PNG(), 'node', 60 * 24 * 3);
		dir('/data/backups', 'node', 60 * 24);
		file(
			'/data/backups/2026-11-22.sql.gz',
			gzipSync(Buffer.from('-- backup\n'.repeat(400))),
			'node',
			60 * 24
		);

		dir('/tmp', 'root', 5);
		this.nodes.get('/tmp')!.mode = 'drwxrwxrwt';
		file('/tmp/fastify-1.sock.lock', text('1\n'), 'node', 5);
		dir('/tmp/sessions', 'node', 2);
		for (let i = 0; i < LIST_CAP + 240; i++) {
			file(
				`/tmp/sessions/sess-${String(i).padStart(5, '0')}.json`,
				text('{"user":null}\n'),
				'node',
				2 + i
			);
		}
		dir('/home/node', 'node', 60 * 24 * 30);
		file('/home/node/.bash_history', text('ls /data\ncat /etc/config/app.yaml\n'), 'node', 60 * 9);
	}

	children(path: string) {
		const prefix = path === '/' ? '/' : path + '/';
		const out: [string, FsNode][] = [];
		for (const [p, n] of this.nodes) {
			if (p === path || !p.startsWith(prefix)) continue;
			if (p.slice(prefix.length).includes('/')) continue;
			out.push([p.slice(prefix.length), n]);
		}
		return out;
	}

	resolve(path: string, followLast = true, depth = 0): string | null {
		if (depth > 20) return null;
		const parts = path.split('/').filter(Boolean);
		let current = '/';
		for (let i = 0; i < parts.length; i++) {
			const next = current === '/' ? `/${parts[i]}` : `${current}/${parts[i]}`;
			const node = this.nodes.get(next);
			if (!node) return i === parts.length - 1 ? next : null;
			if (node.kind === 'symlink' && (followLast || i < parts.length - 1)) {
				const target = node.to.startsWith('/')
					? node.to
					: `${current === '/' ? '' : current}/${node.to}`;
				const resolved = this.resolve(target, true, depth + 1);
				if (!resolved) return null;
				current = resolved;
				continue;
			}
			current = next;
		}
		return current;
	}

	get(path: string, followLast = true) {
		const real = this.resolve(path, followLast);
		if (!real) return null;
		const node = this.nodes.get(real);
		return node ? { real, node } : null;
	}

	mountOf(path: string) {
		let best: Mount | null = null;
		for (const m of MOUNTS) {
			if (path === m.path || path.startsWith(m.path + '/')) {
				if (!best || m.path.length > best.path.length) best = m;
			}
		}
		return best;
	}

	writable(dirPath: string) {
		const hit = this.get(dirPath);
		if (!hit || hit.node.kind !== 'dir') return false;
		if (this.mountOf(hit.real)?.readOnly) return false;
		return hit.node.owner === 'node' || hit.node.mode.endsWith('t');
	}

	entry(name: string, node: FsNode) {
		const base = {
			name,
			mtime: node.mtime,
			mode: node.mode,
			owner: node.owner,
			group: node.owner,
			target: null as 'file' | 'dir' | null,
			linkTo: null as string | null
		};
		if (node.kind === 'file') return { ...base, kind: 'file', size: node.size };
		if (node.kind === 'dir') return { ...base, kind: 'dir', size: null };
		return { ...base, kind: 'symlink', size: null, linkTo: node.to };
	}

	removeTree(path: string) {
		const prefix = path + '/';
		for (const p of [...this.nodes.keys()])
			if (p === path || p.startsWith(prefix)) this.nodes.delete(p);
	}

	moveTree(from: string, to: string) {
		const prefix = from + '/';
		const moved: [string, FsNode][] = [];
		for (const [p, n] of this.nodes) {
			if (p === from) moved.push([to, n]);
			else if (p.startsWith(prefix)) moved.push([to + p.slice(from.length), n]);
		}
		this.removeTree(from);
		for (const [p, n] of moved) this.nodes.set(p, n);
	}

	ensureDirs(path: string) {
		const parts = path.split('/').filter(Boolean);
		let current = '';
		for (const part of parts) {
			current += '/' + part;
			const real = this.resolve(current) ?? current;
			if (!this.nodes.has(real)) {
				this.nodes.set(real, {
					kind: 'dir',
					mtime: this.stamp(),
					mode: 'drwxr-xr-x',
					owner: 'node'
				});
			}
		}
	}

	stamp() {
		return Math.floor(Date.now() / 1000);
	}
}

function normalize(raw: string | null): string | null {
	if (raw == null) return null;
	if (!raw.startsWith('/') || raw.includes('\0')) return null;
	const parts = raw.split('/').filter((p) => p && p !== '.');
	if (parts.includes('..')) return null;
	return '/' + parts.join('/');
}

const parentOf = (path: string) => '/' + path.split('/').filter(Boolean).slice(0, -1).join('/');
const nameOf = (path: string) => path.split('/').filter(Boolean).pop() ?? '';

const IMAGE_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	ico: 'image/x-icon'
};

function tarArchive(fs: MockFs, root: string) {
	const blocks: Buffer[] = [];
	const base = parentOf(root);
	const header = (name: string, size: number, type: '0' | '5', mtime: number) => {
		const h = Buffer.alloc(512);
		h.write(name.slice(0, 99), 0, 'utf8');
		h.write(type === '5' ? '0000755\0' : '0000644\0', 100);
		h.write('0001750\0', 108);
		h.write('0001750\0', 116);
		h.write(size.toString(8).padStart(11, '0') + '\0', 124);
		h.write(mtime.toString(8).padStart(11, '0') + '\0', 136);
		h.write('        ', 148);
		h.write(type, 156);
		h.write('ustar\0' + '00', 257);
		let sum = 0;
		for (const b of h) sum += b;
		h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
		return h;
	};
	const paths = [...fs.nodes.keys()].filter((p) => p === root || p.startsWith(root + '/')).sort();
	for (const p of paths) {
		const node = fs.nodes.get(p)!;
		const rel = p.slice(base === '/' ? 1 : base.length + 1);
		if (node.kind === 'dir') blocks.push(header(rel + '/', 0, '5', node.mtime));
		if (node.kind === 'file') {
			const data = node.data ?? Buffer.alloc(Math.min(node.size, MIB));
			blocks.push(header(rel, data.length, '0', node.mtime), data);
			const pad = (512 - (data.length % 512)) % 512;
			if (pad) blocks.push(Buffer.alloc(pad));
		}
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

function readRaw(req: IncomingMessage, length: number, throttle: number) {
	return new Promise<Buffer | null>((resolve) => {
		const chunks: Buffer[] = [];
		let received = 0;
		const started = Date.now();
		req.on('data', (chunk: Buffer) => {
			chunks.push(chunk);
			received += chunk.length;
			const due = (received / throttle) * 1000 - (Date.now() - started);
			if (due > 0) {
				req.pause();
				setTimeout(() => req.resume(), due);
			}
		});
		req.on('end', () => resolve(received === length ? Buffer.concat(chunks) : null));
		req.on('aborted', () => resolve(null));
		req.on('error', () => resolve(null));
	});
}

function streamBytes(res: ServerResponse, node: { data: Buffer | null; size: number }) {
	if (node.data) {
		res.end(node.data);
		return;
	}
	let left = node.size;
	const chunk = createHash('sha512').update('core').digest();
	const block = Buffer.concat(Array.from({ length: 1024 }, () => chunk));
	const pump = () => {
		while (left > 0) {
			const piece = block.subarray(0, Math.min(block.length, left));
			left -= piece.length;
			if (!res.write(piece)) return res.once('drain', pump);
		}
		res.end();
	};
	pump();
}

export function podFileRoutes(r: Router, { store }: MockContext) {
	const systems = new Map<string, MockFs>();

	const deploymentOfPod = (podName: string) =>
		store.state.deployments.find((d) => store.podsFor(d).some((p) => p.name === podName));

	const access = (podName: string, query: URLSearchParams) => {
		if (!query.get('namespace')) return { error: fail(400, 'namespace is required') };
		const d = deploymentOfPod(podName);
		if (!d) return { error: fail(404, 'Pod not found') };
		if (!d.githubRepo) {
			return {
				error: fail(422, "This image has no shell, so its files can't be browsed", 'no_shell')
			};
		}
		let fs = systems.get(d.id);
		if (!fs) systems.set(d.id, (fs = new MockFs()));
		return { fs, hasTar: d.name !== 'mailer' };
	};

	const target = (query: URLSearchParams, key = 'path') => normalize(query.get(key) ?? '/');

	const guardWrite = (fs: MockFs, path: string) => {
		if (path === '/') return fail(409, 'Refusing to write to /', 'read_only');
		const parent = fs.get(parentOf(path));
		if (!parent) return fail(404, `No such folder: ${parentOf(path)}`);
		if (!fs.writable(parentOf(path)))
			return fail(409, `${parentOf(path)} is read-only`, 'read_only');
		return null;
	};

	r.get('/pods/:podName/files', ({ params, query }) => {
		const a = access(params.podName, query);
		if (a.error) return a.error;
		const { fs } = a;
		const path = target(query);
		if (!path) return fail(400, 'Invalid path');
		const hit = fs.get(path);
		if (!hit) return fail(404, `No such folder: ${path}`);
		if (hit.node.kind !== 'dir') return fail(404, `${path} is not a folder`);
		const children = fs.children(hit.real);
		const entries = children.slice(0, LIST_CAP).map(([name, node]) => {
			const e = fs.entry(name, node);
			if (node.kind === 'symlink') {
				const t = fs.get(`${path === '/' ? '' : path}/${name}`);
				if (t?.node.kind === 'dir') e.target = 'dir';
				if (t?.node.kind === 'file') {
					e.target = 'file';
					(e as { size: number | null }).size = t.node.size;
				}
			}
			return e;
		});
		return {
			path,
			writable: fs.writable(path),
			truncated: children.length > LIST_CAP,
			entries,
			mounts: MOUNTS
		};
	});

	r.get('/pods/:podName/files/content', ({ params, query }) => {
		const a = access(params.podName, query);
		if (a.error) return a.error;
		const path = target(query);
		if (!path) return fail(400, 'Invalid path');
		const hit = a.fs.get(path);
		if (!hit || hit.node.kind !== 'file') return fail(404, `No such file: ${path}`);
		const node = hit.node;
		const bytes = (node.data ?? Buffer.alloc(Math.min(node.size, 8192), 0)).subarray(0, READ_LIMIT);
		let content: string | null = null;
		let binary = bytes.subarray(0, 8192).includes(0);
		if (!binary) {
			try {
				content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			} catch {
				binary = true;
			}
		}
		return {
			path,
			size: node.size,
			mtime: node.mtime,
			binary,
			truncated: node.size > READ_LIMIT,
			content: binary ? null : content
		};
	});

	r.put('/pods/:podName/files/content', ({ params, query, body }) => {
		const a = access(params.podName, query);
		if (a.error) return a.error;
		const { fs } = a;
		const path = target(query);
		if (!path || path === '/') return fail(400, 'Invalid path');
		if (typeof body?.content !== 'string') return fail(400, 'content must be a string');
		const data = Buffer.from(body.content, 'utf8');
		if (data.length > READ_LIMIT)
			return fail(413, 'Files over 1 MB cannot be edited here', 'too_large');
		const blocked = guardWrite(fs, path);
		if (blocked) return blocked;
		const hit = fs.get(path);
		if (hit && hit.node.kind !== 'file') return fail(409, `${path} is not a file`, 'exists');
		if (hit && hit.node.kind === 'file') {
			if (body.expectedMtime != null && hit.node.mtime !== body.expectedMtime) {
				return fail(409, `${path} changed since it was opened`, 'modified');
			}
			hit.node.data = data;
			hit.node.size = data.length;
			hit.node.mtime = fs.stamp();
			return { path, size: hit.node.size, mtime: hit.node.mtime };
		}
		const real = fs.resolve(path) ?? path;
		fs.nodes.set(real, {
			kind: 'file',
			data,
			size: data.length,
			mtime: fs.stamp(),
			mode: '-rw-r--r--',
			owner: 'node'
		});
		return { path, size: data.length, mtime: fs.stamp() };
	});

	r.put('/pods/:podName/files/upload', async ({ params, query, req }) => {
		const a = access(params.podName, query);
		if (a.error) {
			req.resume();
			return a.error;
		}
		const { fs } = a;
		const path = target(query);
		if (!path || path === '/') return fail(400, 'Invalid path');
		const length = Number(req.headers['content-length']);
		if (!Number.isFinite(length)) return fail(411, 'Content-Length is required');
		if (length > UPLOAD_LIMIT) {
			req.resume();
			return fail(413, 'Uploads are limited to 512 MB', 'too_large');
		}
		const overwrite = query.get('overwrite') === '1';
		const existing = fs.get(path);
		if (existing && (existing.node.kind === 'dir' || !overwrite)) {
			req.resume();
			return fail(409, `${path} already exists`, 'exists');
		}
		let dir = parentOf(path);
		while (!fs.get(dir)) dir = parentOf(dir);
		if (!fs.writable(dir) || fs.mountOf(fs.resolve(dir) ?? dir)?.readOnly) {
			req.resume();
			return fail(409, `${parentOf(path)} is read-only`, 'read_only');
		}
		const data = await readRaw(req, length, UPLOAD_BYTES_PER_SECOND);
		if (!data) return fail(400, 'Upload was interrupted');
		fs.ensureDirs(parentOf(path));
		const now = fs.stamp();
		if (existing && existing.node.kind === 'file') {
			existing.node.data = data;
			existing.node.size = data.length;
			existing.node.mtime = now;
		} else {
			fs.nodes.set(fs.resolve(path) ?? path, {
				kind: 'file',
				data,
				size: data.length,
				mtime: now,
				mode: '-rw-r--r--',
				owner: 'node'
			});
		}
		return { path, size: data.length, mtime: now };
	});

	r.post('/pods/:podName/files/mkdir', ({ params, query }) => {
		const a = access(params.podName, query);
		if (a.error) return a.error;
		const path = target(query);
		if (!path || path === '/') return fail(400, 'Invalid path');
		if (a.fs.get(path, false)) return fail(409, `${path} already exists`, 'exists');
		const blocked = guardWrite(a.fs, path);
		if (blocked) return blocked;
		const real =
			(a.fs.resolve(parentOf(path)) ?? parentOf(path)).replace(/\/$/, '') + '/' + nameOf(path);
		a.fs.nodes.set(real, { kind: 'dir', mtime: a.fs.stamp(), mode: 'drwxr-xr-x', owner: 'node' });
		return { path };
	});

	r.post('/pods/:podName/files/move', ({ params, query }) => {
		const a = access(params.podName, query);
		if (a.error) return a.error;
		const { fs } = a;
		const from = target(query);
		const to = normalize(query.get('to'));
		if (!from || !to || from === '/') return fail(400, 'Invalid path');
		if (MOUNTS.some((m) => m.path === from))
			return fail(409, 'A mount cannot be moved', 'mount_root');
		const source = fs.get(from, false);
		if (!source) return fail(404, `No such file: ${from}`);
		if (fs.get(to, false)) return fail(409, `${to} already exists`, 'exists');
		if (to.startsWith(from + '/')) return fail(400, 'A folder cannot move into itself');
		const blocked = guardWrite(fs, from) ?? guardWrite(fs, to);
		if (blocked) return blocked;
		const realTo = (fs.resolve(parentOf(to)) ?? parentOf(to)).replace(/\/$/, '') + '/' + nameOf(to);
		fs.moveTree(source.real, realTo);
		return { path: to };
	});

	r.delete('/pods/:podName/files', ({ params, query }) => {
		const a = access(params.podName, query);
		if (a.error) return a.error;
		const { fs } = a;
		const path = target(query);
		if (!path) return fail(400, 'Invalid path');
		const pinned =
			path === '/' ||
			['/proc', '/sys', '/dev'].some((p) => path === p || path.startsWith(p + '/')) ||
			MOUNTS.some((m) => m.path === path || m.path.startsWith(path + '/'));
		if (pinned) return fail(409, `${path} is or holds a mounted volume`, 'mount_root');
		const hit = fs.get(path, false);
		if (!hit) return fail(404, `No such file: ${path}`);
		const blocked = guardWrite(fs, path);
		if (blocked) return blocked;
		fs.removeTree(hit.real);
		return { path, kind: hit.node.kind === 'dir' ? 'dir' : 'file' };
	});

	r.get('/pods/:podName/files/download', ({ params, query, res }) => {
		const a = access(params.podName, query);
		if (a.error) return a.error;
		const { fs } = a;
		const path = target(query);
		if (!path) return fail(400, 'Invalid path');
		const hit = fs.get(path);
		if (!hit) return fail(404, `No such file: ${path}`);
		const name = nameOf(path) || 'root';
		if (hit.node.kind === 'dir') {
			if (!a.hasTar) {
				return fail(422, 'tar is not installed in this image', 'missing_tool', { tool: 'tar' });
			}
			const archive = tarArchive(fs, hit.real);
			res.writeHead(200, {
				'content-type': 'application/gzip',
				'content-length': String(archive.length),
				'content-disposition': `attachment; filename="${name}.tar.gz"`,
				'cache-control': 'no-store'
			});
			res.end(archive);
			return STREAMING;
		}
		if (hit.node.kind !== 'file') return fail(404, `No such file: ${path}`);
		const ext = name.split('.').pop()?.toLowerCase() ?? '';
		const inline = ['1', 'true'].includes(query.get('inline') ?? '') && IMAGE_TYPES[ext];
		res.writeHead(200, {
			'content-type': inline ? IMAGE_TYPES[ext] : 'application/octet-stream',
			'content-length': String(hit.node.size),
			'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`,
			'cache-control': 'no-store',
			...(inline
				? {
						'content-security-policy': "default-src 'none'; sandbox",
						'x-content-type-options': 'nosniff'
					}
				: {})
		});
		streamBytes(res, hit.node);
		return STREAMING;
	});

	r.post('/__mock/pod-files/touch', ({ query }) => {
		const path = normalize(query.get('path'));
		if (!path) return fail(400, 'Invalid path');
		for (const fs of systems.values()) {
			const hit = fs.get(path);
			if (hit) hit.node.mtime = fs.stamp() + 1;
		}
		return { ok: true };
	});
}
