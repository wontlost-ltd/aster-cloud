import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// guard 客户端（ADR 0042 §4.4）：/api/v1/guard/* 走内部 HMAC v3 签名（真实签名器，不 mock），
// 带 X-Internal-Caller 与 X-User-Business-Roles；非 2xx 映射为 PolicyApiError(code=error, details=错误体)。

vi.mock('@/lib/trace-context', () => ({
  newTraceContext: () => ({ traceparent: '00-abc-def-01' }),
}));

import { createHash, createHmac } from 'node:crypto';
import {
  PolicyApiClient, PolicyApiError, GUARD_TIMEOUT_MS, createPolicyApiClient, isFactIssuerSegment,
} from '@/services/policy/policy-api';

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

  it('审批输入：GET /input、POST /input/reveal（空对象体）与 approve/reject 透传快照哈希（ADR 0042 §12 D10）', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, { approvalId: 'a-1', decisionId: 'd-1', status: 'unavailable', revealed: false, revealedByMe: false }),
    );
    const client = new PolicyApiClient('team1', 'u-1', 'member', 'unknown', ['DPO']);

    await expect(client.getGuardApprovalInput('a-1')).resolves.toMatchObject({ status: 'unavailable' });
    expect(lastCall().url).toMatch(/\/api\/v1\/guard\/approvals\/a-1\/input$/);
    expect(lastCall().init.method).toBe('GET');
    expect(lastCall().headers['X-Internal-Signature']).toBe(
      recomputeV3('GET', lastCall().url, undefined, lastCall().headers),
    );

    await client.revealGuardApprovalInput('a-1');
    expect(lastCall().url).toMatch(/\/api\/v1\/guard\/approvals\/a-1\/input\/reveal$/);
    expect(lastCall().init.method).toBe('POST');
    expect(JSON.parse(lastCall().init.body as string)).toEqual({});

    const hash = 'a'.repeat(64);
    await client.approveGuard('a-1', undefined, hash);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ inputSnapshotHash: hash });
    await client.rejectGuard('a-1', 'no', hash);
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ comment: 'no', inputSnapshotHash: hash });

    fetchMock.mockClear();
    await expect(client.getGuardApprovalInput('../x')).rejects.toMatchObject({ statusCode: 400, code: 'invalid_id' });
    expect(fetchMock).not.toHaveBeenCalled();
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

// 签发方管理（ADR 0040 §11 D3）：/api/v1/guard/fact-issuers 同样走内部 HMAC v3；issuer / kid 只出现在 path 段，
// cloud 本地按 isFactIssuerSegment 拒绝会被编码或被 URL 规范化改写的段，使签名路径与 api 解码后的路径一致。
describe('PolicyApiClient 签发方方法', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const prevKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  const prevHmac = process.env.ASTER_HMAC_SECRET;
  const ISSUER = {
    alg: 'Ed25519', createdAt: '2026-11-13T00:00:00Z', createdBy: 'u-1', enabled: true,
    issuer: 'idp.example.com', kid: '2026-11', publicKey: 'A'.repeat(43),
  };

  beforeEach(() => {
    process.env.ASTER_PLAN_GATE_HMAC_KEY = INTERNAL_KEY;
    delete process.env.ASTER_HMAC_SECRET;
    fetchMock = vi.fn(async () => jsonResponse(200, { issuers: [ISSUER] }));
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

  it('listFactIssuersSignsPathname：GET /api/v1/guard/fact-issuers，带内部签名且签名可重算', async () => {
    const client = new PolicyApiClient('team1', 'u-1', 'member', 'unknown', ['DPO']);
    await expect(client.listFactIssuers()).resolves.toEqual({ issuers: [ISSUER] });

    const { url, init, headers } = lastCall();
    expect(new URL(url).pathname).toBe('/api/v1/guard/fact-issuers');
    expect(new URL(url).search).toBe('');
    expect(init.method).toBe('GET');
    expect(headers['X-Internal-Caller']).toBe('cloud-bff');
    expect(headers['X-Internal-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['X-Internal-Signature']).toBe(recomputeV3('GET', url, undefined, headers));
    expect(headers['X-Tenant-Id']).toBe('team1');
  });

  it('putFactIssuerEncodesSegments：issuer / kid 原样出现在 path，请求体为 GuardFactIssuerPut', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, ISSUER));
    const client = new PolicyApiClient('team1', 'u-1', 'member', 'unknown', []);
    const body = { publicKey: ISSUER.publicKey, notAfter: '2027-01-01T00:00:00Z' };
    await expect(client.putFactIssuer('idp.example.com', '2026-11', body)).resolves.toEqual(ISSUER);

    const { url, init, headers } = lastCall();
    expect(new URL(url).pathname).toBe('/api/v1/guard/fact-issuers/idp.example.com/2026-11');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect(headers['X-Internal-Signature']).toBe(recomputeV3('PUT', url, init.body as string, headers));

    await client.putFactIssuer('aster-cloud', 'k~1', { publicKey: ISSUER.publicKey });
    expect(new URL(lastCall().url).pathname).toBe('/api/v1/guard/fact-issuers/aster-cloud/k~1');
  });

  it('issuerSegmentValidation：会被编码 / 规范化或超长的段 → 本地 400 invalid_issuer_name，不发请求', async () => {
    const client = new PolicyApiClient('t', 'u', 'member', 'unknown', []);
    const put = { publicKey: ISSUER.publicKey };
    const badIssuers = ['..', '.', 'a b', 'a%2f', 'a#b', 'a/b', '', 'é', 'x'.repeat(256)];
    for (const bad of badIssuers) {
      const err = await client.putFactIssuer(bad, 'k1', put).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PolicyApiError);
      expect((err as PolicyApiError).statusCode).toBe(400);
      expect((err as PolicyApiError).code).toBe('invalid_issuer_name');
    }
    for (const bad of ['..', 'a b', 'x'.repeat(65)]) {
      await expect(client.deleteFactIssuer('idp', bad)).rejects.toMatchObject({ statusCode: 400, code: 'invalid_issuer_name' });
    }
    expect(fetchMock).not.toHaveBeenCalled();

    expect(isFactIssuerSegment('idp.example.com', 255)).toBe(true);
    expect(isFactIssuerSegment('k~1', 64)).toBe(true);
    expect(isFactIssuerSegment('x'.repeat(255), 255)).toBe(true);
    expect(isFactIssuerSegment('x'.repeat(65), 64)).toBe(false);
    expect(isFactIssuerSegment('...', 64)).toBe(true);

    fetchMock.mockImplementation(async () => jsonResponse(200, ISSUER));
    await client.putFactIssuer('idp.example.com', 'k~1', put);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('deleteFactIssuer204ReturnsVoid：204 无体 resolve undefined，不因 json() 失败报错', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true, status: 204, statusText: 'No Content',
      json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
    }));
    const client = new PolicyApiClient('team1', 'u-1', 'member', 'unknown', []);
    await expect(client.deleteFactIssuer('idp.example.com', '2026-11')).resolves.toBeUndefined();

    const { url, init, headers } = lastCall();
    expect(init.method).toBe('DELETE');
    expect(new URL(url).pathname).toBe('/api/v1/guard/fact-issuers/idp.example.com/2026-11');
    expect(headers['X-Internal-Signature']).toBe(recomputeV3('DELETE', url, undefined, headers));
  });

  it('putConflictSurfacesCode：409 issuer_key_conflict → PolicyApiError.code；404 空体 → statusCode 404', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(409, { error: 'issuer_key_conflict', message: '该 kid 已登记不同的公钥；换钥请使用新的 kid' }),
    );
    const client = new PolicyApiClient('t', 'u', 'member', 'unknown', []);
    const err = await client.putFactIssuer('idp', 'k1', { publicKey: ISSUER.publicKey }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyApiError);
    expect((err as PolicyApiError).statusCode).toBe(409);
    expect((err as PolicyApiError).code).toBe('issuer_key_conflict');

    fetchMock.mockImplementation(async () => ({
      ok: false, status: 404, statusText: 'Not Found',
      json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
    }));
    await expect(client.deleteFactIssuer('idp', 'k1')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('签发方调用使用 guard 专用 8 s 超时', async () => {
    const timerSpy = vi.spyOn(globalThis, 'setTimeout');
    const client = new PolicyApiClient('t', 'u', 'member', 'unknown', []);
    await client.listFactIssuers();
    expect(timerSpy).toHaveBeenCalledWith(expect.any(Function), GUARD_TIMEOUT_MS);
  });
});
