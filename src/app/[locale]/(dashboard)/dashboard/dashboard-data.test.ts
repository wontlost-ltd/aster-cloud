// @vitest-environment node
/*
 * 仪表盘「常用策略」（生产 E2E F27）：只查未软删的策略，已删除的不再以「已删除」行出现在首页；
 * 按执行次数倒序取前 5 个。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  policiesFindMany: vi.fn(),
  groupBy: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: { policies: { findMany: h.policiesFindMany } },
    select: () => ({ from: () => ({ where: () => ({ groupBy: h.groupBy }) }) }),
  },
  policies: { userId: 'policies.userId', deletedAt: 'policies.deletedAt', updatedAt: 'policies.updatedAt' },
  executions: { policyId: 'executions.policyId' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: string, v: unknown) => ({ eq: [col, v] }),
  isNull: (col: string) => ({ isNull: col }),
  and: (...conds: unknown[]) => ({ and: conds }),
  desc: (col: string) => ({ desc: col }),
  inArray: (col: string, v: unknown) => ({ inArray: [col, v] }),
  sql: () => 'sql',
}));
vi.mock('@/lib/policy-access', () => ({ ownPoliciesVisibleTo: (userId: string) => ({ ownVisible: userId }) }));
vi.mock('@/lib/usage', () => ({ getUsageStats: vi.fn(async () => ({ plan: 'pro' })) }));
vi.mock('@/lib/policy-freeze', () => ({
  getPolicyFreezeStatus: vi.fn(async () => ({ frozenPolicyIds: new Set<string>() })),
}));

import { getDashboardData } from './dashboard-data';

function policy(id: string) {
  return { id, name: id, description: null, piiFields: null, updatedAt: new Date('2026-10-01T00:00:00Z'), deletedAt: null };
}

describe('getDashboardData', () => {
  beforeEach(() => vi.clearAllMocks());

  it('只查询本人仍可见（个人策略 + 仍在其团队的团队策略）且未软删的策略', async () => {
    h.policiesFindMany.mockResolvedValue([]);

    await getDashboardData('u1');

    expect(h.policiesFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { and: [{ ownVisible: 'u1' }, { isNull: 'policies.deletedAt' }] },
      }),
    );
  });

  it('按执行次数倒序取前 5 个，结果不再带 isDeleted 标记', async () => {
    h.policiesFindMany.mockResolvedValue(['a', 'b', 'c', 'd', 'e', 'f'].map(policy));
    h.groupBy.mockResolvedValue([
      { policyId: 'a', c: 1 }, { policyId: 'b', c: 9 }, { policyId: 'c', c: 5 },
      { policyId: 'd', c: 7 }, { policyId: 'e', c: 3 }, { policyId: 'f', c: 8 },
    ]);

    const { policies } = await getDashboardData('u1');

    expect(policies.map((p) => p.id)).toEqual(['b', 'f', 'd', 'c', 'e']);
    expect(policies.every((p) => !('isDeleted' in p))).toBe(true);
  });
});
