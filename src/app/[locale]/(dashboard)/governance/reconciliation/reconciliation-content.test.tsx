/*
 * 对账明细（ADR 0061 §3.7，计划 T6 / T7）：缺省查询与缺省租户（R6）、过滤写回 URL、状态 / severity / kind 切换、
 * 「加载更多」游标、空状态、502 带 requestId、确认成功移出 OPEN 视图、403 隐藏确认入口、晚到的旧响应被丢弃。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, values?: Record<string, unknown>) => {
    const full = ns ? `${ns}.${key}` : key;
    return values ? `${full}:${JSON.stringify(values)}` : full;
  },
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

import { ReconciliationContent, type TenantOption } from './reconciliation-content';
import type { OrphanFilter, OrphanItem } from '@/lib/guard-reconciliation/ui';

const TENANTS: TenantOption[] = [
  { id: 'user-1', name: '', canAck: true },
  { id: 'team-1', name: 'Risk Team', canAck: true },
];
const DEFAULT_FILTER: OrphanFilter = { status: 'OPEN', severities: ['critical', 'warning'] };

const fetchMock = vi.fn();

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function orphan(id: number, over: Partial<OrphanItem> = {}): OrphanItem {
  return {
    id, kind: 'side_effect_without_decision', severity: 'critical', status: 'OPEN', executor: 'aster-guard-sdk',
    detectedAt: '2026-11-20T08:00:00Z', detail: { effectId: `eff-${id}` }, ...over,
  };
}

function page(items: OrphanItem[], next?: number, canAck = true) {
  return json(200, { summary: { lastRun: null, open: {}, openTotal: 0, resultGrace: 'PT15M', lookback: 'P7D' }, page: next === undefined ? { items } : { items, next }, canAck });
}

/** 列表请求的地址（不含概览与确认）。 */
function listCalls(): URL[] {
  return fetchMock.mock.calls
    .map(([u]) => new URL(u as string, 'http://x'))
    .filter((u) => /^\/api\/guard-reconciliation\/[^/]+$/.test(u.pathname));
}

function renderContent(props: Partial<React.ComponentProps<typeof ReconciliationContent>> = {}) {
  return render(
    <ReconciliationContent locale="en" tenants={TENANTS} initialTenantId="team-1" initialFilter={DEFAULT_FILTER} {...props} />,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/en/governance/reconciliation');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('ReconciliationContent', () => {
  it('default query is OPEN + critical,warning：请求地址与 URL 都与之相符', async () => {
    fetchMock.mockResolvedValueOnce(page([orphan(1)]));
    renderContent();
    await screen.findByTestId('orphan-1');
    const [u] = listCalls();
    expect(u.pathname).toBe('/api/guard-reconciliation/team-1');
    expect(u.searchParams.get('status')).toBe('OPEN');
    expect(u.searchParams.get('severity')).toBe('critical,warning');
    expect(u.searchParams.has('before')).toBe(false);
    expect(window.location.search).toBe('?tenant=team-1&status=OPEN&severity=critical%2Cwarning');
  });

  it('未指定租户：按跨租户摘要的第一个可见租户（R6），跳过已不可见的租户', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url === '/api/guard-reconciliation'
      ? json(200, { tenants: [{ tenantId: 'gone' }, { tenantId: 'team-1' }, { tenantId: 'user-1' }], unavailableTenants: [] })
      : page([orphan(1)])));
    renderContent({ initialTenantId: null });
    await screen.findByTestId('orphan-1');
    expect(listCalls()[0].pathname).toBe('/api/guard-reconciliation/team-1');
    expect((screen.getByLabelText('guardReconciliation.filters.tenant') as HTMLSelectElement).value).toBe('team-1');
  });

  it('未指定租户且摘要不可用：退回第一个可见租户（个人租户）', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(url === '/api/guard-reconciliation' ? json(502, {}) : page([])));
    renderContent({ initialTenantId: null });
    await screen.findByText('guardReconciliation.empty.OPEN');
    expect(listCalls()[0].pathname).toBe('/api/guard-reconciliation/user-1');
  });

  it('switching status to ACKNOWLEDGED shows ackComment and acknowledger', async () => {
    fetchMock.mockResolvedValueOnce(page([orphan(1)]));
    renderContent();
    await screen.findByTestId('orphan-1');
    fetchMock.mockResolvedValueOnce(page([orphan(2, {
      status: 'ACKNOWLEDGED', decisionId: undefined, acknowledgedBy: 'u-1', ackComment: 'known old SDK',
      acknowledgedByUser: { name: 'Ada Admin', email: null, image: null }, resolvedAt: '2026-11-20T09:00:00Z', resolution: 'acknowledged',
    })]));
    fireEvent.click(screen.getByRole('tab', { name: 'guardReconciliation.status.ACKNOWLEDGED' }));
    await screen.findByTestId('orphan-2');
    expect(listCalls()[1].searchParams.get('status')).toBe('ACKNOWLEDGED');
    expect(screen.queryByTestId('orphan-1')).toBeNull();
    fireEvent.click(within(screen.getByTestId('orphan-2')).getByRole('button', { name: 'guardReconciliation.expand' }));
    const info = within(screen.getByTestId('ack-info'));
    expect(info.getByText('Ada Admin')).toBeTruthy();
    expect(info.getByText('known old SDK')).toBeTruthy();
    expect(window.location.search).toContain('status=ACKNOWLEDGED');
  });

  it('severity 多选：加 info 即全部（severity=all），再取消 critical 只剩 warning,info；kind 下拉写入 kind', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(page([])));
    renderContent();
    await screen.findByText('guardReconciliation.empty.OPEN');
    fireEvent.click(screen.getByRole('button', { name: 'guardReconciliation.severity.info' }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1].searchParams.get('severity')).toBe('all');
    fireEvent.click(screen.getByRole('button', { name: 'guardReconciliation.severity.critical' }));
    await waitFor(() => expect(listCalls()).toHaveLength(3));
    expect(listCalls()[2].searchParams.get('severity')).toBe('warning,info');
    fireEvent.change(screen.getByLabelText('guardReconciliation.filters.kind'), { target: { value: 'orphan_receipt' } });
    await waitFor(() => expect(listCalls()).toHaveLength(4));
    expect(listCalls()[3].searchParams.get('kind')).toBe('orphan_receipt');
    fireEvent.change(screen.getByLabelText('guardReconciliation.filters.kind'), { target: { value: '' } });
    await waitFor(() => expect(listCalls()).toHaveLength(5));
    expect(listCalls()[4].searchParams.has('kind')).toBe(false);
  });

  it('不允许取消最后一个 severity', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(page([])));
    renderContent({ initialFilter: { status: 'OPEN', severities: ['critical'] } });
    await screen.findByText('guardReconciliation.empty.OPEN');
    fireEvent.click(screen.getByRole('button', { name: 'guardReconciliation.severity.critical' }));
    await waitFor(() => expect(listCalls()).toHaveLength(2));
    expect(listCalls()[1].searchParams.get('severity')).toBe('critical');
  });

  it('load more appends with before=next and hides button when next is absent', async () => {
    fetchMock.mockResolvedValueOnce(page([orphan(9), orphan(8)], 8));
    renderContent();
    await screen.findByTestId('orphan-9');
    fetchMock.mockResolvedValueOnce(page([orphan(7)]));
    fireEvent.click(screen.getByTestId('load-more'));
    await screen.findByTestId('orphan-7');
    expect(listCalls()[1].searchParams.get('before')).toBe('8');
    expect(screen.getByTestId('orphan-9')).toBeTruthy();
    expect(screen.queryByTestId('load-more')).toBeNull();
  });

  it('切换租户重置列表', async () => {
    fetchMock.mockResolvedValueOnce(page([orphan(9)], 9));
    renderContent();
    await screen.findByTestId('orphan-9');
    fetchMock.mockResolvedValueOnce(page([orphan(3)]));
    fireEvent.change(screen.getByLabelText('guardReconciliation.filters.tenant'), { target: { value: 'user-1' } });
    await screen.findByTestId('orphan-3');
    expect(screen.queryByTestId('orphan-9')).toBeNull();
    expect(listCalls()[1].pathname).toBe('/api/guard-reconciliation/user-1');
    expect(window.location.search).toContain('tenant=user-1');
  });

  it('晚到的旧响应被丢弃', async () => {
    let resolveFirst: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolveFirst = r; }));
    renderContent();
    fetchMock.mockResolvedValueOnce(page([orphan(2, { status: 'RESOLVED' })]));
    fireEvent.click(screen.getByRole('tab', { name: 'guardReconciliation.status.RESOLVED' }));
    await screen.findByTestId('orphan-2');
    resolveFirst(page([orphan(1)]));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId('orphan-1')).toBeNull();
  });

  it('tenant without canAck shows no ack button', async () => {
    fetchMock.mockResolvedValueOnce(page([orphan(1)], undefined, false));
    renderContent();
    await screen.findByTestId('orphan-1');
    expect(screen.queryByRole('button', { name: 'guardReconciliation.ack.button' })).toBeNull();
  });

  it('empty state per filter', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(page([])));
    renderContent();
    expect(await screen.findByText('guardReconciliation.empty.OPEN')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'guardReconciliation.status.RESOLVED' }));
    expect(await screen.findByText('guardReconciliation.empty.RESOLVED')).toBeTruthy();
  });

  it('upstream 502 shows error with requestId，重试成功', async () => {
    fetchMock.mockResolvedValueOnce(json(502, { error: 'upstream_unavailable', message: 'x', requestId: 'req-9' }));
    renderContent();
    const alert = await screen.findByTestId('reconciliation-error');
    expect(alert.textContent).toContain('guardReconciliation.errors.upstream_unavailable');
    expect(alert.textContent).toContain('guardReconciliation.errors.requestId:{"id":"req-9"}');
    fetchMock.mockResolvedValueOnce(page([orphan(1)]));
    fireEvent.click(within(alert).getByRole('button', { name: 'guardReconciliation.retry' }));
    expect(await screen.findByTestId('orphan-1')).toBeTruthy();
  });

  it('403 列表显示无权查看', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: 'forbidden', message: 'x' }));
    renderContent();
    expect((await screen.findByTestId('reconciliation-error')).textContent).toContain('guardReconciliation.errors.forbidden');
  });

  async function ackFirstRow(response: Response) {
    fetchMock.mockResolvedValueOnce(page([orphan(1, { decisionId: undefined }), orphan(2, { decisionId: undefined })]));
    renderContent();
    await screen.findByTestId('orphan-1');
    fetchMock.mockResolvedValueOnce(response);
    fireEvent.click(within(screen.getByTestId('orphan-1')).getByRole('button', { name: 'guardReconciliation.ack.button' }));
    fireEvent.change(screen.getByLabelText('guardReconciliation.ack.commentLabel'), { target: { value: 'checked' } });
    fireEvent.click(screen.getByRole('button', { name: 'guardReconciliation.ack.submit' }));
  }

  it('success replaces the row with ACKNOWLEDGED：在 OPEN 视图中移出并提示', async () => {
    await ackFirstRow(json(200, orphan(1, { status: 'ACKNOWLEDGED', resolution: 'acknowledged', ackComment: 'checked' })));
    await waitFor(() => expect(screen.queryByTestId('orphan-1')).toBeNull());
    expect(screen.getByTestId('orphan-2')).toBeTruthy();
    expect(screen.getByTestId('reconciliation-notice').textContent).toBe('guardReconciliation.ack.done');
  });

  it('409 not_open updates row to the returned status and explains', async () => {
    await ackFirstRow(json(409, { error: 'not_open', message: 'x', status: 'RESOLVED' }));
    const row = within(await screen.findByTestId('orphan-1'));
    await waitFor(() => expect(row.getByText('guardReconciliation.status.RESOLVED')).toBeTruthy());
    expect(screen.getByTestId('ack-not-open')).toBeTruthy();
    expect(row.queryByRole('button', { name: 'guardReconciliation.ack.button' })).toBeNull();
  });

  it('ack 403 hides the button（并显示「权限已变化」）', async () => {
    await ackFirstRow(json(403, { error: 'forbidden', message: 'x' }));
    await waitFor(() => expect(screen.getByTestId('reconciliation-notice').textContent).toBe('guardReconciliation.ack.permissionChanged'));
    expect(screen.queryAllByRole('button', { name: 'guardReconciliation.ack.button' })).toHaveLength(0);
    expect(screen.getByTestId('orphan-1')).toBeTruthy();
  });

  it('没有任何可见租户：空状态，不请求', () => {
    renderContent({ tenants: [], initialTenantId: null });
    expect(screen.getByText('guardReconciliation.noTenants')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
