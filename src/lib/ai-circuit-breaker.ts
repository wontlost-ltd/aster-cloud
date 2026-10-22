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

/** 熔断状态严重度：取「成本判定」与「实际生效的 ban」中更严重的一方作为对外状态。 */
const STATE_SEVERITY: Record<CircuitState, number> = {
  closed: 0,
  free_stopped: 1,
  free_trial_stopped: 2,
};

/** 熔断 ban 的原因前缀。releaseCircuit 按此前缀清除，自动与手动熔断共用。 */
const CIRCUIT_BAN_REASON_PREFIX = '全局成本熔断';

/** 手动熔断在原因里的标记，用于在状态里区分「管理员手动」与「成本自动」。 */
const MANUAL_MARKER = 'manual';

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
export async function applyCircuit(
  state: CircuitState,
  options: { manual?: boolean } = {},
): Promise<{ affected: number }> {
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
        "aiBanReason" = ${banReason(state, options.manual === true)}
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
    WHERE "aiBanReason" LIKE ${CIRCUIT_BAN_REASON_PREFIX + '%'}
    RETURNING id
  `);
  const rows = result as unknown as Array<{ id: string }>;
  return { released: rows.length };
}

/** 熔断 ban 的原因文本：前缀 + 档位（+ 手动标记）。 */
function banReason(state: CircuitState, manual: boolean): string {
  return `${CIRCUIT_BAN_REASON_PREFIX}（${state}${manual ? `，${MANUAL_MARKER}` : ''}）`;
}

/**
 * 管理员手动熔断：复用 applyCircuit 的 ban 机制，按最高档（停 Free + Trial）执行，
 * 持续到今日 UTC 结束；releaseCircuit 按同一前缀解除。付费套餐不受影响（与自动熔断一致）。
 */
export async function tripCircuitManually(): Promise<{ affected: number }> {
  return applyCircuit('free_trial_stopped', { manual: true });
}

/** 由当前生效的熔断 ban 原因推出的状态（纯函数，便于测试）。 */
export function stateFromBanReasons(reasons: ReadonlyArray<string | null>): {
  state: CircuitState;
  manual: boolean;
} {
  let state: CircuitState = 'closed';
  let manual = false;
  for (const reason of reasons) {
    if (!reason || !reason.startsWith(CIRCUIT_BAN_REASON_PREFIX)) continue;
    const level: CircuitState = reason.includes('free_trial_stopped')
      ? 'free_trial_stopped'
      : reason.includes('free_stopped')
        ? 'free_stopped'
        : 'closed';
    if (STATE_SEVERITY[level] > STATE_SEVERITY[state]) state = level;
    if (reason.includes(MANUAL_MARKER)) manual = true;
  }
  return { state, manual };
}

/** 取两个状态中更严重的一个。 */
export function moreSevere(a: CircuitState, b: CircuitState): CircuitState {
  return STATE_SEVERITY[a] >= STATE_SEVERITY[b] ? a : b;
}

export interface CircuitStatus {
  /** 今日平台成本（美分）。 */
  todayCents: number;
  /** 对外状态：成本判定与实际生效 ban 中更严重者。管理员概览与熔断器页共用。 */
  state: CircuitState;
  /** 仅按今日成本判定的状态（cron 自动熔断的依据）。 */
  costState: CircuitState;
  /** 当前实际生效的熔断 ban 推出的状态。 */
  banState: CircuitState;
  /** 生效的 ban 中是否有管理员手动熔断。 */
  manual: boolean;
  /** 当前被熔断 ban 拦住的用户数。 */
  bannedUsers: number;
}

/**
 * 熔断器的**唯一状态来源**：管理员概览卡片与熔断器页都读这里，避免一处显示
 * 「健康」、另一处显示「—」的口径分裂。只看成本会漏掉手动熔断；只看 ban 会漏掉
 * 「成本已超阈值、cron 尚未执行」的窗口，故两者取更严重者。
 */
export async function getCircuitStatus(now: Date = new Date()): Promise<CircuitStatus> {
  const [todayCents, banRows] = await Promise.all([
    todayPlatformCostCents(),
    db.execute(sql`
      SELECT "aiBanReason" AS reason, count(*)::int AS users
      FROM "User"
      WHERE "aiBanReason" LIKE ${CIRCUIT_BAN_REASON_PREFIX + '%'}
        AND "aiBannedUntil" > ${now.toISOString()}::timestamp
      GROUP BY "aiBanReason"
    `),
  ]);
  const rows = banRows as unknown as Array<{ reason: string | null; users: number }>;
  const costState = evaluateCircuit(todayCents);
  const { state: banState, manual } = stateFromBanReasons(rows.map((r) => r.reason));
  return {
    todayCents,
    state: moreSevere(costState, banState),
    costState,
    banState,
    manual,
    bannedUsers: rows.reduce((sum, r) => sum + r.users, 0),
  };
}
