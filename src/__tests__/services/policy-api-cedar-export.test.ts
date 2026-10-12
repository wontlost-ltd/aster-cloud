import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Cedar 导出客户端（ADR 0047 §6）：走 request() 的内部签名；503 忙时错误携带错误体与 Retry-After。

vi.mock('@/lib/trace-context', () => ({
  newTraceContext: () => ({ traceparent: '00-abc-def-01' }),
}));

import { PolicyApiClient, PolicyApiError } from '@/services/policy/policy-api';

describe('PolicyApiClient.exportCedar', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const prevKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;

  beforeEach(() => {
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'test-internal-key';
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ exportable: false, diagnostics: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = prevKey;
  });

  it('POSTs the request body to /api/v1/policies/export/cedar with internal signature', async () => {
    const client = new PolicyApiClient('t1', 'u1');
    const req = { source: 'Module m.', locale: 'en-US', aliasSet: null, claimedRef: { cloudPolicyId: 'p1', version: '2' } };
    await client.exportCedar(req);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v1/policies/export/cedar');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(req);
    expect((init.headers as Record<string, string>)['X-Internal-Signature']).toBeTruthy();
  });

  it('503 busy surfaces code, body and Retry-After on PolicyApiError', async () => {
    const body = { error: 'cedar_export_busy', message: 'busy', concurrencyLimit: 2 };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 503, headers: { 'Retry-After': '1' } }));
    const err = await new PolicyApiClient('t1', 'u1')
      .exportCedar({ source: 'Module m.', locale: 'en-US', aliasSet: null })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PolicyApiError);
    expect(err).toMatchObject({ statusCode: 503, code: 'cedar_export_busy', details: body, retryAfter: '1' });
  });
});
