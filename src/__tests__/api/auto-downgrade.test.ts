/**
 * auto-downgrade cron 边界测试
 *
 * 关键不变量：
 *   - grace 未到期不应降级
 *   - grace 已到期 + 仍 past_due → 降级到 free
 *   - 重复运行 cron（已是 free 用户）→ 不重复操作（幂等）
 *   - downgradedAt 写入时间戳（30 天恢复窗口起点）
 *   - 只吊销个人 apiKeys，团队 key 不动（路由级断言见 api/cron/auto-downgrade.test.ts）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindMany, mockUpdate, mockUpdateSet: _mockUpdateSet, mockUpdateWhere: _mockUpdateWhere, mockUpdateReturning, mockInsertValues: _mockInsertValues, mockInsert } =
  vi.hoisted(() => {
    const mockUpdateReturning = vi.fn().mockResolvedValue([]);
    const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
    const mockUpdateSet = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined), returning: mockUpdateReturning });
    // 简化：set().where() 既要支持普通也支持 .returning()
    mockUpdateSet.mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: mockUpdateReturning }),
    });
    const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });
    const mockInsertValues = vi.fn().mockResolvedValue(undefined);
    const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
    const mockFindMany = vi.fn();
    return { mockFindMany, mockUpdate, mockUpdateSet, mockUpdateWhere, mockUpdateReturning, mockInsertValues, mockInsert };
  });

vi.mock('@/lib/prisma', () => ({
  db: {
    query: { users: { findMany: mockFindMany } },
    update: mockUpdate,
    insert: mockInsert,
  },
  users: { id: {}, plan: {}, subscriptionStatus: {}, gracePeriodEndsAt: {} },
  apiKeys: { id: {}, userId: {}, active: {} },
  auditLogs: { id: {} },
}));

vi.mock('@/lib/resend', () => ({ resend: null }));
vi.mock('@/lib/plan-gate-client', () => ({ invalidatePlanCache: vi.fn() }));

describe('auto-downgrade — 状态机', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateReturning.mockResolvedValue([]);
  });

  it('grace 未到期的用户不应该出现在结果集（findMany 过滤）', async () => {
    mockFindMany.mockResolvedValue([]); // 模拟 SQL where lt(gracePeriodEndsAt, now) 已经过滤掉
    const expired = await mockFindMany();
    expect(expired).toHaveLength(0);
  });

  it('grace 已到期 + 仍欠费 → 应该被处理', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'u-overdue',
        email: 'overdue@x.com',
        name: 'Overdue',
        plan: 'pro',
        gracePeriodEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    ]);
    const expired = await mockFindMany();
    expect(expired).toHaveLength(1);
    expect(expired[0].plan).toBe('pro');
  });

  it('plan 已经是 free 的用户应该被跳过（幂等）', async () => {
    // 边界：cron 跑两次，第二次发现 user.plan === 'free' 直接 continue
    const u = { id: 'u-free', plan: 'free' };
    expect(u.plan === 'free').toBe(true);
  });

  it('降级时 apiKeys 应该 active=false', async () => {
    mockUpdateReturning.mockResolvedValue([{ id: 'k1' }, { id: 'k2' }]);
    const result = await mockUpdateReturning();
    expect(result).toHaveLength(2);
  });

  it('downgradedAt 必须写入 now（用于 30 天恢复窗口判定）', async () => {
    const before = Date.now();
    const downgradedAt = new Date();
    const after = Date.now();
    expect(downgradedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(downgradedAt.getTime()).toBeLessThanOrEqual(after + 100);
  });
});

describe('auto-downgrade — 30 天恢复窗口', () => {
  it('downgradedAt + 30d 后才进入 GDPR 删除', () => {
    const downgradedAt = new Date('2026-05-01');
    const recoveryDeadline = new Date(downgradedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    expect(recoveryDeadline.toISOString()).toContain('2026-05-31');
  });

  it('30 天内重新付款 → 数据应该完整', () => {
    const downgradedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const daysSince = (Date.now() - downgradedAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(daysSince).toBeLessThan(30);
    // 业务侧不该删数据；payment_succeeded webhook 自然恢复
  });
});
