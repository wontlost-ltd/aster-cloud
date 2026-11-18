import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// request() 抽出 send() 后（ADR 0059 P2 C1）既有 JSON 调用的行为不变：请求体与签名、204 无体、
// 非 JSON 错误体、错误体 code / error 回退、超时与网络异常的包装。

vi.mock('@/lib/trace-context', () => ({
  newTraceContext: () => ({ traceparent: '00-abc-def-01' }),
}));

import { PolicyApiClient, PolicyApiError } from '@/services/policy/policy-api';

describe('PolicyApiClient.request 回归', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const prevKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;

  beforeEach(() => {
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'test-internal-key';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = prevKey;
  });

  it('JSON 调用：请求体原样发送并带内部签名，响应按 JSON 返回', async () => {
    const body = { success: true, diagnostics: [] };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const req = { source: 'Module m.', locale: 'en-US' };
    await expect(new PolicyApiClient('t1', 'u1').compile(req as never)).resolves.toEqual(body);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v1/policies/compile');
    expect(JSON.parse(init.body as string)).toEqual(req);
    expect((init.headers as Record<string, string>)['X-Internal-Signature']).toBeTruthy();
  });

  it('204 无体：不读 JSON，返回 undefined', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(new PolicyApiClient('t1', 'u1').deleteFactIssuer('issuer', 'kid')).resolves.toBeUndefined();
  });

  it('非 JSON 错误体：按状态码给消息，code 为空', async () => {
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    const err = await new PolicyApiClient('t1', 'u1').compile({ source: 'x', locale: 'en-US' } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyApiError);
    expect(err).toMatchObject({ statusCode: 502, code: undefined, message: 'HTTP 502: Bad Gateway' });
  });

  it('错误体缺 code 时回退到 error 字段，并保留错误体', async () => {
    const body = { error: 'role_mismatch', message: 'nope' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 403 }));
    const err = await new PolicyApiClient('t1', 'u1').compile({ source: 'x', locale: 'en-US' } as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 403, code: 'role_mismatch', message: 'nope', details: body });
  });

  it('成功响应体不是 JSON：包装为 500 UNKNOWN', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    const err = await new PolicyApiClient('t1', 'u1').compile({ source: 'x', locale: 'en-US' } as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 500, code: 'UNKNOWN' });
  });

  it('网络异常：包装为 500 UNKNOWN', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const err = await new PolicyApiClient('t1', 'u1').compile({ source: 'x', locale: 'en-US' } as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 500, code: 'UNKNOWN', message: 'fetch failed' });
  });

  it('超时：408 TIMEOUT', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const err = await new PolicyApiClient('t1', 'u1').checkCedarExport({ source: 'x', locale: 'en-US' }, 5).catch((e: unknown) => e);
    expect(err).toMatchObject({ statusCode: 408, code: 'TIMEOUT' });
  });
});
