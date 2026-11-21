/*
 * 版本详情面板（审批者读源码的地方，裁决 R15）的 layout 只读视图（ADR 0058 §7.7 第 1 条，计划 T7）。
 * 无 layout 的版本：source 区 DOM 与引入 layout 之前逐字节一致（快照在改动前的代码上固化）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

// t 必须在多次渲染间保持同一引用（与真实 next-intl 的 useMemo 一致）：面板的 fetchDetail 以 t 为依赖，
// 每次渲染返回新函数会让 effect 无限重取详情，面板在加载骨架与内容之间来回切换，断言随机落空（#849）。
const translator = vi.hoisted(() => {
  const byNs = new Map<string, (key: string) => string>();
  return (ns: string) => {
    if (!byNs.has(ns)) byNs.set(ns, (key: string) => `${ns}.${key}`);
    return byNs.get(ns)!;
  };
});
vi.mock('next-intl', () => ({
  useTranslations: translator,
  useLocale: () => 'en',
}));

import { VersionDetailPanel } from '@/components/policy/version-detail-panel';
import { LAYOUT_DISPLAY, LAYOUT_SOURCE, STORED_INCONSISTENT, STORED_OK } from '@/__tests__/fixtures/layout-read-fixture';

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

describe('VersionDetailPanel：审批者先看到 canonical（裁决 R15）', () => {
  // 面板本身不区分用户：审批者（团队 owner）在版本列表打开的就是这个面板，渲染与其他读者相同。
  const pending = (layout: unknown, source = LAYOUT_SOURCE) =>
    detail({ status: 'PENDING_APPROVAL', source, content: source, layout });

  it('待审批版本 + layout ok：source 区首先可见的是 canonical 源码，display 只在点击次级标签后出现', async () => {
    const { container } = await renderPanel(pending(STORED_OK));
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].textContent).toBe('policyLayout.tabCanonical');
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    const visiblePre = [...container.querySelectorAll('pre')].filter((el) => !el.closest('[hidden]'));
    expect(visiblePre.map((el) => el.textContent)).toEqual([LAYOUT_SOURCE]);
    expect(screen.queryByRole('region', { name: 'policyLayout.displayLabel' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'policyLayout.tabDisplay' }));
    expect(screen.getByRole('region', { name: 'policyLayout.displayLabel' }).textContent).toBe(LAYOUT_DISPLAY);
  });

  it('inconsistent：只有 canonical 与提示', async () => {
    const { container } = await renderPanel(pending(STORED_INCONSISTENT));
    expect(screen.getByText('policyLayout.inconsistent')).toBeDefined();
    expect(screen.queryByRole('tab')).toBeNull();
    expect([...container.querySelectorAll('pre')].map((el) => el.textContent)).toEqual([LAYOUT_SOURCE]);
  });

  it('layout ok 但与面板显示的源码对不上：按 inconsistent 处理，不显示过期排版', async () => {
    await renderPanel(pending(STORED_OK, SOURCE));
    expect(screen.getByText('policyLayout.inconsistent')).toBeDefined();
    expect(screen.queryByRole('tab')).toBeNull();
  });
});
