import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks（与现有 usage.test.ts 模式一致）
const { mockSelect, mockInsertValues, mockInsert, mockOnConflict, mockUpdateWhere, mockUpdateSet, mockUpdate } = vi.hoisted(() => {
  const mockOnConflict = vi.fn().mockResolvedValue(undefined);
  // values() 既支持直接 await（普通 insert），又支持链 .onConflictDoUpdate（#185 upsert）。
  const mockInsertValues = vi.fn().mockImplementation(() => {
    const p: Promise<undefined> & { onConflictDoUpdate?: typeof mockOnConflict } = Promise.resolve(undefined);
    p.onConflictDoUpdate = mockOnConflict;
    return p;
  });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });
  const mockSelect = vi.fn();
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });
  return { mockSelect, mockInsertValues, mockInsert, mockOnConflict, mockUpdateWhere, mockUpdateSet, mockUpdate };
});

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      aiKeyBindings: { findFirst: vi.fn() },
    },
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  },
  users: { id: {}, plan: {} },
  aiUsageRecords: { id: {}, userId: {}, periodMonth: {}, status: {}, usedByok: {}, createdAt: {}, promptTokens: {}, completionTokens: {} },
  aiKeyBindings: { id: {}, userId: {}, active: {}, lastUsedAt: {}, lastErrorAt: {}, lastError: {}, updatedAt: {} },
}));

// 手动熔断状态（review I5）：默认未熔断，个别用例覆盖。
const { mockGetSetting } = vi.hoisted(() => ({ mockGetSetting: vi.fn(async (): Promise<unknown> => undefined) }));
vi.mock('@/lib/platform-settings', () => ({ getSetting: mockGetSetting, setSetting: vi.fn() }));

// 只包一层 inArray 以便断言「计费状态集合」；其余 drizzle 行为保持真实。
vi.mock('drizzle-orm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('drizzle-orm')>();
  return { ...orig, inArray: vi.fn(orig.inArray) };
});

import { inArray } from 'drizzle-orm';
import { db, aiUsageRecords } from '@/lib/prisma';
import {
  checkAiQuota,
  recordAiUsage,
  byokTokensUsedThisMonth,
  resetByokQuotaUsage,
  AI_MONTHLY_QUOTA,
  AI_RATE_LIMIT_PER_MINUTE,
  BILLABLE_STATUSES,
  countBillableCalls,
  markAiUsageFailed,
} from '@/lib/ai-quota';

/**
 * 给 db.select().from().where() 链路返回固定 count 的结果
 */
function setupCountResult(count: number) {
  const mockWhere = vi.fn().mockResolvedValue([{ c: count }]);
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
}

/**
 * 给 db.select 链路返回多个不同 count（按调用次数顺序）
 */
function setupSequentialCounts(...counts: number[]) {
  let i = 0;
  mockSelect.mockImplementation(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([{ c: counts[i++] ?? 0 }]),
    }),
  }));
}

// 用 any 避免和完整 User shape 类型对齐（测试只关心 ai-quota 用的字段）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockUserBase(overrides: Partial<Record<string, unknown>> = {}): any {
  return {
    id: 'user-1',
    plan: 'free' as const,
    priceLockedAt: null,
    legacyTier: null,
    aiBannedUntil: null,
    aiBanReason: null,
    // 默认已验证邮箱，避免触发 L0.5 邮箱验证守卫
    emailVerified: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('checkAiQuota', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.query.aiKeyBindings.findFirst).mockResolvedValue(undefined);
  });

  describe('BYOK 配额（止血：不再无条件 bypass）', () => {
    // Phase 1 止血：BYOK 真实推理尚未接入（推理走平台 key），故绑定 BYOK 不再无条件放行
    // unlimited，而是走与普通用户相同的平台配额路径，避免 BYOK 用户白嫖平台 LLM 预算。
    // checkAiQuota 现在【完全不读 aiKeyBindings】——下面断言 findFirst 未被调用以锁定这一点。
    it('绑定 BYOK 的 Free 用户仍走平台配额，未用满 → 放行且 usedByok=false（不读 binding）', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'free' }));
      // monthly 5 / lastMinute 0 / lastHour 0 / final monthly 5
      setupSequentialCounts(5, 0, 0, 5);

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        // 关键：BYOK 未接入推理前，usedByok 必须为 false（不能造假），且受平台配额约束
        expect(result.usedByok).toBe(false);
        expect(result.limit).toBe(20);
        expect(result.remaining).toBe(15);
      }
      // 止血后 checkAiQuota 不再查 BYOK 绑定（bypass 已删）
      expect(db.query.aiKeyBindings.findFirst).not.toHaveBeenCalled();
    });

    it('用满平台配额 → 拒绝（BYOK 绑定与否都不再 unlimited bypass）', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'free' }));
      setupCountResult(20); // monthly 用满

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_quota_exhausted');
      }
    });

    it('Phase 2：usedByok=true 跳过平台月配额（即使平台配额已满仍放行），但仍受速率约束', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'free' }));
      // 月配额被跳过（不查 countSuccessfulCalls 作月配额判定）；速率 lastMinute 0 / lastHour 0 / final 0
      setupSequentialCounts(0, 0, 0);

      const result = await checkAiQuota('user-1', { usedByok: true });
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.usedByok).toBe(true);
        expect(result.limit).toBe(-1); // 月配额视为无限（用户自己的 key）
      }
    });

    it('Phase 2：usedByok=true 仍受每分钟速率限制（防高频打爆）', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'free' }));
      // 月配额跳过；lastMinute 超 free 上限 5
      setupCountResult(99); // countCallsSince 返回 99 → 触发速率
      const result = await checkAiQuota('user-1', { usedByok: true });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_rate_limited');
      }
    });
  });

  describe('自动封禁', () => {
    it('aiBannedUntil 在未来时拒绝并返回 retryAfterSec', async () => {
      const banUntil = new Date(Date.now() + 60_000); // 60s later
      vi.mocked(db.query.users.findFirst).mockResolvedValue(
        mockUserBase({ plan: 'free', aiBannedUntil: banUntil, aiBanReason: '滥用检测' })
      );

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_banned');
        expect(result.message).toContain('滥用检测');
        expect(result.retryAfterSec).toBeGreaterThan(0);
        expect(result.retryAfterSec).toBeLessThanOrEqual(60);
      }
    });

    it('aiBannedUntil 在过去时不阻止', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(
        mockUserBase({ plan: 'free', aiBannedUntil: new Date(Date.now() - 60_000) })
      );
      // monthly count 0 / lastMinute 0 / lastHour 0 / final monthly 0
      setupSequentialCounts(0, 0, 0, 0);

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(true);
    });
  });

  describe('管理员手动熔断（review I5）', () => {
    const tripped = () => ({ until: new Date(Date.now() + 3_600_000).toISOString() });

    it.each(['free', 'trial'])('★%s 用户（含熔断后才注册、尚未被打 ban 的）→ ai_banned，至熔断到期', async (plan) => {
      mockGetSetting.mockResolvedValueOnce(tripped());
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan, aiBannedUntil: null }));

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_banned');
        expect(result.message).toBe('全局成本熔断（free_trial_stopped，manual）');
        expect(result.retryAfterSec).toBeGreaterThan(3500);
        expect(result.retryAfterSec).toBeLessThanOrEqual(3600);
      }
    });

    it('付费套餐不受手动熔断影响，且不读熔断状态', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'pro' }));
      setupSequentialCounts(0, 0, 0, 0);

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(true);
      expect(mockGetSetting).not.toHaveBeenCalled();
    });

    it('手动熔断已过期或已解除 → 放行', async () => {
      mockGetSetting.mockResolvedValueOnce({ until: new Date(Date.now() - 1000).toISOString() });
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'free' }));
      setupSequentialCounts(0, 0, 0, 0);
      expect((await checkAiQuota('user-1')).allowed).toBe(true);

      mockGetSetting.mockResolvedValueOnce({ until: null });
      setupSequentialCounts(0, 0, 0, 0);
      expect((await checkAiQuota('user-1')).allowed).toBe(true);
    });
  });

  describe('月度次数配额', () => {
    it('Free 档当月用了 19 次 < 20 → 放行', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'free' }));
      // monthly 19 / lastMinute 0 / lastHour 0 / final monthly 19
      setupSequentialCounts(19, 0, 0, 19);

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.limit).toBe(20);
        expect(result.remaining).toBe(1);
      }
    });

    it('Free 档当月用满 20 次 → 拒绝', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'free' }));
      setupCountResult(20); // monthly

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_quota_exhausted');
        expect(result.message).toContain('20');
      }
    });

    it('Enterprise 档无限额 → 跳过月度配额检查', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'enterprise' }));
      // 跳过 monthly 检查；先 lastMinute 0 / lastHour 0 / final monthly 0
      setupSequentialCounts(0, 0, 0);

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.limit).toBe(-1);
        expect(result.remaining).toBe(-1);
      }
    });

    it('Pro 档配额 500 / 月', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'pro' }));
      setupCountResult(500); // 满

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_quota_exhausted');
        expect(result.message).toContain('500');
      }
    });
  });

  describe('速率限制', () => {
    it('Free 每分钟超 5 次 → 限流', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'free' }));
      // monthly 0 (放行) / lastMinute 5 (满)
      setupSequentialCounts(0, 5);

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_rate_limited');
        expect(result.retryAfterSec).toBe(60);
      }
    });

    it('Free 每小时超 20 次 → 限流', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'free' }));
      // monthly 0 / lastMinute 0 / lastHour 20
      setupSequentialCounts(0, 0, 20);

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_rate_limited');
        expect(result.retryAfterSec).toBe(3600);
      }
    });
  });

  describe('用户不存在', () => {
    it('找不到用户 → 拒绝', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
      const result = await checkAiQuota('ghost');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_quota_exhausted');
      }
    });
  });

  describe('邮箱验证守卫（L5）', () => {
    it('Free + 未验证邮箱 → ai_email_unverified 拒绝', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(
        mockUserBase({ plan: 'free', emailVerified: null })
      );

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_email_unverified');
        expect(result.message).toContain('邮箱验证');
      }
      // 守卫触发后不应进入配额查询
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('Free + 已验证邮箱 → 正常走配额', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(
        mockUserBase({ plan: 'free', emailVerified: new Date('2026-01-01') })
      );
      setupSequentialCounts(0, 0, 0, 0);

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(true);
      if (result.allowed) {
        expect(result.limit).toBe(20);
      }
    });

    it('Trial + 未验证邮箱 → 不被守卫拦截（trial 用户已通过 OAuth）', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(
        mockUserBase({ plan: 'trial', emailVerified: null })
      );
      setupSequentialCounts(0, 0, 0, 0);

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(true);
    });

    it('Free 未验证邮箱用户不再被 BYOK bypass 豁免邮箱验证（止血）', async () => {
      // Phase 1 止血前：BYOK 在 L0 提前放行，顺带跳过了 L0.5 的 Free 邮箱验证门。
      // 止血后 BYOK 不再 bypass → Free + 未验证邮箱走正常路径，被 L0.5 拦截。
      // 这是有意的：BYOK 未接入真实推理前不应享受任何特殊豁免。
      vi.mocked(db.query.users.findFirst).mockResolvedValue(
        mockUserBase({ plan: 'free', emailVerified: null })
      );

      const result = await checkAiQuota('user-1');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toBe('ai_email_unverified');
      }
    });
  });
});

describe('recordAiUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功调用记录 success status + cost 估算', async () => {
    await recordAiUsage({
      userId: 'user-1',
      callKind: 'complete',
      model: 'gpt-4o-mini',
      promptTokens: 1000,
      completionTokens: 500,
      usedByok: false,
      status: 'success',
    });

    expect(mockInsert).toHaveBeenCalled();
    const values = mockInsertValues.mock.calls[0][0];
    expect(values.userId).toBe('user-1');
    expect(values.callKind).toBe('complete');
    expect(values.model).toBe('gpt-4o-mini');
    expect(values.promptTokens).toBe(1000);
    expect(values.completionTokens).toBe(500);
    expect(values.usedByok).toBe(false);
    expect(values.status).toBe('success');
    // gpt-4o-mini 价格：(1000/1M)*$0.15 + (500/1M)*$0.60 = $0.00015 + $0.0003 = $0.00045
    // → 0.045 cents → ceil 1 cent
    expect(values.costCents).toBe(1);
  });

  describe('#185 requestId upsert（精确 token 回填不双记账）', () => {
    it('无 requestId → 普通 insert（不走 upsert）', async () => {
      await recordAiUsage({
        userId: 'u1', callKind: 'complete', model: 'x',
        promptTokens: 0, completionTokens: 0, usedByok: false, status: 'success',
      });
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockOnConflict).not.toHaveBeenCalled();
      expect(mockInsertValues.mock.calls[0][0].requestId).toBeNull();
    });

    it('带 requestId → upsert（onConflictDoUpdate target=requestId）', async () => {
      await recordAiUsage({
        userId: 'u1', callKind: 'complete', model: 'gpt-4o',
        promptTokens: 100, completionTokens: 50, usedByok: false,
        requestId: 'req-1', status: 'success',
      });
      expect(mockOnConflict).toHaveBeenCalledTimes(1);
      expect(mockInsertValues.mock.calls[0][0].requestId).toBe('req-1');
      const conflict = mockOnConflict.mock.calls[0][0];
      // 真实 token（hasTokens）→ set 覆盖 token/cost/model
      expect(conflict.set.promptTokens).toBe(100);
      expect(conflict.set.completionTokens).toBe(50);
      expect(conflict.set.model).toBe('gpt-4o');
    });

    it('占位 0/0 带 requestId → upsert 但 set 里 token 用 self-ref（不覆盖已回填的真 token）', async () => {
      await recordAiUsage({
        userId: 'u1', callKind: 'complete', model: 'unknown',
        promptTokens: 0, completionTokens: 0, usedByok: false,
        requestId: 'req-2', status: 'success',
      });
      const conflict = mockOnConflict.mock.calls[0][0];
      // hasTokens=false → set.promptTokens 不是数字 100 而是 sql self-ref（保留已有值）
      expect(typeof conflict.set.promptTokens).not.toBe('number');
    });
  });

  it('★占位记录带真实 model：占位（无 token）不覆盖已有 model；带 token 的回填以回填值为准', async () => {
    // 最近一次 .values() 参数与 .onConflictDoUpdate({ set }) 参数
    const capturedUpsert = () => ({
      values: mockInsertValues.mock.calls.at(-1)![0],
      set: mockOnConflict.mock.calls.at(-1)![0].set,
    });
    // 占位：values.model 是真实 model，set.model 必须是「保留已有列」的 SQL 表达式（非字符串字面量）
    await recordAiUsage({ userId: 'u', callKind: 'complete', model: 'gpt-4o', promptTokens: 0, completionTokens: 0, usedByok: true, requestId: 'r1', status: 'success' });
    const placeholder = capturedUpsert();
    expect(placeholder.values.model).toBe('gpt-4o');
    expect(typeof placeholder.set.model).not.toBe('string');
    // 回填（带 token）：model 以回填值为准——新版 api 回填的是实际发出 model（与占位一致）；
    // 旧版 api 回填的是其请求/平台默认 model，这是既有 #185 契约（token 为权威），本用例把该规则锁定
    await recordAiUsage({ userId: 'u', callKind: 'complete', model: 'gpt-4o-mini', promptTokens: 10, completionTokens: 5, usedByok: true, requestId: 'r1', status: 'success' });
    expect(capturedUpsert().set.model).toBe('gpt-4o-mini');
  });

  it('BYOK 调用 usedByok=true', async () => {
    await recordAiUsage({
      userId: 'user-1',
      callKind: 'generate',
      model: 'gpt-4o-mini',
      promptTokens: 100,
      completionTokens: 50,
      usedByok: true,
      status: 'success',
    });

    const values = mockInsertValues.mock.calls[0][0];
    expect(values.usedByok).toBe(true);
  });

  it('Phase 3：BYOK 成功 + bindingId → stamp AiKeyBinding.lastUsedAt（单调守卫）', async () => {
    await recordAiUsage({
      userId: 'user-1',
      callKind: 'generate',
      model: 'unknown',
      promptTokens: 0,
      completionTokens: 0,
      usedByok: true,
      aiKeyBindingId: 'binding-1',
      status: 'success',
    });

    // insert usage + update lastUsedAt 各一次
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(setArg.lastUsedAt).toBeInstanceOf(Date);
    // 与 usage 记录共用同一 usedAt
    expect(setArg.lastUsedAt.getTime()).toBe(mockInsertValues.mock.calls[0][0].createdAt.getTime());
    // 成功即清错误状态（与 healthcheck 语义一致）
    expect(setArg.lastErrorAt).toBeNull();
    // 单调守卫 where 被调用（id + userId + active + lastUsedAt < usedAt）
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('Phase 3：usedByok 但无 bindingId → 只 insert，不 stamp', async () => {
    await recordAiUsage({
      userId: 'user-1', callKind: 'generate', model: 'x',
      promptTokens: 0, completionTokens: 0, usedByok: true, status: 'success',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('Phase 3：非 success（api_error）即使 usedByok+bindingId 也不 stamp', async () => {
    await recordAiUsage({
      userId: 'user-1', callKind: 'generate', model: 'x',
      promptTokens: 0, completionTokens: 0, usedByok: true,
      aiKeyBindingId: 'binding-1', status: 'api_error',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('Phase 3：非 BYOK（usedByok=false）不 stamp（即使误传 bindingId）', async () => {
    await recordAiUsage({
      userId: 'user-1', callKind: 'generate', model: 'x',
      promptTokens: 0, completionTokens: 0, usedByok: false,
      aiKeyBindingId: 'binding-1', status: 'success',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('GPT-4 大调用成本估算正确', async () => {
    await recordAiUsage({
      userId: 'user-1',
      callKind: 'generate',
      model: 'gpt-4',
      promptTokens: 1_000_000, // 1M
      completionTokens: 500_000, // 500k
      usedByok: false,
      status: 'success',
    });

    const values = mockInsertValues.mock.calls[0][0];
    // gpt-4: $30/M prompt + $60/M completion
    // = $30 + $30 = $60 = 6000 cents
    expect(values.costCents).toBe(6000);
  });

  it('未知模型回退到 gpt-4o-mini 价位', async () => {
    await recordAiUsage({
      userId: 'user-1',
      callKind: 'generate',
      model: 'mystery-model',
      promptTokens: 1000,
      completionTokens: 500,
      usedByok: false,
      status: 'success',
    });

    const values = mockInsertValues.mock.calls[0][0];
    expect(values.costCents).toBe(1); // 与 gpt-4o-mini 同价
  });

  it('periodMonth 为 YYYY-MM 格式', async () => {
    await recordAiUsage({
      userId: 'user-1',
      callKind: 'complete',
      model: 'gpt-4o-mini',
      promptTokens: 100,
      completionTokens: 50,
      usedByok: false,
      status: 'success',
    });

    const values = mockInsertValues.mock.calls[0][0];
    expect(values.periodMonth).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('AI_MONTHLY_QUOTA / AI_RATE_LIMIT 常量与 PM 文档对齐', () => {
  it('Free 20 / Pro 500 / Enterprise 无限', () => {
    expect(AI_MONTHLY_QUOTA.free).toBe(20);
    expect(AI_MONTHLY_QUOTA.pro).toBe(500);
    expect(AI_MONTHLY_QUOTA.enterprise).toBe(-1);
  });

  it('每分钟 Free 5 / Pro 30 / Enterprise 200', () => {
    expect(AI_RATE_LIMIT_PER_MINUTE.free).toBe(5);
    expect(AI_RATE_LIMIT_PER_MINUTE.pro).toBe(30);
    expect(AI_RATE_LIMIT_PER_MINUTE.enterprise).toBe(200);
  });
});

describe('byokTokensUsedThisMonth（重置额度水位线）', () => {
  beforeEach(() => vi.clearAllMocks());

  // 捕获 db.select().from().where() 的 where 参数并返回固定 SUM。
  function setupSum(total: number) {
    const whereArgs: unknown[] = [];
    const mockWhere = vi.fn().mockImplementation((...args: unknown[]) => {
      whereArgs.push(...args);
      return Promise.resolve([{ t: total }]);
    });
    mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where: mockWhere }) });
    return { mockWhere };
  }

  it('无重置水位线（byokQuotaResetAt=null）→ 返回聚合 SUM，下界=当月初', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({ byokQuotaResetAt: null } as never);
    const { mockWhere } = setupSum(1234);
    const at = new Date('2026-07-20T00:00:00Z');

    const used = await byokTokensUsedThisMonth('user-1', at);
    expect(used).toBe(1234);
    // 读了用户水位线
    expect(db.query.users.findFirst).toHaveBeenCalledTimes(1);
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it('重置水位线在本月内 → 用 resetAt 作为下界（clamp 到 max(月初, resetAt)）', async () => {
    // 7-20 才重置，比 7-01 月初晚 → 下界应取 resetAt。
    const resetAt = new Date('2026-07-20T10:00:00Z');
    vi.mocked(db.query.users.findFirst).mockResolvedValue({ byokQuotaResetAt: resetAt } as never);
    setupSum(0);
    const at = new Date('2026-07-25T00:00:00Z');

    const used = await byokTokensUsedThisMonth('user-1', at);
    // 重置后本月新用量为 0（本测试 SUM mock 返回 0，模拟「计数已清零」）
    expect(used).toBe(0);
    expect(db.query.users.findFirst).toHaveBeenCalledTimes(1);
  });

  it('重置水位线早于当月初（上个月重置）→ 下界仍取当月初,不越月', async () => {
    // 6-15 重置，早于 7-01 → clamp 回月初，本月正常从月初起算。
    const resetAt = new Date('2026-06-15T00:00:00Z');
    vi.mocked(db.query.users.findFirst).mockResolvedValue({ byokQuotaResetAt: resetAt } as never);
    setupSum(999);
    const at = new Date('2026-07-10T00:00:00Z');

    const used = await byokTokensUsedThisMonth('user-1', at);
    expect(used).toBe(999);
  });
});

describe('resetByokQuotaUsage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('盖 users.byokQuotaResetAt=now() 并返回该时间戳（不删审计记录）', async () => {
    const before = Date.now();
    const stamped = await resetByokQuotaUsage('user-1');
    const after = Date.now();

    // 走的是 update().set().where()，不是 delete（审计记录不被删除）
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    const setArg = mockUpdateSet.mock.calls[0][0] as { byokQuotaResetAt: Date };
    expect(setArg.byokQuotaResetAt).toBeInstanceOf(Date);
    // 返回的时间戳在调用窗口内
    expect(stamped.getTime()).toBeGreaterThanOrEqual(before);
    expect(stamped.getTime()).toBeLessThanOrEqual(after);
    expect(setArg.byokQuotaResetAt.getTime()).toBe(stamped.getTime());
  });
});

describe('计费状态集合（到达 provider 的失败记 api_error，仍计入配额）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('BILLABLE_STATUSES = success + api_error（拒绝/限流/封禁/安全拦截不计）', () => {
    expect([...BILLABLE_STATUSES]).toEqual(['success', 'api_error']);
  });

  it('★月配额门：api_error 行与 success 行一样计入（此前这类失败被记成 success 并计入，口径不变）', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUserBase({ plan: 'free' }));
    setupSequentialCounts(20, 0, 0);
    const r = await checkAiQuota('user-1');
    expect(r.allowed).toBe(false);
    expect(inArray).toHaveBeenCalledWith(aiUsageRecords.status, BILLABLE_STATUSES);
  });

  it('countBillableCalls 按计费状态集合计数（/api/user/ai-usage 复用同一口径）', async () => {
    setupCountResult(7);
    expect(await countBillableCalls('user-1', '2026-10')).toBe(7);
    expect(inArray).toHaveBeenCalledWith(aiUsageRecords.status, BILLABLE_STATUSES);
  });

  it('byokTokensUsedThisMonth 同样按计费状态集合汇总（失败前已产出的 token 也耗用户 key）', async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({ byokQuotaResetAt: null } as never);
    setupCountResult(0);
    mockSelect.mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ t: 5 }]) }) });
    expect(await byokTokensUsedThisMonth('user-1')).toBe(5);
    expect(inArray).toHaveBeenCalledWith(aiUsageRecords.status, BILLABLE_STATUSES);
  });
});

describe('markAiUsageFailed（定向 UPDATE，不走保留首次 status 的 upsert）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('按 requestId 把 status 改为 api_error，不碰 token/cost', async () => {
    await markAiUsageFailed('req-1');
    expect(mockUpdate).toHaveBeenCalledWith(aiUsageRecords);
    expect(mockUpdateSet).toHaveBeenCalledWith({ status: 'api_error' });
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('DB 失败只告警，不抛出（状态修正不影响业务响应）', async () => {
    mockUpdateWhere.mockRejectedValueOnce(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(markAiUsageFailed('req-2')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
