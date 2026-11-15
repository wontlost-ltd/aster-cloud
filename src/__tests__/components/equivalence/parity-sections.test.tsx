/**
 * /equivalence 各区块在不同状态下如实渲染（#764）：
 * 一致 / 分歧 / 过期 / 无数据 / 缺维度，且没有缺键回退成 key 路径。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import enPackage from '@aster-cloud/ui-messages/en-US.json';
import { deepMergeMessages } from '@/i18n/request';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { summarizeParity, STALE_AFTER_MS, type ParityHistory, type TrendPoint } from '@/lib/equivalence/parity';

const messages = deepMergeMessages(enPackage as Record<string, unknown>, DEMO_SUPPLEMENT.en);

vi.mock('next-intl/server', () => ({
  getTranslations: async (arg?: string | { namespace?: string }) => {
    const namespace = typeof arg === 'string' ? arg : arg?.namespace;
    return createTranslator({ locale: 'en', messages, namespace: namespace as never });
  },
  getRequestConfig: (fn: unknown) => fn,
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { AgreementCards, CoverageMeters, ParityVerdict } from '@/components/equivalence/parity-overview';
import { ParityDivergences } from '@/components/equivalence/parity-divergences';
import { ParityMethodology } from '@/components/equivalence/parity-methodology';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const pt = (timestamp: string, value: number, total: number): TrendPoint => ({ timestamp, value, total, rate: value / total });
const base: ParityHistory = {
  parse: [pt('2026-05-12T13:54:17Z', 183, 197), pt('2026-11-15T00:00:10Z', 300, 300)],
  eval: [pt('2026-11-13T09:00:00Z', 937, 937), pt('2026-11-15T00:02:04Z', 960, 960)],
  ir: [pt('2026-11-15T00:02:14Z', 333, 333)],
  evalCoverage: [pt('2026-11-15T00:02:05Z', 215, 215)],
  featureCoverage: [pt('2026-11-15T00:02:05Z', 51, 51)],
};

async function renderAll(history: ParityHistory, now = NOW) {
  const summary = summarizeParity(history, now);
  const parts = await Promise.all([
    ParityVerdict({ summary, locale: 'en' }),
    summary.verdict === 'empty' ? null : AgreementCards({ summary, locale: 'en' }),
    summary.verdict === 'empty' ? null : CoverageMeters({ summary, locale: 'en' }),
    summary.verdict === 'empty' ? null : ParityDivergences({ summary }),
    ParityMethodology(),
  ]);
  const view = render(<>{parts}</>);
  // 缺键时 next-intl 会回退成 "equivalencePage.xxx" 路径
  expect(view.container.textContent).not.toMatch(/equivalencePage\.|verdict\.|dimensions\./);
  return view;
}

describe('equivalence 页面区块', () => {
  it('全部一致：结论给出检查总数与日期，三张卡都标「Agree」，显示语料增长', async () => {
    await renderAll(base);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Both engines agree on all 1,593 checks');
    expect(screen.getByText(/Last checked Nov 15, 2026/)).toBeTruthy();
    expect(screen.getAllByText('Agree')).toHaveLength(3);
    expect(screen.getByText('Up from 197 on May 12, 2026')).toBeTruthy();
    expect(screen.queryByText('This report is out of date')).toBeNull();
    expect(screen.queryByText('Open divergences')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Resolved divergences' })).toBeTruthy();
    expect(screen.getAllByRole('meter')).toHaveLength(2);
  });

  it('最新运行有分歧：结论改为分歧数，卡片标红并显示回退，出现未解决分歧区与报告链接', async () => {
    await renderAll({ ...base, eval: [pt('2026-11-13T09:00:00Z', 937, 937), pt('2026-11-15T00:02:04Z', 958, 960)] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      '2 of 1,593 checks gave different results in the latest measurements',
    );
    expect(screen.getByText('Divergence found')).toBeTruthy();
    expect(screen.getAllByText('2 differ').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Down from 100% on Nov 13, 2026')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Open divergences' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Parse report/ }).getAttribute('href')).toContain('equivalence-report.json');
    expect(screen.getByRole('link', { name: 'See which checks differ' }).getAttribute('href')).toBe('#divergences');
  });

  it('报告过期：保留结论但显示过期警告与天数', async () => {
    await renderAll(base, Date.parse('2026-11-15T00:02:14Z') + STALE_AFTER_MS + 2 * 86_400_000);
    expect(screen.getByText('This report is out of date')).toBeTruthy();
    expect(screen.getByText(/The newest measurement is 5 days old/)).toBeTruthy();
    expect(screen.getAllByText(/Last measured Nov 15, 2026/).length).toBeGreaterThanOrEqual(3);
  });

  it('缺一个维度：结论降为「已加载的检查」，警告列出缺失层，该卡显示暂无数据', async () => {
    await renderAll({ ...base, ir: [] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Both engines agree on all 1,260 checks that could be loaded');
    expect(screen.getByText('Incomplete data')).toBeTruthy();
    expect(screen.getByText(/No data is available for: Compiled form \(Core IR\)/)).toBeTruthy();
    expect(screen.getByText('No data available')).toBeTruthy();
    expect(screen.getAllByText('Agree')).toHaveLength(2);
  });

  it('某维度最新测量落后于结论日期：该卡标出自己的测量日期', async () => {
    await renderAll({ ...base, ir: [pt('2026-11-14T00:02:14Z', 333, 333)] });
    expect(screen.getByText('Last measured Nov 14, 2026')).toBeTruthy();
    expect(screen.getByText(/Last checked Nov 15, 2026/)).toBeTruthy();
  });

  it('完全没有数据：不显示任何数字，给出仓库链接', async () => {
    const view = await renderAll({ parse: [], eval: [], ir: [], evalCoverage: [], featureCoverage: [] });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Parity data is not available right now');
    expect(screen.getByRole('link', { name: /Open the test repository/ }).getAttribute('href')).toBe(
      'https://github.com/aster-cloud/aster-lang-test',
    );
    expect(view.container.textContent).not.toMatch(/100%|Last checked/);
  });
});
