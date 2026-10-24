/*
 * runner-parity 徽章**渲染**测试（此前 gap：比较/持久化/端点都测了，但"divergent 是否真在 UI 露出"没测）。
 * 验证：divergent 行 → 红 `parity ✗` 徽章；match 行 → 绿 `parity ✓`；null 行 → 不渲染徽章。
 * ★真正防的失败模式：分叉被静默写进 DB 却从不显示（红路径不 surface）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// tPolicies（面包屑用 useTranslations('policies')）回显即可；本组件文案走 props.translations。
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => `policies.${key}`,
}));
vi.mock('@/lib/format', () => ({ formatDate: (d: string) => d }));
// UI 原语透传为原生元素（只测行为/文案，不测样式框架）。
vi.mock('@/components/ui', () => ({
  Breadcrumbs: () => null,
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { LogsContent } from './logs-content';

const fetchMock = vi.fn();
beforeEach(() => {
  // 初次挂载用 initialLogs（isInitialMount 短路），fetch 不该被调；仍防御性 stub。
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

// 只填组件真正读到的 t.logs.* 键；parity 子块**故意省略** → 走内置英文兜底（parity ✓/✗）。
const translations = {
  logs: {
    title: 'Logs', backToPolicy: 'Back', noLogs: 'No logs', filter: 'Filter', all: 'All',
    success: 'Success', failed: 'Failed', computed: 'Computed', source: 'Source',
    web: 'Web', api: 'API', cli: 'CLI', dateRange: 'Range', from: 'From', to: 'To',
    apply: 'Apply', reset: 'Reset', executedAt: 'At', duration: 'Duration', version: 'Version',
    input: 'Input', output: 'Output', error: 'Error', showMore: 'More', showLess: 'Less',
    page: 'Page', of: 'of', previous: 'Prev', next: 'Next', stats: 'Stats',
    totalExecutions: 'Total', successRate: 'Rate', avgDuration: 'Avg', recentActivity: 'Recent',
    pendingLabel: 'Pending', rateNote: 'Settled decisions only', otherDecisionStates: 'Other states',
    loadError: 'Load error',
  },
} as unknown as Parameters<typeof LogsContent>[0]['translations'];

const initialStats = {
  totalExecutions: 3, successCount: 3, failureCount: 0, avgDurationMs: 10,
  successRate: 100, bySource: [], recentTrend: [],
};

function mkLog(id: string, runnerParityStatus: string | null) {
  return {
    id, success: true, decision: 'approved' as const, input: {}, output: {},
    error: null, duration: 10, source: 'API' as const, policyVersion: 1,
    createdAt: '2026-07-25T00:00:00Z', runnerParityStatus,
  };
}

function renderWith(logs: Array<ReturnType<typeof mkLog>>) {
  return render(
    <LogsContent
      policyId="p1"
      policyName="Test policy"
      translations={translations}
      locale="en"
      initialLogs={logs}
      initialStats={initialStats}
      initialTotalPages={1}
    />,
  );
}

describe('runner-parity 徽章渲染', () => {
  it('★divergent 行 → 露出红 `parity ✗` 徽章（防静默不显示）', () => {
    renderWith([mkLog('e-div', 'divergent')]);
    const badge = screen.getByText('parity ✗');
    expect(badge).toBeTruthy();
    // 红配色 class（divergent 分支）——不是灰(unavailable)也不是绿(match)。
    expect(badge.className).toContain('text-red-700');
    expect(badge.className).not.toContain('text-green-700');
  });

  it('match 行 → 绿 `parity ✓`', () => {
    renderWith([mkLog('e-match', 'match')]);
    const badge = screen.getByText('parity ✓');
    expect(badge.className).toContain('text-green-700');
  });

  it('null（未跑）行 → 不渲染任何 parity 徽章', () => {
    renderWith([mkLog('e-null', null)]);
    expect(screen.queryByText(/^parity /)).toBeNull();
  });

  it('runner-unavailable → 灰 `parity —`（既非红也非绿）', () => {
    renderWith([mkLog('e-unavail', 'runner-unavailable')]);
    const badge = screen.getByText('parity —');
    expect(badge.className).toContain('text-fg-muted');
    expect(badge.className).not.toContain('text-red-700');
  });

  it('★多行混合：divergent 与 match 同列表各自正确露出（不串色）', () => {
    renderWith([mkLog('e-match', 'match'), mkLog('e-div', 'divergent')]);
    expect(screen.getByText('parity ✓').className).toContain('text-green-700');
    expect(screen.getByText('parity ✗').className).toContain('text-red-700');
  });

  it('翻译到位时 divergent 用译文（i18n 路径，非只兜底）', () => {
    const zh = {
      logs: {
        ...translations.logs,
        parity: {
          tooltip: '回放一致性', match: '一致 ✓', divergent: '分叉 ✗',
          unavailable: '不可达 —', error: '错误', indeterminate: '未定 ?',
        },
      },
    } as unknown as typeof translations;
    render(
      <LogsContent policyId="p1" policyName="P" translations={zh} locale="zh"
        initialLogs={[mkLog('e-div', 'divergent')]} initialStats={initialStats} initialTotalPages={1} />,
    );
    const badge = screen.getByText('分叉 ✗');
    expect(badge.className).toContain('text-red-700'); // 配色仍由 status 决定，与文案无关
    expect(screen.queryByText('parity ✗')).toBeNull();  // 不再走英文兜底
  });
});
