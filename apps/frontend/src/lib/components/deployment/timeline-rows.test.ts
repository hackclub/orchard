import assert from 'node:assert/strict';
import test from 'node:test';
import {
	actorLabel,
	auditCategory,
	buildStartedAt,
	collapsePodRuns,
	entryBadge,
	groupByDay,
	groupEntries,
	granularityFor,
	humanizeStep,
	releaseEnds,
	shortRef,
	filterKinds,
	flattenPages,
	foldBuildRuns,
	foldTitle,
	headline,
	hasBuildEntry,
	newlyArrived,
	newestAt,
	newestBuildEntryId,
	originLabel,
	seedFromImageHistory,
	type TimelineEntry
} from './timeline-rows';

function entry(partial: Partial<TimelineEntry> & { id: string; kind: TimelineEntry['kind'] }) {
	return {
		at: '2026-01-01T00:00:00.000Z',
		actor: null,
		title: partial.id,
		detail: null,
		status: null,
		href: null,
		meta: {},
		...partial
	} as TimelineEntry;
}

test('pages flatten in order and a row repeated across a refetch boundary shows once', () => {
	const a = entry({ id: 'release:a', kind: 'release' });
	const b = entry({ id: 'pod:b', kind: 'pod' });
	const c = entry({ id: 'audit:c', kind: 'audit' });
	const rows = flattenPages([
		{ entries: [a, b], nextCursor: 'x' },
		{ entries: [b, c], nextCursor: null }
	]);
	assert.deepEqual(
		rows.map((r) => r.id),
		['release:a', 'pod:b', 'audit:c']
	);
	assert.deepEqual(flattenPages(undefined), []);
});

test('the filter maps to the server kinds list and All sends nothing', () => {
	assert.equal(filterKinds('all'), '');
	assert.equal(filterKinds('deploys'), 'release,build');
	assert.equal(filterKinds('pods'), 'pod');
});

test('the seed built from the deployment payload matches the ids the server will send', () => {
	const seed = seedFromImageHistory(
		[
			{
				id: 'h1',
				image: 'harbor/x:old',
				createdAt: '2026-01-01T00:00:00.000Z',
				isActive: false,
				commitSha: 'abcdef1234',
				commitMessage: 'older\nbody',
				branch: 'main'
			},
			{
				id: 'h2',
				image: 'harbor/x:new',
				createdAt: '2026-01-02T00:00:00.000Z',
				isActive: true
			}
		],
		'https://github.com/org/app.git'
	);
	assert.deepEqual(
		seed.entries.map((e) => e.id),
		['release:h2', 'release:h1']
	);
	assert.equal(seed.entries[1].title, 'older');
	assert.equal(seed.entries[1].detail, 'main · abcdef1');
	assert.equal(seed.entries[1].href, 'https://github.com/org/app/commit/abcdef1234');
	assert.equal(seed.entries[0].title, 'new');
	assert.equal(seed.entries[0].href, null);
});

test('only newer rows that were not on screen count as arrivals: never on first paint, never when paging back', () => {
	const a = entry({ id: 'release:a', kind: 'release', at: '2026-01-02T00:00:00.000Z' });
	const b = entry({ id: 'pod:b', kind: 'pod', at: '2026-01-03T00:00:00.000Z' });
	const older = entry({ id: 'pod:old', kind: 'pod', at: '2025-12-01T00:00:00.000Z' });
	assert.deepEqual(newlyArrived(null, [a, b], 0), []);
	assert.equal(newestAt([a]), Date.parse('2026-01-02T00:00:00.000Z'));
	assert.deepEqual(newlyArrived(new Set(['release:a']), [b, a, older], newestAt([a])), ['pod:b']);
});

test('badges come from the row kind and never from color alone', () => {
	assert.deepEqual(
		entryBadge(entry({ id: 'release:x', kind: 'release', meta: { isActive: true } })),
		{
			kind: 'success',
			label: 'Live',
			pulse: false
		}
	);
	assert.deepEqual(
		entryBadge(entry({ id: 'build:x', kind: 'build', meta: { buildStatus: 'skipped' } })),
		{ kind: 'neutral', label: 'Superseded', pulse: false }
	);
	assert.deepEqual(
		entryBadge(entry({ id: 'pod:x', kind: 'pod', title: 'Pod crashing', status: 'error' })),
		{ kind: 'error', label: 'Crashing', pulse: false }
	);
	assert.equal(
		entryBadge(entry({ id: 'audit:x', kind: 'audit', status: 'warning' })).kind,
		'warning'
	);
});

test('who did it prefers the account, then the git author, then the recorded email', () => {
	const byUser = entry({
		id: 'audit:1',
		kind: 'audit',
		actor: {
			id: 'u',
			username: 'seb',
			email: 'x@y',
			firstName: null,
			lastName: null,
			imageUrl: null
		}
	});
	assert.equal(actorLabel(byUser), '@seb');
	assert.equal(originLabel(byUser), 'by @seb');

	const byPush = entry({
		id: 'release:1',
		kind: 'release',
		meta: { triggerType: 'auto', commitAuthorUsername: 'octocat' }
	});
	assert.equal(originLabel(byPush), 'push by @octocat');

	const platform = entry({ id: 'audit:2', kind: 'audit', meta: { actorEmail: null } });
	assert.equal(originLabel(platform), 'by the platform');
	assert.equal(originLabel(entry({ id: 'pod:1', kind: 'pod' })), 'from Kubernetes');
});

test('the synthetic building row yields to a real build entry when the feed already has one', () => {
	const building = entry({ id: 'build:1', kind: 'build', meta: { buildStatus: 'building' } });
	const failed = entry({ id: 'build:2', kind: 'build', meta: { buildStatus: 'failed' } });
	assert.equal(hasBuildEntry([building], 'building'), true);
	assert.equal(hasBuildEntry([failed], 'building'), false);
	assert.equal(newestBuildEntryId([building, failed], 'failed'), 'build:2');
	assert.equal(newestBuildEntryId([], 'failed'), null);
});

test('a change row is badged by what it touched, not a generic word', () => {
	assert.equal(auditCategory('deployment.env.updated'), 'Env');
	assert.equal(auditCategory('deployment.scaled'), 'App');
	assert.equal(auditCategory('deployment.pod.file.upload'), 'Files');
	assert.equal(auditCategory('deployment.pod.exec.command'), 'Terminal');
	assert.equal(auditCategory('ingress.created'), 'Domain');
	assert.equal(auditCategory('webhook_token.created'), 'Webhook');
	assert.equal(auditCategory('org.member.added'), 'Change');
});

test('rows group by local day with Today and Yesterday named and older days dated', () => {
	const now = new Date(2026, 8, 22, 12, 0, 0).getTime();
	const today = new Date(2026, 8, 22, 9, 0, 0).toISOString();
	const yesterday = new Date(2026, 8, 21, 23, 0, 0).toISOString();
	const older = new Date(2026, 8, 11, 8, 0, 0).toISOString();
	const lastYear = new Date(2025, 11, 31, 8, 0, 0).toISOString();
	const groups = groupByDay(
		[
			entry({ id: 'a', kind: 'audit', at: today }),
			entry({ id: 'b', kind: 'audit', at: today }),
			entry({ id: 'c', kind: 'audit', at: yesterday }),
			entry({ id: 'd', kind: 'audit', at: older }),
			entry({ id: 'e', kind: 'audit', at: lastYear })
		],
		now
	);
	assert.deepEqual(
		groups.map((g) => [g.label, g.entries.length]),
		[
			['Today', 2],
			['Yesterday', 1],
			['11 September', 1],
			['31 December 2025', 1]
		]
	);
});

test('a pod that went pending, scheduled, ready is one row with its steps in order', () => {
	const pod = (id: string, status: string, name = 'web-1') =>
		entry({ id, kind: 'pod', title: `Pod ${status}`, meta: { podName: name, toStatus: status } });
	const rows = collapsePodRuns([
		pod('p3', 'ready'),
		pod('p2', 'scheduled'),
		pod('p1', 'pending'),
		pod('q1', 'removed', 'web-0'),
		entry({ id: 'a', kind: 'audit' }),
		pod('p0', 'removed')
	]);
	assert.deepEqual(
		rows.map((r) => [r.id, r.steps ?? null, r.count ?? 1]),
		[
			['p3', ['pending', 'scheduled', 'ready'], 3],
			['q1', null, 1],
			['a', null, 1],
			['p0', null, 1]
		]
	);
	assert.equal(rows[0].title, 'Pod ready');
});

test('the release card reads the live release and the one before it', () => {
	const r = (id: string, isActive: boolean) => entry({ id, kind: 'release', meta: { isActive } });
	assert.deepEqual(releaseEnds([]), { live: null, previous: null });
	const ends = releaseEnds([entry({ id: 'x', kind: 'pod' }), r('new', true), r('old', false)]);
	assert.equal(ends.live?.id, 'new');
	assert.equal(ends.previous?.id, 'old');
	const noActive = releaseEnds([r('a', false), r('b', false)]);
	assert.equal(noActive.live?.id, 'a');
	assert.equal(noActive.previous?.id, 'b');
	const rolledBack = releaseEnds([r('newest', false), r('mid', true), r('oldest', false)]);
	assert.equal(rolledBack.live?.id, 'mid');
	assert.equal(rolledBack.previous?.id, 'oldest');
});

test('build start is the earliest step timestamp and a short ref prefers the sha', () => {
	assert.equal(buildStartedAt(null), null);
	assert.equal(
		buildStartedAt({ clone: 1_700_000_000_000, build: 1_700_000_050_000 }),
		'2023-11-14T22:13:20.000Z'
	);
	assert.equal(
		shortRef(entry({ id: 'r', kind: 'release', meta: { commitSha: 'abcdef1234', tag: 'v1' } })),
		'abcdef1'
	);
	assert.equal(shortRef(entry({ id: 'r', kind: 'release', meta: { tag: 'v1' } })), 'v1');
	assert.equal(
		shortRef(entry({ id: 'r', kind: 'release', meta: { image: 'ghcr.io/a/b:2.0' } })),
		'2.0'
	);
	assert.equal(humanizeStep('push_image'), 'Push image');
	assert.equal(humanizeStep(null), 'Starting');
});

test('changes group by month, deploys by day so a long history has somewhere to land', () => {
	const now = new Date(2026, 8, 22, 12, 0, 0).getTime();
	const rows = [
		entry({ id: 'a', kind: 'release', at: new Date(2026, 8, 11, 9).toISOString() }),
		entry({ id: 'b', kind: 'release', at: new Date(2026, 8, 3, 9).toISOString() }),
		entry({ id: 'c', kind: 'release', at: new Date(2026, 7, 28, 9).toISOString() }),
		entry({ id: 'd', kind: 'release', at: new Date(2025, 11, 2, 9).toISOString() })
	];
	assert.equal(granularityFor('deploys'), 'day');
	assert.equal(granularityFor('changes'), 'month');
	assert.equal(granularityFor('all'), 'day');
	assert.equal(granularityFor('pods'), 'day');
	assert.deepEqual(
		groupEntries(rows, 'month', now).map((g) => [g.label, g.entries.length]),
		[
			['This month', 2],
			['August', 1],
			['December 2025', 1]
		]
	);
	assert.equal(groupEntries(rows, 'day', now).length, 4);
});

test('builds and deploys are titled by their commit, everything else keeps its title', () => {
	const failed = entry({
		id: 'f',
		kind: 'build',
		title: 'Build failed',
		meta: { buildStatus: 'failed', commitMessage: 'hero v2\n\nlonger body' }
	});
	assert.equal(headline(failed), 'hero v2');
	assert.equal(headline(entry({ id: 'r', kind: 'release', title: 'abc1234' })), 'abc1234');
	assert.equal(headline(entry({ id: 'a', kind: 'audit', title: 'Env changed' })), 'Env changed');
});

test('three or more failed builds in a row fold into one, shorter runs and other rows stay', () => {
	const build = (id: string, buildStatus: string) =>
		entry({ id, kind: 'build', meta: { buildStatus } });
	const rows = [
		entry({ id: 'live', kind: 'release' }),
		build('f1', 'failed'),
		build('f2', 'failed'),
		build('f3', 'failed'),
		build('s1', 'skipped'),
		build('s2', 'canceled'),
		build('f4', 'failed'),
		entry({ id: 'old', kind: 'release' })
	];
	const out = foldBuildRuns(rows);
	assert.deepEqual(
		out.map((e) => e.id),
		['live', 'fold:f1', 's1', 's2', 'f4', 'old']
	);
	assert.deepEqual(
		out[1].folded?.map((e) => e.id),
		['f1', 'f2', 'f3']
	);
	assert.equal(foldTitle(out[1]), '3 builds failed');
	const skipped = foldBuildRuns([
		build('a', 'skipped'),
		build('b', 'canceled'),
		build('c', 'skipped')
	]);
	assert.equal(foldTitle(skipped[0]), '3 builds skipped');
});

test('rows that arrive out of order never split a day into two groups with the same key', () => {
	const now = new Date(2026, 9, 31, 22, 0, 0).getTime();
	const rows = [
		entry({ id: 'a', kind: 'release', at: new Date(2026, 9, 19, 12).toISOString() }),
		entry({ id: 'b', kind: 'release', at: new Date(2026, 9, 18, 12).toISOString() }),
		entry({ id: 'c', kind: 'build', at: new Date(2026, 9, 19, 9).toISOString() })
	];
	const groups = groupEntries(rows, 'day', now);
	assert.deepEqual(
		groups.map((g) => [g.key, g.entries.map((e) => e.id)]),
		[
			['2026-10-19', ['a', 'c']],
			['2026-10-18', ['b']]
		]
	);
});
