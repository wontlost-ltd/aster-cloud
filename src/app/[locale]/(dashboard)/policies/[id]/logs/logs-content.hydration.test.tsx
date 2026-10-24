/*
 * 执行日志时间列：服务端（运行时 UTC、服务端时刻）与浏览器（本地时区、本地时刻）各自格式化会得到
 * 不同的 tooltip 与"x 分钟前"文本，触发 hydration mismatch。这里在 UTC 下做 SSR、在另一时区且
 * "现在"稍晚的浏览器里 hydrate，要求零 mismatch，挂载后再显示相对时间。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => `policies.${key}`,
}));
vi.mock('@/components/ui', () => ({
  Breadcrumbs: () => null,
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { LogsContent } from './logs-content';

const CREATED_AT = '2026-10-12T22:29:08Z';
const SERVER_NOW = new Date('2026-10-12T22:49:30Z');
const BROWSER_NOW = new Date('2026-10-12T22:51:10Z');

const translations = {
  logs: {
    title: 'Logs', noLogs: 'No logs', all: 'All', success: 'Success', failed: 'Failed',
    computed: 'Computed', require_approval: 'Needs approval', escalate: 'Escalated',
    web: 'Web', api: 'API', cli: 'CLI', duration: 'Duration', version: 'Version',
    successRate: 'Rate', avgDuration: 'Avg', totalExecutions: 'Total',
    pendingLabel: 'Pending', rateNote: 'Settled decisions only', otherDecisionStates: 'Other states', error: 'Execution error', loadError: 'Load error',
  },
} as unknown as Parameters<typeof LogsContent>[0]['translations'];

const props = {
  policyId: 'p1',
  policyName: 'Test policy',
  translations,
  locale: 'en',
  initialLogs: [
    {
      id: 'e1', success: true, decision: 'approved' as const, input: {}, output: {}, error: null,
      duration: 12, source: 'API' as const, policyVersion: 1, createdAt: CREATED_AT, runnerParityStatus: null,
    },
  ],
  initialStats: {
    totalExecutions: 1234, successCount: 1200, failureCount: 34, pendingCount: 0, indeterminateCount: 0,
    avgDurationMs: 12, successRate: 97, bySource: [], recentTrend: [],
  },
  initialTotalPages: 1,
};

const originalTz = process.env.TZ;

afterEach(() => {
  process.env.TZ = originalTz;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('LogsContent — 时间列 hydration', () => {
  it('服务端 UTC、浏览器 Pacific/Auckland 且时刻不同时 hydrate 不报 mismatch，挂载后显示相对时间', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    process.env.TZ = 'UTC';
    vi.setSystemTime(SERVER_NOW);
    const html = renderToString(<LogsContent {...props} />);

    process.env.TZ = 'Pacific/Auckland';
    vi.setSystemTime(BROWSER_NOW);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    const recoverable: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      hydrateRoot(container, <LogsContent {...props} />, {
        onRecoverableError: (err) => recoverable.push(err),
      });
    });
    const mismatchLogs = consoleError.mock.calls.filter((args) => /hydrat/i.test(String(args[0])));
    consoleError.mockRestore();

    expect(recoverable).toEqual([]);
    expect(mismatchLogs).toEqual([]);
    expect(container.textContent).toContain('22m ago');
    expect(container.querySelector('[title$=" UTC"]')?.getAttribute('title')).toContain('10:29:08');
  });
});
