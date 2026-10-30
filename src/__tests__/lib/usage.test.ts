import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mockUser, type MockUser } from '@/__tests__/helpers/mock-user';

// Use vi.hoisted to define mocks that need to be referenced inside vi.mock factories
const {
  mockInsertOnConflict,
  mockInsertValues,
  mockInsert,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockSelect,
} = vi.hoisted(() => {
  const mockInsertOnConflict = vi.fn().mockResolvedValue(undefined);
  const mockInsertValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockInsertOnConflict });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  const mockSelect = vi.fn();

  return {
    mockInsertOnConflict,
    mockInsertValues,
    mockInsert,
    mockUpdateWhere,
    mockUpdateSet,
    mockUpdate,
    mockSelect,
  };
});

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
      usageRecords: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      teamMembers: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    insert: mockInsert,
    update: mockUpdate,
    select: mockSelect,
  },
  users: { id: {}, plan: {}, trialEndsAt: {} },
  usageRecords: { id: {}, userId: {}, type: {}, count: {}, period: {} },
  policies: { id: {}, userId: {}, deletedAt: {} },
  teamMembers: { userId: {}, role: {} },
}));

import { db, policies } from '@/lib/prisma';
import {
  checkUsageLimit,
  recordUsage,
  getUsageStats,
  hasFeatureAccess,
  getLexiconQuota,
  getLexiconQuotaWithContext,
  EVIDENCE_EXPORT_METRIC,
} from '@/lib/usage';

// Helper to setup db.select chain for policy count queries
function setupSelectCount(count: number) {
  const mockWhere = vi.fn().mockResolvedValue([{ count }]);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
  return mockWhere;
}

function containsSqlNode(value: unknown, target: unknown): boolean {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((part) => containsSqlNode(part, target));
  if (!value || typeof value !== 'object') return false;
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  return Array.isArray(chunks) && chunks.some((part) => containsSqlNode(part, target));
}

// mockUser 已从 helpers 模块 import（顶部）

function mockUsageRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'usage-1',
    userId: 'user-1',
    type: 'execution' as const,
    count: 0,
    period: '2024-01',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

describe('Usage Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset insert/update chains
    mockInsertOnConflict.mockResolvedValue(undefined);
    mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockInsertOnConflict });
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockUpdateWhere.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
  });

  afterEach(() => vi.restoreAllMocks());

  describe('checkUsageLimit', () => {
    it('should return not allowed when user is not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

      const result = await checkUsageLimit('nonexistent-user', 'execution');

      expect(result).toEqual({ allowed: false, message: 'User not found' });
    });

    it('should return allowed with unlimited remaining for unlimited plan (enterprise)', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'enterprise' }));

      const result = await checkUsageLimit('user-1', 'execution');

      // enterprise plan has -1 executions limit (unlimited)
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(-1);
      expect(result.remaining).toBe(-1);
    });

    it('should return allowed with remaining count when under limit', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());
      vi.mocked(db.query.usageRecords.findFirst).mockResolvedValue(mockUsageRecord({ count: 500 }));

      const result = await checkUsageLimit('user-1', 'execution');

      // PM v1.1 free plan: 1,000 evaluations limit, 500 used
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(1000);
      expect(result.remaining).toBe(500);
    });

    it('should return not allowed with message when at limit', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());
      vi.mocked(db.query.usageRecords.findFirst).mockResolvedValue(mockUsageRecord({ count: 1000 }));

      const result = await checkUsageLimit('user-1', 'execution');

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(1000);
      expect(result.remaining).toBe(0);
      expect(result.message).toContain('1000');
    });

    it('should treat expired trial as free plan', async () => {
      const pastDate = new Date('2020-01-01');
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'trial', trialEndsAt: pastDate }));
      vi.mocked(db.query.usageRecords.findFirst).mockResolvedValue(mockUsageRecord({ count: 0 }));

      const result = await checkUsageLimit('user-1', 'execution');

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(1000); // PM v1.1 free plan limit
      // Also verify user plan was downgraded
      expect(db.update).toHaveBeenCalled();
    });

    it('should return allowed with unlimited for usage types without limit mapping (pii_scan)', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());

      const result = await checkUsageLimit('user-1', 'pii_scan');

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(-1);
      expect(result.remaining).toBe(-1);
    });

    it('should count 0 usage when no usage record exists for period', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());
      vi.mocked(db.query.usageRecords.findFirst).mockResolvedValue(undefined);

      const result = await checkUsageLimit('user-1', 'execution');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1000); // PM v1.1 free plan: 1,000 evaluations
    });

    it('should return not allowed for api_call when free plan has 0 api quota', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());
      vi.mocked(db.query.usageRecords.findFirst).mockResolvedValue(mockUsageRecord({ count: 0 }));

      const result = await checkUsageLimit('user-1', 'api_call');

      // free plan: apiCalls = 0, so count (0) >= limit (0) → not allowed
      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(0);
    });
  });

  describe('recordUsage', () => {
    it('should insert or upsert usage record for the current period', async () => {
      await recordUsage('user-1', 'execution');

      expect(mockInsert).toHaveBeenCalled();
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          type: 'execution',
          count: 1,
        })
      );
      expect(mockInsertOnConflict).toHaveBeenCalled();
    });

    it('should record custom count when provided', async () => {
      await recordUsage('user-1', 'api_call', 5);

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          type: 'api_call',
          count: 5,
        })
      );
    });

    it('should include a period in YYYY-MM format', async () => {
      await recordUsage('user-1', 'pii_scan');

      const callArgs = mockInsertValues.mock.calls[0][0];
      expect(callArgs.period).toMatch(/^\d{4}-\d{2}$/);
    });

    // ★向后兼容守卫：证据导出重命名后，持久化的计量枚举值必须仍是 'compliance_report'
    // （usageRecords.type 是 pg enum，改值需迁移；现有行也用此值）。别把它误改成 'evidence_export'。
    it('evidence export metric persists as the legacy enum value compliance_report', async () => {
      expect(EVIDENCE_EXPORT_METRIC).toBe('compliance_report');
      await recordUsage('user-1', EVIDENCE_EXPORT_METRIC);
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', type: 'compliance_report' })
      );
    });
  });

  describe('getUsageStats', () => {
    it('counts active policies only and excludes policies in the recycle bin', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'pro' }));
      vi.mocked(db.query.usageRecords.findMany).mockResolvedValue([]);
      const mockWhere = setupSelectCount(4);
      await getUsageStats('user-1');

      expect(containsSqlNode(mockWhere.mock.calls[0]?.[0], policies.deletedAt)).toBe(true);
    });

    it('should return usage stats with plan limits and current usage', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'pro' }));
      vi.mocked(db.query.usageRecords.findMany).mockResolvedValue([
        mockUsageRecord({ type: 'execution', count: 100 }),
        mockUsageRecord({ type: 'api_call', count: 50 }),
      ]);
      // policy count query
      setupSelectCount(10);

      const result = await getUsageStats('user-1');

      expect(result.plan).toBe('pro');
      expect(result.usage.executions).toBe(100);
      expect(result.usage.apiCalls).toBe(50);
      expect(result.usage.policies).toBe(10);
      // PM v1.1：用户没 priceLockedAt（=null）→ getEffectiveLimits 走 PM_PLAN_LIMITS_V2
      // pro 档：publishedRules=100, evaluations=50000
      expect(result.usage.policiesLimit).toBe(100);
      expect(result.usage.executionsLimit).toBe(50000);
      expect(result.features.apiAccess).toBe(true);
    });

    it('should return trial days left for active trial users', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'trial', trialEndsAt: futureDate }));
      vi.mocked(db.query.usageRecords.findMany).mockResolvedValue([]);
      setupSelectCount(0);

      const result = await getUsageStats('user-1');

      expect(result.plan).toBe('trial');
      expect(result.trialDaysLeft).toBeGreaterThan(0);
      expect(result.trialDaysLeft).toBeLessThanOrEqual(7);
    });

    it('should downgrade expired trial to free and return null trial days left', async () => {
      const pastDate = new Date('2020-01-01');
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'trial', trialEndsAt: pastDate }));
      vi.mocked(db.query.usageRecords.findMany).mockResolvedValue([]);
      setupSelectCount(0);

      const result = await getUsageStats('user-1');

      expect(result.plan).toBe('free');
      expect(result.trialDaysLeft).toBeNull();
      expect(db.update).toHaveBeenCalled();
    });

    it('should default to free plan when user has unknown plan', async () => {
      // 故意传入非法 plan 值，验证 fallback；用 unknown 双层 cast 绕过类型系统（测试 only）
      vi.mocked(db.query.users.findFirst).mockResolvedValue(
        mockUser({ plan: 'unknown_plan' as unknown as MockUser['plan'] })
      );
      vi.mocked(db.query.usageRecords.findMany).mockResolvedValue([]);
      setupSelectCount(0);

      const result = await getUsageStats('user-1');

      expect(result.plan).toBe('free');
    });

    it('should return 0 for usage types not present in records', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'pro' }));
      vi.mocked(db.query.usageRecords.findMany).mockResolvedValue([]);
      setupSelectCount(5);

      const result = await getUsageStats('user-1');

      expect(result.usage.executions).toBe(0);
      expect(result.usage.piiScans).toBe(0);
      expect(result.usage.evidenceExports).toBe(0);
      expect(result.usage.apiCalls).toBe(0);
    });
  });

  describe('hasFeatureAccess', () => {
    it('should return false when user is not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

      const result = await hasFeatureAccess('nonexistent', 'apiAccess');

      expect(result).toBe(false);
    });

    it('should return false for free plan API access', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());

      const result = await hasFeatureAccess('user-1', 'apiAccess');

      expect(result).toBe(false);
    });

    it('should return true for pro plan API access', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'pro' }));

      const result = await hasFeatureAccess('user-1', 'apiAccess');

      expect(result).toBe(true);
    });

    it('should return false for free plan evidence export', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());

      const result = await hasFeatureAccess('user-1', 'evidenceExport');

      expect(result).toBe(false);
    });

    it('should return true for team plan teamFeatures', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'team' }));

      const result = await hasFeatureAccess('user-1', 'teamFeatures');

      expect(result).toBe(true);
    });

    it('should treat expired trial as free plan', async () => {
      const pastDate = new Date('2020-01-01');
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'trial', trialEndsAt: pastDate }));

      // trial has apiAccess=true, but expired trial → free which has apiAccess=false
      const result = await hasFeatureAccess('user-1', 'apiAccess');

      expect(result).toBe(false);
    });

    it('should treat enterprise unlimited (-1) as available', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'enterprise' }));

      // enterprise.customLexiconMaxTerms = -1 (unlimited).
      // The old hasFeatureAccess numeric branch (`value > 0`) would have
      // rejected -1; we expect the new logic to treat it as available.
      const result = await hasFeatureAccess('user-1', 'customLexiconMaxTerms');

      expect(result).toBe(true);
    });
  });

  describe('getLexiconQuota', () => {
    it('should return disabled quota for free users', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());

      const result = await getLexiconQuota('user-1');

      expect(result).toEqual({ maxTerms: 0, bulkAsync: false, allowed: false });
    });

    it('should return the pro tier quota with async bulk enabled', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'pro' }));

      const result = await getLexiconQuota('user-1');

      expect(result).toEqual({ maxTerms: 5000, bulkAsync: true, allowed: true });
    });

    it('should return unlimited (-1) for enterprise', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'enterprise' }));

      const result = await getLexiconQuota('user-1');

      expect(result).toEqual({ maxTerms: -1, bulkAsync: true, allowed: true });
    });

    it('should downgrade an expired trial before resolving the quota', async () => {
      const pastDate = new Date('2020-01-01');
      vi.mocked(db.query.users.findFirst).mockResolvedValue(
        mockUser({ plan: 'trial', trialEndsAt: pastDate }),
      );

      const result = await getLexiconQuota('user-1');

      // Expired trial → free → no quota.
      expect(result).toEqual({ maxTerms: 0, bulkAsync: false, allowed: false });
      expect(db.update).toHaveBeenCalled();
    });

    it('should return disabled quota when the user record is missing', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

      const result = await getLexiconQuota('nonexistent');

      expect(result).toEqual({ maxTerms: 0, bulkAsync: false, allowed: false });
    });
  });

  // 词汇按作者存储、团队策略用作者词汇：团队里的 Free 成员按所在团队 owner 的套餐获得词汇能力（#672）
  describe('getLexiconQuota — 团队 owner 套餐', () => {
    const membership = (ownerPlan: string, trialEndsAt: Date | null = null) => ({
      team: { owner: { plan: ownerPlan, trialEndsAt } },
    });

    it('Free 成员所在团队 owner 为 Pro → 按 Pro 配额，标出 viaTeam', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());
      vi.mocked(db.query.teamMembers.findMany).mockResolvedValue([membership('pro')] as never);

      expect(await getLexiconQuota('user-1')).toEqual({ maxTerms: 5000, bulkAsync: true, allowed: true });
      const ctx = await getLexiconQuotaWithContext('user-1');
      expect(ctx.viaTeam).toBe(true);
      expect(ctx.plan).toBe('free'); // 个人套餐照实返回，降级横幅等仍按本人
    });

    it('多个团队取配额最大的 owner 套餐', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());
      vi.mocked(db.query.teamMembers.findMany).mockResolvedValue([membership('pro'), membership('enterprise')] as never);
      expect((await getLexiconQuota('user-1')).maxTerms).toBe(-1);
    });

    it('团队 owner 的试用已过期按 Free 计，不放宽', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser());
      vi.mocked(db.query.teamMembers.findMany).mockResolvedValue([membership('trial', new Date('2020-01-01'))] as never);
      expect(await getLexiconQuota('user-1')).toEqual({ maxTerms: 0, bulkAsync: false, allowed: false });
    });

    it('个人套餐更高时用个人套餐，viaTeam=false', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'pro' }));
      vi.mocked(db.query.teamMembers.findMany).mockResolvedValue([membership('free')] as never);
      const ctx = await getLexiconQuotaWithContext('user-1');
      expect(ctx.maxTerms).toBe(5000);
      expect(ctx.viaTeam).toBe(false);
    });
  });
});
