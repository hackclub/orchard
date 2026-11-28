import test from 'node:test';
import assert from 'node:assert/strict';
import { K8sCnpgService } from '../src/kubernetes/k8s-cnpg.service';

test('query stats request machine-readable psql output', async () => {
  const service = Object.create(K8sCnpgService.prototype) as any;
  let command: string[] = [];
  service.findCnpgPrimaryPod = async () => 'database-1';
  service.execInPod = async (
    _namespace: string,
    _pod: string,
    _container: string,
    args: string[]
  ) => {
    command = args;
    return {
      stdout: '[{"id":"42","query":"select $1","calls":3}]\n',
      stderr: '',
      success: true
    };
  };

  const result = await service.getQueryStats('tenant', 'database', 'app');

  assert.deepEqual(command.slice(0, 9), [
    'psql',
    '-U',
    'postgres',
    '-d',
    'app',
    '-v',
    'ON_ERROR_STOP=1',
    '-t',
    '-A'
  ]);
  assert.equal(command[9], '-c');
  assert.deepEqual(result, {
    installed: true,
    queries: [{ id: '42', query: 'select $1', calls: 3 }]
  });
});

test('query stats group pg_stat_statements rows by queryid', async () => {
  const service = Object.create(K8sCnpgService.prototype) as any;
  let sql = '';
  service.runPsqlInCnpg = async (_ns: string, _cluster: string, _db: string, query: string) => {
    sql = query;
    return {
      stdout: '[{"id":"7","calls":4,"total_ms":80,"mean_ms":20}]\n',
      stderr: '',
      success: true
    };
  };

  const result = await service.getQueryStats('tenant', 'database', 'app');

  assert.match(sql, /sum\(calls\) AS calls/);
  assert.match(sql, /sum\(total_exec_time\) \/ nullif\(sum\(calls\), 0\)/);
  assert.match(sql, /max\(max_exec_time\)/);
  assert.match(sql, /GROUP BY queryid\s+ORDER BY sum\(total_exec_time\) DESC\s+LIMIT 100/);
  assert.deepEqual(result, {
    installed: true,
    queries: [{ id: '7', calls: 4, total_ms: 80, mean_ms: 20 }]
  });
});
