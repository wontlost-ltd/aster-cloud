/*
 * 审批视图的策略内嵌词汇（ADR 0060 §7.5，计划 T11）：
 * - 版本详情：映射表在别名映射之下，字面量行带「展开为字符串」标记；已存文本损坏时明说不会执行；
 *   无内嵌词汇的版本 DOM 与改动前一致（version-detail-layout 的快照在 main 上固化，本 PR 不改）。
 * - 版本对比：两侧存的文本不同单列一行「策略自带词汇已变更」，相同或都没有时不显示。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
  useLocale: () => 'en',
}));
vi.mock('@/components/policy/whatif-batch-panel', () => ({ WhatIfBatchPanel: () => <div data-testid="whatif" /> }));

import { VersionDetailPanel } from '@/components/policy/version-detail-panel';
import { VersionComparePanel } from '@/components/policy/version-compare-panel';
import { EmbeddedVocabularyMap } from '@/components/policy/embedded-vocabulary-map';

const SOURCE = '模块 明月光。\n规则 地上霜，产出 望明月：\n  返回 思故乡。';
const POEM_TEXT =
  '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},{"kind":"struct","localized":"望明月","canonical":"Text"}]}';
const T = 'policyEditor.embeddedTerms';

function detail(over: Record<string, unknown> = {}) {
  return {
    id: 'ver-2', version: 2, source: SOURCE, content: SOURCE,
    sourceHash: 'h2', prevHash: 'h1', status: 'PENDING_APPROVAL', isDefault: false,
    releaseNote: null, aliasSet: null, createdBy: 'author', createdAt: '2026-11-20T00:00:00Z',
    deprecatedAt: null, deprecatedBy: null, archivedAt: null, archivedBy: null,
    approvals: [], layout: { status: 'none' },
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderDetail(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
  const view = render(<VersionDetailPanel policyId="p1" version={2} />);
  await waitFor(() => expect(screen.getByText('v2')).toBeDefined());
  return view;
}

describe('EmbeddedVocabularyMap', () => {
  it('NULL / 缺省：不渲染任何东西', () => {
    expect(render(<EmbeddedVocabularyMap embeddedVocabularyJson={null} />).container.innerHTML).toBe('');
    expect(render(<EmbeddedVocabularyMap embeddedVocabularyJson={undefined} />).container.innerHTML).toBe('');
  });

  it('写法 → 规范名 / 展开值；字面量行带标记', () => {
    render(<EmbeddedVocabularyMap embeddedVocabularyJson={POEM_TEXT} />);
    const region = screen.getByRole('region', { name: `${T}.mapTitle` });
    const rows = within(region).getAllByTestId('embedded-vocabulary-row');
    expect(rows.map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent))).toEqual([
      ['思故乡', '"静夜思"', `${T}.kind_literal · ${T}.expandsTo`],
      ['望明月', 'Text', `${T}.kind_struct`],
    ]);
  });

  it('field 显示所属类型', () => {
    const text = '{"v":1,"terms":[{"kind":"field","localized":"光","canonical":"light","parent":"Moon"}]}';
    render(<EmbeddedVocabularyMap embeddedVocabularyJson={text} />);
    expect(screen.getByText('Moon.light')).toBeDefined();
  });

  it.each([['非 JSON', 'not json'], ['非规范序列化', '{"terms":[],"v":1}'], ['空串', '']])('%s：明说无法读取、不会执行', (_l, text) => {
    render(<EmbeddedVocabularyMap embeddedVocabularyJson={text} />);
    expect(screen.getByRole('alert').textContent).toBe(`${T}.mapUnreadable`);
  });
});

describe('VersionDetailPanel：内嵌词汇映射表', () => {
  it('在别名映射之下；没有别名时也显示', async () => {
    await renderDetail(detail({ embeddedVocabulary: POEM_TEXT, aliasSet: '{"PLUS":["接 着"]}' }));
    const map = screen.getByTestId('embedded-vocabulary-map');
    const aliasTitle = screen.getByText('policies.versions.detail.alias.mapTitle');
    expect(aliasTitle.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();

    await renderDetail(detail({ embeddedVocabulary: POEM_TEXT }));
    expect(screen.getAllByTestId('embedded-vocabulary-row')).toHaveLength(2);
  });

  it('无内嵌词汇（null 或旧接口不带字段）：没有映射表', async () => {
    await renderDetail(detail({ embeddedVocabulary: null }));
    expect(screen.queryByTestId('embedded-vocabulary-map')).toBeNull();
    cleanup();
    await renderDetail(detail());
    expect(screen.queryByTestId('embedded-vocabulary-map')).toBeNull();
  });
});

describe('VersionComparePanel：内嵌词汇已变更', () => {
  const V2 = `${SOURCE}\n`;
  const VERSIONS = [
    { id: 'r1', version: 1, status: 'APPROVED', isDefault: true, releaseNote: null, createdAt: '2026-11-18T00:00:00Z' },
    { id: 'r2', version: 2, status: 'PENDING_APPROVAL', isDefault: false, releaseNote: null, createdAt: '2026-11-19T00:00:00Z' },
  ];
  async function renderCompare(left: string | null | undefined, right: string | null | undefined) {
    const side = (text: string | null | undefined, source: string) => ({
      source,
      layout: { status: 'none' },
      ...(text === undefined ? {} : { embeddedVocabulary: text }),
    });
    const byVersion: Record<number, unknown> = { 1: side(left, SOURCE), 2: side(right, V2) };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => byVersion[Number(url.split('/').pop())] })));
    render(<VersionComparePanel policyId="p1" versions={VERSIONS as never} />);
    await waitFor(() => expect(screen.queryByText('policies.versionCompare.loadSourceError')).toBeNull());
    await waitFor(() => expect(screen.getAllByText(/思故乡/).length).toBeGreaterThan(0));
  }
  const row = () => screen.queryByTestId('embedded-vocabulary-compare-changed');

  it('一侧有、一侧无：显示一行', async () => {
    await renderCompare(null, POEM_TEXT);
    expect(row()?.textContent).toContain(`${T}.compareChanged`);
  });

  it('两侧相同或都没有（含旧接口）：不显示', async () => {
    await renderCompare(POEM_TEXT, POEM_TEXT);
    expect(row()).toBeNull();
    cleanup();
    await renderCompare(undefined, null);
    expect(row()).toBeNull();
  });
});
