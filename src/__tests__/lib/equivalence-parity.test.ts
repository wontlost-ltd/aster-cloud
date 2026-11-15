import { describe, it, expect } from 'vitest';
import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import {
  dedupeByDay,
  parseTrendCsv,
  summarizeParity,
  STALE_AFTER_MS,
  type ParityHistory,
  type TrendPoint,
} from '@/lib/equivalence/parity';
import { formatParityRate } from '@/lib/equivalence/format';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { locales } from '@/i18n/config';

/**
 * /equivalence 的诚实性判定（#764）：无数据、过期、分歧、回退、缺维度
 * 都必须如实反映到 summary，不能因为数据不全就显示「全部一致」。
 */

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const pt = (timestamp: string, value: number, total: number): TrendPoint => ({
  timestamp,
  value,
  total,
  rate: total > 0 ? value / total : 0,
});

function history(overrides: Partial<ParityHistory> = {}): ParityHistory {
  return {
    parse: [pt('2026-11-13T09:00:00.000Z', 290, 290), pt('2026-11-15T00:00:10.000Z', 300, 300)],
    eval: [pt('2026-11-13T09:00:00.000Z', 937, 937), pt('2026-11-15T00:02:04.000Z', 960, 960)],
    ir: [pt('2026-11-13T09:00:00.000Z', 320, 320), pt('2026-11-15T00:02:14.000Z', 333, 333)],
    evalCoverage: [pt('2026-11-15T00:02:05.000Z', 215, 215)],
    featureCoverage: [pt('2026-11-15T00:02:05.000Z', 51, 51)],
    ...overrides,
  };
}

describe('parseTrendCsv', () => {
  it('按表头定位分子列：parse(equivalent) / eval(identical) / coverage(value)', () => {
    expect(parseTrendCsv('timestamp,total,equivalent,divergent,rate\n2026-11-15T00:00:10.946Z,300,300,0,1.0000\n')).toEqual([
      pt('2026-11-15T00:00:10.946Z', 300, 300),
    ]);
    expect(parseTrendCsv('timestamp,total,identical,divergent,rate\n2026-11-15T00:02:04.988Z,960,950,10,0.9896')[0]).toMatchObject({
      value: 950,
      total: 960,
    });
    expect(parseTrendCsv('timestamp,total,value,rate\n2026-11-15T00:02:05.044Z,215,215,1.0000')[0]?.value).toBe(215);
  });

  it('丢弃脏行，空文件 / 只有表头 / 缺列返回空数组', () => {
    const csv = 'timestamp,total,identical,divergent,rate\nnot-a-date,1,1,0,1\n2026-11-15T00:00:00Z,abc,1,0,1\n2026-11-15T00:00:00Z,2,2,0,1';
    expect(parseTrendCsv(csv)).toHaveLength(1);
    expect(parseTrendCsv('')).toEqual([]);
    expect(parseTrendCsv('timestamp,total,value,rate')).toEqual([]);
    expect(parseTrendCsv('timestamp,rate\n2026-11-15T00:00:00Z,1')).toEqual([]);
  });

  it('拒绝不可信的计数：分子大于分母、负数、非整数', () => {
    const csv = [
      'timestamp,total,identical,divergent,rate',
      '2026-11-12T00:00:00Z,10,11,0,1.1',
      '2026-11-13T00:00:00Z,10,-1,0,0',
      '2026-11-14T00:00:00Z,10.5,10,0,1',
      '2026-11-15T00:00:00Z,10,10,0,1',
    ].join('\n');
    expect(parseTrendCsv(csv).map((p) => p.timestamp)).toEqual(['2026-11-15T00:00:00Z']);
  });
});

describe('dedupeByDay', () => {
  it('同一 UTC 日只保留最新一条，并按时间升序', () => {
    const out = dedupeByDay([
      pt('2026-11-15T09:00:00Z', 10, 10),
      pt('2026-11-14T00:00:00Z', 8, 8),
      pt('2026-11-15T01:00:00Z', 9, 10),
    ]);
    expect(out.map((p) => p.timestamp)).toEqual(['2026-11-14T00:00:00Z', '2026-11-15T09:00:00Z']);
  });
});

describe('summarizeParity', () => {
  it('全部一致：verdict=agree，检查总数为三个一致率维度之和，覆盖率不计入', () => {
    const s = summarizeParity(history(), NOW);
    expect(s.verdict).toBe('agree');
    expect(s.totalChecks).toBe(300 + 960 + 333);
    expect(s.divergentChecks).toBe(0);
    expect(s.stale).toBe(false);
    expect(s.lastChecked).toBe('2026-11-15T00:02:14.000Z');
    expect(s.ageDays).toBe(0);
    expect(s.agreement.parse.first?.total).toBe(290);
  });

  it('任一维度最新一次有分歧：verdict=diverged，并给出分歧数与回退', () => {
    const s = summarizeParity(
      history({ eval: [pt('2026-11-13T09:00:00Z', 937, 937), pt('2026-11-15T00:02:04Z', 957, 960)] }),
      NOW,
    );
    expect(s.verdict).toBe('diverged');
    expect(s.divergentChecks).toBe(3);
    expect(s.agreement.eval.gap).toBe(3);
    expect(s.agreement.eval.regressed).toBe(true);
    expect(s.agreement.parse.regressed).toBe(false);
  });

  it('历史上有分歧但最新一致：不算 diverged（如实反映当前状态）', () => {
    const s = summarizeParity(
      history({ parse: [pt('2026-05-12T13:54:17Z', 183, 197), pt('2026-11-15T00:00:10Z', 300, 300)] }),
      NOW,
    );
    expect(s.verdict).toBe('agree');
    expect(s.agreement.parse.regressed).toBe(false);
  });

  it('覆盖率下降只标记该维度回退，不改变一致性结论', () => {
    const s = summarizeParity(
      history({ featureCoverage: [pt('2026-11-13T09:00:00Z', 51, 51), pt('2026-11-15T00:02:05Z', 50, 51)] }),
      NOW,
    );
    expect(s.verdict).toBe('agree');
    expect(s.coverage.featureCoverage.regressed).toBe(true);
  });

  it('最新测量超过 72 小时：stale，并给出天数', () => {
    const later = Date.parse('2026-11-15T00:02:14.000Z') + STALE_AFTER_MS + 1;
    const s = summarizeParity(history(), later);
    expect(s.stale).toBe(true);
    expect(s.ageDays).toBe(3);
    expect(s.agreement.ir.stale).toBe(true);
  });

  it('恰好 72 小时内不算过期（容忍一次漏跑）', () => {
    const s = summarizeParity(history(), Date.parse('2026-11-15T00:00:10.000Z') + STALE_AFTER_MS);
    expect(s.stale).toBe(false);
  });

  it('单个维度过期也要标记整体 stale', () => {
    const s = summarizeParity(history({ ir: [pt('2026-11-01T00:00:00Z', 300, 300)] }), NOW);
    expect(s.stale).toBe(true);
    expect(s.agreement.ir.stale).toBe(true);
    expect(s.agreement.parse.stale).toBe(false);
  });

  it('缺一个维度：verdict=partial（不能宣称全部一致），列出缺失维度', () => {
    const s = summarizeParity(history({ ir: [] }), NOW);
    expect(s.verdict).toBe('partial');
    expect(s.missing).toEqual(['ir']);
    expect(s.totalChecks).toBe(300 + 960);
    expect(s.agreement.ir.latest).toBeNull();
  });

  it('缺维度同时有分歧：diverged 优先于 partial', () => {
    const s = summarizeParity(history({ ir: [], parse: [pt('2026-11-15T00:00:10Z', 299, 300)] }), NOW);
    expect(s.verdict).toBe('diverged');
    expect(s.missing).toEqual(['ir']);
  });

  it('lastChecked 只取一致率维度，覆盖率更晚也不影响', () => {
    const s = summarizeParity(history({ featureCoverage: [pt('2026-11-15T06:00:00Z', 51, 51)] }), NOW);
    expect(s.lastChecked).toBe('2026-11-15T00:02:14.000Z');
  });

  it('三个一致率维度都没有数据：verdict=empty，即使覆盖率有数据', () => {
    const s = summarizeParity(history({ parse: [], eval: [], ir: [] }), NOW);
    expect(s.verdict).toBe('empty');
    expect(s.lastChecked).toBeNull();
    expect(s.ageDays).toBeNull();
    expect(s.stale).toBe(false);
  });

  it('分母为 0 视为无数据', () => {
    const zero = [pt('2026-11-15T00:00:00Z', 0, 0)];
    expect(summarizeParity(history({ parse: zero, eval: zero, ir: zero }), NOW).verdict).toBe('empty');
  });
});

describe('formatParityRate', () => {
  it('100% 不带小数；不会把 99.96% 四舍五入成 100%', () => {
    expect(formatParityRate(1, 'en')).toBe('100%');
    expect(formatParityRate(959.6 / 960, 'en')).toBe('99.9%');
    expect(formatParityRate(0.9289, 'en')).toBe('92.8%');
  });
});

describe('equivalencePage 补充文案', () => {
  type Tree = Record<string, unknown>;
  const leaves = (tree: Tree, prefix = ''): string[] =>
    Object.entries(tree).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) ? leaves(v as Tree, `${prefix}${k}.`) : [`${prefix}${k}`],
    );
  const block = (locale: (typeof locales)[number]) => (DEMO_SUPPLEMENT[locale] as Tree).equivalencePage as Tree;

  it.each(locales)('%s 与 en 键集一致，方法要点条数一致', (locale) => {
    expect(leaves(block(locale)).sort()).toEqual(leaves(block('en')).sort());
    const items = (block(locale).methodology as Tree).items as string[];
    expect(items).toHaveLength(((block('en').methodology as Tree).items as string[]).length);
  });

  it.each(locales)('%s 的 ICU 消息可用实际参数格式化', (locale) => {
    // 文案树是运行时数据（非全局 messages 类型），故以宽松签名调用。
    const t = createTranslator({ locale, messages: { equivalencePage: block(locale) } as AbstractIntlMessages, namespace: 'equivalencePage' }) as unknown as (
      key: string,
      values?: Record<string, string | number>,
    ) => string;
    expect(t('verdict.agree', { count: 1593 })).toMatch(/1[,.\s  ]?593/);
    expect(t('verdict.diverged', { count: 3, total: 1593 })).toContain('3');
    expect(t('verdict.staleBody', { days: 4 })).toContain('4');
    expect(t('dimensions.badgeDiverged', { count: 1 })).toContain('1');
    expect(t('dimensions.growth', { count: 197, date: 'D' })).toContain('197');
    expect(t('coverage.evalCoverage.detail', { value: '215', total: '215' })).toContain('215');
  });
});
