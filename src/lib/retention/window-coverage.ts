/**
 * 窗口 × 留存期的覆盖判定（issue #396）。
 *
 * <h2>为什么需要这个</h2>
 *
 * What-If 的 `WINDOW_PRESETS` 提供到 `LAST_YEAR`（365 天）与 `CUSTOM`（任意区间），
 * 而执行日志按 plan 留存（free 7 天 / pro 90 天）。两者**口径不一致**：
 * pro 用户选「最近一年」，90 天前的执行早已被留存 GC 删除，批次会在无解释的
 * 情况下少掉大半样本——甚至空窗。
 *
 * <h2>处置：不缩小选择，但绝不让用户误以为拿到了全量</h2>
 *
 * 三种可能的解法里选了「显式告知」：
 *   1. 按 plan 裁剪窗口选项 —— 把留存限制暴露成产品限制，且用户不知道为什么少了选项
 *   2. 留存期拉到 ≥365 天 —— 违背 GDPR Art 5(1)(e) 存储限制（保留期不得超过必要范围）
 *   3. **保留选项 + 显式标注实际覆盖** ← 本模块
 *
 * 第 3 条与本仓既有的诚实口径一脉相承：`coverageNote`（漏斗）、
 * `previewAllLegacy`（证据导出）都是同一个原则——
 * **样本不足不可怕，让用户误以为是全量才可怕。**
 */

import { resolveRetention } from './execution-retention';

export interface WindowCoverage {
  /** 该租户的执行日志留存天数；null = 无法判定（如 enterprise），此时不做任何截断声明 */
  readonly retentionDays: number | null;
  /** 请求窗口的起点是否早于留存边界（即窗口有一段"必然没数据"） */
  readonly truncated: boolean;
  /** 实际有数据的最早时刻；null = 无法判定 */
  readonly effectiveFrom: Date | null;
  /** 窗口总天数（用于文案里说"365 天里只有 90 天有数据"） */
  readonly requestedDays: number;
  /** 实际被留存覆盖的天数；null = 无法判定 */
  readonly coveredDays: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function wholeDaysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.ceil((to.getTime() - from.getTime()) / MS_PER_DAY));
}

/**
 * 判定某个窗口在给定 plan 下的真实覆盖情况。
 *
 * @param plan   租户档位
 * @param from   请求窗口起点
 * @param to     请求窗口终点（左闭右开，与 ADR 0034 §3.3 一致）
 * @param now    注入当前时间以便测试
 */
export function assessWindowCoverage(
  plan: string | null | undefined,
  from: Date,
  to: Date,
  now: Date = new Date(),
): WindowCoverage {
  const requestedDays = wholeDaysBetween(from, to);
  const { executionDays } = resolveRetention(plan);

  if (executionDays === null) {
    // 无法判定留存期（enterprise / 未知 plan）→ 不做任何截断声明。
    // ★这里必须保持沉默而不是猜一个数：说"你的数据只有 90 天"而实际是永久，
    //   会让用户白白缩小分析窗口；反过来也一样误导。
    return {
      retentionDays: null,
      truncated: false,
      effectiveFrom: null,
      requestedDays,
      coveredDays: null,
    };
  }

  const boundary = new Date(now.getTime() - executionDays * MS_PER_DAY);
  const truncated = from.getTime() < boundary.getTime();
  const effectiveFrom = truncated ? boundary : from;

  return {
    retentionDays: executionDays,
    truncated,
    effectiveFrom,
    requestedDays,
    // 截断时按 effectiveFrom 起算；未截断则整个窗口都被覆盖
    coveredDays: wholeDaysBetween(effectiveFrom, to),
  };
}
