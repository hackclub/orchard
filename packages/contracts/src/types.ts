import type { ZodTypeAny } from 'zod';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';

export type Auth = 'public' | 'authenticated' | 'superadmin';

export type Scope = 'read' | 'deploy' | 'exec';

export interface GeneratedRoute {
  method: Method;
  path: string;
  auth: Auth;
  requiredScope?: Scope;
}

export interface RouteAttachment {
  request?: ZodTypeAny;
  query?: ZodTypeAny;
  binaryBody?: boolean;
  response?: ZodTypeAny;
  summary?: string;
  scope?: Scope;
  operationId?: string;
}

export interface Route extends GeneratedRoute, RouteAttachment {}
