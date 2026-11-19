/*
 * 策略详情页源码卡片的 layout 只读视图（ADR 0058 §7.7 第 1 条，计划 T7 / 裁决 R16）。
 * 活跃版本没有 layout 时，卡片 DOM 与引入 layout 之前逐字节一致（快照在改动前的代码上固化）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

vi.mock('next-intl', () => ({ useTranslations: (ns: string) => (key: string) => `${ns}.${key}` }));
vi.mock('@/components/policy/share-with-teams-card', () => ({ ShareWithTeamsCard: () => <div /> }));
vi.mock('@/components/policy/policy-review-panel', () => ({
  PolicyReviewPanel: ({ hasDisplayLayout }: { hasDisplayLayout?: boolean }) => (
    <div data-testid="review-panel" data-has-display-layout={String(hasDisplayLayout)} />
  ),
}));
vi.mock('@/components/policy/policy-versions-tab', () => ({ PolicyVersionsTab: () => <div /> }));
vi.mock('@/components/policy/policy-analytics-section', () => ({ PolicyAnalyticsSection: () => <div /> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import { PolicyDetailContent } from
  '@/app/[locale]/(dashboard)/policies/[id]/policy-detail-content';
import { LAYOUT_DISPLAY, LAYOUT_SOURCE, STORED_INCONSISTENT, STORED_OK } from '@/__tests__/fixtures/layout-read-fixture';

const SOURCE = 'Module m.\n\nRule decide given x: Int, produce Int:\n  Return x.\n';

const policy = {
  id: 'pol-0058', name: 'Layout detail', description: '', content: SOURCE, version: 2,
  isPublic: true, shareSlug: null, piiFields: null, isFrozen: false,
  createdAt: '2026-11-19T00:00:00Z', updatedAt: '2026-11-19T00:00:00Z', versions: [],
  _count: { executions: 0 },
};

function deepStub(path = ''): unknown {
  return new Proxy(function stub() {} as unknown as object, {
    get: (_t, k) => {
      if (typeof k !== 'string' || k === 'toString') return () => path || 'x';
      if (k === 'then') return undefined;
      return deepStub(path ? `${path}.${k}` : k);
    },
    apply: () => 'x',
  });
}
const translations = deepStub() as never;

afterEach(() => cleanup());

function renderDetail(props: Record<string, unknown> = {}) {
  return render(<PolicyDetailContent policy={policy as never} translations={translations} locale="en" {...props} />);
}

/** 源码卡片：`<pre>` 所在的整张卡片（标题 + 源码）。 */
function sourceCard(container: HTMLElement): HTMLElement {
  const pre = container.querySelector('pre');
  if (!pre) throw new Error('源码 <pre> 未渲染');
  return pre.closest('.shadow') as HTMLElement;
}

describe('策略详情源码卡片：活跃版本无 layout 时 DOM 不变', () => {
  it('activeLayout = none：卡片与改动前快照一致', () => {
    const { container } = renderDetail({ activeLayout: { status: 'none' } });
    expect(sourceCard(container).outerHTML).toMatchSnapshot();
  });

  it('不传 activeLayout（旧调用方）：卡片与改动前快照一致', () => {
    const { container } = renderDetail();
    expect(sourceCard(container).outerHTML).toMatchSnapshot();
  });
});

describe('策略详情源码卡片：活跃版本有 layout', () => {
  const withSource = { ...policy, content: LAYOUT_SOURCE };

  it('ok：canonical 默认，display 是次级标签', () => {
    const { container } = render(
      <PolicyDetailContent policy={withSource as never} translations={translations} locale="en" activeLayout={STORED_OK} />,
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => [t.textContent, t.getAttribute('aria-selected')])).toEqual([
      ['policyLayout.tabCanonical', 'true'],
      ['policyLayout.tabDisplay', 'false'],
    ]);
    expect(sourceCard(container).querySelector('pre')!.textContent).toBe(LAYOUT_SOURCE);
    fireEvent.click(tabs[1]);
    expect(screen.getByRole('region', { name: 'policyLayout.displayLabel' }).textContent).toBe(LAYOUT_DISPLAY);
  });

  it('无编辑权限的读者（公开策略、非作者、无结构化编写能力）同样看到 display 标签', () => {
    render(
      <PolicyDetailContent
        policy={withSource as never}
        translations={translations}
        locale="en"
        capabilities={{ execute: false, update: false, delete: false }}
        activeLayout={STORED_OK}
      />,
    );
    expect(screen.getByRole('tab', { name: 'policyLayout.tabDisplay' })).toBeDefined();
  });

  it('inconsistent：只有 canonical 与提示', () => {
    render(
      <PolicyDetailContent policy={withSource as never} translations={translations} locale="en" activeLayout={STORED_INCONSISTENT} />,
    );
    expect(screen.getByText('policyLayout.inconsistent')).toBeDefined();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it.each([
    ['none', { status: 'none' }, 'false'],
    ['ok', STORED_OK, 'true'],
    ['inconsistent', STORED_INCONSISTENT, 'true'],
  ])('复核面板收到 hasDisplayLayout（%s → %s）', (_name, activeLayout, expected) => {
    render(
      <PolicyDetailContent policy={withSource as never} translations={translations} locale="en" activeLayout={activeLayout as never} />,
    );
    expect(screen.getByTestId('review-panel').getAttribute('data-has-display-layout')).toBe(expected);
  });
});
