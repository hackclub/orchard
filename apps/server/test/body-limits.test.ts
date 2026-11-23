import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  bodyTierFor,
  parseLargeBody,
  registerBodyParsers,
  PUBLIC_BODY_LIMIT,
  DEFAULT_BODY_LIMIT,
  LARGE_BODY_LIMIT,
  FILE_EDIT_BODY_LIMIT
} from '../src/http/body-limits';
import { assertSafeSamlResponse, SAML_MAX_DEPTH } from '../src/sso/saml-guard';

function buildApp() {
  const app = express();
  registerBodyParsers((type, options) => app.use((express as any)[type](options)));
  app.use(async (req, res, next) => {
    if (bodyTierFor(req.originalUrl) !== 'large') return next();
    if (req.headers.authorization !== 'Bearer orch_x') return res.status(401).end();
    try {
      await parseLargeBody(req, res);
      next();
    } catch (err: any) {
      res.status(err?.status ?? 400).end();
    }
  });
  app.post(/^\/apiv1\/.*/, (req, res) => {
    res.json({ bytes: JSON.stringify(req.body ?? {}).length });
  });
  return app;
}

async function post(
  app: express.Express,
  path: string,
  body: Buffer,
  headers: Record<string, string> = {}
): Promise<{ status: number; ms: number }> {
  const server = http.createServer(app).listen(0);
  const { port } = server.address() as AddressInfo;
  const started = process.hrtime.bigint();
  try {
    return await new Promise((resolve) => {
      const req = http.request(
        { port, path, method: 'POST', headers: { 'content-length': body.length, ...headers } },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              ms: Number(process.hrtime.bigint() - started) / 1e6
            })
          );
        }
      );
      req.on('error', () =>
        resolve({ status: 0, ms: Number(process.hrtime.bigint() - started) / 1e6 })
      );
      req.end(body);
    });
  } finally {
    server.close();
  }
}

const json = { 'content-type': 'application/json' };
const form = { 'content-type': 'application/x-www-form-urlencoded' };

test('pre-auth routes get the small tier, authenticated imports the large one', () => {
  for (const url of [
    '/apiv1/sso/saml/p1/acs',
    '/apiv1/auth/otp/request',
    '/apiv1/scim/v2/Users',
    '/apiv1/invitations/abc/accept',
    '/apiv1/setup/complete',
    '/apiv1/protection/exchange'
  ]) {
    assert.equal(bodyTierFor(url), 'public', url);
  }
  assert.equal(bodyTierFor('/apiv1/github/app/webhook'), 'webhook');
  assert.equal(bodyTierFor('/apiv1/projects/import'), 'large');
  assert.equal(bodyTierFor('/apiv1/projects/abc'), 'default');
});

test('routes whose real payloads exceed 1 MB are in the large tier', () => {
  for (const url of [
    '/apiv1/deployments/d1/env',
    '/apiv1/deployments/d1/build-config',
    '/apiv1/environments/e1/shared-vars',
    '/apiv1/projects/p1/deployments',
    '/apiv1/projects/p1/template-instances',
    '/apiv1/jobs/j1/steps',
    '/apiv1/projects/p1/jobs',
    '/apiv1/templates',
    '/apiv1/templates/t1',
    '/apiv1/databases/d1/restore',
    '/apiv1/internal/image-scans/6f1c7a3e-0000-4000-8000-000000000000/result'
  ]) {
    assert.equal(bodyTierFor(url), 'large', url);
  }
  assert.equal(bodyTierFor('/apiv1/deployments/d1/name'), 'default');
});

test('a 20 MB body to a pre-auth route is rejected with 413 before it is parsed', async () => {
  const app = buildApp();
  const big = Buffer.alloc(20 * 1024 * 1024, 0x61);
  const saml = await post(app, '/apiv1/sso/saml/p1/acs', big, form);
  const otp = await post(app, '/apiv1/auth/otp/request', big, json);
  assert.equal(saml.status, 413);
  assert.equal(otp.status, 413);
  assert.ok(saml.ms < 1000 && otp.ms < 1000, `rejected in ${saml.ms}ms / ${otp.ms}ms`);
});

test('a body just under the pre-auth limit still parses', async () => {
  const app = buildApp();
  const body = Buffer.from(JSON.stringify({ email: 'a'.repeat(PUBLIC_BODY_LIMIT - 100) }));
  assert.equal((await post(app, '/apiv1/auth/otp/request', body, json)).status, 200);
});

test('authenticated routes keep a larger budget than pre-auth ones', async () => {
  const app = buildApp();
  const mid = Buffer.from(JSON.stringify({ x: 'a'.repeat(DEFAULT_BODY_LIMIT + 1000) }));
  assert.equal((await post(app, '/apiv1/projects/abc', mid, json)).status, 413);
  const large = Buffer.from(JSON.stringify({ x: 'a'.repeat(3 * 1024 * 1024) }));
  assert.ok(LARGE_BODY_LIMIT > large.length);
  const authed = { ...json, authorization: 'Bearer orch_x' };
  assert.equal((await post(app, '/apiv1/projects/import', large, authed)).status, 200);
  assert.equal((await post(app, '/apiv1/projects/import', large, json)).status, 401);
});

function b64(xml: string) {
  return Buffer.from(xml).toString('base64');
}

test('saml guard accepts a normal response and rejects DTDs, entities and bombs', () => {
  const ok = b64(
    '<samlp:Response xmlns:samlp="x"><saml:Assertion><a>1</a></saml:Assertion></samlp:Response>'
  );
  assert.equal(assertSafeSamlResponse(ok), ok);
  const doctype = b64('<!DOCTYPE r [<!ENTITY a "x">]><r>&a;</r>');
  assert.throws(() => assertSafeSamlResponse(doctype), /Invalid SAML/);
  assert.throws(() => assertSafeSamlResponse(b64('<!doctype x><r/>')), /Invalid SAML/);
  const deep = b64('<a>'.repeat(SAML_MAX_DEPTH + 5) + '</a>'.repeat(SAML_MAX_DEPTH + 5));
  assert.throws(() => assertSafeSamlResponse(deep), /Invalid SAML/);
  const wide = b64('<r>' + '<a/>'.repeat(6000) + '</r>');
  assert.throws(() => assertSafeSamlResponse(wide), /Invalid SAML/);
  assert.throws(() => assertSafeSamlResponse('A'.repeat(600 * 1024)), /Invalid SAML/);
  assert.throws(() => assertSafeSamlResponse(undefined), /Invalid SAML/);
  assert.throws(() => assertSafeSamlResponse('<not base64>'), /Invalid SAML/);
});

test('an unauthenticated body to a large-tier route is never parsed', async () => {
  const app = buildApp();
  const big = Buffer.alloc(20 * 1024 * 1024, 0x61);
  const res = await post(app, '/apiv1/projects/import', big, { ...json, cookie: 'junk=1' });
  assert.equal(res.status, 401);
  assert.ok(res.ms < 1000);
});

test('pod file uploads reach the handler as an untouched stream', async () => {
  assert.equal(bodyTierFor('/apiv1/pods/web-1/files/upload?path=/a&namespace=n'), 'raw');
  assert.equal(bodyTierFor('/apiv1/pods/web-1/files/content'), 'fileEdit');
  assert.equal(bodyTierFor('/apiv1/pods/web-1/files'), 'default');
  const app = express();
  registerBodyParsers((type, options) => app.use((express as any)[type](options)));
  const seen: number[] = [];
  app.post(/^\/apiv1\/pods\/[^/]+\/files\/upload$/, (req, res) => {
    let bytes = 0;
    req.on('data', (chunk: Buffer) => (bytes += chunk.length));
    req.on('end', () => {
      seen.push(bytes);
      res.status(200).end();
    });
  });
  const body = Buffer.from(JSON.stringify({ x: 'a'.repeat(DEFAULT_BODY_LIMIT + 1000) }));
  for (const headers of [json, { 'content-type': 'application/octet-stream' }, form]) {
    assert.equal((await post(app, '/apiv1/pods/web-1/files/upload', body, headers)).status, 200);
  }
  assert.deepEqual(seen, [body.length, body.length, body.length]);
});

test('pod file edits get a 3 MiB JSON budget', async () => {
  const app = buildApp();
  const url = '/apiv1/pods/web-1/files/content';
  const fits = Buffer.from(JSON.stringify({ content: '\\u0001'.repeat(400_000) }));
  assert.ok(fits.length > DEFAULT_BODY_LIMIT && fits.length < FILE_EDIT_BODY_LIMIT);
  assert.equal((await post(app, url, fits, json)).status, 200);
  const big = Buffer.from(JSON.stringify({ content: 'a'.repeat(FILE_EDIT_BODY_LIMIT + 10) }));
  assert.equal((await post(app, url, big, json)).status, 413);
});
