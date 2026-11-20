/*
 * 治理页「Guard 对账」摘要卡（ADR 0061 §3.7，计划 T5）：客户端自取跨租户摘要；加载骨架、按租户行与徽章变体、
 * 不可用租户提示、空结果不渲染、失败可重试。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  useLocale: () => 'en',
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { ReconciliationSummaryCard } from './reconciliation-summary-card';
import type { ReconciliationOverview } from '@/lib/guard-reconciliation/overview';

const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const OVERVIEW: ReconciliationOverview = {
  tenants: [
    {
      tenantId: 'team-1', tenantName: 'Risk Team', canAck: true, lastRunAt: '2026-11-20T08:05:00Z',
      openBySeverity: { critical: 2, warning: 1, info: 7 }, openTotal: 10,
    },
    {
      tenantId: 'user-1', tenantName: '', canAck: true, lastRunAt: null,
      openBySeverity: { critical: 0, warning: 0, info: 3 }, openTotal: 3,
    },
  ],
  unavailableTenants: [],
};

beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('ReconciliationSummaryCard', () => {
  it('加载中显示骨架，并只请求跨租户摘要', async () => {
    let resolve: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
    render(<ReconciliationSummaryCard />);
    expect(screen.getByTestId('reconciliation-summary-loading')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/api/guard-reconciliation', expect.objectContaining({ cache: 'no-store' }));
    resolve(json(200, OVERVIEW));
    await screen.findByTestId('reconciliation-tenant-team-1');
    expect(screen.queryByTestId('reconciliation-summary-loading')).toBeNull();
  });

  it('每个租户一行：名称（个人租户本地化）、三个 severity 徽章与变体、UTC 时间或尚未对账、查看链接', async () => {
    fetchMock.mockResolvedValueOnce(json(200, OVERVIEW));
    render(<ReconciliationSummaryCard />);

    const team = within(await screen.findByTestId('reconciliation-tenant-team-1'));
    expect(team.getByText('Risk Team')).toBeTruthy();
    const badges = Object.fromEntries(
      team.getAllByText(/^counts\./).map((el) => [el.getAttribute('data-severity'), el]),
    );
    expect(badges.critical.textContent).toBe('counts.critical:{"count":2}');
    expect(badges.critical.className).toMatch(/danger/);
    expect(badges.warning.className).toMatch(/warning/);
    expect(badges.info.className).not.toMatch(/danger|warning/);
    expect(team.getByText(/UTC$/).textContent).toContain('2026');
    expect(team.getByRole('link').getAttribute('href')).toBe('/governance/reconciliation?tenant=team-1');

    const personal = within(screen.getByTestId('reconciliation-tenant-user-1'));
    expect(personal.getByText('personal')).toBeTruthy();
    expect(personal.getByText('neverRun')).toBeTruthy();
    // 计数为 0 的 critical 不用 danger
    const zero = personal.getAllByText(/^counts\./).find((el) => el.getAttribute('data-severity') === 'critical')!;
    expect(zero.className).not.toMatch(/danger/);
  });

  it('unavailableTenants 非空时提示数量，其余租户照常显示', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...OVERVIEW, unavailableTenants: ['team-9'] }));
    render(<ReconciliationSummaryCard />);
    expect(await screen.findByText('unavailable:{"count":1}')).toBeTruthy();
    expect(screen.getByTestId('reconciliation-tenant-team-1')).toBeTruthy();
  });

  it('没有任何可见租户且无不可用租户：整卡不渲染任何节点', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { tenants: [], unavailableTenants: [] }));
    const { container } = render(<ReconciliationSummaryCard />);
    await vi.waitFor(() => expect(container.innerHTML).toBe(''));
  });

  it('请求失败显示错误条，重试成功后渲染', async () => {
    fetchMock.mockResolvedValueOnce(json(500, {}));
    render(<ReconciliationSummaryCard />);
    expect(await screen.findByText('loadFailed')).toBeTruthy();
    fetchMock.mockResolvedValueOnce(json(200, OVERVIEW));
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(await screen.findByTestId('reconciliation-tenant-team-1')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('网络异常同样显示错误条', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    render(<ReconciliationSummaryCard />);
    expect(await screen.findByText('loadFailed')).toBeTruthy();
  });
});
