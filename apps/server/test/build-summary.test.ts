import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DISK_FULL_HINT,
  REGISTRY_SERVER_ERROR_HINT,
  summarizeBuildFailure
} from '../src/docker/build-summary';

const craftFailure = [
  '#22 0.413 > craft@0.0.1 build /app',
  '#22 0.413 > vite build',
  '#22 3.414 vite v7.1.3 building SSR bundle for production...',
  '#22 6.964 transforming...',
  '#22 7.102 error during build:',
  '#22 7.102 src/routes/+layout.ts (3:9): "PUBLIC_POSTHOG_KEY" is not exported by "virtual:env/static/public"',
  '#22 ERROR: process "pnpm run build" did not complete successfully: exit code: 1',
  'error: failed to solve: process "pnpm run build" did not complete successfully: exit code: 1'
].join('\n');

test("the failing step's own output carries the cause, not just the exit code", () => {
  const summary = summarizeBuildFailure(craftFailure);
  assert.match(summary, /PUBLIC_POSTHOG_KEY/);
  assert.match(summary, /error during build:/);
  assert.match(summary, /did not complete successfully/);
});

test('output from steps that did not fail is left out', () => {
  const summary = summarizeBuildFailure(
    ['#4 1.0 installing unrelated things', ...craftFailure.split('\n')].join('\n')
  );
  assert.doesNotMatch(summary, /unrelated things/);
});

test('only the tail of a noisy failing step is kept', () => {
  const noisy = [
    ...Array.from({ length: 40 }, (_, i) => `#22 0.${i} noise line ${i}`),
    '#22 9.9 the real cause',
    '#22 ERROR: process "pnpm run build" did not complete successfully: exit code: 1'
  ].join('\n');
  const summary = summarizeBuildFailure(noisy);
  assert.match(summary, /the real cause/);
  assert.doesNotMatch(summary, /noise line 0\b/);
});

test('a dockerfile lint failure still explains itself', () => {
  const summary = summarizeBuildFailure('lint violation found for rules: JSONArgsRecommended');
  assert.match(summary, /check=skip=JSONArgsRecommended/);
});

test('a pusher failure is still surfaced', () => {
  const summary = summarizeBuildFailure('#5 ERROR: nope', 'FATA[0003] denied: permission denied');
  assert.match(summary, /Pusher: FATA/);
});

test('with nothing recognisable it falls back to the log tail', () => {
  const summary = summarizeBuildFailure('time=skip me\nsomething odd happened');
  assert.match(summary, /something odd happened/);
  assert.doesNotMatch(summary, /skip me/);
});

test('the summary stays short enough for a headline', () => {
  const huge = Array.from({ length: 200 }, (_, i) => `#9 0.${i} ${'x'.repeat(80)}`)
    .concat('#9 ERROR: boom')
    .join('\n');
  assert.ok(summarizeBuildFailure(huge).length <= 800);
});

test('empty logs do not throw', () => {
  assert.equal(typeof summarizeBuildFailure(null, null), 'string');
});

test('a pusher that runs out of disk says so', () => {
  const summary = summarizeBuildFailure(
    'Build job failed with the following reasons:\nContainer pusher terminated: Error - exit code 1\n\n',
    'time="2026-11-25T01:35:14Z" level=fatal msg="initializing source oci:/output/image: write /var/tmp/x: no space left on device"'
  );
  assert.ok(summary.startsWith(DISK_FULL_HINT));
  assert.match(summary, /Pusher: .*no space left on device/);
});

test('a build pod evicted for disk pressure names the cause', () => {
  const summary = summarizeBuildFailure(
    'Build job failed with the following reasons:\nPod Evicted: The node was low on resource: ephemeral-storage. Threshold quantity: 1Gi, available: 512Mi.\nContainer pusher terminated: Error - exit code 137\n\n'
  );
  assert.ok(summary.includes(DISK_FULL_HINT));
  assert.match(summary, /Pod Evicted: The node was low on resource: ephemeral-storage/);
});

test('a registry 500 during push points at the registry', () => {
  const summary = summarizeBuildFailure(
    '',
    'time="2026-11-25T01:49:20Z" level=fatal msg="writing blob: uploading layer chunked: received unexpected HTTP status: 500 Internal Server Error"'
  );
  assert.ok(summary.startsWith(REGISTRY_SERVER_ERROR_HINT));
  assert.match(summary, /Pusher: .*500 Internal Server Error/);
});
