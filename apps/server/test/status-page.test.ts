import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { StatusPagesService } from '../src/status-pages/status-pages.service';
import {
  databaseStatus,
  deploymentStatus,
  incidentsFromTransitions,
  normalizeComponents,
  overallStatus,
  SLUG_PATTERN,
  SUBDOMAIN_PATTERN,
  uptimeDays,
  uptimePercent
} from '../src/status-pages/status-model';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

const healthy = {
  status: 'running',
  stopped: false,
  replicas: 2,
  workload: { specReplicas: 2, readyReplicas: 2 },
  crashingSince: null,
  firingAlerts: 0
};

test('an app is operational only when every replica the cluster wants is ready', () => {
  assert.equal(deploymentStatus(healthy).status, 'operational');
  assert.deepEqual(
    deploymentStatus({ ...healthy, workload: { specReplicas: 2, readyReplicas: 1 } }),
    {
      status: 'degraded',
      detail: '1 of 2 replicas ready'
    }
  );
  assert.equal(
    deploymentStatus({ ...healthy, workload: { specReplicas: 2, readyReplicas: 0 } }).status,
    'down'
  );
});

test('the crash state outranks the replica counts, and a stopped app is maintenance, not an outage', () => {
  assert.equal(deploymentStatus({ ...healthy, crashingSince: ago(3) }).status, 'degraded');
  assert.equal(
    deploymentStatus({
      ...healthy,
      crashingSince: ago(3),
      workload: { specReplicas: 2, readyReplicas: 0 }
    }).status,
    'down'
  );
  assert.equal(deploymentStatus({ ...healthy, stopped: true }).status, 'maintenance');
  assert.equal(deploymentStatus({ ...healthy, status: 'stopped' }).status, 'maintenance');
});

test('a firing alert degrades an app that is otherwise serving, and no cluster data is unknown, never green', () => {
  assert.deepEqual(deploymentStatus({ ...healthy, firingAlerts: 1 }), {
    status: 'degraded',
    detail: 'An alert is firing'
  });
  assert.equal(deploymentStatus({ ...healthy, workload: null }).status, 'unknown');
});

test('a database reads from its lifecycle status and its own crash state', () => {
  assert.equal(databaseStatus({ status: 'ready', crashingSince: null }).status, 'operational');
  assert.equal(databaseStatus({ status: 'restoring', crashingSince: null }).status, 'degraded');
  assert.equal(databaseStatus({ status: 'error', crashingSince: null }).status, 'down');
  assert.equal(databaseStatus({ status: 'ready', crashingSince: ago(2) }).status, 'down');
  assert.equal(databaseStatus({ status: 'stopped', crashingSince: null }).status, 'maintenance');
});

test('the page is as bad as its worst component, but maintenance and unknown do not count as an outage', () => {
  assert.equal(overallStatus(['operational', 'operational']), 'operational');
  assert.equal(overallStatus(['operational', 'maintenance', 'unknown']), 'operational');
  assert.equal(overallStatus(['operational', 'degraded']), 'degraded');
  assert.equal(overallStatus(['degraded', 'down']), 'down');
  assert.equal(overallStatus([]), 'operational');
});

test('incidents open on a crash, close on the next ready pod, and merge when the gap is short', () => {
  const t = (min: number, toStatus: string, podName = 'web-1') => ({
    podName,
    toStatus,
    at: ago(min)
  });
  const incidents = incidentsFromTransitions(
    [
      t(120, 'crashing'),
      t(110, 'ready'),
      t(108, 'crashing'),
      t(100, 'ready'),
      t(30, 'crashing'),
      t(20, 'ready')
    ],
    null,
    NOW
  );
  assert.equal(incidents.length, 2);
  assert.equal(incidents[0].startedAt.toISOString(), ago(120).toISOString());
  assert.equal(incidents[0].endedAt?.toISOString(), ago(100).toISOString());
  assert.equal(incidents[1].startedAt.toISOString(), ago(30).toISOString());
  assert.equal(incidents[1].endedAt?.toISOString(), ago(20).toISOString());
});

test('the live crash state is the truth for the current incident', () => {
  const t = (min: number, toStatus: string) => ({ podName: 'web-1', toStatus, at: ago(min) });
  const ongoing = incidentsFromTransitions([t(30, 'crashing')], ago(35), NOW);
  assert.equal(ongoing.length, 1);
  assert.equal(ongoing[0].startedAt.toISOString(), ago(35).toISOString());
  assert.equal(ongoing[0].endedAt, null);
  const fresh = incidentsFromTransitions([], ago(4), NOW);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].endedAt, null);
  const stale = incidentsFromTransitions([t(30, 'crashing')], null, NOW);
  assert.equal(stale[0].endedAt?.toISOString(), NOW.toISOString());
});

test('the uptime strip charges each day only for the minutes an incident overlapped it', () => {
  const incident = {
    startedAt: new Date('2026-09-24T23:30:00.000Z'),
    endedAt: new Date('2026-09-25T00:30:00.000Z')
  };
  const bars = uptimeDays([incident], NOW, 3);
  assert.deepEqual(
    bars.map((b) => [b.day, b.status, b.downtimeMs / 60_000]),
    [
      ['2026-09-23', 'operational', 0],
      ['2026-09-24', 'degraded', 30],
      ['2026-09-25', 'degraded', 30]
    ]
  );
  const allDay = uptimeDays(
    [{ startedAt: new Date('2026-09-24T00:00:00.000Z'), endedAt: null }],
    NOW,
    2
  );
  assert.deepEqual(
    allDay.map((b) => b.status),
    ['down', 'down']
  );
  assert.equal(uptimePercent(uptimeDays([], NOW, 30), NOW), 100);
  assert.ok(uptimePercent(bars, NOW) < 100);
});

test('components are validated, deduplicated and capped, never trusted from the client as-is', () => {
  const out = normalizeComponents([
    { kind: 'deployment', resourceId: 'a', name: '  Web  ' },
    { kind: 'deployment', resourceId: 'a', name: 'dupe' },
    { kind: 'database', resourceId: 'b' },
    { kind: 'sandbox', resourceId: 'c' },
    'junk',
    { kind: 'deployment' }
  ]);
  assert.deepEqual(out, [
    { id: 'deployment:a', kind: 'deployment', resourceId: 'a', name: 'Web' },
    { id: 'database:b', kind: 'database', resourceId: 'b', name: '' }
  ]);
  assert.equal(normalizeComponents('nope').length, 0);
  assert.equal(
    normalizeComponents(
      Array.from({ length: 60 }, (_, i) => ({ kind: 'deployment', resourceId: String(i) }))
    ).length,
    40
  );
});

test('slugs and hosts are 3 characters or more, matching the message', () => {
  for (const short of ['a', '1', 'ab']) {
    assert.equal(SLUG_PATTERN.test(short), false, short);
    assert.equal(SUBDOMAIN_PATTERN.test(short), false, short);
  }
  for (const ok of ['abc', 'a-b', 'acme-status']) {
    assert.equal(SLUG_PATTERN.test(ok), true, ok);
    assert.equal(SUBDOMAIN_PATTERN.test(ok), true, ok);
  }
  assert.equal(SLUG_PATTERN.test('a'.repeat(64)), true);
  assert.equal(SLUG_PATTERN.test('a'.repeat(65)), false);
  assert.equal(SUBDOMAIN_PATTERN.test('a'.repeat(50)), true);
  assert.equal(SUBDOMAIN_PATTERN.test('a'.repeat(51)), false);
  assert.equal(SLUG_PATTERN.test('-abc'), false);
});

function statusPages(existing: { slug: string }) {
  const page = {
    id: 'p1',
    organizationId: 'o1',
    slug: existing.slug,
    title: 'Acme status',
    description: null,
    subdomain: null,
    isPublic: true,
    components: [],
    createdAt: NOW,
    updatedAt: NOW
  };
  const db = {
    statusPage: {
      count: async () => 0,
      findFirst: async () => page,
      findUnique: async () => ({ id: page.id }),
      findUniqueOrThrow: async () => page,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(page, data)
    },
    organization: { findUnique: async () => ({ name: 'Acme', slug: 'a' }) }
  };
  const prisma = { ...db, $transaction: async (fn: (tx: unknown) => unknown) => fn(db) };
  const audit = { log: async () => undefined, diff: () => ({}) };
  const service = new StatusPagesService(prisma as any, {} as any, audit as any);
  return { service, page };
}

const actor = { id: 'u1', email: 'owner@example.com' };
const tooShort = (e: unknown) =>
  e instanceof BadRequestException && /3-64 characters/.test(e.message);

test('a one-character slug is refused on create and on rename', async () => {
  const { service } = statusPages({ slug: 'acme' });
  await assert.rejects(service.create('o1', { slug: 'a' }, actor as any), tooShort);
  await assert.rejects(service.create('o1', {}, actor as any), tooShort);
  await assert.rejects(service.update('o1', 'p1', { slug: 'b' }, actor as any), tooShort);
});

test('a page saved with a short slug can still be edited without renaming it', async () => {
  const { service, page } = statusPages({ slug: 'a' });
  const out = await service.update('o1', 'p1', { slug: 'a', title: 'New title' }, actor as any);
  assert.equal(out.slug, 'a');
  assert.equal(page.title, 'New title');
});

test('a busy month keeps the newest pod transitions, so a fresh outage still shows', async () => {
  const deploymentId = 'd0000000-0000-0000-0000-000000000001';
  const now = Date.now();
  const transitions = [];
  for (let i = 0; i < 6000; i++) {
    transitions.push({
      deploymentId,
      podName: 'web-1',
      toStatus: i % 2 ? 'ready' : 'crashing',
      at: new Date(now - 29 * 24 * 3_600_000 + i * 1_000)
    });
  }
  transitions.push({
    deploymentId,
    podName: 'web-1',
    toStatus: 'crashing',
    at: new Date(now - 3 * 3_600_000)
  });
  const none = async () => [];
  const prisma = {
    statusPage: {
      findUnique: async () => ({
        slug: 'acme',
        title: 'Acme',
        description: null,
        isPublic: true,
        organizationId: 'org',
        organization: { name: 'Acme' },
        components: [{ kind: 'deployment', resourceId: deploymentId }]
      })
    },
    deployment: {
      findMany: async () => [
        {
          id: deploymentId,
          name: 'web',
          displayName: null,
          status: 'running',
          stopped: false,
          replicas: 1
        }
      ]
    },
    podTransition: {
      findMany: async (args: { orderBy: { at: 'asc' | 'desc' }; take: number }) => {
        const dir = args.orderBy.at === 'desc' ? -1 : 1;
        return [...transitions]
          .sort((a, b) => dir * (a.at.getTime() - b.at.getTime()))
          .slice(0, args.take);
      }
    },
    k8sWorkload: { findMany: none },
    deploymentCrashState: { findMany: none },
    metricAlertState: { findMany: none },
    database: { findMany: none },
    databaseCrashState: { findMany: none }
  };
  const service = new StatusPagesService(prisma as any, {} as any, {} as any);
  const page = await service.render('acme');
  assert.equal(Date.parse(page!.incidents[0].startedAt), now - 3 * 3_600_000);
  assert.notEqual(page!.components[0].days.at(-1)?.status, 'operational');
});
