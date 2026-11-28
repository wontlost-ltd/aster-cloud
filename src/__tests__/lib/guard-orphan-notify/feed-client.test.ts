// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrphanFeedError, createOrphanFeedClient } from '@/lib/guard-orphan-notify/feed-client';

vi.mock('server-only', () => ({}));

interface Fixture {
  tenantsRequest: { detectedSince: string; limit: number };
  summaryRequest: { tenantId: string; afterId: number; detectedSince: string };
  tenantsResponse: unknown;
  summaryResponse: Record<string, unknown>;
  summaryEmptyResponse: unknown;
}
const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'fixtures', 'guard-orphan-feed-contract.json'), 'utf8'),
) as Fixture;

const BASE = 'http://api.test';
const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(res: Response | (() => Promise<Response>), hmacKey: string | null = 'test-key') {
  // Response 体只能读一次：多次调用时按 body 文本重建
  const replay = typeof res === 'function' ? null : res.clone();
  const fetchImpl = vi.fn(async () => (typeof res === 'function' ? res() : replay!.clone()));
  const client = createOrphanFeedClient({ baseUrl: BASE, hmacKey, fetchImpl: fetchImpl as unknown as typeof fetch });
  return { fetchImpl, client };
}

async function errorOf(p: Promise<unknown>): Promise<OrphanFeedError> {
  try {
    await p;
  } catch (e) {
    return e as OrphanFeedError;
  }
  throw new Error('expected rejection');
}

const summaryQ = { tenantId: 't1', afterId: 0, detectedSince: '2026-11-21T00:00:00Z' };

describe('orphan feed client', () => {
  it('refuses to call without key', async () => {
    const { fetchImpl, client } = setup(jsonRes(200, fixture.tenantsResponse), null);
    const err = await errorOf(client.tenants({ detectedSince: 'x' }));
    expect(err).toBeInstanceOf(OrphanFeedError);
    expect([err.status, err.code]).toEqual([0, 'hmac_not_configured']);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('tenants posts signed body', async () => {
    const { fetchImpl, client } = setup(jsonRes(200, fixture.tenantsResponse));
    await client.tenants(fixture.tenantsRequest);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/internal/guard/orphan-feed/tenants`);
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h['X-Aster-Timestamp']).toMatch(/^\d+$/);
    expect(h['X-Aster-Nonce']).toBeTruthy();
    expect(h['X-Aster-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(h['Content-Type']).toBe('application/json');
    expect(h['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(JSON.parse(init.body as string)).toEqual(fixture.tenantsRequest);
  });

  it('omits afterTenant / limit when not given, sends them when given', async () => {
    const { fetchImpl, client } = setup(jsonRes(200, fixture.tenantsResponse));
    await client.tenants({ detectedSince: 'd', afterTenant: undefined, limit: undefined });
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ detectedSince: 'd' });
    await client.tenants({ detectedSince: 'd', afterTenant: 'a', limit: 10 });
    expect(JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      detectedSince: 'd',
      afterTenant: 'a',
      limit: 10,
    });
  });

  it('summary posts to the summary endpoint', async () => {
    const { fetchImpl, client } = setup(jsonRes(200, fixture.summaryResponse));
    await client.summary(fixture.summaryRequest);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/internal/guard/orphan-feed/summary`);
    expect(JSON.parse(init.body as string)).toEqual(fixture.summaryRequest);
  });

  it('parses contract fixture', async () => {
    expect(await setup(jsonRes(200, fixture.summaryResponse)).client.summary(summaryQ)).toEqual(fixture.summaryResponse);
    expect(await setup(jsonRes(200, fixture.summaryEmptyResponse)).client.summary(summaryQ)).toEqual(
      fixture.summaryEmptyResponse,
    );
    expect(await setup(jsonRes(200, fixture.tenantsResponse)).client.tenants({ detectedSince: 'd' })).toEqual(
      fixture.tenantsResponse,
    );
  });

  it('parses a tenants page with next', async () => {
    const page = { items: [{ tenantId: 'a', maxId: 3 }], next: 'a' };
    expect(await setup(jsonRes(200, page)).client.tenants({ detectedSince: 'd' })).toEqual(page);
  });

  it.each([
    ['maxId as string', { ...fixture.summaryResponse, maxId: '1' }],
    ['negative runId', { ...fixture.summaryResponse, runIds: [-1] }],
    ['fractional total', { ...fixture.summaryResponse, total: 1.5 }],
    ['fractional byKind', { ...fixture.summaryResponse, byKind: { x: 1.5 } }],
    ['empty tenantId', { ...fixture.summaryResponse, tenantId: '' }],
    ['bad firstDetectedAt', { ...fixture.summaryResponse, firstDetectedAt: 'not-a-date' }],
    ['non-string lastDetectedAt', { ...fixture.summaryResponse, lastDetectedAt: 5 }],
    ['null body', null],
  ])('malformed summary throws: %s', async (_n, body) => {
    const err = await errorOf(setup(jsonRes(200, body)).client.summary(summaryQ));
    expect([err.status, err.code]).toEqual([200, 'malformed_response']);
  });

  it.each([
    ['missing items', {}],
    ['item maxId string', { items: [{ tenantId: 'a', maxId: '1' }] }],
    ['item empty tenantId', { items: [{ tenantId: '', maxId: 1 }] }],
    ['next not string', { items: [], next: 3 }],
  ])('malformed tenants throws: %s', async (_n, body) => {
    const err = await errorOf(setup(jsonRes(200, body)).client.tenants({ detectedSince: 'd' }));
    expect([err.status, err.code]).toEqual([200, 'malformed_response']);
  });

  it('non-JSON 200 body is malformed_response', async () => {
    const err = await errorOf(setup(new Response('ok', { status: 200 })).client.summary(summaryQ));
    expect([err.status, err.code]).toEqual([200, 'malformed_response']);
  });

  it('maps http errors', async () => {
    let err = await errorOf(setup(jsonRes(403, { error: 'hmac_not_configured' })).client.tenants({ detectedSince: 'd' }));
    expect([err.status, err.code]).toEqual([403, 'hmac_not_configured']);
    err = await errorOf(setup(jsonRes(400, { error: 'invalid_query' })).client.tenants({ detectedSince: 'd' }));
    expect([err.status, err.code]).toEqual([400, 'invalid_query']);
  });

  it('error bodies are parsed defensively', async () => {
    const cases: [Response, string][] = [
      [new Response('Unauthorized', { status: 401 }), 'http_401'],
      [jsonRes(500, { error: 5 }), 'http_500'],
      [jsonRes(502, { message: 'x' }), 'http_502'],
      [jsonRes(503, null), 'http_503'],
    ];
    for (const [res, code] of cases) {
      const err = await errorOf(setup(res).client.tenants({ detectedSince: 'd' }));
      expect(err.code).toBe(code);
    }
  });

  it('fetch rejection and timeout map to unreachable', async () => {
    let err = await errorOf(
      setup(() => Promise.reject(new TypeError('fetch failed'))).client.tenants({ detectedSince: 'd' }),
    );
    expect([err.status, err.code]).toEqual([0, 'unreachable']);

    const fetchImpl = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(init.signal!.reason));
        }),
    );
    const client = createOrphanFeedClient({
      baseUrl: BASE,
      hmacKey: 'k',
      timeoutMs: 20,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    err = await errorOf(client.summary(summaryQ));
    expect([err.status, err.code]).toEqual([0, 'unreachable']);
  });
});

describe('orphan feed client base URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function calledUrl(): Promise<string> {
    const fetchImpl = vi.fn(async () => jsonRes(200, fixture.tenantsResponse));
    const client = createOrphanFeedClient({ hmacKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.tenants(fixture.tenantsRequest);
    return (fetchImpl.mock.calls[0] as unknown as [string])[0];
  }

  it('prefers ASTER_API_INTERNAL_URL', async () => {
    vi.stubEnv('ASTER_API_INTERNAL_URL', 'http://internal.test');
    vi.stubEnv('ASTER_POLICY_API_INTERNAL_URL', 'http://policy-internal.test');
    expect(await calledUrl()).toBe('http://internal.test/api/internal/guard/orphan-feed/tenants');
  });

  it('falls back to the policy API URLs the rest of cloud uses', async () => {
    vi.stubEnv('ASTER_API_INTERNAL_URL', '');
    vi.stubEnv('ASTER_POLICY_API_INTERNAL_URL', '');
    vi.stubEnv('NEXT_PUBLIC_ASTER_POLICY_API_URL', 'http://public-policy.test');
    expect(await calledUrl()).toBe('http://public-policy.test/api/internal/guard/orphan-feed/tenants');
  });

  it('never falls back to the in-cluster host when nothing is configured', async () => {
    vi.stubEnv('ASTER_API_INTERNAL_URL', '');
    vi.stubEnv('ASTER_POLICY_API_INTERNAL_URL', '');
    vi.stubEnv('NEXT_PUBLIC_ASTER_POLICY_API_URL', '');
    const url = await calledUrl();
    expect(url).not.toContain('aster-api:8080');
    // 测试进程回落到本机 discard 端口；生产进程回落到 PRODUCTION_POLICY_API_URL（见 policy-api-url.test）
    expect(url).toBe('http://127.0.0.1:9/api/internal/guard/orphan-feed/tenants');
  });
});
