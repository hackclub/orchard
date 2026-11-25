import assert from 'node:assert/strict';
import test from 'node:test';
import {
	componentCopy,
	durationLabel,
	loadStatusPage,
	overallCopy,
	STATUS_FAILING,
	STATUS_UNREACHABLE,
	statusApiUrl,
	statusErrorMessage,
	StatusHttpError,
	uptimeLabel
} from './status-page';

test('the page reads its data from the apex api when served on a status host', () => {
	assert.equal(statusApiUrl('acme', 'orchard.my', 'orchard.my'), '/apiv1/status/acme');
	assert.equal(statusApiUrl('acme', 'localhost', ''), '/apiv1/status/acme');
	assert.equal(
		statusApiUrl('acme', 'acme-status.orchard.my', 'orchard.my'),
		'https://orchard.my/apiv1/status/acme'
	);
	assert.equal(statusApiUrl('a b', 'orchard.my', 'orchard.my'), '/apiv1/status/a%20b');
});

test('a status host reads from the platform origin when the api is not on the apex', () => {
	assert.equal(
		statusApiUrl(
			'acme',
			'acme-status.apps.example.com',
			'apps.example.com',
			'https://orchard.example.com'
		),
		'https://orchard.example.com/apiv1/status/acme'
	);
	assert.equal(
		statusApiUrl('acme', 'orchard.example.com', 'apps.example.com', 'https://orchard.example.com'),
		'/apiv1/status/acme'
	);
});

test('copy is the canonical status page vocabulary', () => {
	assert.equal(overallCopy('operational').label, 'All systems operational');
	assert.equal(overallCopy('degraded').label, 'Partial outage');
	assert.equal(overallCopy('down').label, 'Major outage');
	assert.equal(componentCopy('maintenance').tone, 'info');
	assert.equal(componentCopy('unknown').label, 'No data');
});

test('durations and uptime round the way a person reads them', () => {
	const now = Date.parse('2026-09-25T12:00:00Z');
	assert.equal(durationLabel('2026-09-25T11:30:00Z', null, now), '30 min');
	assert.equal(durationLabel('2026-09-25T09:15:00Z', '2026-09-25T11:30:00Z', now), '2 h 15 min');
	assert.equal(durationLabel('2026-09-23T10:00:00Z', null, now), '2 d 2 h');
	assert.equal(uptimeLabel(100), '100%');
	assert.equal(uptimeLabel(99.996), '100%');
	assert.equal(uptimeLabel(99.12), '99.12%');
});

function scripted(steps: (() => Response | Promise<Response>)[]) {
	const calls: string[] = [];
	const fetch = (async (url: string) => {
		calls.push(url);
		const step = steps.shift();
		if (!step) throw new Error('no more responses');
		return step();
	}) as unknown as typeof globalThis.fetch;
	return { fetch, calls };
}

const networkDown = () => {
	throw new TypeError('Failed to fetch');
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a network failure retries with backoff and renders once a request gets through', async () => {
	const waits: number[] = [];
	const { fetch, calls } = scripted([networkDown, networkDown, () => json({ slug: 'acme' })]);
	const result = await loadStatusPage('/apiv1/status/acme', {
		fetch,
		sleep: async (ms) => {
			waits.push(ms);
		},
		delays: [1_000, 3_000]
	});
	assert.equal(result.kind, 'ok');
	assert.equal(calls.length, 3);
	assert.deepEqual(waits, [1_000, 3_000]);
});

test('a network failure that outlasts the retries shows a plain line, not the browser error', async () => {
	const { fetch, calls } = scripted([networkDown, networkDown, networkDown]);
	const result = await loadStatusPage('/x', { fetch, sleep: async () => {}, delays: [1, 1] });
	assert.deepEqual(result, { kind: 'failed', message: STATUS_UNREACHABLE });
	assert.equal(calls.length, 3);
	assert.ok(!STATUS_UNREACHABLE.includes('Failed to fetch'));
});

test('a missing page answers at once and is not retried', async () => {
	const { fetch, calls } = scripted([() => json({}, 404)]);
	const result = await loadStatusPage('/x', { fetch, sleep: async () => {}, delays: [1, 1] });
	assert.deepEqual(result, { kind: 'missing' });
	assert.equal(calls.length, 1);
});

test('a server error retries, a client error does not', async () => {
	const retried = scripted([() => json({}, 502), () => json({ slug: 'acme' })]);
	const ok = await loadStatusPage('/x', {
		fetch: retried.fetch,
		sleep: async () => {},
		delays: [1, 1]
	});
	assert.equal(ok.kind, 'ok');
	assert.equal(retried.calls.length, 2);

	const refused = scripted([() => json({}, 400)]);
	const failed = await loadStatusPage('/x', {
		fetch: refused.fetch,
		sleep: async () => {},
		delays: [1, 1]
	});
	assert.deepEqual(failed, { kind: 'failed', message: STATUS_FAILING });
	assert.equal(refused.calls.length, 1);
});

test('error copy never echoes the raw error', () => {
	assert.equal(statusErrorMessage(new TypeError('Failed to fetch')), STATUS_UNREACHABLE);
	assert.equal(statusErrorMessage(new StatusHttpError(500)), STATUS_FAILING);
	assert.equal(statusErrorMessage(new SyntaxError('Unexpected token')), STATUS_FAILING);
	assert.equal(
		statusErrorMessage(new DOMException('timed out', 'TimeoutError')),
		STATUS_UNREACHABLE
	);
});

test('a request that never answers times out and is retried instead of wedging the page', async () => {
	let calls = 0;
	const fetch = ((_url: string, init?: RequestInit) => {
		calls++;
		if (calls === 3) return Promise.resolve(json({ slug: 'acme' }));
		return new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
		});
	}) as unknown as typeof globalThis.fetch;
	const result = await loadStatusPage('/x', {
		fetch,
		sleep: async () => {},
		delays: [1, 1],
		timeoutMs: 20
	});
	assert.equal(result.kind, 'ok');
	assert.equal(calls, 3);
});

test('a 200 with a body that is not json is retried like an outage', async () => {
	const { fetch, calls } = scripted([
		() => new Response('<html>bad gateway</html>', { status: 200 }),
		() => json({ slug: 'acme' })
	]);
	const result = await loadStatusPage('/x', { fetch, sleep: async () => {}, delays: [1, 1] });
	assert.equal(result.kind, 'ok');
	assert.equal(calls.length, 2);
});
