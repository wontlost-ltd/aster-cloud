import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';

/**
 * /api/internal/apikey/verify 路由级回归：
 *  - keyHash 必须是 64 位 hex（非 hex/错长度 → 400，且不解析身份）
 *  - fail-closed：HMAC 密钥未配置 → 503（audit #168）；坏签名 → 401
 *  - 身份一律取自解析器（ADR 0015 §2），响应透传 tenantId/role/quotaOwnerId
 *
 * 输入校验用例携带合法签名以隔离校验逻辑。路由不再直接查库，只 mock 解析器。
 */

const { mockResolve } = vi.hoisted(() => ({ mockResolve: vi.fn() }));
vi.mock('@/lib/api-key-identity', () => ({ resolveApiKeyIdentity: mockResolve }));

const originalKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
const TEST_KEY = 'test-shared-hmac-key';
const PATH = '/api/internal/apikey/verify';

// ★v2 签名（绑定 nonce + bodyHash）。此前用 v1（method\npath\nts），
// 而 v1 已于 2026-08-01 默认关闭——它不绑 body/nonce，可在时钟窗内换 body 重放。
// 生产早已只发 v2（aster-api InternalCallSigner / cloud signInternalCallerHeaders），
// 这些用例是最后残留的 v1 调用方。
function signedHeaders(key: string, rawBody = ''): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = `n-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2)}`;
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const sig = createHmac('sha256', key)
    .update(`POST\n${PATH}\n${ts}\n${nonce}\n${bodyHash}`)
    .digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Aster-Timestamp': ts,
    'X-Aster-Nonce': nonce,
    'X-Internal-Signature': sig,
  };
}

function postKeyHash(body: unknown, headers?: Record<string, string>): Request {
  const raw = JSON.stringify(body);
  return new Request(`http://cloud.test${PATH}`, {
    method: 'POST',
    headers: headers ?? signedHeaders(TEST_KEY, raw),   // ★body 必须参与 v2 签名
    body: raw,
  });
}

describe('POST /api/internal/apikey/verify — keyHash hex 校验', () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolve.mockReset();
    process.env.ASTER_PLAN_GATE_HMAC_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('长度 64 但非 hex → 400，不解析身份', async () => {
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const res = await POST(postKeyHash({ keyHash: 'z'.repeat(64) }));
    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('长度不是 64 → 400，不解析身份', async () => {
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const res = await POST(postKeyHash({ keyHash: 'abc' }));
    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('keyHash 缺失 → 400', async () => {
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const res = await POST(postKeyHash({}));
    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('合法 64 hex → 交给解析器（命中 not_found 分支）', async () => {
    mockResolve.mockResolvedValue({ valid: false, reason: 'not_found' });
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const res = await POST(postKeyHash({ keyHash: 'a'.repeat(64) }));
    expect(res.status).toBe(200);
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockResolve).toHaveBeenCalledWith('a'.repeat(64));
    const body = await res.json();
    expect(body).toEqual({ valid: false, reason: 'not_found' });
  });
});

describe('成功路径（ADR 0015）', () => {
  const HASH = 'a'.repeat(64);

  beforeEach(() => {
    vi.resetModules();
    mockResolve.mockReset();
    process.env.ASTER_PLAN_GATE_HMAC_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
    vi.restoreAllMocks();
  });

  // 解析器 mock 取真实 ApiKeyIdentity 形状（含 teamId），同时钉住 teamId 不外泄到响应体
  it('个人 key：tenantId=userId、role=owner、quotaOwnerId=userId', async () => {
    mockResolve.mockResolvedValue({ valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', teamId: null, quotaOwnerId: 'u1', role: 'owner', plan: 'pro', subscriptionStatus: 'active' });
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const res = await POST(postKeyHash({ keyHash: HASH }));
    expect(await res.json()).toEqual({ valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', quotaOwnerId: 'u1', plan: 'pro', subscriptionStatus: 'active', role: 'owner' });
  });

  it('团队 key：tenantId=teamId、role=成员角色、quotaOwnerId=owner', async () => {
    mockResolve.mockResolvedValue({ valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', teamId: 't1', quotaOwnerId: 'owner', role: 'member', plan: 'team', subscriptionStatus: 'active' });
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const body = await (await POST(postKeyHash({ keyHash: HASH }))).json();
    expect(body).toEqual({ valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', quotaOwnerId: 'owner', plan: 'team', subscriptionStatus: 'active', role: 'member' });
  });

  it('membership_revoked / revoked 带 ISO 时间', async () => {
    mockResolve.mockResolvedValue({ valid: false, reason: 'membership_revoked' });
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    expect(await (await POST(postKeyHash({ keyHash: HASH }))).json()).toEqual({ valid: false, reason: 'membership_revoked' });
    const at = new Date('2026-01-01T00:00:00Z');
    mockResolve.mockResolvedValue({ valid: false, reason: 'revoked', revokedAt: at });
    expect(await (await POST(postKeyHash({ keyHash: HASH }))).json()).toEqual({ valid: false, reason: 'revoked', revokedAt: at.toISOString() });
  });

  it('expired 带 ISO expiredAt', async () => {
    const at = new Date('2020-01-01T00:00:00Z');
    mockResolve.mockResolvedValue({ valid: false, reason: 'expired', expiredAt: at });
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    expect(await (await POST(postKeyHash({ keyHash: HASH }))).json()).toEqual({ valid: false, reason: 'expired', expiredAt: at.toISOString() });
  });
});

describe('POST /api/internal/apikey/verify — fail-closed HMAC (audit #168)', () => {
  beforeEach(() => {
    vi.resetModules();
    mockResolve.mockReset();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('HMAC 密钥未配置 → 503，不查 DB', async () => {
    delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const res = await POST(postKeyHash({ keyHash: 'a'.repeat(64) }, { 'Content-Type': 'application/json' }));
    expect(res.status).toBe(503);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('缺少签名头 → 401', async () => {
    process.env.ASTER_PLAN_GATE_HMAC_KEY = TEST_KEY;
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const res = await POST(postKeyHash({ keyHash: 'a'.repeat(64) }, { 'Content-Type': 'application/json' }));
    expect(res.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('坏签名 → 401，不查 DB', async () => {
    process.env.ASTER_PLAN_GATE_HMAC_KEY = TEST_KEY;
    const bad = signedHeaders('wrong-key');
    const { POST } = await import('@/app/api/internal/apikey/verify/route');
    const res = await POST(postKeyHash({ keyHash: 'a'.repeat(64) }, bad));
    expect(res.status).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });
});
