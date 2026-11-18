import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

/**
 * 策略详情页「导出为 Cedar」的位置与显隐（#786）。
 *
 * - 按钮在页头右上的操作组里，与执行 / 编辑 / 删除同组，排在破坏性的「删除」之前；
 * - 结果 / 提示的 aria-live 状态区在页头之后（紧贴操作组下方），不在操作组里；
 * - 服务端判定不可导出时（showCedarExport=false）整组不渲染；缺省也不渲染（fail-closed，旧调用方不会突然多出按钮）。
 */

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/components/policy/share-with-teams-card', () => ({ ShareWithTeamsCard: () => <div /> }));
vi.mock('@/components/policy/policy-review-panel', () => ({ PolicyReviewPanel: () => <div /> }));
vi.mock('@/components/policy/policy-versions-tab', () => ({ PolicyVersionsTab: () => <div /> }));
vi.mock('@/components/policy/policy-analytics-section', () => ({ PolicyAnalyticsSection: () => <div /> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));

import { PolicyDetailContent } from
  '@/app/[locale]/(dashboard)/policies/[id]/policy-detail-content';

const policy = {
  id: 'pol-786',
  name: 'Cedar placement',
  description: '',
  content: 'Module m.',
  version: 1,
  isFrozen: false,
  createdAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
  _count: { executions: 0 },
};

/** 只有本用例关心的文案给真实值，其余任意深度属性都可当字符串用 */
function deepStub(path = ''): unknown {
  const real: Record<string, string> = {
    executeAction: 'Execute', edit: 'Edit', delete: 'Delete',
    'cedarExport.button': 'Export to Cedar', 'cedarExport.exporting': 'Exporting…',
    'cedarExport.noExecutableVersion': 'Approve a version first',
    'packageExport.menu': 'Export', 'packageExport.exporting': 'Exporting…',
  };
  return new Proxy(function stub() {} as unknown as object, {
    get: (_t, k) => {
      if (typeof k !== 'string') return () => real[path] ?? 'x';
      if (k === 'toString') return () => real[path] ?? 'x';
      if (k === 'then') return undefined;
      const next = path ? `${path}.${k}` : k;
      return next in real ? real[next] : deepStub(next);
    },
    apply: () => 'x',
  });
}
const translations = deepStub() as never;

afterEach(() => cleanup());

const actions = (group: HTMLElement) => Array.from(group.querySelectorAll('a[href], button'));

function renderDetail(props: Record<string, unknown>) {
  return render(<PolicyDetailContent policy={policy as never} translations={translations} locale="en" {...props} />);
}

describe('policy detail: Export to Cedar (#786)', () => {
  it('exportable: the button sits in the header action group, before Delete', () => {
    renderDetail({ showCedarExport: true });
    const group = screen.getByTestId('policy-actions');
    const names = actions(group).map((el) => el.getAttribute('aria-label') || el.textContent);
    expect(names).toEqual(['Execute', 'Edit', 'Export to Cedar', 'Delete']);
  });

  it('exportable: the status region follows the header, outside the action group', () => {
    renderDetail({ showCedarExport: true });
    const status = screen.getByTestId('cedar-export-status');
    expect(screen.getByTestId('policy-actions').contains(status)).toBe(false);
    // 状态区紧跟在页头（PageHeader 渲染的 <header>）之后，中间没有别的块
    expect(document.querySelector('header')?.nextElementSibling).toBe(status);
  });

  it('not exportable: neither the button nor the status region is rendered', () => {
    renderDetail({ showCedarExport: false });
    expect(screen.queryByTestId('cedar-export-button')).toBeNull();
    expect(screen.queryByTestId('cedar-export-status')).toBeNull();
    expect(actions(screen.getByTestId('policy-actions'))).toHaveLength(3);
  });

  it('defaults to hidden when the server did not decide (fail-closed for callers)', () => {
    renderDetail({});
    expect(screen.queryByTestId('cedar-export-button')).toBeNull();
  });

  it('no executable version yet: disabled button with the approve-first hint below the header', () => {
    renderDetail({ showCedarExport: true, hasExecutableVersion: false });
    const button = screen.getByTestId('cedar-export-button');
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('cedar-export-status').textContent).toContain('Approve a version first');
  });

  it('the action group wraps on narrow screens instead of overflowing', () => {
    renderDetail({ showCedarExport: true });
    expect(screen.getByTestId('policy-actions').className).toMatch(/\bflex-wrap\b/);
  });

  // ADR 0059 P2：策略包选项接入后，没有包选项时操作组与之前逐字相同
  describe('policy package export (ADR 0059 P2)', () => {
    const none = { jre: 'unavailable', node: 'unavailable', diagnostics: { jre: [], node: [] }, entryRequired: false, entryCandidates: [] };
    const jre = { ...none, jre: 'exportable' };

    it('Cedar only: the action group DOM is unchanged whether packageExport is absent, null or all-unavailable', () => {
      const baseline = renderDetail({ showCedarExport: true }).container.querySelector('[data-testid="policy-actions"]')!.outerHTML;
      cleanup();
      for (const packageExport of [null, none]) {
        const html = renderDetail({ showCedarExport: true, packageExport }).container.querySelector('[data-testid="policy-actions"]')!.outerHTML;
        expect(html).toBe(baseline);
        cleanup();
      }
    });

    it('package options present: the Cedar button becomes an Export menu in the same place', () => {
      renderDetail({ showCedarExport: true, packageExport: jre });
      // 可访问名不含 aria-hidden 的「导出中…」占位文案
      const accessibleName = (el: Element) => {
        const clone = el.cloneNode(true) as Element;
        clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
        return el.getAttribute('aria-label') || clone.textContent;
      };
      expect(actions(screen.getByTestId('policy-actions')).map(accessibleName)).toEqual(['Execute', 'Edit', 'Export', 'Delete']);
      expect(screen.queryByTestId('cedar-export-button')).toBeNull();
    });

    it('package options without Cedar: the menu still renders, with its own status region after the header', () => {
      renderDetail({ showCedarExport: false, packageExport: jre });
      expect(screen.getByTestId('policy-export-menu-button')).toBeTruthy();
      const status = screen.getByTestId('package-export-status');
      expect(screen.getByTestId('policy-actions').contains(status)).toBe(false);
      expect(document.querySelector('header')?.nextElementSibling).toBe(status);
    });

    it('neither Cedar nor packages: nothing export-related renders', () => {
      renderDetail({ showCedarExport: false, packageExport: null });
      expect(screen.queryByTestId('policy-export-menu-button')).toBeNull();
      expect(screen.queryByTestId('package-export-status')).toBeNull();
      expect(actions(screen.getByTestId('policy-actions'))).toHaveLength(3);
    });
  });
});
