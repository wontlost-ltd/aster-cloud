// What-If / 漏斗的时间窗口 × 数据留存期的一致性（issue #396）。
//
// ## 被发现的问题
//
// WINDOW_PRESETS 提供到 LAST_YEAR（365 天）与 CUSTOM（任意区间），
// 而执行日志按 plan 留存（free 7 天 / pro 90 天）。两者口径不一致：
// **pro 用户选「最近一年」，90 天前的执行早已被留存 GC 删除**，
// 批次会在无解释的情况下少掉大半样本——甚至空窗，而 UI 上那个选项还在。
//
// 骨架我最初拍了 180 天，同样短于 365，漏斗会在半年线上静默截断。
//
// ## 本文件守什么
//
// 两条不变量：
//   1. 骨架留存 ≥ 最长窗口（否则漏斗被静默截断）
//   2. 窗口超出执行日志留存时，必须能**判定出**截断并给出实际覆盖天数
//      （不缩小用户的选择，但绝不让他误以为拿到了全量）

import { describe, it, expect } from 'vitest';

import { SKELETON_RETENTION_DAYS, resolveRetention } from '@/lib/retention/execution-retention';
import { assessWindowCoverage } from '@/lib/retention/window-coverage';

/** 与 whatif-batch-panel.tsx 的 WINDOW_PRESETS 对应的天数上界。 */
const LONGEST_PRESET_DAYS = 365; // LAST_YEAR

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-15T00:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

describe('窗口 × 留存期一致性（issue #396）', () => {
  it('★骨架留存必须 ≥ 最长窗口，否则漏斗会被静默截断', () => {
    // 若这条红了，说明有人调小了骨架留存却没裁剪 WINDOW_PRESETS——
    // 用户选「最近一年」会看到少一截的漏斗，且不知道为什么。
    expect(SKELETON_RETENTION_DAYS).toBeGreaterThanOrEqual(LONGEST_PRESET_DAYS);
  });

  it('★pro 选「最近一年」必须判定为截断，并给出实际覆盖天数', () => {
    // 这正是本 issue 的核心场景：选项给到 365 天，数据只有 90 天。
    const c = assessWindowCoverage('pro', ago(365), NOW, NOW);

    expect(c.retentionDays).toBe(90);
    expect(c.truncated).toBe(true);
    expect(c.requestedDays).toBe(365);
    expect(c.coveredDays).toBe(90);
    expect(c.effectiveFrom).toEqual(ago(90));
  });

  it('free 选「最近一个月」同样截断（7 天留存）', () => {
    const c = assessWindowCoverage('free', ago(30), NOW, NOW);
    expect(c.truncated).toBe(true);
    expect(c.coveredDays).toBe(7);
  });

  it('窗口在留存期内则不报截断——不制造无谓的警告', () => {
    // 噪音会让真正的截断提示被忽略。
    const c = assessWindowCoverage('pro', ago(30), NOW, NOW);
    expect(c.truncated).toBe(false);
    expect(c.coveredDays).toBe(30);
    expect(c.effectiveFrom).toEqual(ago(30));
  });

  it('★留存期无法判定时保持沉默，不猜一个数', () => {
    // enterprise 无 audit featureKey（见 execution-retention.ts）。
    // 说"你的数据只有 90 天"而实际是永久，会让用户白白缩小分析窗口；
    // 反过来也一样误导。故一律不做截断声明。
    const c = assessWindowCoverage('enterprise', ago(365), NOW, NOW);
    expect(c.retentionDays).toBeNull();
    expect(c.truncated).toBe(false);
    expect(c.coveredDays).toBeNull();
    expect(c.effectiveFrom).toBeNull();
  });

  it('CUSTOM 超长区间同样被判定（不是只对预设生效）', () => {
    // CUSTOM 可以填任意区间，比 LAST_YEAR 还长。
    const c = assessWindowCoverage('pro', ago(1000), NOW, NOW);
    expect(c.truncated).toBe(true);
    expect(c.coveredDays).toBe(90);
  });

  it('骨架留存与执行日志留存是两条独立的轴', () => {
    // 骨架无 PII、不按 plan 走；执行日志含 input、按 plan 走。
    // 混成一条会让「漏斗还有数据但 What-If 空窗」这种真实情况无法表达。
    for (const plan of ['free', 'pro', 'enterprise']) {
      expect(resolveRetention(plan).skeletonDays).toBe(SKELETON_RETENTION_DAYS);
    }
    expect(resolveRetention('free').executionDays).not.toBe(SKELETON_RETENTION_DAYS);
  });
});
