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

import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { SKELETON_RETENTION_DAYS, resolveRetention } from '@/lib/retention/execution-retention';
import {
  allowedWindowPresets,
  assessWindowCoverage,
} from '@/lib/retention/window-coverage';

/** 与 whatif-batch-panel.tsx 的 WINDOW_PRESETS 顺序一致。 */
const ALL_PRESETS = [
  'LAST_MONTH',
  'LAST_QUARTER',
  'LAST_HALF_YEAR',
  'LAST_YEAR',
  'CUSTOM',
] as const;

const presetsFor = (plan: string) =>
  allowedWindowPresets([...ALL_PRESETS], resolveRetention(plan).executionDays);

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

  it('★free 看不到「最近一年」——那个档位对它必然空窗', () => {
    // 本 issue 的直接后果：此前四个档位对所有 plan 一视同仁，
    // free（7 天留存）点「最近一年」拿不到任何数据，而选项还在那里。
    const p = presetsFor('free');
    expect(p).not.toContain('LAST_YEAR');
    expect(p).not.toContain('LAST_HALF_YEAR');
    expect(p).not.toContain('LAST_QUARTER');
  });

  it('★free 仍保留至少一个档位——不能把「数据少」变成「功能没了」', () => {
    // 7 天留存连 LAST_MONTH(31) 都超出。若严格过滤会得到空列表，
    // 用户连按钮都点不了。故保底给最短档位 + 动态标注实际覆盖。
    const p = presetsFor('free');
    expect(p).toContain('LAST_MONTH');
    expect(p.length).toBeGreaterThan(0);
  });

  it('pro（90 天）拿到季度档——日历月的 1-2 天擦边不该藏掉整个档位', () => {
    // LAST_QUARTER 实际跨度 89-92 天（服务端用 minusMonths(3)）。
    // 若按最大值 92 严格裁剪，90 天留存的 pro 就看不到「最近一个季度」——
    // 为几天差额藏掉一整个档位，比显示「覆盖 90 天」更糟。
    const p = presetsFor('pro');
    expect(p).toContain('LAST_QUARTER');
    expect(p).not.toContain('LAST_YEAR');
  });

  it('★enterprise（留存无法判定）不裁剪，保留全部档位', () => {
    const p = presetsFor('enterprise');
    for (const k of ALL_PRESETS) expect(p).toContain(k);
  });

  it('CUSTOM 永远保留——它的区间由用户自填，走动态判定', () => {
    for (const plan of ['free', 'pro', 'enterprise']) {
      expect(presetsFor(plan), `${plan} 缺 CUSTOM`).toContain('CUSTOM');
    }
  });

  it('默认选中的档位必须在可见列表里（否则提交一个看不见的选择）', () => {
    // whatif-batch-panel 的 useState 默认值是 LAST_MONTH。
    for (const plan of ['free', 'pro', 'team', 'enterprise']) {
      expect(presetsFor(plan), `${plan} 默认档位不可见`).toContain('LAST_MONTH');
    }
  });

  it('★retentionDays 覆盖参数：客户端不需要拿到 plan 也能判定', () => {
    // plan 是计费信息，不该为了显示一句提示就下发到浏览器。
    // 客户端只拿服务端算好的 retentionDays，故 assessWindowCoverage 支持直接给天数。
    const c = assessWindowCoverage(null, ago(365), NOW, NOW, 90);
    expect(c.retentionDays).toBe(90);
    expect(c.truncated).toBe(true);
    expect(c.coveredDays).toBe(90);

    // override 传 null（enterprise）→ 与按 plan 解析同样保持沉默
    const ent = assessWindowCoverage(null, ago(365), NOW, NOW, null);
    expect(ent.truncated).toBe(false);
    expect(ent.retentionDays).toBeNull();
  });

  it('★四语都必须有 windowTruncated 文案且占位符齐全', () => {
    // 缺 locale 会让该语言用户看到裸键名；缺占位符会让提示说不出具体天数，
    // 变成「你的范围超了」这种无法据以行动的废话。
    for (const locale of ['en', 'zh', 'de', 'hi'] as const) {
      const tpl = (DEMO_SUPPLEMENT as Record<string, Record<string, Record<string, string>>>)[
        locale
      ]?.whatIf?.windowTruncated;
      expect(tpl, `${locale} 缺 windowTruncated`).toBeTruthy();
      for (const ph of ['{requested}', '{retention}', '{covered}']) {
        expect(tpl, `${locale} 缺占位符 ${ph}`).toContain(ph);
      }
    }
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
