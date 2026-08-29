// AI 配额计算 + 异常检测
// 详见 aster-deploy/docs/pm/07-ai-billing.md

import { db, users, aiUsageRecords, aiKeyBindings } from '@/lib/prisma';
import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { getEffectiveLimits, type PlanType } from '@/lib/plans';
import { encryptForAudit } from '@/lib/ai-audit-vault';
import { redactPii } from '@/lib/ai-pii-redactor';

// ============================================================================
// 月度配额（次数）
// ============================================================================

/** Free 月配额（PM 文档 07-ai-billing.md）*/
export const AI_MONTHLY_QUOTA = {
  free: 20,
  trial: 100,
  pro: 500,        // 每席位
  team: 500,
  enterprise: -1,  // 无限
} as const;

/** 速率限制（每分钟）*/
export const AI_RATE_LIMIT_PER_MINUTE = {
  free: 5,
  trial: 15,
  pro: 30,
  team: 30,
  enterprise: 200,
} as const;

/** 速率限制（每小时） */
export const AI_RATE_LIMIT_PER_HOUR = {
  free: 20,
  trial: 80,
  pro: 200,
  team: 200,
  enterprise: 1000,
} as const;

export type AiQuotaResult =
  | { allowed: true; remaining: number; limit: number; usedByok: boolean }
  | {
      allowed: false;
      reason: 'ai_quota_exhausted' | 'ai_rate_limited' | 'ai_banned' | 'ai_email_unverified';
      message: string;
      retryAfterSec?: number;
    };

/**
 * 检查用户当前是否可调 AI
 *
 * 顺序：
 *   1. 风险层 / 邮箱验证门
 *   2. 用户是否被自动封禁
 *   3. 月度次数配额（Phase 2：BYOK 用本次调用真的用了用户 key，跳过平台月配额）
 *   4. 每分钟速率（BYOK 也受限，防高频打爆代理/上游）
 *   5. 每小时速率（同上）
 *
 * @param opts.usedByok 本次是否用 BYOK（由 cloud 是否成功注入 `_byok` envelope 权威决定）。
 *   true 时跳过平台月配额，但保留 ban / 风险层 / 邮箱验证 / 速率保护。
 */
export async function checkAiQuota(
  userId: string,
  opts: { usedByok?: boolean } = {}
): Promise<AiQuotaResult> {
  const usedByok = opts.usedByok === true;
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      plan: true,
      priceLockedAt: true,
      legacyTier: true,
      aiBannedUntil: true,
      aiBanReason: true,
      emailVerified: true,
      riskTier: true,
    },
  });
  if (!user) {
    return { allowed: false, reason: 'ai_quota_exhausted', message: 'user not found' };
  }

  // 注册风险层 → 配额乘子 + email-verified 硬要求
  const { policyForTier } = await import('@/lib/risk-tier');
  const tier = (user.riskTier ?? 0) as 0 | 1 | 2 | 3 | 4;
  const riskPolicy = policyForTier(tier);

  // tier 4 + tier 3 完全禁用 AI
  if (riskPolicy.aiQuotaMultiplier === 0) {
    return {
      allowed: false,
      reason: 'ai_banned',
      message: `AI 功能因账户风险等级被禁用（tier ${tier}）。如需启用请联系 support@aster-lang.cloud。`,
    };
  }

  // tier ≥ 2 强制 email-verified（不再走 plan 分支，所有 plan 都要求）
  if (riskPolicy.requireEmailVerifiedForApi && !user.emailVerified) {
    return {
      allowed: false,
      reason: 'ai_email_unverified',
      message: '账户处于审查状态，请先完成邮箱验证以解锁 AI 功能。验证邮件已发送至您注册邮箱。',
    };
  }

  // L0: BYOK 配额 bypass —— 【暂时禁用，止血】。
  //
  // 历史行为：用户绑定了 active BYOK key 就无条件放行（unlimited）。但真实 LLM 推理
  // 从不使用 BYOK key —— 所有 generate/suggest/complete 都走 aster-api 的平台 key
  // （ConfigTenantLlmKeyProvider 取 Vault 平台 key；cloud 代理只转发 tenant + HMAC，
  // 不传 BYOK key）。于是"无条件 bypass 平台配额"让 BYOK 用户用 Aster 的平台 LLM 预算
  // 做无限 AI，而非消耗自己的 key —— 成本泄漏。
  //
  // 止血：BYOK 用户暂时也走下面的平台配额路径（不再无条件放行）。待 BYOK 真正接入推理
  // （cloud 转发解密 key → aster-api per-request override → 用用户 key 真实调用）后，
  // 再在"确认本次会用 BYOK 推理"的前提下恢复 bypass。届时 usedByok 才应为 true。
  //
  // 注意：不在此处 stamp AiKeyBinding.lastUsedAt —— 该字段语义是"最后一次真实使用"，
  // BYOK 尚未用于推理，标记它会造假。lastUsedAt 的回写在 BYOK 推理接入后与真实调用同步。

  // L0.5: Free 档强制邮箱验证才解锁配额（trial / pro / team / enterprise 不受影响）
  // 详见 07-ai-billing.md "反多重注册"
  if (user.plan === 'free' && !user.emailVerified) {
    return {
      allowed: false,
      reason: 'ai_email_unverified',
      // ★不要写「验证邮件已发送」——本函数不发信，发信由用户在设置页
      //   主动触发（/api/user/send-verification）。此前这句是不实的：
      //   当时全仓根本没有发信路径，用户等一封永远不会来的邮件。
      message: '请先完成邮箱验证以解锁 AI 功能：在「设置 → 邮箱验证」中发送验证邮件。',
    };
  }

  // L1: 自动封禁
  if (user.aiBannedUntil && user.aiBannedUntil > new Date()) {
    const sec = Math.ceil((user.aiBannedUntil.getTime() - Date.now()) / 1000);
    return {
      allowed: false,
      reason: 'ai_banned',
      message: user.aiBanReason || '账号被临时禁用 AI 功能',
      retryAfterSec: sec,
    };
  }

  const plan = user.plan as PlanType;

  // L2: 月度次数配额（base × riskTier 乘子；tier 0 trusted = ×1，tier 1 = ×0.5 …）
  // Phase 2：BYOK 本次用的是用户自己的 key，不消耗平台预算 → 跳过平台月配额（视为无限），
  // 但上面的 ban/风险/邮箱与下面的速率保护仍生效。
  const baseLimit = AI_MONTHLY_QUOTA[plan as keyof typeof AI_MONTHLY_QUOTA] ?? 20;
  const monthlyLimit = usedByok
    ? -1
    : (baseLimit === -1
        ? -1
        : Math.max(1, Math.floor(baseLimit * riskPolicy.aiQuotaMultiplier)));
  if (monthlyLimit !== -1) {
    const period = currentPeriod();
    const monthlyCount = await countSuccessfulCalls(userId, period);
    if (monthlyCount >= monthlyLimit) {
      return {
        allowed: false,
        reason: 'ai_quota_exhausted',
        message: tier > 0
          ? `本月 AI 配额已用尽（${monthlyCount} / ${monthlyLimit}，账户风险等级 ${tier} 影响配额）。绑定自己的 OpenAI key 或联系 support。`
          : `本月 AI 配额已用尽（${monthlyCount} / ${monthlyLimit}）。绑定自己的 OpenAI key 或升级套餐。`,
      };
    }
  }

  // L3: 每分钟速率
  const perMinuteLimit = AI_RATE_LIMIT_PER_MINUTE[plan as keyof typeof AI_RATE_LIMIT_PER_MINUTE] ?? 5;
  const lastMinute = await countCallsSince(userId, new Date(Date.now() - 60_000));
  if (lastMinute >= perMinuteLimit) {
    return {
      allowed: false,
      reason: 'ai_rate_limited',
      message: `请求太频繁（${lastMinute}/${perMinuteLimit} 每分钟）`,
      retryAfterSec: 60,
    };
  }

  // L4: 每小时速率
  const perHourLimit = AI_RATE_LIMIT_PER_HOUR[plan as keyof typeof AI_RATE_LIMIT_PER_HOUR] ?? 20;
  const lastHour = await countCallsSince(userId, new Date(Date.now() - 3_600_000));
  if (lastHour >= perHourLimit) {
    return {
      allowed: false,
      reason: 'ai_rate_limited',
      message: `1 小时内请求达到上限（${lastHour}/${perHourLimit}）`,
      retryAfterSec: 3600,
    };
  }

  // 计算剩余
  void getEffectiveLimits; // 保留 import，未来扩展用
  const period = currentPeriod();
  const monthlyCount = await countSuccessfulCalls(userId, period);
  return {
    allowed: true,
    remaining: monthlyLimit === -1 ? -1 : Math.max(0, monthlyLimit - monthlyCount),
    limit: monthlyLimit,
    usedByok,
  };
}

/**
 * 调用完成后记录用量（异步、不阻塞业务路径）
 */
export async function recordAiUsage(params: {
  userId: string;
  teamId?: string | null;
  callKind: 'generate' | 'explain' | 'suggest' | 'complete' | 'repair';
  model: string;
  promptTokens: number;
  completionTokens: number;
  usedByok: boolean;
  /** BYOK 绑定 id（Phase 3）：usedByok && status=success 时据此 stamp AiKeyBinding.lastUsedAt。 */
  aiKeyBindingId?: string | null;
  /**
   * 请求关联 id（issue #185）：非空则按 requestId upsert 同一行——cloud 先记占位 0/0 驱动配额，
   * aster-api 后带同一 requestId 回填真实 token。竞态安全：占位（0/0）不覆盖已有真实 token，
   * 回填（非 0）覆盖占位；createdAt/status 保留首次值。null 则插新行（老行为）。
   */
  requestId?: string | null;
  status: 'success' | 'quota_exhausted' | 'rate_limited' | 'banned' | 'api_error' | 'blocked_unsafe';
  promptHash?: string | null;
  /** 调用审计：原始 prompt / completion，会被加密存 180 天 */
  prompt?: string | null;
  completion?: string | null;
  /** PII 脱敏后的 prompt 明文（永久保留） */
  redactedPrompt?: string | null;
  /** 内容安全标记（jailbreak / pii / toxic / blocked_reason） */
  safetyFlags?: {
    jailbreak_attempt?: boolean;
    pii_detected?: boolean;
    toxic?: boolean;
    blocked_reason?: string;
  } | null;
}): Promise<void> {
  const cost = estimateCostCents(params.model, params.promptTokens, params.completionTokens);
  const usedAt = new Date(); // insert 与 lastUsedAt stamp 共用同一时刻
  const hasTokens = params.promptTokens > 0 || params.completionTokens > 0;
  const values = {
    id: globalThis.crypto.randomUUID(),
    userId: params.userId,
    teamId: params.teamId ?? null,
    periodMonth: currentPeriod(usedAt),
    callKind: params.callKind,
    model: params.model,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    costCents: cost,
    usedByok: params.usedByok,
    status: params.status,
    promptHash: params.promptHash ?? null,
    encryptedPrompt: encryptForAudit(params.prompt) as unknown as string | null,
    encryptedCompletion: encryptForAudit(params.completion) as unknown as string | null,
    // 调用方未显式传 redactedPrompt 时自动从 prompt 脱敏生成
    redactedPrompt:
      params.redactedPrompt ?? (params.prompt ? redactPii(params.prompt) : null),
    safetyFlags: params.safetyFlags ?? null,
    requestId: params.requestId ?? null,
    createdAt: usedAt,
  };

  if (params.requestId) {
    // issue #185：按 requestId upsert 同一行（占位 + 回填 = 一笔，不双记账）。
    // 竞态安全（Codex 审查）：
    //   - 只有本次带真实 token（hasTokens）才覆盖 token/cost/model（回填晚到也能生效）；
    //     否则保留 EXCLUDED 之外的已有值（占位晚到不会把已回填的真实 token 清 0）。
    //   - createdAt / status / callKind / userId 保留首次值（COALESCE 到已有行，不被占位/回填改写）。
    //   - 审计字段（prompt/completion/hash/safety）只在本次带值时补，不覆盖已有。
    await db
      .insert(aiUsageRecords)
      .values(values)
      .onConflictDoUpdate({
        target: aiUsageRecords.requestId,
        set: {
          promptTokens: hasTokens ? values.promptTokens : sql`${aiUsageRecords.promptTokens}`,
          completionTokens: hasTokens ? values.completionTokens : sql`${aiUsageRecords.completionTokens}`,
          costCents: hasTokens ? values.costCents : sql`${aiUsageRecords.costCents}`,
          model: hasTokens ? values.model : sql`${aiUsageRecords.model}`,
          usedByok: sql`${aiUsageRecords.usedByok}`,
          promptHash: sql`coalesce(${aiUsageRecords.promptHash}, ${values.promptHash})`,
          encryptedPrompt: sql`coalesce(${aiUsageRecords.encryptedPrompt}, excluded."encryptedPrompt")`,
          encryptedCompletion: sql`coalesce(${aiUsageRecords.encryptedCompletion}, excluded."encryptedCompletion")`,
          redactedPrompt: sql`coalesce(${aiUsageRecords.redactedPrompt}, excluded."redactedPrompt")`,
        },
      });
  } else {
    await db.insert(aiUsageRecords).values(values);
  }

  // Phase 3：真实 BYOK 成功调用 → stamp AiKeyBinding.lastUsedAt，让 dashboard "最近使用"
  // 反映真实推理用量（此前该字段只被 cron healthcheck 更新 → 打后端的 key 永远"从未使用"）。
  // 与 apiKeys usage route 一致的单调守卫（防旧请求晚到把时间戳往回退）+ best-effort（更新失败
  // 不影响已成功的 usage 记录与业务响应）。
  if (params.usedByok && params.status === 'success' && params.aiKeyBindingId) {
    try {
      await db
        .update(aiKeyBindings)
        .set({ lastUsedAt: usedAt, lastErrorAt: null, lastError: null, updatedAt: usedAt })
        .where(
          and(
            eq(aiKeyBindings.id, params.aiKeyBindingId),
            // 纵深防御（Codex 审查）：绑定 userId + active，避免竞态下 stamp 到刚被停用/别人的 binding
            eq(aiKeyBindings.userId, params.userId),
            eq(aiKeyBindings.active, true),
            or(isNull(aiKeyBindings.lastUsedAt), lt(aiKeyBindings.lastUsedAt, usedAt))
          )
        );
    } catch (e) {
      // 不把用户可控的 aiKeyBindingId 拼进格式串——console.warn 首参会被当格式串解析
      // （%s/%d/%o 等）→ 用 %s 占位以参数化传入，规避格式串注入。
      console.warn('[ai-usage] stamp AiKeyBinding.lastUsedAt failed for binding=%s:', params.aiKeyBindingId, e);
    }
  }
}

// ============================================================================
// 内部辅助
// ============================================================================

function currentPeriod(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 本月（UTC）该用户经 **BYOK** key 成功调用消耗的总 token 数（prompt+completion）。
 * ⚠️ aiUsageRecords 无 provider 列 → 这是**每用户跨所有 BYOK key 的总量**,非 per-provider。
 * 供 UI 显示「剩余额度」+ checkAiQuota 对 BYOK tokenQuota enforcement。
 *
 * 「重置额度」水位线：用户点「重置额度」后 users.byokQuotaResetAt 被盖成 now()——此后只统计
 * createdAt >= max(当月初, byokQuotaResetAt) 的用量行（等价「清空本月已用」而不删不可变审计记录）。
 * 用 createdAt 而非 periodMonth 做下界，才能在月中精确从重置时刻起算。
 */
export async function byokTokensUsedThisMonth(
  userId: string,
  at: Date = new Date(),
): Promise<number> {
  // 当月初（UTC）——统计的自然下界。
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  // 用户重置水位线；取 max(月初, resetAt) 作为实际下界（重置只可能把下界往后推，不越月）。
  const u = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { byokQuotaResetAt: true },
  });
  const resetAt = u?.byokQuotaResetAt ?? null;
  const lowerBound = resetAt && resetAt.getTime() > monthStart.getTime() ? resetAt : monthStart;

  const r = await db
    .select({
      t: sql<number>`COALESCE(SUM("promptTokens" + "completionTokens"), 0)::int`,
    })
    .from(aiUsageRecords)
    .where(
      and(
        eq(aiUsageRecords.userId, userId),
        eq(aiUsageRecords.periodMonth, currentPeriod(at)),
        gte(aiUsageRecords.createdAt, lowerBound),
        eq(aiUsageRecords.usedByok, true),
        eq(aiUsageRecords.status, 'success'),
      ),
    );
  return r[0]?.t ?? 0;
}

/**
 * 「重置额度」：把用户 BYOK 用量重置水位线盖成 now()。
 *
 * 不删不可变 aiUsageRecords（加密审计 / 计费 / 180 天留存），只推进水位线——此后
 * byokTokensUsedThisMonth 只统计 createdAt >= 该时刻的行，UI「本月已用」清零，enforcement
 * （BYOK tokenQuota 接入推理后）也从此刻重新起算。返回盖入的时间戳供审计 metadata。
 */
export async function resetByokQuotaUsage(userId: string): Promise<Date> {
  const now = new Date();
  await db.update(users).set({ byokQuotaResetAt: now }).where(eq(users.id, userId));
  return now;
}

async function countSuccessfulCalls(userId: string, periodMonth: string): Promise<number> {
  const r = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(aiUsageRecords)
    .where(
      and(
        eq(aiUsageRecords.userId, userId),
        eq(aiUsageRecords.periodMonth, periodMonth),
        eq(aiUsageRecords.usedByok, false),
        eq(aiUsageRecords.status, 'success')
      )
    );
  return r[0]?.c ?? 0;
}

async function countCallsSince(userId: string, since: Date): Promise<number> {
  const r = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(aiUsageRecords)
    .where(and(eq(aiUsageRecords.userId, userId), gte(aiUsageRecords.createdAt, since)));
  return r[0]?.c ?? 0;
}

/**
 * 估算成本（美分），按 OpenAI 公开价格
 * 默认 gpt-4o-mini；其他模型回退到 gpt-4o-mini 价位（保守）
 */
function estimateCostCents(model: string, promptTokens: number, completionTokens: number): number {
  // 价格表（USD per 1M tokens）
  const pricing: Record<string, { prompt: number; completion: number }> = {
    'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
    'gpt-4o': { prompt: 2.5, completion: 10 },
    'gpt-4': { prompt: 30, completion: 60 },
    'claude-3-5-sonnet': { prompt: 3, completion: 15 },
    'claude-3-haiku': { prompt: 0.25, completion: 1.25 },
  };
  const p = pricing[model] || pricing['gpt-4o-mini'];
  const usd = (promptTokens / 1_000_000) * p.prompt + (completionTokens / 1_000_000) * p.completion;
  return Math.ceil(usd * 100); // 向上取整美分
}
