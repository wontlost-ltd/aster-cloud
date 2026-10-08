// src/__tests__/lib/api-quota-pool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * owner 共享配额池（ADR 0015 §4）：所有 API 调用量统计点都经由同一 helper，
 * 按配额 owner（团队 key → 团队 owner，个人 key → 本人）归池；
 * 旧行 quotaOwnerId 为 NULL 时按持有者 userId 归池（COALESCE 语义，不回填）。
 */

const { mockWhere } = vi.hoisted(() => ({ mockWhere: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  db: { select: () => ({ from: () => ({ where: mockWhere }) }) },
  apiCallRecords: { quotaOwnerId: 'quotaOwnerId', userId: 'userId', periodMonth: 'periodMonth', status: 'status' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...c: unknown[]) => ({ op: 'and', c }),
  or: (...c: unknown[]) => ({ op: 'or', c }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  sql: Object.assign(() => ({ op: 'sql' }), { raw: () => ({ op: 'sql' }) }),
}));

describe('api-quota-pool', () => {
  beforeEach(() => {
    vi.resetModules();
    mockWhere.mockReset();
  });

  it('ownerPoolCondition = or(eq(quotaOwnerId,O), and(isNull(quotaOwnerId), eq(userId,O)))', async () => {
    const { ownerPoolCondition } = await import('@/lib/api-quota-pool');
    expect(ownerPoolCondition('O')).toEqual({ op: 'or', c: [
      { op: 'eq', col: 'quotaOwnerId', val: 'O' },
      { op: 'and', c: [{ op: 'isNull', col: 'quotaOwnerId' }, { op: 'eq', col: 'userId', val: 'O' }] },
    ] });
  });

  it('countOwnerPoolUsage 以 period 与 status=success 过滤并返回 count', async () => {
    const { countOwnerPoolUsage, ownerPoolCondition } = await import('@/lib/api-quota-pool');
    mockWhere.mockResolvedValue([{ c: 7 }]);
    expect(await countOwnerPoolUsage('O', '2026-10')).toBe(7);
    expect(mockWhere).toHaveBeenCalledWith({ op: 'and', c: [ownerPoolCondition('O'), { op: 'eq', col: 'periodMonth', val: '2026-10' }, { op: 'eq', col: 'status', val: 'success' }] });
    mockWhere.mockResolvedValue([]);
    expect(await countOwnerPoolUsage('O', '2026-10')).toBe(0);
  });

  it('currentPeriodMonth 用 UTC', async () => {
    const { currentPeriodMonth } = await import('@/lib/api-quota-pool');
    expect(currentPeriodMonth(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10');
    expect(currentPeriodMonth(new Date('2026-11-01T00:30:00+08:00'))).toBe('2026-10');
    expect(currentPeriodMonth(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01');
  });
});
