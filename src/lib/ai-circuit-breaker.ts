// 全局 AI 成本熔断器
//
// 当平台日 LLM 成本超阈值时自动停所有 Free 用户的 AI（保留 Pro/Enterprise）。
// 管理员通过 admin UI 解锁。
//
// 状态存储：Postgres（不依赖 Redis 持久化）。
// 触发：cron 每 10 分钟扫一次今日累计成本。

import { db } from '@/lib/prisma';
import { sql } from 'drizzle-orm';
import { BILLABLE_STATUS_SQL } from '@/lib/ai-quota';

/**
 * 阈值（生产环境通过 env 覆盖，留 escape hatch）
 *   - 日成本超 USD 200 → 停 Free
 *   - 日成本超 USD 500 → 停 Trial + Free
 */
export const CIRCUIT_BREAKER_THRESHOLDS = {
  freeStop: parseInt(process.env.AI_CIRCUIT_FREE_USD || '200', 10) * 100, // 美分
  trialStop: parseInt(process.env.AI_CIRCUIT_TRIAL_USD || '500', 10) * 100,
} as const;

export type CircuitState = 'closed' | 'free_stopped' | 'free_trial_stopped';

/**
 * 算今日（UTC）累计平台成本（不含 BYOK）
 */
export async function todayPlatformCostCents(): Promise<number> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayIso = today.toISOString();
  const result = await db.execute(sql`
    SELECT COALESCE(SUM("costCents"), 0)::int AS cents
    FROM "AiUsageRecord"
    WHERE "createdAt" >= ${todayIso}::timestamp
      AND "usedByok" = false
      AND status IN (${BILLABLE_STATUS_SQL})
  `);
  const rows = result as unknown as Array<{ cents: number }>;
  return rows[0]?.cents ?? 0;
}

/**
 * 评估当前应处于什么熔断状态
 */
export function evaluateCircuit(todayCents: number): CircuitState {
  if (todayCents >= CIRCUIT_BREAKER_THRESHOLDS.trialStop) return 'free_trial_stopped';
  if (todayCents >= CIRCUIT_BREAKER_THRESHOLDS.freeStop) return 'free_stopped';
  return 'closed';
}

/**
 * 应用熔断：把符合条件的用户 aiBannedUntil 设为今日 UTC 23:59
 *
 * 设计意图：
 *   - 不写一个全局 flag，直接给用户加 ban，让 checkAiQuota 自然拒绝
 *   - 24h 后自动解禁（cron 第二天发现成本回落自动 closed）
 *   - 管理员可以单独解某个用户（更新 aiBannedUntil = NULL）
 */
export async function applyCircuit(state: CircuitState): Promise<{ affected: number }> {
  if (state === 'closed') return { affected: 0 };

  const endOfDay = new Date();
  endOfDay.setUTCHours(23, 59, 59, 999);
  const endOfDayIso = endOfDay.toISOString();

  const plansToBan = state === 'free_stopped' ? ['free'] : ['free', 'trial'];
  const plansList = sql.join(
    plansToBan.map((p) => sql`${p}`),
    sql`, `
  );

  const result = await db.execute(sql`
    UPDATE "User"
    SET "aiBannedUntil" = ${endOfDayIso}::timestamp,
        "aiBanReason" = ${'全局成本熔断（' + state + '）'}
    WHERE "plan"::text IN (${plansList})
      AND ("aiBannedUntil" IS NULL OR "aiBannedUntil" < ${endOfDayIso}::timestamp)
    RETURNING id
  `);
  const rows = result as unknown as Array<{ id: string }>;
  return { affected: rows.length };
}

/**
 * 管理员手动解除熔断（清除自动熔断打的 ban）
 */
export async function releaseCircuit(): Promise<{ released: number }> {
  const result = await db.execute(sql`
    UPDATE "User"
    SET "aiBannedUntil" = NULL,
        "aiBanReason" = NULL
    WHERE "aiBanReason" LIKE '全局成本熔断%'
    RETURNING id
  `);
  const rows = result as unknown as Array<{ id: string }>;
  return { released: rows.length };
}
