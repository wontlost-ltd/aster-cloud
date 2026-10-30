// src/__tests__/lib/api-quota-pool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * owner 共享配额池（ADR 0015 §4）：所有 API 调用量统计点都经由同一 helper，
 * 按配额 owner（团队 key → 团队 owner，个人 key → 本人）归池；
 * 旧行 quotaOwnerId 为 NULL 时按持有者 userId 归池（COALESCE 语义，不回填）。
 */

const { mockWhere, mockValues } = vi.hoisted(() => ({ mockWhere: vi.fn(), mockValues: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  db: { select: () => ({ from: () => ({ where: mockWhere }) }), insert: () => ({ values: mockValues }) },
  apiCallRecords: { quotaOwnerId: 'quotaOwnerId', userId: 'userId', periodMonth: 'periodMonth', status: 'status' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...c: unknown[]) => ({ op: 'and', c }),
  or: (...c: unknown[]) => ({ op: 'or', c }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  inArray: (col: unknown, vals: unknown) => ({ op: 'inArray', col, vals }),
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

  // 全量快照同步按页批量取 owner 池用量（#694）：一次查询按池键分组，而非每个用户一次 count。
  it('countOwnerPoolUsageByOwner 一次查询按池键分组，未出现的 owner 计 0', async () => {
    const { countOwnerPoolUsageByOwner } = await import('@/lib/api-quota-pool');
    const groupBy = vi.fn().mockResolvedValue([{ owner: 'A', c: 3 }, { owner: 'B', c: 5 }]);
    mockWhere.mockReturnValue({ groupBy });

    const usage = await countOwnerPoolUsageByOwner(['A', 'B', 'C'], '2026-10');

    expect(usage).toEqual(new Map([['A', 3], ['B', 5], ['C', 0]]));
    expect(mockWhere).toHaveBeenCalledTimes(1);
    expect(mockWhere).toHaveBeenCalledWith({ op: 'and', c: [
      { op: 'or', c: [
        { op: 'inArray', col: 'quotaOwnerId', vals: ['A', 'B', 'C'] },
        { op: 'and', c: [{ op: 'isNull', col: 'quotaOwnerId' }, { op: 'inArray', col: 'userId', vals: ['A', 'B', 'C'] }] },
      ] },
      { op: 'eq', col: 'periodMonth', val: '2026-10' },
      { op: 'eq', col: 'status', val: 'success' },
    ] });
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('countOwnerPoolUsageByOwner 空 owner 列表不查库', async () => {
    const { countOwnerPoolUsageByOwner } = await import('@/lib/api-quota-pool');
    expect(await countOwnerPoolUsageByOwner([], '2026-10')).toEqual(new Map());
    expect(mockWhere).not.toHaveBeenCalled();
  });

  it('currentPeriodMonth 用 UTC', async () => {
    const { currentPeriodMonth } = await import('@/lib/api-quota-pool');
    expect(currentPeriodMonth(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10');
    expect(currentPeriodMonth(new Date('2026-11-01T00:30:00+08:00'))).toBe('2026-10');
    expect(currentPeriodMonth(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01');
  });

  it('recordApiCallRecord 按 UTC 月份写入 owner 池一行', async () => {
    const { recordApiCallRecord } = await import('@/lib/api-quota-pool');
    mockValues.mockResolvedValue(undefined);
    const now = new Date('2026-11-01T00:30:00+08:00');
    await recordApiCallRecord({
      userId: 'member', tenantId: 't1', apiKeyId: 'k1', quotaOwnerId: 'owner',
      endpointPath: '/api/v1/policies/{id}/execute', status: 'success', latencyMs: 12,
    }, now);
    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'member', tenantId: 't1', apiKeyId: 'k1', quotaOwnerId: 'owner', periodMonth: '2026-10',
      endpointPath: '/api/v1/policies/{id}/execute', status: 'success', latencyMs: 12, createdAt: now,
    }));
    expect(typeof mockValues.mock.calls[0][0].id).toBe('string');
  });
});
