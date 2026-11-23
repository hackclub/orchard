import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
  type RouteConfig
} from '@asteasolutions/zod-to-openapi';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assignOperationIds } from './operation-ids';
import { registry as routeRegistry } from './registry';
import type { Route } from './types';

extendZodWithOpenApi(z);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(packageRoot, 'openapi.json');

const genericObject = z.object({}).passthrough();
const bodyMethods = new Set(['POST', 'PUT', 'PATCH']);

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

function tagFor(path: string): string {
  return path.split('/')[1] || 'root';
}

function descriptionFor(route: Route): string {
  return route.scope ? `Auth: ${route.auth} (scope: ${route.scope})` : `Auth: ${route.auth}`;
}

function requestFor(route: Route): RouteConfig['request'] {
  const request: NonNullable<RouteConfig['request']> = {};
  const params = pathParams(route.path);
  if (params.length > 0) {
    request.params = z.object(Object.fromEntries(params.map((name) => [name, z.string()])));
  }
  if (route.binaryBody) {
    request.body = {
      content: {
        'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) }
      }
    };
  } else if (bodyMethods.has(route.method) && (route.request || !route.query)) {
    request.body = {
      content: {
        'application/json': { schema: route.request ?? genericObject }
      }
    };
  } else if (route.request instanceof z.ZodObject) {
    request.query = route.request;
  }
  if (route.query instanceof z.ZodObject) request.query = route.query;
  return request;
}

const openApiRegistry = new OpenAPIRegistry();

openApiRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description: 'Orchard personal access token'
});

openApiRegistry.registerComponent('securitySchemes', 'cookieAuth', {
  type: 'apiKey',
  in: 'cookie',
  name: 'session_token',
  description: 'Browser session cookie'
});

const operationIds = assignOperationIds(routeRegistry);

for (const route of routeRegistry) {
  openApiRegistry.registerPath({
    operationId: operationIds.get(`${route.method} ${route.path}`),
    method: route.method.toLowerCase() as Parameters<
      typeof openApiRegistry.registerPath
    >[0]['method'],
    path: toOpenApiPath(route.path),
    summary: route.summary ?? `${route.method} ${route.path}`,
    description: descriptionFor(route),
    tags: [tagFor(route.path)],
    security: route.auth === 'public' ? undefined : [{ bearerAuth: [] }, { cookieAuth: [] }],
    request: requestFor(route),
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': { schema: route.response ?? genericObject }
        }
      }
    }
  });
}

const generator = new OpenApiGeneratorV31(openApiRegistry.definitions);
const document = generator.generateDocument({
  openapi: '3.1.0',
  info: {
    title: 'Orchard API',
    version: '0.1.0',
    description:
      'Generated from @orchard/contracts route registry (bootstrap source: apps/server auth-coverage snapshot).'
  }
});

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortDeep(entry)])
    );
  }
  return value;
}

const json = `${JSON.stringify(sortDeep(document), null, 2)}\n`;
writeFileSync(outputPath, json);

const operationCount = Object.values(document.paths ?? {}).reduce(
  (count, pathItem) =>
    count +
    Object.keys(pathItem as object).filter((key) =>
      ['get', 'post', 'put', 'patch', 'delete'].includes(key)
    ).length,
  0
);

console.log(
  `wrote ${outputPath}: ${Object.keys(document.paths ?? {}).length} paths, ${operationCount} operations, ${json.length} bytes`
);
