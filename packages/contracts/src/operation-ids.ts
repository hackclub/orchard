export interface OperationKey {
  method: string;
  path: string;
  operationId?: string;
}

const NOT_COLLECTIONS = new Set([
  'status',
  'stats',
  'settings',
  'metrics',
  'limits',
  'details',
  'analytics',
  'access',
  'progress',
  'address',
  'class',
  'dns'
]);

function isParam(segment: string): boolean {
  return segment.startsWith(':') || segment.startsWith('{');
}

function paramName(segment: string): string {
  return segment.replace(/^[:{]\*?/, '').replace(/\}$/, '');
}

function snake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function looksLikeCollection(segment: string): boolean {
  const word = snake(segment).split('_').pop() ?? '';
  if (NOT_COLLECTIONS.has(word)) return false;
  return word.endsWith('s') && !/(ss|us)$/.test(word);
}

function verbFor(method: string, segments: string[]): string | null {
  const last = segments[segments.length - 1];
  const endsWithParam = last === undefined || isParam(last);
  switch (method) {
    case 'GET':
      if (endsWithParam) return 'get';
      return looksLikeCollection(last) ? 'list' : 'get';
    case 'POST':
      if (last === undefined) return 'create';
      if (endsWithParam) return `by_${snake(paramName(last))}`;
      return looksLikeCollection(last) ? 'create' : null;
    case 'PUT':
      return endsWithParam ? 'update' : 'set';
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return method.toLowerCase();
  }
}

export function baseOperationId(method: string, path: string): string {
  const segments = path.split('/').filter(Boolean);
  const words = segments
    .filter((s) => !isParam(s))
    .map(snake)
    .filter(Boolean);
  if (words.length === 0) words.push('root');
  const verb = verbFor(method.toUpperCase(), segments);
  const parts = verb ? [...words, verb] : words;
  return parts.join('_');
}

function paramSuffix(path: string): string | null {
  const params = path
    .split('/')
    .filter((s) => isParam(s))
    .map((s) => snake(paramName(s)));
  return params.length ? params.join('_') : null;
}

export function assignOperationIds<T extends OperationKey>(routes: T[]): Map<string, string> {
  const keyOf = (route: OperationKey) => `${route.method.toUpperCase()} ${route.path}`;
  const fixed = new Map<string, string>();
  for (const route of routes) if (route.operationId) fixed.set(keyOf(route), route.operationId);
  const sorted = [...routes]
    .filter((route) => !fixed.has(keyOf(route)))
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const ids = new Map<string, string>();
  for (const route of sorted) ids.set(keyOf(route), baseOperationId(route.method, route.path));

  const resolve = (refine: (route: OperationKey, current: string) => string) => {
    const groups = new Map<string, OperationKey[]>();
    for (const route of sorted) {
      const id = ids.get(keyOf(route))!;
      groups.set(id, [...(groups.get(id) ?? []), route]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const route of group) ids.set(keyOf(route), refine(route, ids.get(keyOf(route))!));
    }
  };

  resolve((route, current) => {
    const suffix = paramSuffix(route.path);
    return suffix ? `${current}_by_${suffix}` : current;
  });
  resolve((route, current) => `${current}_${route.method.toLowerCase()}`);

  const seen = new Map<string, number>();
  for (const route of sorted) {
    const id = ids.get(keyOf(route))!;
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    if (count > 1) ids.set(keyOf(route), `${id}_${count}`);
  }
  const taken = new Set(ids.values());
  for (const [key, id] of fixed) {
    if (taken.has(id)) throw new Error(`operationId ${id} on ${key} is already in use`);
    taken.add(id);
    ids.set(key, id);
  }
  return ids;
}
