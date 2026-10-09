/*
 * 时长列渲染（UI E2E O2）：API 字段是 durationMs，缺失/非数字时必须显示「—」，绝不出现 NaN；
 * 统计卡展示待处置数与通过率口径说明。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => `policies.${key}`,
}));
vi.mock('@/lib/format', () => ({ formatDate: (d: string) => d }));
vi.mock('@/components/ui', () => ({
  Breadcrumbs: () => null,
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { LogsContent, formatDuration } from './logs-content';

afterEach(cleanup);

const translations = {
  logs: {
    title: 'Logs', noLogs: 'No logs', all: 'All', success: 'Success', failed: 'Failed',
    computed: 'Computed', require_approval: 'Needs approval', escalate: 'Escalated',
    web: 'Web', api: 'API', cli: 'CLI', duration: 'Duration', version: 'Version',
    successRate: 'Rate', avgDuration: 'Avg', totalExecutions: 'Total',
    pendingLabel: 'Pending', rateNote: 'Settled decisions only', loadError: 'Load error',
  },
} as unknown as Parameters<typeof LogsContent>[0]['translations'];

function mkLog(id: string, duration: unknown) {
  return {
    id, success: false, decision: 'require_approval' as const, input: {}, output: {},
    error: null, duration: duration as number, source: 'API' as const, policyVersion: 1,
    createdAt: '2026-07-25T00:00:00Z', runnerParityStatus: null,
  };
}

describe('formatDuration', () => {
  it('数字 ⇒ ms / s；缺失/非数字 ⇒ —', () => {
    expect(formatDuration(12)).toBe('12ms');
    expect(formatDuration(1500)).toBe('1.50s');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration('12')).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});

describe('LogsContent 时长与统计', () => {
  it('★缺失时长的行渲染「—」，页面无 NaN；统计卡显示待处置与口径说明', () => {
    const { container } = render(
      <LogsContent
        policyId="p1"
        policyName="Test policy"
        translations={translations}
        locale="en"
        initialLogs={[mkLog('e1', undefined), mkLog('e2', 42)]}
        initialStats={{
          totalExecutions: 5, successCount: 1, failureCount: 0, pendingCount: 4,
          avgDurationMs: Number.NaN, successRate: 100, bySource: [], recentTrend: [],
        }}
        initialTotalPages={1}
      />,
    );
    expect(container.textContent).not.toContain('NaN');
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('42ms')).toBeTruthy();
    expect(screen.getByTestId('logs-rate-note').textContent).toContain('Pending: 4');
  });
});
