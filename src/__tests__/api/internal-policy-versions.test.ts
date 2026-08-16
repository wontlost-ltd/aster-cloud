import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 策略版本源码拉取端点（What-If 重放用）。
 *
 * ★这是个**内部端点**，返回的是**用户策略源码**——用户资产。
 * 故重点不是「查得对不对」，而是三道边界：
 *   1. 无共享密钥 → 503（fail-closed，不是放行）
 *   2. 验签失败 → 401
 *   3. 查询**必须**按 userId 过滤——租户隔离不是可选项
 *
 * 背景：aster-api 原本在自己库里找目标版本，但那张表是执行期编译缓存
 * （id 为 bigint 自增），与本库的 PolicyVersion（UUID）不是同一批数据，
 * 导致 UI 发起的 What-If **从未成功过**。改由本端点提供源码。
 */

const verifyInternalSignature = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-signing', () => ({ verifyInternalSignature }));

const captured = vi.hoisted(() => ({ where: undefined as unknown }));
const rows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('@/lib/prisma', () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (w: unknown) => {
      captured.where = w;
      return chain;
    },
    limit: () => Promise.resolve(rows.value),
  };
  return {
    db: { select: () => chain },
    policyVersions: new Proxy({}, { get: (_t, p) => `policyVersions.${String(p)}` }),
    policies: new Proxy({}, { get: (_t, p) => `policies.${String(p)}` }),
  };
});

vi.mock('drizzle-orm', () => ({
  and: (...xs: unknown[]) => ({ op: 'and', xs: xs.filter(Boolean) }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

const { GET } = await import('@/app/api/internal/policy-versions/route');

const URL_OK =
  'https://x.test/api/internal/policy-versions?versionId=v-uuid&userId=u1';

function req(url = URL_OK) {
  return new Request(url);
}

describe('内部端点：策略版本源码', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.where = undefined;
    rows.value = [];
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'k';
    verifyInternalSignature.mockResolvedValue({ ok: true });
  });

  it('★没有共享密钥 → 503，绝不放行', async () => {
    delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    const res = await GET(req());
    expect(res.status).toBe(503);
  });

  it('★验签失败 → 401', async () => {
    verifyInternalSignature.mockResolvedValue({ ok: false, reason: 'bad_sig' });
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('★缺 userId → 400（不能"忘了传就拿到全量"）', async () => {
    const res = await GET(
      req('https://x.test/api/internal/policy-versions?versionId=v-uuid'),
    );
    expect(res.status).toBe(400);
  });

  it('缺 versionId → 400', async () => {
    const res = await GET(
      req('https://x.test/api/internal/policy-versions?userId=u1'),
    );
    expect(res.status).toBe(400);
  });

  it('★查询条件必须同时含 versionId 与 userId（租户隔离）', async () => {
    rows.value = [{ id: 'v-uuid', policyId: 'p1', version: 2, content: 'Module x.' }];
    await GET(req());

    const json = JSON.stringify(captured.where);
    expect(json, '查询未按 versionId 过滤').toContain('policyVersions.id');
    expect(json, '查询未按 userId 过滤 → 可跨租户读取他人源码').toContain(
      'policies.userId',
    );
    expect(json).toContain('u1');
  });

  it('命中时返回源码', async () => {
    rows.value = [{ id: 'v-uuid', policyId: 'p1', version: 2, content: 'Module x.' }];
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      versionId: 'v-uuid',
      policyId: 'p1',
      version: 2,
      content: 'Module x.',
    });
  });

  it('★查不到 → 404，且不区分"不存在"与"不属于你"', async () => {
    rows.value = [];
    const res = await GET(req());
    expect(res.status).toBe(404);
    // 错误体不得泄露该 id 是否存在——否则成了可探测的存在性信号。
    expect(await res.json()).toEqual({ error: 'version_not_found' });
  });
});
