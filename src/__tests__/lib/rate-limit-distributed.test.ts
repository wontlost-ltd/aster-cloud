// 分布式速率限制测试（审计 #168）。
//
// 钉住：①KV 可用时全局固定窗口计数（到上限拒）②窗口滚动后重置 ③KV 不可用 → 回退内存限流
// ④KV 读失败 → fail-open（不因限流基础设施抖动拒合法用户）⑤remaining/resetAt 正确。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock getCloudflareContext（getKV 用它取 env.CACHE）。默认无 KV → 走内存回退分支；
// 需要 KV 的用例里覆盖为返回带 CACHE 的 env。
const mockGetCloudflareContext = vi.fn(async () => ({ env: {} as { CACHE?: unknown } }));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: mockGetCloudflareContext,
}));

import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';
import { resetRateLimit } from '@/lib/rate-limit';

/**
 * 内存 KV mock（模拟 Cloudflare KVNamespace 的 get/put）。
 *
 * ★put 必须与真实 KV 一样拒绝 expirationTtl < 60（官方文档：The minimum value is 60）。
 * 曾经 mock 接受任意 TTL：生产上 put 恒抛错、静默回退内存限流，而内存限流计数结果相同，
 * 测试照样全绿（#477）。
 */
function makeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      if (opts?.expirationTtl !== undefined && opts.expirationTtl < 60) {
        throw new Error(`KV PUT failed: 400 Invalid expiration_ttl of ${opts.expirationTtl}. Expiration TTL must be at least 60.`);
      }
      store.set(k, v);
    }),
  };
}

/** 计数确实写进了 KV（而不是静默回退到内存限流）。 */
const kvCount = (kv: ReturnType<typeof makeKv>) => [...kv.store.values()].map(Number);

const CFG = { windowMs: 60_000, maxRequests: 3 };

describe('checkRateLimitDistributed (审计 #168)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCloudflareContext.mockResolvedValue({ env: {} });
  });
  afterEach(() => {
    resetRateLimit('u1'); // 清内存回退状态，避免测试间串扰
  });

  it('KV 可用：固定窗口计数，到上限即拒（全局，跨调用共享）', async () => {
    const kv = makeKv();
    mockGetCloudflareContext.mockResolvedValue({ env: { CACHE: kv } });
    const now = 1_000_000;

    const r1 = await checkRateLimitDistributed('u1', CFG, now);
    await checkRateLimitDistributed('u1', CFG, now);
    const r3 = await checkRateLimitDistributed('u1', CFG, now);
    const r4 = await checkRateLimitDistributed('u1', CFG, now);

    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
    expect(r4.allowed).toBe(false); // 第 4 次超上限 3
    expect(r4.retryAfterSeconds).toBeGreaterThan(0);
    expect(kvCount(kv)).toEqual([3]);
  });

  it('★60s 窗口内任意时刻写入的 TTL 都满足 KV 下限 60s，计数落在 KV（#477）', async () => {
    const windowStart = 60_000 * 1_000;
    // 窗口起点、中段、最后 1 秒——旧实现只有起点后约 1 秒内 TTL ≥ 60
    for (const offset of [0, 1_000, 30_000, 59_000, 59_999]) {
      const kv = makeKv();
      mockGetCloudflareContext.mockResolvedValue({ env: { CACHE: kv } });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = await checkRateLimitDistributed(`ttl-${offset}`, CFG, windowStart + offset);
      expect(r.allowed).toBe(true);
      expect(kvCount(kv), `offset ${offset}`).toEqual([1]);
      expect(kv.put.mock.calls[0][2]?.expirationTtl).toBeGreaterThanOrEqual(60);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
      resetRateLimit(`ttl-${offset}`);
    }
  });

  it('长窗口（1 小时）的 TTL 仍覆盖到窗口结束', async () => {
    const kv = makeKv();
    mockGetCloudflareContext.mockResolvedValue({ env: { CACHE: kv } });
    const hour = { windowMs: 3_600_000, maxRequests: 3 };
    await checkRateLimitDistributed('u1', hour, 3_600_000 * 10 + 1_000);
    expect(kv.put.mock.calls[0][2]?.expirationTtl).toBeGreaterThanOrEqual(3_599);
  });

  it('KV 可用：窗口滚动后计数重置（新窗口 key）', async () => {
    const kv = makeKv();
    mockGetCloudflareContext.mockResolvedValue({ env: { CACHE: kv } });
    const w1 = 1_000_000;
    await checkRateLimitDistributed('u1', CFG, w1);
    await checkRateLimitDistributed('u1', CFG, w1);
    await checkRateLimitDistributed('u1', CFG, w1);
    expect((await checkRateLimitDistributed('u1', CFG, w1)).allowed).toBe(false);

    // 跨到下一个窗口（+windowMs）→ 新 key → 重新放行
    const w2 = w1 + CFG.windowMs;
    expect((await checkRateLimitDistributed('u1', CFG, w2)).allowed).toBe(true);
  });

  it('KV 不可用（非 Cloudflare）→ 回退内存限流（仍能限流）', async () => {
    mockGetCloudflareContext.mockRejectedValue(new Error('not on cloudflare'));
    const r1 = await checkRateLimitDistributed('u1', CFG);
    await checkRateLimitDistributed('u1', CFG);
    await checkRateLimitDistributed('u1', CFG);
    const r4 = await checkRateLimitDistributed('u1', CFG);
    expect(r1.allowed).toBe(true);
    expect(r4.allowed).toBe(false); // 内存限流同样在第 4 次拒
  });

  it('KV 读失败 → fail-open 到内存限流（不拒合法用户）', async () => {
    const kv = makeKv();
    kv.get.mockRejectedValue(new Error('kv read blip'));
    mockGetCloudflareContext.mockResolvedValue({ env: { CACHE: kv } });
    const r = await checkRateLimitDistributed('u1', CFG);
    expect(r.allowed).toBe(true); // 首次经内存回退放行，不因 KV 抖动拒绝
  });

  it('★KV 可读不可写 → 回退内存限流（仍限流，不是 fail-open to nothing）', async () => {
    // Codex 复审 High：put 失败若只放行不计数 = 攻击者打挂 KV 写即近乎无限流。
    // 修复后：写失败进 catch → 回退内存 checkRateLimit，仍在第 4 次拒。
    const kv = makeKv();
    kv.put.mockRejectedValue(new Error('kv write quota exceeded'));
    mockGetCloudflareContext.mockResolvedValue({ env: { CACHE: kv } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r1 = await checkRateLimitDistributed('u1', CFG);
    // 回退必须留痕：曾经静默回退，KV 写入从未成功也无人察觉（#477）
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[rate-limit]'), expect.any(Error));
    warn.mockRestore();
    await checkRateLimitDistributed('u1', CFG);
    await checkRateLimitDistributed('u1', CFG);
    const r4 = await checkRateLimitDistributed('u1', CFG);
    expect(r1.allowed).toBe(true);
    expect(r4.allowed).toBe(false); // 内存兜底仍在第 4 次拒，非无限流
  });

  it('resetAt 对齐窗口边界', async () => {
    const kv = makeKv();
    mockGetCloudflareContext.mockResolvedValue({ env: { CACHE: kv } });
    const now = 1_234_567; // 非边界
    const r = await checkRateLimitDistributed('u1', CFG, now);
    const expectedWindowStart = Math.floor(now / CFG.windowMs) * CFG.windowMs;
    expect(r.resetAt).toBe(expectedWindowStart + CFG.windowMs);
  });
});
