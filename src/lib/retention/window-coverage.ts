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

/**
 * 各窗口档位对应的天数。与 `whatif-batch-panel.tsx` 的 `WINDOW_PRESETS`
 * 及 aster-api `ReplayBatchResource.resolveWindow` 三处对齐。
 *
 * <p>★`CUSTOM` 不在此表：它由用户自填区间，天数在运行时才知道，
 * 故走 {@link assessWindowCoverage} 逐次判定，不做静态裁剪。
 */
export const WINDOW_PRESET_DAYS: Readonly<Record<string, number>> = Object.freeze({
  LAST_MONTH: 31,
  LAST_QUARTER: 92,
  LAST_HALF_YEAR: 183,
  LAST_YEAR: 366,
});

/**
 * 裁剪时允许的越界容差（天）。
 *
 * <p>服务端用**日历月**算窗口（`today.minusMonths(3)`），故实际跨度随日期浮动：
 * LAST_QUARTER 是 89–92 天。若按最大值 92 严格裁剪，90 天留存的 pro 用户
 * 就看不到「最近一个季度」——而实际只在部分月份差 1–2 天。
 *
 * <p>取舍：**整档超出才隐藏，边缘擦边则保留 + 动态标注**。
 * 为几天差额藏掉一整个档位，比让用户看到「365 天里覆盖 90 天」更糟——
 * 后者至少是可理解的事实，前者是无法解释的功能缺失。
 */
const PRESET_TOLERANCE_DAYS = 3;

/**
 * 按留存期裁掉「必然拿不到数据」的窗口档位。
 *
 * <h3>为什么裁而不是只标注</h3>
 *
 * 起初只做了 {@link assessWindowCoverage}（选完再告诉你截断了）。但那对
 * free（7 天留存）等于：四个档位里三个点了都是空窗，用户要试错才知道。
 * **当前那套窗口选项实际只适用于留存期最长的企业级用户。**
 *
 * 故改为两层：
 *   - 静态裁剪（本函数）——档位整个超出留存期就不给选，从源头避免空窗
 *   - 动态标注（assessWindowCoverage）——选中的档位/自定义区间**部分**
 *     超出时，如实说明实际覆盖多少天
 *
 * <h3>永远至少保留一个档位</h3>
 *
 * free 只有 7 天留存，连 LAST_MONTH(31) 都超出。若严格过滤会得到空列表，
 * 用户连按钮都点不了——那是把「数据少」变成「功能没了」。
 * 故保底返回最短的那个档位，配合动态标注告诉用户实际覆盖范围。
 *
 * @param retentionDays 执行日志留存天数；null（无法判定，如 enterprise）= 不裁剪
 */
export function allowedWindowPresets(
  presetKinds: readonly string[],
  retentionDays: number | null,
): string[] {
  if (retentionDays === null) return [...presetKinds];

  const fits = presetKinds.filter((k) => {
    const days = WINDOW_PRESET_DAYS[k];
    // 表里没有的（CUSTOM）一律保留：它的区间由用户自填，动态判定。
    return days === undefined || days - PRESET_TOLERANCE_DAYS <= retentionDays;
  });

  // 保底：至少给一个最短档位（见上方说明）。
  if (fits.some((k) => WINDOW_PRESET_DAYS[k] !== undefined)) return fits;

  const shortest = presetKinds
    .filter((k) => WINDOW_PRESET_DAYS[k] !== undefined)
    .sort((a, b) => WINDOW_PRESET_DAYS[a] - WINDOW_PRESET_DAYS[b])[0];

  return shortest ? [shortest, ...fits] : fits;
}

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
  /**
   * 直接给定留存天数，跳过 plan 解析。
   *
   * ★给客户端组件用：浏览器侧只拿到服务端算好的 `retentionDays`，**没有 plan**
   * （plan 是敏感的计费信息，不该为了显示一句提示就下发到前端）。
   * 传 `undefined` 则按 plan 解析，服务端路径不受影响。
   */
  retentionDaysOverride?: number | null,
): WindowCoverage {
  const requestedDays = wholeDaysBetween(from, to);
  const executionDays =
    retentionDaysOverride !== undefined
      ? retentionDaysOverride
      : resolveRetention(plan).executionDays;

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
