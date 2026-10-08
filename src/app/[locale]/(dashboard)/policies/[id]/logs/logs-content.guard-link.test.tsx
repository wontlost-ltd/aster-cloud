/*
 * 日志页 guard 入口渲染（ADR 0042 §5.4）：已登记行链到收件箱定位，登记失败行可「重新登记」，
 * 重新登记成功后就地换成链接；无 metadata 行不渲染任何入口。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

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

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const translations = {
  logs: {
    title: 'Logs', backToPolicy: 'Back', noLogs: 'No logs', filter: 'Filter', all: 'All',
    success: 'Success', failed: 'Failed', computed: 'Computed', require_approval: 'Needs approval',
    escalate: 'Escalated', source: 'Source', web: 'Web', api: 'API', cli: 'CLI', dateRange: 'Range',
    from: 'From', to: 'To', apply: 'Apply', reset: 'Reset', executedAt: 'At', duration: 'Duration',
    version: 'Version', input: 'Input', output: 'Output', error: 'Error', showMore: 'More', showLess: 'Less',
    page: 'Page', of: 'of', previous: 'Prev', next: 'Next', stats: 'Stats', totalExecutions: 'Total',
    successRate: 'Rate', avgDuration: 'Avg', recentActivity: 'Recent', loadError: 'Load error',
    viewApproval: 'Pending approval · View', registerGuard: 'Register again', guardError: 'Registration failed',
  },
} as unknown as Parameters<typeof LogsContent>[0]['translations'];

const initialStats = {
  totalExecutions: 1, successCount: 0, failureCount: 0, avgDurationMs: 10,
  successRate: 0, bySource: [], recentTrend: [],
};

function mkLog(id: string, metadata: Record<string, string> | null) {
  return {
    id, success: false, decision: 'require_approval' as const, input: {}, output: {},
    error: null, duration: 10, source: 'dashboard' as const, policyVersion: 1,
    createdAt: '2026-10-09T00:00:00Z', runnerParityStatus: null, metadata,
  };
}

function renderWith(logs: Array<ReturnType<typeof mkLog>>) {
  return render(
    <LogsContent policyId="p1" policyName="P" translations={translations} locale="en"
      initialLogs={logs} initialStats={initialStats} initialTotalPages={1} />,
  );
}

describe('日志页 guard 入口', () => {
  it('有 guardDecisionId → 链接到 /approvals?decisionId=d1', () => {
    renderWith([mkLog('e1', { guardDecisionId: 'd1', guardApprovalId: 'a1' })]);
    const link = screen.getByText('Pending approval · View');
    expect(link.getAttribute('href')).toContain('/approvals?decisionId=d1');
    expect(screen.queryByText('Register again')).toBeNull();
  });

  it('有 guardError → 渲染「重新登记」按钮，点击后 POST 并就地换成链接', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ metadata: { guardDecisionId: 'd9', guardApprovalId: 'a9' } }),
    });
    renderWith([mkLog('e2', { guardError: 'client_error' })]);

    const button = screen.getByRole('button', { name: 'Register again' });
    expect(button.getAttribute('title')).toContain('client_error');
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledWith('/api/policies/p1/executions/e2/guard-register', { method: 'POST' });
    await waitFor(() => expect(screen.getByText('Pending approval · View').getAttribute('href')).toContain('decisionId=d9'));
  });

  it('无 metadata → 不渲染链接或按钮', () => {
    renderWith([mkLog('e3', null)]);
    expect(screen.queryByText('Pending approval · View')).toBeNull();
    expect(screen.queryByText('Register again')).toBeNull();
  });
});
