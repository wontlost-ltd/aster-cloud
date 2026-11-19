/*
 * 版本对比面板的「显示排版已变更」一行（ADR 0058 §7.7 第 2 条，计划 T8）。
 * diff 只比 canonical 源码；两侧都没有 layout 时 DOM 与引入 layout 之前一致（快照在改动前固化）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}));
vi.mock('@/components/policy/whatif-batch-panel', () => ({ WhatIfBatchPanel: () => <div data-testid="whatif" /> }));

import { VersionComparePanel } from '@/components/policy/version-compare-panel';
import { STORED_INCONSISTENT, STORED_OK } from '@/__tests__/fixtures/layout-read-fixture';

const V1 = 'Module m.\n\nRule decide given x: Int, produce Int:\n  Return x.\n';
const V2 = 'Module m.\n\nRule decide given x: Int, produce Int:\n  Return 1.\n';

const VERSIONS = [
  { id: 'r1', version: 1, status: 'APPROVED', isDefault: true, releaseNote: null, createdAt: '2026-11-18T00:00:00Z' },
  { id: 'r2', version: 2, status: 'PENDING_APPROVAL', isDefault: false, releaseNote: null, createdAt: '2026-11-19T00:00:00Z' },
] as const;

function stubVersions(byVersion: Record<number, Record<string, unknown>>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
    const v = Number(url.split('/').pop());
    return { ok: true, json: async () => byVersion[v] };
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderCompare(byVersion: Record<number, Record<string, unknown>>) {
  stubVersions(byVersion);
  const view = render(<VersionComparePanel policyId="p1" versions={[...VERSIONS] as never} />);
  await waitFor(() => expect(screen.getByText('Return 1.')).toBeDefined());
  return view;
}

describe('VersionComparePanel：两侧都没有 layout 时 DOM 不变', () => {
  it('两侧 layout.status = none：与改动前快照一致', async () => {
    const { container } = await renderCompare({
      1: { source: V1, layout: { status: 'none' } },
      2: { source: V2, layout: { status: 'none' } },
    });
    expect(container.innerHTML).toMatchSnapshot();
  });
});

describe('VersionComparePanel：显示排版已变更', () => {
  const row = () => screen.queryByTestId('layout-compare-changed');
  const statsText = (container: HTMLElement) =>
    [...container.querySelectorAll('span')].map((el) => el.textContent).filter((s) => s?.startsWith('policies.versionCompare.lines'));
  const diffRows = (container: HTMLElement) => container.querySelectorAll('.font-mono > div').length;

  it('一侧 none、一侧 ok：显示「显示排版已变更」，带可见标签', async () => {
    await renderCompare({ 1: { source: V1, layout: { status: 'none' } }, 2: { source: V2, layout: STORED_OK } });
    expect(row()).not.toBeNull();
    expect(screen.getByText('policyLayout.compareChanged')).toBeDefined();
    expect(screen.getByText('policyLayout.compareNote')).toBeDefined();
  });

  it('两侧同哈希：不显示', async () => {
    await renderCompare({ 1: { source: V1, layout: STORED_OK }, 2: { source: V2, layout: STORED_OK } });
    expect(row()).toBeNull();
  });

  it('inconsistent 也按哈希比较：与同哈希的 ok 相同则不显示，与 none 不同则显示', async () => {
    await renderCompare({ 1: { source: V1, layout: STORED_INCONSISTENT }, 2: { source: V2, layout: STORED_OK } });
    expect(row()).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    await renderCompare({ 1: { source: V1, layout: STORED_INCONSISTENT }, 2: { source: V2, layout: { status: 'none' } } });
    expect(row()).not.toBeNull();
  });

  it('有该行时 diff 行数与增删统计与无 layout 时相同（diff 只比 canonical）', async () => {
    const plain = await renderCompare({ 1: { source: V1 }, 2: { source: V2 } });
    const plainRows = diffRows(plain.container);
    const plainStats = statsText(plain.container);
    cleanup();
    vi.unstubAllGlobals();
    const withRow = await renderCompare({ 1: { source: V1, layout: { status: 'none' } }, 2: { source: V2, layout: STORED_OK } });
    expect(row()).not.toBeNull();
    expect(diffRows(withRow.container)).toBe(plainRows);
    expect(statsText(withRow.container)).toEqual(plainStats);
    expect(plainStats).toEqual([
      'policies.versionCompare.linesAdded:{"n":1}',
      'policies.versionCompare.linesRemoved:{"n":1}',
    ]);
  });
});
