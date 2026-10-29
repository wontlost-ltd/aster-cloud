import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

/**
 * POST /api/internal/policies/[id]/invalidate-cache（#649）。
 * resolver 迁移 Job 跑在 k8s 里拿不到 Workers KV，经此端点让 Worker 删除策略执行缓存。
 */

const { mockInvalidate } = vi.hoisted(() => ({ mockInvalidate: vi.fn(async () => undefined) }));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: mockInvalidate }));
// 重放拒绝由 internal-signature 单测与真 Postgres 集成测试覆盖；本文件只关心路由行为。
vi.mock('@/services/security/nonce-service', () => ({ claimNonce: vi.fn(async () => true) }));

const originalKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
const TEST_KEY = 'test-shared-hmac-key';
const PATH = '/api/internal/policies/pol-1/invalidate-cache';

function signedHeaders(key: string, path = PATH): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = `n-${Math.random().toString(36).slice(2)}`;
  const bodyHash = createHash('sha256').update('').digest('hex');
  const sig = createHmac('sha256', key).update(`POST\n${path}\n${ts}\n${nonce}\n${bodyHash}`).digest('hex');
  return { 'X-Aster-Timestamp': ts, 'X-Aster-Nonce': nonce, 'X-Internal-Signature': sig };
}

async function call(headers: Record<string, string>, id = 'pol-1') {
  const { POST } = await import('@/app/api/internal/policies/[id]/invalidate-cache/route');
  return POST(new Request(`http://cloud.test/api/internal/policies/${id}/invalidate-cache`, { method: 'POST', headers }), {
    params: Promise.resolve({ id }),
  });
}

describe('POST /api/internal/policies/[id]/invalidate-cache', () => {
  beforeEach(() => {
    vi.resetModules();
    mockInvalidate.mockClear();
    process.env.ASTER_PLAN_GATE_HMAC_KEY = TEST_KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
  });

  it('签名有效 → 失效该策略的缓存并返回 200', async () => {
    const res = await call(signedHeaders(TEST_KEY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ invalidated: true });
    expect(mockInvalidate).toHaveBeenCalledWith('pol-1');
  });

  it('签名密钥不符 → 401，不触碰缓存', async () => {
    const res = await call(signedHeaders('wrong-key'));
    expect(res.status).toBe(401);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('缺签名头 → 401', async () => {
    const res = await call({});
    expect(res.status).toBe(401);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('签名绑定路径：为另一策略签的请求不能失效本策略', async () => {
    const res = await call(signedHeaders(TEST_KEY, '/api/internal/policies/other/invalidate-cache'));
    expect(res.status).toBe(401);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('未配置共享密钥 → 503（fail-closed）', async () => {
    delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    const res = await call(signedHeaders(TEST_KEY));
    expect(res.status).toBe(503);
    expect(mockInvalidate).not.toHaveBeenCalled();
  });
});
