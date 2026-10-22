// 全局 AI 成本熔断器
//
// 当平台日 LLM 成本超阈值时自动停所有 Free 用户的 AI（保留 Pro/Enterprise）。
// 管理员通过 admin UI 解锁，也可手动熔断。
//
// 状态存储：Postgres（不依赖 Redis 持久化）。
//   - 熔断落到每个用户的 aiBannedUntil（checkAiQuota 自然拒绝）；
//   - 手动熔断另在 PlatformSetting 记一条到期时间，让熔断后才注册 / 降级进 Free、Trial 的用户
//     同样被拦（AI 配额门直接读它），cron 也据此持续补打 ban，直到解除或 UTC 当日结束。
// 触发：cron 每 10 分钟扫一次今日累计成本。

import { db } from '@/lib/prisma';
import { sql } from 'drizzle-orm';
import { BILLABLE_STATUS_SQL } from '@/lib/ai-quota';
import { getSetting, setSetting } from '@/lib/platform-settings';

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
 * 手动熔断状态在 PlatformSetting 中的键，值为 `{ until: ISO 时间 | null }`。
 * 不放进 PLATFORM_SETTING_KEYS：那是通用管理开关列表，手动熔断只能经熔断器接口（带审计）改。
 */
export const MANUAL_TRIP_SETTING_KEY = 'ai_circuit.manual_trip';

/** 手动熔断停用的套餐（与最高档自动熔断一致）。 */
export const MANUAL_TRIP_PLANS: readonly string[] = ['free', 'trial'];

/** 今日 UTC 结束时刻。 */
function endOfUtcDay(now: Date = new Date()): Date {
  const end = new Date(now);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

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

  const endOfDayIso = endOfUtcDay().toISOString();

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
 * 管理员手动解除熔断：清除自动与手动熔断打的 ban，并清掉手动熔断状态，
 * 否则 AI 配额门与 cron 会按仍生效的手动熔断继续拦截。
 */
export async function releaseCircuit(adminId: string): Promise<{ released: number }> {
  await setSetting(MANUAL_TRIP_SETTING_KEY, { until: null }, adminId);
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

/** 手动熔断对用户展示的原因（与写入 aiBanReason 的文本一致）。 */
export const MANUAL_TRIP_BAN_REASON = banReason('free_trial_stopped', true);

/**
 * 管理员手动熔断：按最高档（停 Free + Trial）执行，持续到今日 UTC 结束或 releaseCircuit。
 * 先记下手动熔断状态（覆盖之后才进入 Free/Trial 的用户，cron 据此补打 ban），
 * 再复用 applyCircuit 给现有用户打 ban。付费套餐不受影响（与自动熔断一致）。
 */
export async function tripCircuitManually(adminId: string): Promise<{ affected: number }> {
  await setSetting(MANUAL_TRIP_SETTING_KEY, { until: endOfUtcDay().toISOString() }, adminId);
  return applyCircuit('free_trial_stopped', { manual: true });
}

/** 由存储值推出仍生效的手动熔断到期时间（纯函数，便于测试）；未熔断、已过期或值非法返回 null。 */
export function activeManualTripUntil(value: unknown, now: Date = new Date()): Date | null {
  const until = (value as { until?: unknown } | null | undefined)?.until;
  if (typeof until !== 'string') return null;
  const at = new Date(until);
  return Number.isNaN(at.getTime()) || at <= now ? null : at;
}

/**
 * 当前生效的手动熔断到期时间；没有则 null。读走 PlatformSetting 的进程内缓存（≤60s 传播），
 * 读库失败时按「未熔断」处理，不因设置表故障停掉全部免费用户的 AI。
 */
export async function getManualTripUntil(now: Date = new Date()): Promise<Date | null> {
  return activeManualTripUntil(await getSetting<unknown>(MANUAL_TRIP_SETTING_KEY), now);
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
  /** 当前实际生效的熔断（用户 ban 与手动熔断状态）推出的状态。 */
  banState: CircuitState;
  /** 是否有生效的管理员手动熔断。 */
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
  const [todayCents, manualUntil, banRows] = await Promise.all([
    todayPlatformCostCents(),
    getManualTripUntil(now),
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
  const fromBans = stateFromBanReasons(rows.map((r) => r.reason));
  // 手动熔断即使此刻没有命中任何用户（例如还没有 Free 用户），也是生效中的熔断。
  const banState = manualUntil ? moreSevere(fromBans.state, 'free_trial_stopped') : fromBans.state;
  return {
    todayCents,
    state: moreSevere(costState, banState),
    costState,
    banState,
    manual: fromBans.manual || manualUntil !== null,
    bannedUsers: rows.reduce((sum, r) => sum + r.users, 0),
  };
}
