import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';
import { Reply, Router, STREAMING, type Method } from './router.ts';
import { EventHub } from './events.ts';
import { createStore, type Store } from './store.ts';
import { registerRoutes } from './routes/index.ts';
import { terminalServer } from './terminal.ts';

const PREFIX = '/apiv1';
const METHODS = new Set<Method>(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const PUBLIC = /^\/(auth|sso|health|setup\/status|invitations\/[^/]+$)/;

export interface MockUpload {
	filename: string;
	type: string;
	data: Buffer;
}

function parseMultipart(raw: Buffer, boundary: string) {
	const fields: Record<string, string> = {};
	const files: Record<string, MockUpload> = {};
	const delimiter = Buffer.from(`--${boundary}`);
	let start = raw.indexOf(delimiter);
	while (start !== -1) {
		const next = raw.indexOf(delimiter, start + delimiter.length);
		if (next === -1) break;
		const part = raw.subarray(start + delimiter.length + 2, next - 2);
		const split = part.indexOf('\r\n\r\n');
		if (split !== -1) {
			const head = part.subarray(0, split).toString('utf8');
			const data = part.subarray(split + 4);
			const name = /name="([^"]*)"/.exec(head)?.[1];
			const filename = /filename="([^"]*)"/.exec(head)?.[1];
			const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim();
			if (name && filename !== undefined) {
				files[name] = {
					filename,
					type: type ?? 'application/octet-stream',
					data: Buffer.from(data)
				};
			} else if (name) {
				fields[name] = data.toString('utf8');
			}
		}
		start = next;
	}
	return { fields, files };
}

function readBody(req: IncomingMessage): Promise<any> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on('data', (c: Buffer) => chunks.push(c));
		req.on('end', () => {
			const buffer = Buffer.concat(chunks);
			const boundary = /multipart\/form-data;.*boundary=("?)([^";]+)\1/i.exec(
				req.headers['content-type'] ?? ''
			)?.[2];
			if (boundary) return resolve(parseMultipart(buffer, boundary));
			const raw = buffer.toString('utf8');
			if (!raw) return resolve(undefined);
			try {
				resolve(JSON.parse(raw));
			} catch {
				resolve(raw);
			}
		});
		req.on('error', () => resolve(undefined));
	});
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>) {
	if (res.headersSent) return;
	const isText = typeof body === 'string';
	res.writeHead(status, {
		'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json',
		'cache-control': 'no-store',
		...headers
	});
	if (body === undefined || status === 204) res.end();
	else res.end(isText ? body : JSON.stringify(body));
}

export interface MockContext {
	store: Store;
	hub: EventHub;
	log: (msg: string) => void;
}

export function mockApi(): Plugin {
	process.env.PUBLIC_API_BASE = '';
	process.env.PUBLIC_POSTHOG_KEY = '';
	return {
		name: 'orchard-mock-api',
		apply: 'serve',
		config: () => ({ cacheDir: 'node_modules/.vite-mock' }),
		configureServer(server: ViteDevServer) {
			const logger = server.config.logger;
			const log = (msg: string) => logger.info(`\x1b[35m[mock]\x1b[0m ${msg}`, { timestamp: true });
			const hub = new EventHub();
			const store = createStore(hub);
			const router = new Router();
			registerRoutes(router, { store, hub, log });
			const warned = new Set<string>();
			const latency = Number(process.env.ORCHARD_MOCK_LATENCY ?? 0);

			server.httpServer?.once('close', () => store.dispose());
			const terminal = terminalServer(store);
			server.httpServer?.on('upgrade', (req, socket, head) => {
				if (!req.url?.startsWith(PREFIX)) return;
				terminal(req, socket, head);
			});

			server.httpServer?.once('listening', () => {
				const me = store.me();
				const who = me ? `${me.username} <${me.email}>` : 'nobody';
				setTimeout(() => {
					logger.info(
						`\n  \x1b[45m\x1b[30m MOCK API \x1b[0m  no backend needed, signed in as ${who}\n  \x1b[2m${PREFIX}/* is answered in-memory from apps/frontend/mock (state resets on restart)\x1b[0m\n`
					);
				}, 50);
			});

			server.middlewares.use(PREFIX, async (req, res) => {
				const method = (req.method ?? 'GET').toUpperCase() as Method;
				const url = new URL(req.url ?? '/', 'http://mock');
				const path = url.pathname.replace(/\/+$/, '') || '/';
				if (!METHODS.has(method)) return send(res, 204, undefined, {});
				const raw = (req.headers['content-type'] ?? '').startsWith('application/octet-stream');
				const body = method === 'GET' || raw ? undefined : await readBody(req);
				if (latency > 0) await new Promise((r) => setTimeout(r, latency));
				if (!store.state.signedIn && !PUBLIC.test(path)) {
					return send(res, 401, { statusCode: 401, message: 'Unauthorized' }, {});
				}
				const hit = router.match(method, path);
				try {
					if (!hit) {
						const key = `${method} ${path}`;
						if (!warned.has(key)) {
							warned.add(key);
							logger.warn(`\x1b[33m[mock] unhandled ${method} ${PREFIX}${path}\x1b[0m`, {
								timestamp: true
							});
						}
						return send(res, 200, method === 'GET' ? [] : { ok: true }, {});
					}
					const out = await hit.handler({
						method,
						path,
						params: hit.params,
						query: url.searchParams,
						body,
						req,
						res
					});
					if (out === STREAMING) return;
					if (out instanceof Reply) return send(res, out.status, out.body, out.headers);
					if (out === undefined) return send(res, 200, { ok: true }, {});
					return send(res, 200, out, {});
				} catch (err) {
					logger.error(`[mock] ${method} ${PREFIX}${path} threw: ${(err as Error).stack ?? err}`);
					return send(res, 500, { statusCode: 500, message: (err as Error).message }, {});
				}
			});
		}
	};
}
