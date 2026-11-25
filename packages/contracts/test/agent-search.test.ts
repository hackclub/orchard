import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findOperation,
  searchOperations,
  tokenize,
  type AgentOperation
} from '../src/agent-search';
import { assignOperationIds, baseOperationId } from '../src/operation-ids';

const op = (
  operationId: string,
  method: string,
  path: string,
  summary: string,
  extra: Partial<AgentOperation> = {}
): AgentOperation => ({
  operationId,
  method,
  path,
  summary,
  tags: [path.split('/')[1]],
  scope: method === 'GET' ? 'read' : 'deploy',
  ...extra
});

const fixture: AgentOperation[] = [
  op('deployments_list', 'GET', '/deployments', 'List deployments'),
  op('deployments_get', 'GET', '/deployments/:id', 'Get a deployment'),
  op('deployments_restart', 'POST', '/deployments/:id/restart', 'Restart a deployment'),
  op('deployments_logs_list', 'GET', '/deployments/:id/logs', 'Recent logs for a deployment'),
  op('deployments_env_set', 'PUT', '/deployments/:id/env', 'Replace environment variables', {
    'x-orchard-destructive': true
  }),
  op(
    'deployments_rollout_get',
    'GET',
    '/deployments/:id/rollout',
    'Rollout status and failure diagnosis'
  ),
  op('deployments_recent_builds_list', 'GET', '/deployments/recent-builds', 'Recent builds'),
  op('databases_get', 'GET', '/databases/:id', 'Get a database'),
  op('databases_connection_get', 'GET', '/databases/:id/connection', 'Database credentials', {
    'x-orchard-sensitive': true
  }),
  op('databases_delete', 'DELETE', '/databases/:id', 'Delete a database', {
    'x-orchard-destructive': true
  }),
  op('pods_logs_list', 'GET', '/pods/:podName/logs', 'Logs for one pod')
];

test('tokenize splits camelCase, snake and paths and stems plurals', () => {
  assert.deepEqual(tokenize('deployments_rollout_get'), ['deployment', 'rollout', 'get']);
  assert.deepEqual(tokenize('getDatabaseConnections'), ['get', 'database', 'connection']);
  assert.deepEqual(tokenize('the status of my app'), ['status', 'app']);
});

test('search ranks the obvious operation first', () => {
  assert.equal(
    searchOperations(fixture, 'restart deployment')[0].operationId,
    'deployments_restart'
  );
  assert.equal(
    searchOperations(fixture, 'database password')[0].operationId,
    'databases_connection_get'
  );
  assert.equal(
    searchOperations(fixture, 'is my app live rollout')[0].operationId,
    'deployments_rollout_get'
  );
  assert.equal(searchOperations(fixture, 'pod logs')[0].operationId, 'pods_logs_list');
});

test('search flags sensitive and destructive hits and respects limit', () => {
  const hits = searchOperations(fixture, 'database', 2);
  assert.equal(hits.length, 2);
  const all = searchOperations(fixture, 'database', 10);
  assert.equal(all.find((h) => h.operationId === 'databases_delete')?.destructive, true);
  assert.equal(all.find((h) => h.operationId === 'databases_connection_get')?.sensitive, true);
});

test('search ordering is stable for equal scores', () => {
  const first = searchOperations(fixture, 'deployment', 20).map((h) => h.operationId);
  const second = searchOperations([...fixture].reverse(), 'deployment', 20).map(
    (h) => h.operationId
  );
  assert.deepEqual(first, second);
});

test('search returns nothing for unrelated queries', () => {
  assert.deepEqual(searchOperations(fixture, 'zebra'), []);
});

test('findOperation resolves ids, templates and concrete paths', () => {
  assert.equal(findOperation(fixture, 'databases_get')?.path, '/databases/:id');
  assert.equal(findOperation(fixture, 'GET /databases/:id')?.operationId, 'databases_get');
  assert.equal(
    findOperation(fixture, 'get /deployments/abc-123/logs')?.operationId,
    'deployments_logs_list'
  );
  assert.equal(
    findOperation(fixture, 'GET /deployments/recent-builds')?.operationId,
    'deployments_recent_builds_list'
  );
  assert.equal(findOperation(fixture, 'POST /nope'), undefined);
});

test('operation ids follow <tag>_<words>_<verb>', () => {
  assert.equal(baseOperationId('GET', '/deployments/:id/rollout'), 'deployments_rollout_get');
  assert.equal(baseOperationId('GET', '/deployments'), 'deployments_list');
  assert.equal(baseOperationId('POST', '/deployments/:id/restart'), 'deployments_restart');
  assert.equal(baseOperationId('POST', '/projects/:id/deployments'), 'projects_deployments_create');
  assert.equal(baseOperationId('PUT', '/deployments/:id/env'), 'deployments_env_set');
  assert.equal(baseOperationId('PATCH', '/deployments/:id/image'), 'deployments_image_update');
  assert.equal(baseOperationId('DELETE', '/databases/:id'), 'databases_delete');
  assert.equal(
    baseOperationId('POST', '/projects/ingresses/validate-dns'),
    'projects_ingresses_validate_dns'
  );
});

test('operation ids are unique even when static words collide', () => {
  const ids = assignOperationIds([
    { method: 'GET', path: '/share/:token/sessions/:sid' },
    { method: 'GET', path: '/share/sessions/:sid' },
    { method: 'PUT', path: '/x/:id' },
    { method: 'PATCH', path: '/x/:id' }
  ]);
  assert.equal(new Set(ids.values()).size, 4);
  assert.equal(ids.get('PUT /x/:id'), 'x_update_by_id_put');
});

test('an explicit operation id is kept and cannot take a derived one', () => {
  const ids = assignOperationIds([
    { method: 'PATCH', path: '/d/:id/image' },
    { method: 'POST', path: '/d/:id/image-update', operationId: 'd_image_update_pull' }
  ]);
  assert.equal(ids.get('POST /d/:id/image-update'), 'd_image_update_pull');
  assert.equal(ids.get('PATCH /d/:id/image'), 'd_image_update');
  assert.throws(() =>
    assignOperationIds([
      { method: 'PATCH', path: '/d/:id/image' },
      { method: 'GET', path: '/d/:id/thing', operationId: 'd_image_update' }
    ])
  );
});
