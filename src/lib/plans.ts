// src/lib/plans.ts
// 单一真相源：集中管理订阅计划的展示、配额与价格配置

// ==================== 货币配置 ====================
export const CURRENCY_CONFIG = {
  USD: { symbol: '$', code: 'USD', locale: 'en-US' },
  CNY: { symbol: '¥', code: 'CNY', locale: 'zh-CN' },
  EUR: { symbol: '€', code: 'EUR', locale: 'de-DE' },
} as const;

export type CurrencyCode = keyof typeof CURRENCY_CONFIG;

// 语言到默认货币的映射
export const LOCALE_CURRENCY_MAP: Record<string, CurrencyCode> = {
  en: 'USD',
  zh: 'CNY',
  de: 'EUR',
  fr: 'EUR',
};

// 多币种价格配置
// PM 05 §2：Pro 公开价 = ¥299 / $39 / €36 per seat / month
export const PLAN_PRICES = {
  pro: {
    USD: { monthly: 39, yearly: 374 },
    CNY: { monthly: 299, yearly: 2870 },
    EUR: { monthly: 36, yearly: 346 },
  },
} as const;

// 多币种 Stripe 价格 ID 配置
// 环境变量命名规则：NEXT_PUBLIC_STRIPE_{PLAN}_{INTERVAL}_{CURRENCY}_PRICE_ID
export const STRIPE_PRICE_IDS: Record<string, Record<CurrencyCode, { monthly: string | undefined; yearly: string | undefined }>> = {
  pro: {
    USD: {
      monthly: process.env.NEXT_PUBLIC_STRIPE_PRO_MONTHLY_PRICE_ID,
      yearly: process.env.NEXT_PUBLIC_STRIPE_PRO_YEARLY_PRICE_ID,
    },
    CNY: {
      monthly: process.env.NEXT_PUBLIC_STRIPE_PRO_MONTHLY_CNY_PRICE_ID,
      yearly: process.env.NEXT_PUBLIC_STRIPE_PRO_YEARLY_CNY_PRICE_ID,
    },
    EUR: {
      monthly: process.env.NEXT_PUBLIC_STRIPE_PRO_MONTHLY_EUR_PRICE_ID,
      yearly: process.env.NEXT_PUBLIC_STRIPE_PRO_YEARLY_EUR_PRICE_ID,
    },
  },
};

// ==================== 类型定义 ====================
type BillingPrice = {
  monthly: number | null;
  yearly: number | null;
};

type PlanLimits = {
  policies: number;
  executions: number;
  apiCalls: number;  // API 调用配额（独立于 Web 执行）
  apiKeys: number;
  teamMembers: number;
};

export type PlanCapabilities = {
  piiDetection: 'basic' | 'advanced';
  sharing: boolean;
  /** 证据导出（基于真实执行链）。旧名 complianceReports（已重命名，语义从「假合规分」改为「真证据导出」）。 */
  evidenceExport: boolean;
  apiAccess: boolean;
  teamFeatures: boolean;
  sso?: boolean;
  auditLogs?: boolean;
  customLexicon: boolean;
  customLexiconMaxTerms: number;
  customLexiconBulkUploadAsync: boolean;
  customIntegrations?: boolean;
};

// Plan feature keys for i18n (use with t('billing.plans.features.{key}'))
// PM v1.1：统一用于首页和账单页的功能描述
export const PLAN_FEATURE_KEYS = {
  // Free 计划
  rules5: 'rules5',
  evaluations1k: 'evaluations1k',
  aiDrafts20: 'aiDrafts20',
  allLanguagePacks: 'allLanguagePacks',
  audit7days: 'audit7days',
  // Pro 计划
  unlimitedTeamMembers: 'unlimitedTeamMembers',
  rules100: 'rules100',
  evaluations50k: 'evaluations50k',
  aiDrafts500: 'aiDrafts500',
  audit90days: 'audit90days',
  inviteReviewersPaidSeat: 'inviteReviewersPaidSeat',
  reviewerNotAuthor: 'reviewerNotAuthor',
  soxCompliant: 'soxCompliant',
  stripeBilling: 'stripeBilling',
  customDomainVocabulary: 'customDomainVocabulary',
  // Enterprise 计划
  multiTeamCustomApprovals: 'multiTeamCustomApprovals',
  /**
   * 审计日志不限期保留（issue #396）。
   *
   * ★与 audit7days / audit90days 同属一条"审计留存"轴，三者**互斥**：
   * 一个 plan 只应命中其一。`AUDIT_KEY_TO_DAYS` 把前两者映射成天数，
   * 本 key 映射成"不清理"。
   *
   * 此前 enterprise 一个 audit key 都没有，于是留存期在代码里**无从判断**——
   * 留存 GC 只能保守地跳过不删（并留痕）。加上本 key 后语义变成**显式声明**：
   * 不是"查不到所以不敢删"，而是"产品明确承诺不限期"。
   */
  auditUnlimited: 'auditUnlimited',
  unlimitedRulesEvaluations: 'unlimitedRulesEvaluations',
  unlimitedAiDraftsByok: 'unlimitedAiDraftsByok',
  customIndustryLexicons: 'customIndustryLexicons',
  hashChainAuditSignature: 'hashChainAuditSignature',
  ssoSamlOidc: 'ssoSamlOidc',
  customDeployment: 'customDeployment',
  slaGuarantee: 'slaGuarantee',
  dedicatedSupport: 'dedicatedSupport',
} as const;

// PM v1.1 三档：Free / Pro / Enterprise
// `trial` 仅作为内部数据模型保留（用户旅程中的临时状态），不展示在 Pricing
// `team` 已下线（无客户）；DB enum 'team' 值保留以避免 schema migration
export const PLANS = {
  free: {
    name: 'free',
    limits: {
      policies: 5,
      executions: 1000,
      apiCalls: 0,
      apiKeys: 0,
      teamMembers: 1,
    },
    featureKeys: ['rules5', 'evaluations1k', 'aiDrafts20', 'allLanguagePacks', 'audit7days'],
    capabilities: {
      piiDetection: 'basic',
      sharing: false,
      evidenceExport: false,
      apiAccess: false,
      teamFeatures: false,
      customLexicon: false,
      customLexiconMaxTerms: 0,
      customLexiconBulkUploadAsync: false,
    },
    price: { monthly: 0, yearly: 0 },
    stripePriceId: null,
  },
  trial: {
    name: 'trial',
    limits: {
      policies: 100,
      executions: 50000,
      apiCalls: 5000,
      apiKeys: 5,
      teamMembers: -1,
    },
    featureKeys: ['rules100', 'evaluations50k', 'aiDrafts500', 'audit90days'],
    capabilities: {
      piiDetection: 'advanced',
      sharing: true,
      evidenceExport: true,
      apiAccess: true,
      teamFeatures: true,
      customLexicon: true,
      customLexiconMaxTerms: 500,
      customLexiconBulkUploadAsync: false,
    },
    price: { monthly: 0, yearly: 0 },
    stripePriceId: null,
    trialDays: 14,
  },
  pro: {
    name: 'pro',
    limits: {
      policies: 100,
      executions: 50000,
      apiCalls: 5000,
      apiKeys: 5,
      teamMembers: -1,
    },
    featureKeys: [
      'unlimitedTeamMembers',
      'rules100',
      'evaluations50k',
      'aiDrafts500',
      'allLanguagePacks',
      'audit90days',
      'inviteReviewersPaidSeat',
      'reviewerNotAuthor',
      'soxCompliant',
      'stripeBilling',
      'customDomainVocabulary',
    ],
    capabilities: {
      piiDetection: 'advanced',
      sharing: true,
      evidenceExport: true,
      apiAccess: true,
      teamFeatures: true,
      auditLogs: true,
      customLexicon: true,
      customLexiconMaxTerms: 5000,
      customLexiconBulkUploadAsync: true,
    },
    price: PLAN_PRICES.pro.USD,
    stripePriceId: {
      monthly: process.env.NEXT_PUBLIC_STRIPE_PRO_MONTHLY_PRICE_ID,
      yearly: process.env.NEXT_PUBLIC_STRIPE_PRO_YEARLY_PRICE_ID,
    },
  },
  // 'team' 档位已下线（PM v1.1 三档化）。DB enum 'team' 值保留以兼容历史数据。
  // 若未来需要恢复，参考 git 历史 commit pre-2026-05。
  team: {
    name: 'team',
    limits: {
      policies: 100,
      executions: 50000,
      apiCalls: 5000,
      apiKeys: 5,
      teamMembers: -1,
    },
    featureKeys: [
      'unlimitedTeamMembers',
      'rules100',
      'evaluations50k',
      'aiDrafts500',
      'allLanguagePacks',
      'audit90days',
      'reviewerNotAuthor',
      'soxCompliant',
      'customDomainVocabulary',
    ],
    capabilities: {
      piiDetection: 'advanced',
      sharing: true,
      evidenceExport: true,
      apiAccess: true,
      teamFeatures: true,
      sso: true,
      auditLogs: true,
      customLexicon: true,
      customLexiconMaxTerms: 25000,
      customLexiconBulkUploadAsync: true,
    },
    price: PLAN_PRICES.pro.USD,
    stripePriceId: null,
  },
  enterprise: {
    name: 'enterprise',
    limits: {
      policies: -1,
      executions: -1,
      apiCalls: -1,
      apiKeys: -1,
      teamMembers: -1,
    },
    featureKeys: [
      'multiTeamCustomApprovals',
      // 审计留存：不限期（issue #396）。free=audit7days / pro,team=audit90days，
      // 三者同轴互斥，留存 GC 据此决定清理阈值。
      'auditUnlimited',
      'unlimitedRulesEvaluations',
      'unlimitedAiDraftsByok',
      'customIndustryLexicons',
      'hashChainAuditSignature',
      'ssoSamlOidc',
      'customDeployment',
      'slaGuarantee',
      'dedicatedSupport',
      'customDomainVocabulary',
    ],
    capabilities: {
      piiDetection: 'advanced',
      sharing: true,
      evidenceExport: true,
      apiAccess: true,
      teamFeatures: true,
      sso: true,
      auditLogs: true,
      customLexicon: true,
      customLexiconMaxTerms: -1,
      customLexiconBulkUploadAsync: true,
      customIntegrations: true,
    },
    price: { monthly: null, yearly: null },
    stripePriceId: null,
  },
} as const satisfies Record<
  string,
  {
    name: string;
    limits: PlanLimits;
    featureKeys: readonly string[];
    capabilities: PlanCapabilities;
    price: BillingPrice;
    stripePriceId: { monthly: string | undefined | null; yearly: string | undefined | null } | null;
    trialDays?: number;
  }
>;

export type PlanType = keyof typeof PLANS;
export type PlanConfig = (typeof PLANS)[PlanType];
export type PlanLimitType = keyof PlanConfig['limits'];
export type BillingInterval = keyof PlanConfig['price'];

/**
 * 根据计划与币种返回价格，确保单一真相源
 * PM v1.1：team 档已下线，按 pro 等价返回（防御性兜底）
 */
export function getPlanPrice(plan: PlanType, currency: CurrencyCode = 'USD'): BillingPrice {
  switch (plan) {
    case 'pro':
    case 'team':
      return PLAN_PRICES.pro[currency];
    case 'free':
    case 'trial':
      return { monthly: 0, yearly: 0 };
    case 'enterprise':
    default:
      return { monthly: null, yearly: null };
  }
}

export function getPlanConfig(plan: PlanType): PlanConfig {
  return PLANS[plan];
}

export function getPlanLimit(plan: PlanType, limitType: PlanLimitType): number {
  return PLANS[plan].limits[limitType];
}

export function hasFeature(plan: PlanType, feature: string): boolean {
  return (PLANS[plan].featureKeys as readonly string[]).includes(feature);
}

export function isUnlimited(limit: number): boolean {
  return limit === -1;
}

export function canAccessApiKeys(plan: PlanType): boolean {
  // -1 = unlimited（Enterprise）；> 0 = 有限额度（Pro / Trial）；0 = 无 API 访问（Free）
  const apiKeys = PLANS[plan].limits.apiKeys;
  return apiKeys === -1 || apiKeys > 0;
}

export function hasCapability(plan: PlanType, capability: keyof PlanCapabilities): boolean {
  const capabilities = PLANS[plan].capabilities as PlanCapabilities;
  return Boolean(capabilities[capability]);
}

/**
 * 获取计划的 Stripe 价格 ID（支持多币种）
 * @param plan 计划类型
 * @param interval 计费周期
 * @param currency 货币代码（默认 USD）
 */
export function getPlanStripePriceId(
  plan: PlanType,
  interval: BillingInterval,
  currency: CurrencyCode = 'USD'
): string | null {
  // 检查是否有多币种价格 ID 配置
  const currencyPriceIds = STRIPE_PRICE_IDS[plan]?.[currency];
  if (currencyPriceIds) {
    const priceId = currencyPriceIds[interval];
    if (priceId) return priceId;
  }

  // 回退到 USD 价格 ID（如果当前货币未配置）
  if (currency !== 'USD') {
    const usdPriceIds = STRIPE_PRICE_IDS[plan]?.USD;
    if (usdPriceIds) {
      const usdPriceId = usdPriceIds[interval];
      if (usdPriceId) return usdPriceId;
    }
  }

  // 最后回退到 PLANS 中的旧配置（兼容性）
  const legacyIds = PLANS[plan].stripePriceId;
  return legacyIds ? legacyIds[interval] ?? null : null;
}

// ==================== 多币种价格函数 ====================

/**
 * 根据语言获取默认货币
 */
export function getCurrencyForLocale(locale: string): CurrencyCode {
  return LOCALE_CURRENCY_MAP[locale] || 'USD';
}

/**
 * 格式化价格显示
 */
export function formatPrice(amount: number, currency: CurrencyCode): string {
  const config = CURRENCY_CONFIG[currency];
  return new Intl.NumberFormat(config.locale, {
    style: 'currency',
    currency: config.code,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * 获取 Pro 计划的价格
 */
export function getProPrice(currency: CurrencyCode, interval: BillingInterval): number {
  return PLAN_PRICES.pro[currency][interval];
}

// ============================================================================
// v1.1 PM 重构：分离档位与组织实体（详见 aster-deploy/docs/pm/05-pricing-packaging.md）
// ----------------------------------------------------------------------------
// 关键决策（v3 简化：无老 Team 客户）：
//   1. 公开 Pricing 只展示三档：Free / Pro / Enterprise
//   2. DB enum 'team' / 'trial' 值保留（避免 schema migration 风险，无客户实际触发）
//   3. Pro = 1 seat 起步；启用审批流需邀请第二位 reviewer（PM_PLAN_LIMITS_V2.pro.approvalSeatThreshold）
//   4. 限额渐进 reconcile：priceLockedAt < 2026-06-01 走 LEGACY_PLAN_LIMITS，新签走 PM_PLAN_LIMITS_V2
// ============================================================================

/** 公开 Pricing 页展示的档位 */
export const PUBLIC_PRICING_TIERS = ['free', 'pro', 'enterprise'] as const;
export type PublicPricingTier = (typeof PUBLIC_PRICING_TIERS)[number];

/** 遗留档位（不在公开页展示，仅作为 DB enum 历史值兼容） */
export const LEGACY_TIERS = ['trial', 'team'] as const;
export type LegacyTier = (typeof LEGACY_TIERS)[number];

/** 限额切换时间点 — 在此之前订阅的用户走旧限额（老用户保护） */
export const PRICE_LOCKED_CUTOFF = new Date('2026-06-01T00:00:00Z');

/**
 * v1.1 PM 限额（新签客户）
 * 与 aster-deploy/docs/pm/05-pricing-packaging.md 中的三档矩阵一致
 */
export const PM_PLAN_LIMITS_V2 = {
  free: {
    publishedRules: 5,
    evaluations: 1000,
    apiCalls: 0,
    apiKeys: 0,
    auditRetentionDays: 7,
    maxTeamMembers: 1,
    approvalRequired: false,
    concurrentReplayBatches: 0,   // What-If：免费档不提供（ADR 0034 §7.2）
    minSeats: 1,
  },
  pro: {
    publishedRules: 100,
    evaluations: 50000,
    apiCalls: 5000,
    apiKeys: 5,
    auditRetentionDays: 90,
    maxTeamMembers: -1,
    approvalRequired: true,
    concurrentReplayBatches: 1,   // What-If：一次一个批次（ADR 0034 §7.2）
    minSeats: 1,
    /** 启用审批流需要的最低席位数（reviewer ≠ author 的硬性要求） */
    approvalSeatThreshold: 2,
  },
  enterprise: {
    publishedRules: -1,
    evaluations: -1,
    apiCalls: -1,
    apiKeys: -1,
    auditRetentionDays: -1,
    maxTeamMembers: -1,
    approvalRequired: true,
    concurrentReplayBatches: -1,  // What-If：按合同配置，-1=不限（ADR 0034 §7.2）
    customRoles: true,
    minSeats: 1,
  },
} as const;

/**
 * 老用户限额快照（priceLockedAt < 2026-06-01 的客户）
 * v3：team 档已下线无客户；保留 'trial' 作为内部状态兜底
 */
export const LEGACY_PLAN_LIMITS = {
  free: { publishedRules: 3, evaluations: 100, apiCalls: 0, apiKeys: 0, auditRetentionDays: 7, maxTeamMembers: 1, approvalRequired: false, concurrentReplayBatches: 0, minSeats: 1 },
  trial: { publishedRules: 25, evaluations: 5000, apiCalls: 1000, apiKeys: 5, auditRetentionDays: 30, maxTeamMembers: 5, approvalRequired: false, concurrentReplayBatches: 1, minSeats: 1 },
  pro: { publishedRules: 25, evaluations: 5000, apiCalls: 5000, apiKeys: 5, auditRetentionDays: 90, maxTeamMembers: 5, approvalRequired: false, concurrentReplayBatches: 1, minSeats: 1 },
  enterprise: { publishedRules: -1, evaluations: -1, apiCalls: -1, apiKeys: -1, auditRetentionDays: -1, maxTeamMembers: -1, approvalRequired: true, concurrentReplayBatches: -1, minSeats: 1 },
} as const;

/**
 * 计算用户实际生效的限额
 *
 * 策略：
 *   - 没有 priceLockedAt（未付费 / 新注册）→ 走 V2 新限额
 *   - priceLockedAt < 2026-06-01（老付费用户）→ 走 LEGACY 限额，保持原服务体验
 *   - priceLockedAt >= 2026-06-01（新签客户）→ 走 V2 新限额
 *
 * v3：legacyTier='team' grandfather 路径已移除（无客户）。
 * 'team' / 'trial' 档位走兜底分支映射到 pro 限额。
 */
export function getEffectiveLimits(user: {
  plan: PlanType;
  priceLockedAt?: Date | string | null;
  legacyTier?: string | null;
}): {
  publishedRules: number;
  evaluations: number;
  apiCalls: number;
  apiKeys: number;
  auditRetentionDays: number;
  maxTeamMembers: number;
  approvalRequired: boolean;
  minSeats: number;
  approvalSeatThreshold?: number;
  customRoles?: boolean;
  /** What-If 并发批次上限（ADR 0034 §7.2）。0=无此功能，-1=不限。 */
  concurrentReplayBatches: number;
} {
  const lockedAt = user.priceLockedAt
    ? typeof user.priceLockedAt === 'string'
      ? new Date(user.priceLockedAt)
      : user.priceLockedAt
    : null;

  // 老用户保护：在切换日之前签的，走老限额（不影响其原本能用的功能）
  if (lockedAt && lockedAt < PRICE_LOCKED_CUTOFF) {
    const legacyKey = user.plan as keyof typeof LEGACY_PLAN_LIMITS;
    if (LEGACY_PLAN_LIMITS[legacyKey]) {
      return { ...LEGACY_PLAN_LIMITS[legacyKey] };
    }
  }

  // 'team' / 'trial' 历史 enum 值映射到 pro 限额（PM v1.1 三档化）
  const normalizedPlan: PlanType =
    user.plan === 'team' || user.plan === 'trial' ? 'pro' : user.plan;

  const v2Key = normalizedPlan as keyof typeof PM_PLAN_LIMITS_V2;
  if (PM_PLAN_LIMITS_V2[v2Key]) {
    return { ...PM_PLAN_LIMITS_V2[v2Key] };
  }

  return { ...PM_PLAN_LIMITS_V2.free };
}

/**
 * UI 展示用：将后端 plan 映射为公开档位
 * v3：legacyTier 不再影响展示（无 grandfather 客户）
 */
export function getDisplayPlan(user: { plan: PlanType; legacyTier?: string | null }): PublicPricingTier {
  if (user.plan === 'enterprise') return 'enterprise';
  if (user.plan === 'pro' || user.plan === 'team' || user.plan === 'trial') return 'pro';
  return 'free';
}

/**
 * 年付折扣率（v1.1 PM 决策：年付 -20%）
 */
export const ANNUAL_DISCOUNT_RATE = 0.8;

/**
 * 由月价计算年价（× 12 × 0.8）
 */
export function getAnnualAmount(monthly: number): number {
  return Math.round(monthly * 12 * ANNUAL_DISCOUNT_RATE);
}

/**
 * 公开页用的本地化货币选择
 * 与 getCurrencyForLocale 行为一致，仅命名上对齐 PM 文档
 */
export function getPublicCurrency(locale: string): CurrencyCode {
  return getCurrencyForLocale(locale);
}

/**
 * v1.1 三档 Pro 公开价格（月）
 *   - CNY ¥299
 *   - USD $39（Q5 拍板）
 *   - EUR €36（≈ USD 折算）
 */
export const PUBLIC_PRO_MONTHLY_PRICE: Record<CurrencyCode, number> = {
  CNY: 299,
  USD: 39,
  EUR: 36,
};

/**
 * Stripe priceId 反向查找表
 * 输入 priceId → 输出 { plan, interval, currency }
 *
 * 用于 webhook 处理时识别订阅档位，替代脆弱的 priceId.includes('team')。
 * 同时是未来扩展 SKU（如 enterprise-vpc / pro-annual-discount / edu）的统一入口。
 */
export type PriceIdInfo = {
  plan: PlanType;
  interval: BillingInterval;
  currency: CurrencyCode;
};

export function getPriceIdMap(): Record<string, PriceIdInfo> {
  const map: Record<string, PriceIdInfo> = {};
  for (const [planName, byCurrency] of Object.entries(STRIPE_PRICE_IDS)) {
    for (const [currencyCode, intervals] of Object.entries(byCurrency)) {
      for (const interval of ['monthly', 'yearly'] as const) {
        const priceId = intervals[interval];
        if (priceId) {
          map[priceId] = {
            plan: planName as PlanType,
            interval,
            currency: currencyCode as CurrencyCode,
          };
        }
      }
    }
  }
  return map;
}

/**
 * 通过 Stripe priceId 反查档位信息
 * 找不到时返回 null（webhook 应作为 unknown 处理，告警但不崩溃）
 */
export function lookupPriceId(priceId: string | null | undefined): PriceIdInfo | null {
  if (!priceId) return null;
  return getPriceIdMap()[priceId] ?? null;
}
