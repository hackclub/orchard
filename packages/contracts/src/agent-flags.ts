export const SENSITIVE_OPERATIONS = new Set<string>([
  'GET /databases/:id/connection',
  'POST /databases/:id/users',
  'POST /databases/:id/rotate-password',
  'GET /projects/:id/ingresses/:ingressId/protection',
  'GET /users/me/git-connections/:connectionId/webhook-secret',
  'POST /deployments/:id/webhook-tokens',
  'POST /organizations/:id/notification-channels',
  'POST /auth/tokens',
  'POST /organizations/:id/scim/tokens',
  'POST /pods/:podName/exec',
  'GET /pods/:podName/files/download',
  'GET /pods/:podName/files/content',
  'PUT /pods/:podName/files/content',
  'PUT /pods/:podName/files/upload',
  'POST /pods/:podName/files/mkdir',
  'POST /pods/:podName/files/move',
  'DELETE /pods/:podName/files'
]);

export const DESTRUCTIVE_OPERATIONS = new Set<string>([
  'POST /databases/:id/upgrade',
  'PUT /deployments/:id/env',
  'PUT /environments/:id/shared-vars',
  'PUT /deployments/:id/volumes',
  'PUT /deployments/:deploymentId/services/:serviceId',
  'PATCH /databases/:id/settings',
  'PUT /jobs/:id/steps',
  'POST /deployments/:id/stop',
  'POST /databases/:id/stop',
  'POST /databases/:id/restore',
  'POST /checkpoints/:id/restore',
  'POST /checkpoints/groups/:groupId/restore',
  'POST /database-operations/:opId/undo',
  'POST /databases/:id/rotate-password',
  'POST /projects/:id/transfer-org',
  'POST /deployments/:id/cancel',
  'POST /pods/:podName/files/move',
  'PUT /pods/:podName/files/upload',
  'PUT /pods/:podName/files/content'
]);

export const AGENT_HIDDEN_PREFIXES = [
  '/admin',
  '/setup',
  '/scim',
  '/sso',
  '/.well-known',
  '/authorize',
  '/register',
  '/token',
  '/auth/passkey',
  '/auth/password',
  '/auth/mcp-token',
  '/auth/login',
  '/auth/callback',
  '/auth/logout'
];

export function isSensitiveOperation(method: string, path: string): boolean {
  return SENSITIVE_OPERATIONS.has(`${method.toUpperCase()} ${path}`);
}

export function isDestructiveOperation(method: string, path: string): boolean {
  const upper = method.toUpperCase();
  return upper === 'DELETE' || DESTRUCTIVE_OPERATIONS.has(`${upper} ${path}`);
}

export function isAgentVisible(route: { method: string; path: string; auth: string }): boolean {
  if (route.auth !== 'authenticated') return false;
  if (route.method.toUpperCase() === 'ALL') return false;
  return !AGENT_HIDDEN_PREFIXES.some(
    (prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`)
  );
}
