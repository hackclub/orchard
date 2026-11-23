import express from 'express';

export const PUBLIC_BODY_LIMIT = 512 * 1024;
export const DEFAULT_BODY_LIMIT = 1024 * 1024;
export const WEBHOOK_BODY_LIMIT = 5 * 1024 * 1024;
export const LARGE_BODY_LIMIT = 25 * 1024 * 1024;
export const RAW_BODY_LIMIT = 512 * 1024 * 1024;
export const FILE_EDIT_BODY_LIMIT = 3 * 1024 * 1024;

export type BodyTier = 'public' | 'default' | 'webhook' | 'large' | 'raw' | 'fileEdit';

export const BODY_TIER_LIMITS: Record<BodyTier, number> = {
  public: PUBLIC_BODY_LIMIT,
  default: DEFAULT_BODY_LIMIT,
  webhook: WEBHOOK_BODY_LIMIT,
  large: LARGE_BODY_LIMIT,
  raw: RAW_BODY_LIMIT,
  fileEdit: FILE_EDIT_BODY_LIMIT
};

const PREFIX = /^\/(?:apiv1|api)(?=\/|$)/;

const WEBHOOK_ROUTES = [
  /^\/webhooks?(?:\/|$)/,
  /^\/github\/app\/webhook(?:\/|$)/,
  /\/webhook(?:s)?(?:\/|$)/
];

const PUBLIC_ROUTES = [
  /^\/auth(?:\/|$)/,
  /^\/sso(?:\/|$)/,
  /^\/scim(?:\/|$)/,
  /^\/invitations(?:\/|$)/,
  /^\/setup(?:\/|$)/,
  /^\/status(?:\/|$)/,
  /^\/protection(?:\/|$)/,
  /^\/oauth(?:\/|$)/,
  /^\/git\/oauth(?:\/|$)/,
  /^\/mcp\/oauth(?:\/|$)/,
  /^\/instance-config(?:\/|$)/,
  /^\/agent-spec(?:\/|$)/,
  /^\/security\/image-scan-result(?:\/|$)/
];

const SCIM_ROUTES = [/^\/scim\/v2(?:\/|$)/, /^\/scim(?:\/|$)/];

const LARGE_ROUTES = [
  /^\/projects\/import(?:\/|$)/,
  /^\/templates(?:\/|$)/,
  /\/(?:import|restore)(?:\/|$)/,
  /^\/deployments\/[^/]+\/(?:env|build-config)$/,
  /^\/environments\/[^/]+\/shared-vars$/,
  /^\/projects\/[^/]+\/deployments$/,
  /^\/projects\/[^/]+\/template-instances$/,
  /^\/jobs\/[^/]+\/steps$/,
  /^\/projects\/[^/]+\/jobs$/,
  /^\/internal\/image-scans\/[^/]+\/result$/
];

const RAW_ROUTES = [/^\/pods\/[^/]+\/files\/upload$/];

const FILE_EDIT_ROUTES = [/^\/pods\/[^/]+\/files\/content$/];

function routePath(url: string): string {
  const path = (url.split('?')[0] ?? '').replace(/\/+$/, '') || '/';
  return path.replace(PREFIX, '') || '/';
}

export function bodyTierFor(url: string): BodyTier {
  const path = routePath(url);
  if (RAW_ROUTES.some((re) => re.test(path))) return 'raw';
  if (FILE_EDIT_ROUTES.some((re) => re.test(path))) return 'fileEdit';
  if (WEBHOOK_ROUTES.some((re) => re.test(path))) return 'webhook';
  if (PUBLIC_ROUTES.some((re) => re.test(path)) || SCIM_ROUTES.some((re) => re.test(path))) {
    return 'public';
  }
  if (LARGE_ROUTES.some((re) => re.test(path))) return 'large';
  return 'default';
}

const JSON_TYPES = ['application/json', 'application/scim+json'];

interface ParserRequest {
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  is?: (types: string | string[]) => string | false | null;
}

export function registerBodyParsers(
  use: (
    type: 'json' | 'urlencoded',
    options: { limit: number; extended?: boolean; type: (req: any) => boolean }
  ) => unknown
): void {
  const tierOf = (req: ParserRequest) => bodyTierFor(req.originalUrl ?? req.url);
  for (const tier of Object.keys(BODY_TIER_LIMITS) as BodyTier[]) {
    if (tier === 'large' || tier === 'raw') continue;
    const limit = BODY_TIER_LIMITS[tier];
    use('json', {
      limit,
      type: (req: ParserRequest) => tierOf(req) === tier && !!req.is?.(JSON_TYPES)
    });
    use('urlencoded', {
      limit,
      extended: true,
      type: (req: ParserRequest) =>
        tierOf(req) === tier && !!req.is?.('application/x-www-form-urlencoded')
    });
  }
}

function runParser(
  parser: (req: any, res: any, next: (err?: unknown) => void) => void,
  req: any,
  res: any
): Promise<void> {
  return new Promise((resolve, reject) =>
    parser(req, res, (err) => (err ? reject(err) : resolve()))
  );
}

export async function parseLargeBody(req: any, res: any): Promise<void> {
  const verify = (r: any, _res: any, buf: Buffer) => {
    if (Buffer.isBuffer(buf)) r.rawBody = buf;
  };
  await runParser(express.json({ limit: LARGE_BODY_LIMIT, type: JSON_TYPES, verify }), req, res);
  await runParser(
    express.urlencoded({ limit: LARGE_BODY_LIMIT, extended: true, verify }),
    req,
    res
  );
}
