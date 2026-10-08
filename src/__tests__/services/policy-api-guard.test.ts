import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// guard 客户端（ADR 0042 §4.4）：/api/v1/guard/* 走内部 HMAC v3 签名（真实签名器，不 mock），
// 带 X-Internal-Caller 与 X-User-Business-Roles；非 2xx 映射为 PolicyApiError(code=error, details=错误体)。

vi.mock('@/lib/trace-context', () => ({
  newTraceContext: () => ({ traceparent: '00-abc-def-01' }),
}));

import { PolicyApiClient, PolicyApiError, createPolicyApiClient } from '@/services/policy/policy-api';

type FetchCall = [string, RequestInit];

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    json: async () => body,
  };
}

describe('PolicyApiClient guard 方法', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const prevKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  const prevHmac = process.env.ASTER_HMAC_SECRET;

  beforeEach(() => {
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'test-internal-key';
    delete process.env.ASTER_HMAC_SECRET;
    fetchMock = vi.fn(async () => jsonResponse(200, { items: [], page: 0, size: 50 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = prevKey;
    if (prevHmac === undefined) delete process.env.ASTER_HMAC_SECRET;
    else process.env.ASTER_HMAC_SECRET = prevHmac;
  });

  function lastCall(): { url: string; init: RequestInit; headers: Record<string, string> } {
    const [url, init] = fetchMock.mock.calls.at(-1) as FetchCall;
    return { url, init, headers: init.headers as Record<string, string> };
  }

  it('listGuardApprovals：URL 含默认分页，带内部签名与业务角色头', async () => {
    const client = new PolicyApiClient('team1', 'u-1', 'member', 'unknown', ['DPO', 'CISO']);
    const page = await client.listGuardApprovals('PENDING');

    expect(page).toEqual({ items: [], page: 0, size: 50 });
    const { url, init, headers } = lastCall();
    expect(url).toMatch(/\/api\/v1\/guard\/approvals\?status=PENDING&page=0&size=50$/);
    expect(init.method).toBe('GET');
    expect(headers['X-Internal-Caller']).toBe('cloud-bff');
    expect(headers['X-Internal-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['X-User-Business-Roles']).toBe('CISO,DPO');
    expect(headers['X-User-Id']).toBe('u-1');
  });

  it('createPolicyApiClient 第 5 参透传业务角色；缺省不发角色头', async () => {
    await createPolicyApiClient('t', 'u', 'member', undefined, ['CISO']).getGuardDecision('d-1');
    expect(lastCall().url).toMatch(/\/api\/v1\/guard\/decisions\/d-1$/);
    expect(lastCall().headers['X-User-Business-Roles']).toBe('CISO');

    await createPolicyApiClient('t', 'u').getGuardDecision('d-1');
    expect(lastCall().headers['X-Internal-Caller']).toBe('cloud-bff');
    expect(lastCall().headers).not.toHaveProperty('X-User-Business-Roles');
  });

  it('guardFromEvidence / approveGuard / rejectGuard：方法、路径与请求体', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { decisionId: 'd-1' }));
    const client = new PolicyApiClient('t', 'u', 'member', 'unknown', ['CISO']);
    const action = { principal: { id: 'p-1' }, action: { name: 'refund' } };

    await expect(client.guardFromEvidence({ correlationId: 'c-1', action })).resolves.toEqual({ decisionId: 'd-1' });
    expect(lastCall().url).toMatch(/\/api\/v1\/guard\/decisions\/from-evidence$/);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ correlationId: 'c-1', action });

    await client.approveGuard('a-1', 'ok');
    expect(lastCall().url).toMatch(/\/api\/v1\/guard\/approvals\/a-1\/approve$/);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ comment: 'ok' });

    await client.rejectGuard('a-1', 'no');
    expect(lastCall().url).toMatch(/\/api\/v1\/guard\/approvals\/a-1\/reject$/);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ comment: 'no' });
  });

  it('403 role_mismatch → PolicyApiError.code 取 error 字段，details 保留 verifiedRoles', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(403, { error: 'role_mismatch', message: 'role required', verifiedRoles: [] }),
    );
    const client = new PolicyApiClient('t', 'u', 'member', 'unknown', []);

    const err = await client.approveGuard('a-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyApiError);
    const pe = err as PolicyApiError;
    expect(pe.statusCode).toBe(403);
    expect(pe.code).toBe('role_mismatch');
    expect(pe.message).toBe('role required');
    expect(pe.details?.verifiedRoles).toEqual([]);
  });
});
