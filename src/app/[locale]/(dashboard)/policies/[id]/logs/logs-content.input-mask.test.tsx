/*
 * 日志页输入渲染（cloud#754，ADR 0042 §12 F9）：输入以打码视图树形展示，`$pii` 显示为级别 · 类别徽标，
 * 未声明类型显示「不可见」徽标；页面上不出现 `$pii` 原始 JSON，也没有任何「显示原值」入口。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => `policies.${key}`,
}));
vi.mock('@/lib/format', () => ({ formatDate: (d: string) => d }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('@/components/ui', () => ({
  Breadcrumbs: () => null,
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { LogsContent } from './logs-content';

afterEach(cleanup);

const baseTranslations = {
  title: 'Logs', backToPolicy: 'Back', noLogs: 'No logs', filter: 'Filter', all: 'All',
  success: 'Success', failed: 'Failed', computed: 'Computed', require_approval: 'Needs approval',
  escalate: 'Escalated', source: 'Source', web: 'Web', api: 'API', cli: 'CLI', dateRange: 'Range',
  from: 'From', to: 'To', apply: 'Apply', reset: 'Reset', executedAt: 'At', duration: 'Duration',
  version: 'Version', input: 'Input', output: 'Output', error: 'Error', showMore: 'More', showLess: 'Less',
  page: 'Page', of: 'of', previous: 'Prev', next: 'Next', stats: 'Stats', totalExecutions: 'Total',
  successRate: 'Rate', avgDuration: 'Avg', recentActivity: 'Recent', loadError: 'Load error',
  pendingLabel: 'Pending', rateNote: 'Settled', otherDecisionStates: 'Other', viewApproval: 'View',
  registerGuard: 'Register', guardError: 'Failed', guardDenied: 'Denied', guardAllowed: 'Allowed',
};

type Translations = Parameters<typeof LogsContent>[0]['translations'];

const initialStats = { totalExecutions: 1, successCount: 1, failureCount: 0, avgDurationMs: 1, successRate: 100, bySource: [], recentTrend: [] };

function mkLog(input: unknown, marksSource: 'version' | 'none') {
  return {
    id: 'e1', success: true, decision: 'approved' as const, input, inputMask: { maskRules: 'v1' as const, marksSource },
    output: { allowed: true }, error: null, duration: 1, source: 'dashboard' as const, policyVersion: 1,
    createdAt: '2026-11-15T00:00:00Z', runnerParityStatus: null, metadata: null,
  };
}

function renderExpanded(log: ReturnType<typeof mkLog>, inputMask?: Record<string, string>) {
  const translations = { logs: { ...baseTranslations, ...(inputMask ? { inputMask } : {}) } } as unknown as Translations;
  render(
    <LogsContent policyId="p1" policyName="P" translations={translations} locale="en"
      initialLogs={[log]} initialStats={initialStats} initialTotalPages={1} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /More/ }));
  return screen.getByTestId('log-input');
}

const MASKED = {
  applicant: {
    amount: 100,
    email: { $pii: { level: 'L2', category: 'email' } },
    items: [{ sku: 'SKU-1' }],
  },
  extra: { $pii: { level: 'unknown' } },
};

describe('日志页输入打码渲染', () => {
  it('明文字段原样显示；@pii 显示级别 · 类别徽标；未声明显示不可见徽标；不渲染 $pii 原始 JSON', () => {
    const panel = renderExpanded(mkLog(MASKED, 'version'), {
      note: 'Masked note', piiBadge: '{level} · {category}', unknown: 'Not visible', marksNone: 'All hidden',
    });
    expect(within(panel).getByText('100')).toBeTruthy();
    expect(within(panel).getByText('SKU-1')).toBeTruthy();
    expect(within(panel).getByTestId('pii-masked').textContent).toBe('L2 · email');
    expect(within(panel).getByTestId('pii-unknown').textContent).toBe('Not visible');
    expect(panel.textContent).not.toContain('$pii');
    expect(within(panel).getByText('Masked note')).toBeTruthy();
    expect(within(panel).queryByText('All hidden')).toBeNull();
  });

  it('marksSource = none：显示「类型不可用、全部隐藏」说明', () => {
    const panel = renderExpanded(mkLog({ applicant: { $pii: { level: 'unknown' } } }, 'none'), {
      note: 'Masked note', piiBadge: '{level} · {category}', unknown: 'Not visible', marksNone: 'All hidden',
    });
    expect(within(panel).getByText('All hidden')).toBeTruthy();
  });

  it('日志面没有「显示原值」入口', () => {
    const panel = renderExpanded(mkLog(MASKED, 'version'));
    expect(within(panel).queryByRole('button')).toBeNull();
  });

  it('缺翻译时降级英文默认文案', () => {
    const panel = renderExpanded(mkLog(MASKED, 'version'));
    expect(within(panel).getByTestId('pii-masked').textContent).toBe('L2 · email');
    expect(within(panel).getByTestId('pii-unknown').textContent).toBe('Undeclared type, not visible');
  });
});
