/*
 * 版本详情面板（审批者读源码的地方，裁决 R15）的 layout 只读视图（ADR 0058 §7.7 第 1 条，计划 T7）。
 * 无 layout 的版本：source 区 DOM 与引入 layout 之前逐字节一致（快照在改动前的代码上固化）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
  useLocale: () => 'en',
}));

import { VersionDetailPanel } from '@/components/policy/version-detail-panel';

const SOURCE = 'Module m.\n\nRule decide given x: Int, produce Int:\n  Return x.\n';

function detail(over: Record<string, unknown> = {}) {
  return {
    id: 'ver-2', version: 2, source: SOURCE, content: SOURCE,
    sourceHash: 'h2', prevHash: 'h1', status: 'PENDING_APPROVAL', isDefault: false,
    releaseNote: 'note', aliasSet: null, createdBy: 'author', createdAt: '2026-11-19T00:00:00Z',
    deprecatedAt: null, deprecatedBy: null, archivedAt: null, archivedBy: null,
    approvals: [],
    layout: { status: 'none' },
    ...over,
  };
}

function stubDetail(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => body }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderPanel(body: unknown) {
  stubDetail(body);
  const view = render(<VersionDetailPanel policyId="p1" version={2} />);
  await waitFor(() => expect(screen.getByText('v2')).toBeDefined());
  return view;
}

describe('VersionDetailPanel：无 layout 的版本 DOM 不变', () => {
  it('layout.status = none：整块面板与改动前快照一致', async () => {
    const { container } = await renderPanel(detail());
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('旧接口不带 layout 字段：同样与改动前快照一致', async () => {
    const { layout: _omit, ...legacy } = detail();
    void _omit;
    const { container } = await renderPanel(legacy);
    expect(container.innerHTML).toMatchSnapshot();
  });
});
