import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// guard 客户端（ADR 0042 §4.4）：/api/v1/guard/* 走内部 HMAC v3 签名（真实签名器，不 mock），
// 带 X-Internal-Caller 与 X-User-Business-Roles；非 2xx 映射为 PolicyApiError(code=error, details=错误体)。

vi.mock('@/lib/trace-context', () => ({
  newTraceContext: () => ({ traceparent: '00-abc-def-01' }),
}));

import { createHash, createHmac } from 'node:crypto';
import { PolicyApiClient, PolicyApiError, GUARD_TIMEOUT_MS, createPolicyApiClient } from '@/services/policy/policy-api';

const INTERNAL_KEY = 'test-internal-key';
const FIXED_MS = 1_760_000_000_123;
const FIXED_NONCE = 'cd'.repeat(16);

/** 以 node:crypto 独立重算 v3 签名：path/query 取自实际 fetch URL，身份取自实际发出的头。 */
function recomputeV3(method: string, url: string, body: string | undefined, headers: Record<string, string>): string {
  const u = new URL(url);
  const bodyHash = createHash('sha256').update(body ?? '').digest('hex');
  const canonical = [
    method, u.pathname, u.search.slice(1), headers['X-Aster-Timestamp'], headers['X-Aster-Nonce'], bodyHash,
    headers['X-Tenant-Id'], headers['X-User-Role'], headers['X-User-Id'], headers['X-User-Business-Roles'] ?? '',
  ].join('\n');
  return createHmac('sha256', INTERNAL_KEY).update(canonical).digest('hex');
}

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
    process.env.ASTER_PLAN_GATE_HMAC_KEY = INTERNAL_KEY;
    delete process.env.ASTER_HMAC_SECRET;
    fetchMock = vi.fn(async () => jsonResponse(200, { items: [], page: 0, size: 50 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it('签名按实际 fetch URL 的 path/query 与发出的 userId/角色重算一致（固定时间与 nonce）', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_MS);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
      (arr as unknown as Uint8Array).fill(0xcd);
      return arr;
    });
    const client = new PolicyApiClient('team1', 'u-1', 'member', 'unknown', ['DPO', 'CISO']);
    await client.listGuardApprovals('APPROVED', 2, 10);

    const { url, init, headers } = lastCall();
    expect(init.method).toBe('GET');
    expect(url).toMatch(/\?status=APPROVED&page=2&size=10$/);
    expect(headers['X-Aster-Timestamp']).toBe('1760000000');
    expect(headers['X-Aster-Nonce']).toBe(FIXED_NONCE);
    expect(headers['X-Internal-Signature']).toBe(recomputeV3('GET', url, undefined, headers));

    fetchMock.mockImplementation(async () => jsonResponse(200, { decisionId: 'd-1' }));
    await client.approveGuard('a-1', 'ok');
    const post = lastCall();
    expect(post.headers['X-Internal-Signature']).toBe(
      recomputeV3('POST', post.url, post.init.body as string, post.headers)
    );
    // 篡改 userId 后重算必然不同：证明 userId 确实签入
    expect(post.headers['X-Internal-Signature']).not.toBe(
      recomputeV3('POST', post.url, post.init.body as string, { ...post.headers, 'X-User-Id': 'u-2' })
    );
  });

  it('非法 guard 路径 id → 本地 400 invalid_id，不发请求', async () => {
    const client = new PolicyApiClient('t', 'u', 'member', 'unknown', []);
    for (const bad of ['a/b', 'a b', '', 'é', 'x'.repeat(65)]) {
      const err = await client.approveGuard(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PolicyApiError);
      expect((err as PolicyApiError).statusCode).toBe(400);
      expect((err as PolicyApiError).code).toBe('invalid_id');
    }
    await expect(client.getGuardDecision('../x')).rejects.toMatchObject({ statusCode: 400 });
    await expect(client.rejectGuard('a?b', 'no')).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();

    await client.getGuardDecision('0b9f2c1e-7d4a-4f5b-9c3e-1a2b3c4d5e6f');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('guard 调用使用专用 8 s 超时，超时中止映射为 408 TIMEOUT', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    fetchMock.mockImplementation(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const client = new PolicyApiClient('t', 'u', 'member', 'unknown', []);
    const err = await client.listGuardApprovals('PENDING').catch((e: unknown) => e);

    expect(GUARD_TIMEOUT_MS).toBe(8000);
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), GUARD_TIMEOUT_MS);
    expect(err).toBeInstanceOf(PolicyApiError);
    expect((err as PolicyApiError).statusCode).toBe(408);
    expect((err as PolicyApiError).code).toBe('TIMEOUT');
  });
});
