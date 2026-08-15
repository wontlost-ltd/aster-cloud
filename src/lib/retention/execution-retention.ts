/**
 * 执行日志与决策骨架的留存期解析（issue #396）。
 *
 * <h2>背景：一个已售卖但未执行的承诺</h2>
 *
 * `plans.ts` 的 featureKeys 里写着 `audit7days`（free）/ `audit90days`（pro 等），
 * 但全仓**没有任何代码按它清理数据**——`cleanupOldExecutionLogs` 零调用方。
 * 即所有档位实际留存都是**永久**。三重问题：已售卖未兑现、GDPR Art 5(1)(e)
 * 存储限制无依据、`Execution` 表只增不减成本无上限。
 *
 * 本模块把 featureKey 翻译成**可执行的天数**，供 cron GC 使用。
 * 参照 `telemetry-retention-gc` 的做法——那条链路的注释说得最准：
 * 「makes that contract self-executing (not a docs-only promise)」。
 *
 * <h2>★为什么 enterprise 返回 null 而不是给个默认值</h2>
 *
 * enterprise 档在 `plans.ts` 里**一个 audit key 都没有**，而本仓的
 * `unlimited*` 约定（`unlimitedTeamMembers` 等）也没有对应的 `auditUnlimited`。
 * 所以「enterprise 该留多久」在代码里**无从判断**。
 *
 * 删除不可逆。给默认值有两种错法，都很糟：
 *   - 默认 90 天 → 真的删掉企业客户的审计数据，与"企业级更长留存"的预期相悖
 *   - 默认无限 → 靠"查不到 key"来推断语义，将来有人加个 key 就静默改变行为
 *
 * 故此处返回 `null` = **不清理，且调用方必须显式记录跳过原因**。
 * 待产品显式加 `auditUnlimited` / `audit365days` 后再改这里。
 */

import { PLANS } from '@/lib/plans';

/**
 * 决策骨架的留存天数——与 plan **解耦**，见文件尾部说明。
 *
 * ★取值下界由**条件漏斗能选到的最长窗口**决定，不是拍脑袋定的：
 * What-If / 漏斗的 `WINDOW_PRESETS` 含 `LAST_YEAR`（365 天），
 * 骨架若短于它，用户选"最近一年"就会在留存线上被静默截断——
 * 看到的漏斗少了一截，却不知道为什么。
 *
 * 故 365 是**下界**而非偏好值；调小必须同时裁剪 WINDOW_PRESETS。
 * `whatif-window-retention.test.ts` 会在两者失配时转红。
 */
export const SKELETON_RETENTION_DAYS = 365;

/**
 * featureKey → 天数。只列**真实存在**的 key，不做模式匹配。
 *
 * 用穷举表而不是 `/audit(\d+)days/` 正则：正则会把将来任何形如
 * `auditXXXdays` 的新 key 静默纳入，包括写错的（`audit90day` 少个 s
 * 会匹配失败并落到"无 key"分支 → 变成不清理，而不是报错）。
 * 穷举表让新增 key 必须同步改这里，改漏了会在测试里炸出来。
 */
const AUDIT_KEY_TO_DAYS: Readonly<Record<string, number>> = Object.freeze({
  audit7days: 7,
  audit90days: 90,
});

export interface RetentionDecision {
  /** 执行日志留存天数；null = 无法判定，**不得清理** */
  readonly executionDays: number | null;
  /** 为什么是 null（供 cron 日志与审计留痕）；非 null 时为空 */
  readonly skipReason: string | null;
  /** 决策骨架留存天数——恒为 SKELETON_RETENTION_DAYS，与 plan 无关 */
  readonly skeletonDays: number;
}

/**
 * 解析某个 plan 的留存期。
 *
 * @param plan 租户档位；未知档位按"无法判定"处理（同 enterprise）
 */
export function resolveRetention(plan: string | null | undefined): RetentionDecision {
  const base = { skeletonDays: SKELETON_RETENTION_DAYS } as const;

  if (!plan) {
    return { ...base, executionDays: null, skipReason: 'plan 缺失' };
  }

  const def = (PLANS as Record<string, { featureKeys?: readonly string[] } | undefined>)[plan];
  if (!def) {
    return { ...base, executionDays: null, skipReason: `未知 plan「${plan}」` };
  }

  const hit = (def.featureKeys ?? []).find((k) => k in AUDIT_KEY_TO_DAYS);
  if (!hit) {
    // enterprise 走这条路径。见文件头注释：这不是遗漏，是刻意不猜。
    return {
      ...base,
      executionDays: null,
      skipReason: `plan「${plan}」无 audit 留存 featureKey——需产品显式定义（issue #396）`,
    };
  }

  return { ...base, executionDays: AUDIT_KEY_TO_DAYS[hit], skipReason: null };
}

/** 所有已知 plan 的留存决策，供 cron 一次性取全量、避免逐租户查 PLANS。 */
export function retentionByPlan(): Readonly<Record<string, RetentionDecision>> {
  const out: Record<string, RetentionDecision> = {};
  for (const name of Object.keys(PLANS)) {
    out[name] = resolveRetention(name);
  }
  return Object.freeze(out);
}

/**
 * 决策骨架为什么与 plan 解耦、且比 Audit 留得久：
 *
 * `TraceSkeleton` **结构上不含 result 字段**（见 aster-api 的
 * `replay/.../TraceSkeleton.java` 类注释），故骨架里没有业务值、没有 PII，
 * 不受 `replayRetentionEnabled` 门控，也就不适用 Audit 那套合规留存上限。
 *
 * 反过来，若让骨架跟 Audit 同期，free 档 7 天后条件漏斗就没数据了——
 * 而漏斗恰恰是给业务人员看的核心价值（见
 * aster-api/docs/strategy-replay-gap-analysis.md 第 0.3 节：
 * 「骨架无 PII，可独立设更长留存（分析价值随样本量上升）」）。
 *
 * 180 天是**可调的产品参数**，不是技术约束；改这里即可。
 */
