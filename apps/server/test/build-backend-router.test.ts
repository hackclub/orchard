import test from 'node:test';
import assert from 'node:assert/strict';
import {
  builderPoolOf,
  decideBuilder,
  type BuilderKind
} from '../src/docker/fc/build-backend-router';
import {
  FAST_BUILDER_ROUTINGS,
  parseFastBuilderRouting,
  type FastBuilderRouting
} from '../src/instance-settings/instance-settings.service';

const on = () => Promise.resolve(true);
const off = () => Promise.resolve(false);
const broken = () => Promise.reject(new Error('posthog down'));
const never = () => {
  throw new Error('flag must not be evaluated');
};

test('super builds always stay on depot', async () => {
  for (const override of [null, 'firecracker', 'kubernetes']) {
    assert.equal(
      await decideBuilder({
        buildWithDepot: true,
        override,
        firecrackerAvailable: true,
        flag: never
      }),
      'depot'
    );
  }
});

test('firecracker unavailable means the standard builder, whatever the override', async () => {
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: 'firecracker',
      firecrackerAvailable: false,
      flag: never
    }),
    'kubernetes'
  );
});

test('overrides win over the flag', async () => {
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: 'kubernetes',
      firecrackerAvailable: true,
      flag: never
    }),
    'kubernetes'
  );
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: 'firecracker',
      firecrackerAvailable: true,
      flag: never
    }),
    'firecracker'
  );
});

test('the flag decides when there is no override, and failure means the standard builder', async () => {
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: null,
      firecrackerAvailable: true,
      flag: on
    }),
    'firecracker'
  );
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: null,
      firecrackerAvailable: true,
      flag: off
    }),
    'kubernetes'
  );
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: null,
      firecrackerAvailable: true,
      flag: broken
    }),
    'kubernetes'
  );
});

test('unset routing behaves exactly like flag routing', async () => {
  const flags = [on, off, broken];
  for (const override of [null, 'firecracker', 'kubernetes']) {
    for (const firecrackerAvailable of [true, false]) {
      for (const flag of flags) {
        const base = { buildWithDepot: false, override, firecrackerAvailable, flag };
        assert.equal(
          await decideBuilder(base),
          await decideBuilder({ ...base, routing: 'flag' }),
          `override=${override} available=${firecrackerAvailable}`
        );
      }
    }
  }
});

test('every routing mode against every override', async () => {
  const cases: [FastBuilderRouting, string | null, BuilderKind][] = [
    ['all', null, 'firecracker'],
    ['all', 'firecracker', 'firecracker'],
    ['all', 'kubernetes', 'kubernetes'],
    ['per_app', null, 'kubernetes'],
    ['per_app', 'firecracker', 'firecracker'],
    ['per_app', 'kubernetes', 'kubernetes'],
    ['off', null, 'kubernetes'],
    ['off', 'firecracker', 'kubernetes'],
    ['off', 'kubernetes', 'kubernetes']
  ];
  for (const [routing, override, expected] of cases) {
    assert.equal(
      await decideBuilder({
        buildWithDepot: false,
        override,
        firecrackerAvailable: true,
        routing,
        flag: never
      }),
      expected,
      `routing=${routing} override=${override}`
    );
  }
});

test('flag routing asks the flag only for Auto', async () => {
  for (const [flag, expected] of [
    [on, 'firecracker'],
    [off, 'kubernetes'],
    [broken, 'kubernetes']
  ] as const) {
    assert.equal(
      await decideBuilder({
        buildWithDepot: false,
        override: null,
        firecrackerAvailable: true,
        routing: 'flag',
        flag
      }),
      expected
    );
  }
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: 'firecracker',
      firecrackerAvailable: true,
      routing: 'flag',
      flag: never
    }),
    'firecracker'
  );
  assert.equal(
    await decideBuilder({
      buildWithDepot: false,
      override: 'kubernetes',
      firecrackerAvailable: true,
      routing: 'flag',
      flag: never
    }),
    'kubernetes'
  );
});

test('depot and a missing fast builder short-circuit every routing mode', async () => {
  for (const routing of FAST_BUILDER_ROUTINGS) {
    for (const override of [null, 'firecracker', 'kubernetes']) {
      assert.equal(
        await decideBuilder({
          buildWithDepot: true,
          override,
          firecrackerAvailable: true,
          routing,
          flag: never
        }),
        'depot'
      );
      assert.equal(
        await decideBuilder({
          buildWithDepot: false,
          override,
          firecrackerAvailable: false,
          routing,
          flag: never
        }),
        'kubernetes'
      );
    }
  }
});

test('routing parses stored and env values', () => {
  assert.equal(parseFastBuilderRouting('all'), 'all');
  assert.equal(parseFastBuilderRouting(' Per_App '), 'per_app');
  assert.equal(parseFastBuilderRouting('per-app'), 'per_app');
  assert.equal(parseFastBuilderRouting('off'), 'off');
  assert.equal(parseFastBuilderRouting('flag'), 'flag');
  assert.equal(parseFastBuilderRouting('on'), null);
  assert.equal(parseFastBuilderRouting(''), null);
  assert.equal(parseFastBuilderRouting(undefined), null);
});

test('legacy runs without a recorded builder fall back to the depot flag', () => {
  assert.equal(builderPoolOf({ builder: null }, true), 'depot');
  assert.equal(builderPoolOf({ builder: null }, false), 'kubernetes');
  assert.equal(builderPoolOf({ builder: 'firecracker' }, false), 'firecracker');
  assert.equal(builderPoolOf({ builder: 'nonsense' }, false), 'kubernetes');
});
