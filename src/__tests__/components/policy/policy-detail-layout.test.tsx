/*
 * 策略详情页源码卡片的 layout 只读视图（ADR 0058 §7.7 第 1 条，计划 T7 / 裁决 R16）。
 * 活跃版本没有 layout 时，卡片 DOM 与引入 layout 之前逐字节一致（快照在改动前的代码上固化）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';

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
