/*
 * 执行日志页本地化（生产 E2E F4）：相对时间与筛选区标签不得出现硬编码英文——
 * 「刚刚」走翻译，分钟/小时/天按界面语言格式化；「状态」筛选标签、加载与空态提示都取自翻译。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => `policies.${key}`,
}));
vi.mock('@/components/ui', () => ({
  Breadcrumbs: () => null,
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { LogsContent, formatRelativeTime } from './logs-content';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = new Date('2026-10-22T12:00:00Z');

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe('formatRelativeTime', () => {
  it('不足一分钟返回传入的本地化「刚刚」', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    expect(formatRelativeTime(ago(10_000), 'zh', '刚刚')).toBe('刚刚');
  });

  it('分钟/小时/天按 locale 格式化（zh 不出现英文 ago）', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    expect(formatRelativeTime(ago(5 * 60_000), 'zh', '刚刚')).toBe('5分钟前');
    expect(formatRelativeTime(ago(3 * 3_600_000), 'zh', '刚刚')).toBe('3小时前');
    expect(formatRelativeTime(ago(2 * 86_400_000), 'zh', '刚刚')).toBe('2天前');
    expect(formatRelativeTime(ago(5 * 60_000), 'en', 'Just now')).toBe('5m ago');
  });
});

describe('LogsContent 筛选区与空态文案', () => {
  const translations = {
    logs: {
      title: 'Logs', noLogs: '暂无执行日志', all: '全部', success: '成功', failed: '失败',
      filter: '状态', filtersTitle: '筛选', source: '来源', from: '从', to: '至',
      web: '网页', api: 'API', cli: '命令行', successRate: 'Rate', avgDuration: 'Avg', totalExecutions: 'Total',
      pendingLabel: 'Pending', rateNote: 'note', loadError: 'Load error',
      justNow: '刚刚', loadingLogs: '正在加载执行日志…', noLogsHint: '执行该策略后，日志会显示在这里',
    },
  } as unknown as Parameters<typeof LogsContent>[0]['translations'];

  it('「状态」标签与筛选标题来自翻译，空态提示不含硬编码英文', () => {
    render(
      <LogsContent policyId="p1" policyName="P" translations={translations} locale="zh" initialLogs={[]}
        initialStats={{ totalExecutions: 0, successCount: 0, failureCount: 0, pendingCount: 0, indeterminateCount: 0,
          avgDurationMs: 0, successRate: 0, bySource: [], recentTrend: [] }}
        initialTotalPages={1} />,
    );
    expect(screen.getByText('筛选')).toBeTruthy();
    expect(screen.getByText('状态')).toBeTruthy();
    expect(screen.getByText('执行该策略后，日志会显示在这里')).toBeTruthy();
    expect(screen.queryByText('Status')).toBeNull();
    expect(screen.queryByText('Execute the policy to see logs here')).toBeNull();
  });
});
