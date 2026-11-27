import test from 'node:test';
import assert from 'node:assert/strict';
import { hasBackupRoute, platformBackupTarget } from '../src/instance-config/object-storage';
import {
  FAST_BUILDER_ROUTING_KEY,
  IMAGE_SCANNER_KEY,
  InstanceSettingsService,
  NO_BACKUP_STORAGE,
  markBackupDependent,
  MCP_ENABLED_KEY,
  SSO_ENFORCED_KEY
} from '../src/instance-settings/instance-settings.service';

class FakePrisma {
  rows = new Map<string, string>();

  instanceSetting = {
    findUnique: async ({ where }: any) => {
      const value = this.rows.get(where.key);
      return value === undefined ? null : { key: where.key, value };
    },
    upsert: async ({ where, update }: any) => {
      this.rows.set(where.key, update.value);
      return { key: where.key, value: update.value };
    }
  };
}

function build() {
  const prisma = new FakePrisma();
  return { prisma, settings: new InstanceSettingsService(prisma as any) };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// An upgraded instance has no row for this key, and MCP has always worked
// there. Reading a missing row as "off" would silently kill every existing
// agent connection on the release that added the toggle.
test('MCP is on when nothing has been stored', async () => {
  const { settings } = build();
  await withEnv({ MCP_ENABLED: undefined }, async () => {
    assert.equal(await settings.isMcpEnabled(), true);
    assert.deepEqual(await settings.getMcpState(), {
      enabled: true,
      dbValue: true,
      envOverride: null
    });
  });
});

test('turning MCP off is remembered', async () => {
  const { settings } = build();
  await withEnv({ MCP_ENABLED: undefined }, async () => {
    await settings.setMcp(false);
    assert.equal(await settings.isMcpEnabled(), false);
    await settings.setMcp(true);
    assert.equal(await settings.isMcpEnabled(), true);
  });
});

test('the environment overrides the stored value and reports itself as the reason', async () => {
  const { settings } = build();
  await withEnv({ MCP_ENABLED: undefined }, async () => {
    await settings.setMcp(true);
  });
  await withEnv({ MCP_ENABLED: 'false' }, async () => {
    assert.equal(await settings.isMcpEnabled(), false);
    assert.deepEqual(await settings.getMcpState(), {
      enabled: false,
      dbValue: true,
      envOverride: false
    });
  });
});

// A pinned toggle is read-only for everyone, not only for the panel that hides
// the switch. Storing the write changes nothing while the variable is set and
// then becomes the instance's answer the day it is unset.
test('a pinned toggle refuses the write instead of storing it', async () => {
  const { prisma, settings } = build();
  await withEnv({ MCP_ENABLED: 'false' }, async () => {
    await assert.rejects(() => settings.setMcp(true), /MCP_ENABLED/);
    assert.equal(prisma.rows.has(MCP_ENABLED_KEY), false);
  });
  await withEnv({ USERSPACE_NODE_SCHEDULING: 'true' }, async () => {
    await assert.rejects(() => settings.setUserspaceScheduling(false), /USERSPACE_NODE_SCHEDULING/);
  });
});

// Userspace scheduling ships off, so it must not inherit the new default.
test('a toggle that ships off stays off when nothing has been stored', async () => {
  const { settings } = build();
  await withEnv({ USERSPACE_NODE_SCHEDULING: undefined }, async () => {
    assert.equal(await settings.isUserspaceSchedulingEnabled(), false);
  });
});

test('single sign-on is optional until an administrator requires it', async () => {
  const { prisma, settings } = build();
  await withEnv({ SSO_ENFORCED: undefined }, async () => {
    assert.equal(await settings.isSsoEnforced(), false);
    await settings.setSsoEnforced(true);
    assert.equal(await settings.isSsoEnforced(), true);
    assert.equal(prisma.rows.get(SSO_ENFORCED_KEY), 'true');
  });
  await withEnv({ SSO_ENFORCED: 'false' }, async () => {
    assert.equal(await settings.isSsoEnforced(), false);
    await assert.rejects(() => settings.setSsoEnforced(true), /SSO_ENFORCED/);
  });
});

test('an unset image scanner follows the computed default, a saved or pinned one wins', async () => {
  await withEnv({ IMAGE_SCANNER: undefined }, async () => {
    const { prisma, settings } = build();
    assert.deepEqual(await settings.getImageScannerState(async () => 'trivy'), {
      value: 'trivy',
      dbValue: null,
      envOverride: null
    });
    assert.equal((await settings.getImageScannerState()).value, 'off');
    prisma.rows.set(IMAGE_SCANNER_KEY, 'off');
    assert.equal((await settings.getImageScannerState(async () => 'trivy')).value, 'off');
  });
  await withEnv({ IMAGE_SCANNER: 'harbor' }, async () => {
    const { settings } = build();
    let asked = false;
    const state = await settings.getImageScannerState(async () => {
      asked = true;
      return 'trivy';
    });
    assert.equal(state.value, 'harbor');
    assert.equal(asked, false);
  });
});

test('fast builder routing is stored, else the env default, else the flag', async () => {
  await withEnv({ FAST_BUILDER_ROUTING_DEFAULT: undefined }, async () => {
    const { prisma, settings } = build();
    assert.deepEqual(await settings.getFastBuilderRoutingState(), {
      value: 'flag',
      dbValue: null,
      fallback: 'flag'
    });
    await settings.setFastBuilderRouting('off');
    assert.equal(prisma.rows.get(FAST_BUILDER_ROUTING_KEY), 'off');
    assert.equal((await settings.getFastBuilderRoutingState()).value, 'off');
  });
  await withEnv({ FAST_BUILDER_ROUTING_DEFAULT: 'all' }, async () => {
    const { prisma, settings } = build();
    assert.deepEqual(await settings.getFastBuilderRoutingState(), {
      value: 'all',
      dbValue: null,
      fallback: 'all'
    });
    await settings.setFastBuilderRouting('per_app');
    assert.equal(prisma.rows.get(FAST_BUILDER_ROUTING_KEY), 'per_app');
    assert.deepEqual(await settings.getFastBuilderRoutingState(), {
      value: 'per_app',
      dbValue: 'per_app',
      fallback: 'all'
    });
  });
  await withEnv({ FAST_BUILDER_ROUTING_DEFAULT: 'nonsense' }, async () => {
    const { settings } = build();
    assert.equal((await settings.getFastBuilderRoutingState()).value, 'flag');
  });
});

test('drop checkpoints and restore tests are unavailable without any backup storage', () => {
  const t = { enabled: true, dbValue: true, envOverride: null };
  const toggles = {
    ddlCheckpoints: t,
    restoreDrills: t,
    pluginMigration: t,
    poolerByDefault: t
  };
  const marked = markBackupDependent(toggles, false);
  assert.equal(marked.ddlCheckpoints.unavailable, NO_BACKUP_STORAGE);
  assert.equal(marked.restoreDrills.unavailable, NO_BACKUP_STORAGE);
  assert.equal(marked.poolerByDefault.unavailable, undefined);
  assert.equal(markBackupDependent(toggles, true).ddlCheckpoints.unavailable, undefined);
});

test('a backup route needs a backup bucket, an org bucket, or nothing counts', async () => {
  const env = {
    R2_ACCOUNT_ID: undefined,
    R2_ENDPOINT: 'http://object-storage.orchard-object-storage.svc.cluster.local:9000',
    R2_ACCESS_KEY_ID: 'ak',
    R2_SECRET_ACCESS_KEY: 'sk',
    R2_BUCKET_NAME: 'assets',
    R2_BACKUP_BUCKET: undefined,
    R2_REGION: undefined
  };
  await withEnv(env, async () => {
    assert.equal(platformBackupTarget(), null);
    assert.equal(hasBackupRoute(null), false);
    assert.equal(
      hasBackupRoute({
        backupR2Endpoint: 'https://s3.example.com',
        backupR2Bucket: 'b',
        backupR2AccessKey: 'a',
        backupR2SecretKey: 's'
      }),
      true
    );
  });
  await withEnv(
    { ...env, R2_BACKUP_BUCKET: 'orchard-backups', R2_REGION: 'us-east-1' },
    async () => {
      assert.deepEqual(platformBackupTarget(), {
        endpoint: 'http://object-storage.orchard-object-storage.svc.cluster.local:9000',
        bucket: 'orchard-backups',
        region: 'us-east-1',
        accessKey: 'ak',
        secretKey: 'sk',
        pathStyle: true,
        local: false
      });
      assert.equal(hasBackupRoute(null), true);
    }
  );
});
