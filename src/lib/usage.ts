import { db, users, usageRecords, policies } from '@/lib/prisma';
import { eq, and, sql, isNull } from 'drizzle-orm';
import {
  PLANS,
  getPlanConfig,
  getPlanLimit,
  isUnlimited,
  getEffectiveLimits,
  PlanCapabilities,
  PlanLimitType,
  PlanType,
} from '@/lib/plans';

export type UsageType = 'execution' | 'pii_scan' | 'compliance_report' | 'api_call';

/**
 * 证据导出的计量类型。★持久化枚举值仍是 'compliance_report'（usageRecords.type 是 pg enum，
 * 改值需 ALTER TYPE 且旧值删不掉；现有行也用此值）——故只在代码/语义层重命名为 evidence-export，
 * 计量口径的持久 identity 保持不变、向后兼容。日后若要一等公民 'evidence_export' 值须另立迁移 + 双读。
 */
export const EVIDENCE_EXPORT_METRIC = 'compliance_report' as const satisfies UsageType;

const USAGE_LIMIT_MAPPING: Record<UsageType, PlanLimitType | null> = {
  execution: 'executions',
  pii_scan: null,
  compliance_report: null,
  api_call: 'apiCalls',  // API 调用独立配额
};

// 获取当前周期字符串（YYYY-MM）
function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function normalizePlan(plan?: string | null): PlanType {
  if (plan && plan in PLANS) {
    return plan as PlanType;
  }
  return 'free';
}

function resolvePlan(plan: PlanType, trialEndsAt: Date | null) {
  if (plan === 'trial' && trialEndsAt && trialEndsAt < new Date()) {
    return { plan: 'free' as PlanType, downgraded: true };
  }
  return { plan, downgraded: false };
}

// 检查指定用量是否超限
export async function checkUsageLimit(
  userId: string,
  type: UsageType
): Promise<{ allowed: boolean; remaining?: number; limit?: number; used?: number; message?: string }> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      plan: true,
      trialEndsAt: true,
    },
  });

  if (!user) {
    return { allowed: false, message: 'User not found' };
  }

  const normalizedPlan = normalizePlan(user.plan);
  const { plan: effectivePlan, downgraded } = resolvePlan(normalizedPlan, user.trialEndsAt);

  if (downgraded) {
    await db.update(users)
      .set({ plan: effectivePlan })
      .where(eq(users.id, userId));
  }

  const limitKey = USAGE_LIMIT_MAPPING[type];
  if (!limitKey) {
    return { allowed: true, limit: -1, remaining: -1 };
  }

  const limit = getPlanLimit(effectivePlan, limitKey);
  if (isUnlimited(limit)) {
    return { allowed: true, limit, remaining: -1 };
  }

  const period = getCurrentPeriod();
  const usage = await db.query.usageRecords.findFirst({
    where: and(
      eq(usageRecords.userId, userId),
      eq(usageRecords.type, type),
      eq(usageRecords.period, period)
    ),
  });

  const currentCount = usage?.count || 0;

  if (currentCount >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      used: currentCount,
      message: `You've reached your monthly limit of ${limit} ${type}s. Upgrade to unlock more capacity.`,
    };
  }

  return {
    allowed: true,
    limit,
    remaining: limit - currentCount,
    used: currentCount,
  };
}

// 记录用量计数
export async function recordUsage(userId: string, type: UsageType, count = 1): Promise<void> {
  const period = getCurrentPeriod();
  const now = new Date();

  await db.insert(usageRecords)
    .values({
      id: crypto.randomUUID(),
      userId,
      type,
      period,
      count,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [usageRecords.userId, usageRecords.type, usageRecords.period],
      set: {
        count: sql`${usageRecords.count} + ${count}`,
        updatedAt: now,
      },
    });
}

// 获取用户用量统计
export async function getUsageStats(userId: string) {
  const period = getCurrentPeriod();

  const [user, usageRecordsData, policyCountResult] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { plan: true, trialEndsAt: true, priceLockedAt: true, legacyTier: true },
    }),
    db.query.usageRecords.findMany({
      where: and(eq(usageRecords.userId, userId), eq(usageRecords.period, period)),
    }),
    db.select({ count: sql<number>`count(*)::int` })
      .from(policies)
      .where(and(eq(policies.userId, userId), isNull(policies.deletedAt))),
  ]);

  const policyCount = policyCountResult[0]?.count || 0;

  const normalizedPlan = normalizePlan(user?.plan || 'free');
  const { plan: effectivePlan, downgraded } = resolvePlan(normalizedPlan, user?.trialEndsAt ?? null);

  if (downgraded) {
    await db.update(users)
      .set({ plan: effectivePlan })
      .where(eq(users.id, userId));
  }

  const planConfig = getPlanConfig(effectivePlan);
  const { capabilities } = planConfig;

  // PM v1.1：限额数字优先用 getEffectiveLimits（priceLockedAt 决定走 LEGACY 还是 V2）
  // 字段名映射：getEffectiveLimits 返回 publishedRules，旧 limits 用 policies
  const eff = getEffectiveLimits({
    plan: effectivePlan,
    priceLockedAt: user?.priceLockedAt,
    legacyTier: user?.legacyTier,
  });
  const limits = {
    policies: eff.publishedRules,
    executions: eff.evaluations,
    apiCalls: eff.apiCalls,
    apiKeys: eff.apiKeys,
    teamMembers: eff.maxTeamMembers,
  };

  let trialDaysLeft: number | null = null;
  if (effectivePlan === 'trial' && user?.trialEndsAt) {
    const now = new Date();
    const diff = user.trialEndsAt.getTime() - now.getTime();
    trialDaysLeft = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  const usageByType: Record<string, number> = {};
  for (const record of usageRecordsData) {
    usageByType[record.type] = record.count;
  }

  return {
    plan: effectivePlan,
    trialDaysLeft,
    limits,
    usage: {
      executions: usageByType.execution || 0,  // 使用 UsageRecord，与配额检查一致
      executionsLimit: limits.executions,
      policies: policyCount,
      policiesLimit: limits.policies,
      piiScans: usageByType.pii_scan || 0,
      // 证据导出次数（仍读持久计量值 compliance_report，见 EVIDENCE_EXPORT_METRIC）。
      evidenceExports: usageByType.compliance_report || 0,
      apiCalls: usageByType.api_call || 0,
      apiCallsLimit: limits.apiCalls,
    },
    features: {
      piiDetection: capabilities.piiDetection,
      sharing: capabilities.sharing,
      evidenceExport: capabilities.evidenceExport,
      apiAccess: capabilities.apiAccess,
      teamFeatures: capabilities.teamFeatures,
    },
  };
}

// 检查指定功能是否可用
export async function hasFeatureAccess(
  userId: string,
  feature: keyof PlanCapabilities
): Promise<boolean> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { plan: true, trialEndsAt: true },
  });

  if (!user) return false;

  const normalizedPlan = normalizePlan(user.plan);
  const { plan: effectivePlan, downgraded } = resolvePlan(normalizedPlan, user.trialEndsAt);

  if (downgraded) {
    await db.update(users)
      .set({ plan: effectivePlan })
      .where(eq(users.id, userId));
  }

  const capabilities = getPlanConfig(effectivePlan).capabilities as PlanCapabilities;
  const value = capabilities[feature];

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    // -1 sentinel = unlimited; any positive quota = available.
    return value === -1 || value > 0;
  }

  return Boolean(value);
}

/**
 * 解析用户当前的自定义词汇配额。所有 customLexicon-相关 service 层调用都走
 * 这个统一入口：返回 maxTerms（-1 = 无限）、bulkAsync 能力、allowed 兜底。
 *
 * 复用 hasFeatureAccess 的 trial 过期自动降级写回逻辑，确保 plan 状态与
 * cron-window 行为一致。
 */
export async function getLexiconQuota(
  userId: string,
): Promise<{ maxTerms: number; bulkAsync: boolean; allowed: boolean }> {
  const ctx = await getLexiconQuotaWithContext(userId);
  return { maxTerms: ctx.maxTerms, bulkAsync: ctx.bulkAsync, allowed: ctx.allowed };
}

/**
 * 返回 quota + 触发上下文(当前 plan、是否刚从 trial 降级)。前端 Pro-gate /
 * 降级横幅需要这些信息以解释"为什么"——只关心额度数值的调用方继续用
 * getLexiconQuota。
 */
export async function getLexiconQuotaWithContext(userId: string): Promise<{
  maxTerms: number;
  bulkAsync: boolean;
  allowed: boolean;
  plan: PlanType;
  downgraded: boolean;
  trialEndsAt: Date | null;
}> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { plan: true, trialEndsAt: true },
  });

  if (!user) {
    return {
      maxTerms: 0,
      bulkAsync: false,
      allowed: false,
      plan: 'free',
      downgraded: false,
      trialEndsAt: null,
    };
  }

  const normalizedPlan = normalizePlan(user.plan);
  const { plan: effectivePlan, downgraded } = resolvePlan(normalizedPlan, user.trialEndsAt);

  if (downgraded) {
    await db
      .update(users)
      .set({ plan: effectivePlan })
      .where(eq(users.id, userId));
  }

  const capabilities = getPlanConfig(effectivePlan).capabilities as PlanCapabilities;
  const maxTerms = capabilities.customLexiconMaxTerms;
  const bulkAsync = capabilities.customLexiconBulkUploadAsync;
  const allowed = capabilities.customLexicon && (maxTerms === -1 || maxTerms > 0);

  return {
    maxTerms,
    bulkAsync,
    allowed,
    plan: effectivePlan,
    downgraded,
    trialEndsAt: user.trialEndsAt,
  };
}
