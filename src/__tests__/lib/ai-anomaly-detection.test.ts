import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSelect, mockUpdate, mockUpdateSet, mockUpdateWhere: _mockUpdateWhere, mockExecute } = vi.hoisted(() => {
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });
  const mockSelect = vi.fn();
  const mockExecute = vi.fn();
  return { mockSelect, mockUpdate, mockUpdateSet, mockUpdateWhere, mockExecute };
});

vi.mock('@/lib/prisma', () => ({
  db: {
    select: mockSelect,
    update: mockUpdate,
    execute: mockExecute,
  },
  users: { id: {} },
  aiUsageRecords: { userId: {}, promptHash: {}, createdAt: {}, usedByok: {}, status: {}, promptTokens: {}, completionTokens: {} },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { detectAndBan } from '@/lib/ai-anomaly-detection';

/** 把 db.select().from().where().groupBy().having() 链路设置成返回固定结果 */
function setupAggregateChain(results: unknown[]) {
  const mockHaving = vi.fn().mockResolvedValue(results);
  const mockGroupBy = vi.fn().mockReturnValue({ having: mockHaving });
  const mockWhere = vi.fn().mockReturnValue({ groupBy: mockGroupBy });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  return { from: mockFrom };
}

describe('detectAndBan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([]);
  });

  it('无异常时返回空 list 且不调用 update', async () => {
    // Signal 1 (repeats): 空
    // Signal 2 (heavyUsers): 空
    mockSelect.mockReturnValue(setupAggregateChain([]));
    mockExecute.mockResolvedValue([]);

    const signals = await detectAndBan();
    expect(signals).toEqual([]);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('Signal 1: 同 prompt 重复 ≥5 次 → 封禁 24h', async () => {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // Signal 1: 重复 prompt
        return setupAggregateChain([
          { userId: 'user-abuser', promptHash: 'hash1', c: 7 },
        ]);
      }
      // Signal 2: 高 token，空
      return setupAggregateChain([]);
    });
    mockExecute.mockResolvedValue([]);

    const signals = await detectAndBan();
    expect(signals.length).toBe(1);
    expect(signals[0].userId).toBe('user-abuser');
    expect(signals[0].reason).toContain('重复 7 次');

    // 验证 ban 时间 ≈ 24h
    const banDuration = signals[0].banUntil.getTime() - Date.now();
    expect(banDuration).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(banDuration).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);

    // 验证 update 被调用
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        aiBannedUntil: expect.any(Date),
        aiBanReason: expect.stringContaining('重复 7 次'),
      })
    );
  });

  it('Signal 2: 1h token > 100k → 封禁 24h', async () => {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return setupAggregateChain([]); // S1 空
      // S2: 高 token
      return setupAggregateChain([{ userId: 'user-heavy', total: 250_000 }]);
    });

    const signals = await detectAndBan();
    expect(signals.length).toBe(1);
    expect(signals[0].userId).toBe('user-heavy');
    expect(signals[0].reason).toContain('250,000');
    expect(signals[0].reason).toContain('tokens');
  });

  it('Signal 3: 失败率 > 80% (≥10 次) → 封禁 1h', async () => {
    mockSelect.mockReturnValue(setupAggregateChain([])); // S1, S2 空
    // S3 通过 db.execute raw SQL；S4 同样走 execute（jailbreak），第二次返回 []
    mockExecute
      .mockResolvedValueOnce([
        { userId: 'user-failing', total: 12, failed: 11 },
      ])
      .mockResolvedValueOnce([]);

    const signals = await detectAndBan();
    expect(signals.length).toBe(1);
    expect(signals[0].userId).toBe('user-failing');
    expect(signals[0].reason).toContain('92%'); // 11/12 ≈ 91.6% → Math.round → 92
    expect(signals[0].reason).toContain('11/12');

    // 验证 ban 时间 ≈ 1h（不是 24h）
    const banDuration = signals[0].banUntil.getTime() - Date.now();
    expect(banDuration).toBeGreaterThan(59 * 60 * 1000);
    expect(banDuration).toBeLessThanOrEqual(60 * 60 * 1000 + 1000);
  });

  it('Signal 4: jailbreak 累计 ≥3 次 → 封禁 24h', async () => {
    mockSelect.mockReturnValue(setupAggregateChain([])); // S1, S2 空
    // S3 失败率空，S4 jailbreak 命中，S5 cluster 空
    mockExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ userId: 'user-injector', strikes: 5 }])
      .mockResolvedValueOnce([]);

    const signals = await detectAndBan();
    expect(signals.length).toBe(1);
    expect(signals[0].userId).toBe('user-injector');
    expect(signals[0].reason).toContain('5 次');
    expect(signals[0].reason).toContain('prompt injection');

    // 24h 封禁（jailbreak 危害严重，封满 24h）
    const banDuration = signals[0].banUntil.getTime() - Date.now();
    expect(banDuration).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(banDuration).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });

  it('Signal 5: 注册 IP 聚类 ≥5 账号 → 全部冻结待审核', async () => {
    mockSelect.mockReturnValue(setupAggregateChain([])); // S1, S2 空
    // S3 空, S4 空, S5 命中
    mockExecute
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          hash: 'abc123def456789a',
          user_ids: ['cluster-u1', 'cluster-u2', 'cluster-u3', 'cluster-u4', 'cluster-u5'],
        },
      ]);

    const signals = await detectAndBan();
    expect(signals.length).toBe(5);
    expect(signals.every((s) => s.reason.includes('可疑批量注册'))).toBe(true);
    expect(signals.every((s) => s.reason.includes('5 个账号'))).toBe(true);

    // 冻结时长 ≈ 100 年（实质永久）
    const banDurationDays = (signals[0].banUntil.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(banDurationDays).toBeGreaterThan(36000);

    // 5 个用户都被 update
    expect(mockUpdate).toHaveBeenCalledTimes(5);
  });

  it('多重信号去重：同一用户多个信号只 ban 一次', async () => {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return setupAggregateChain([
          { userId: 'user-bad', promptHash: 'h1', c: 6 },
        ]);
      }
      return setupAggregateChain([{ userId: 'user-bad', total: 200_000 }]);
    });
    // S3 失败率 + S4 jailbreak 都命中同一用户；S5 cluster 空
    mockExecute
      .mockResolvedValueOnce([{ userId: 'user-bad', total: 20, failed: 18 }])
      .mockResolvedValueOnce([{ userId: 'user-bad', strikes: 4 }])
      .mockResolvedValueOnce([]);

    const signals = await detectAndBan();
    expect(signals.length).toBe(4); // 4 个信号生成（S1+S2+S3+S4）

    // 但 update 只调一次（去重生效）
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('多个用户同时被 ban', async () => {
    let callCount = 0;
    mockSelect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return setupAggregateChain([
          { userId: 'user-a', promptHash: 'h1', c: 5 },
          { userId: 'user-b', promptHash: 'h2', c: 8 },
        ]);
      }
      return setupAggregateChain([]);
    });

    const signals = await detectAndBan();
    expect(signals.length).toBe(2);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
  });

  it('★Signal 3 的「失败」不含计费状态：api_error（provider 故障 / BYOK 模型错误）不计入失败率', async () => {
    mockSelect.mockReturnValue(setupAggregateChain([]));
    mockExecute.mockResolvedValue([]);
    await detectAndBan();
    const dialect = new PgDialect();
    const queries = mockExecute.mock.calls.map((c) => dialect.sqlToQuery(c[0] as SQL));
    const signal3 = queries.find((q) => q.sql.includes('CASE WHEN status'));
    expect(signal3).toBeDefined();
    expect(signal3!.sql).toContain('status NOT IN (');
    expect(signal3!.sql).not.toContain("!= 'success'");
    expect(signal3!.params).toEqual(expect.arrayContaining(['success', 'api_error']));
  });
});
