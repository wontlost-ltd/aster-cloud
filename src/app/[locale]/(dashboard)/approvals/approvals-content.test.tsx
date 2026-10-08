/*
 * 审批收件箱客户端（ADR 0042 §5.2）：按 canAct 区分可审/只读、空列表、?decisionId= 高亮，
 * 驳回本地要求理由，api 403 role_mismatch 带 verifiedRoles 提示，成功后按当前 tab 重新拉取。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock('@/components/ui', () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
  Badge: ({ children, title }: { children: React.ReactNode; title?: string }) => <span title={title}>{children}</span>,
  Breadcrumbs: () => null,
  Button: ({ children, variant: _v, size: _s, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...rest}>{children}</button>
  ),
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => <label htmlFor={htmlFor}>{children}</label>,
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

import { ApprovalsContent } from './approvals-content';
import type { InboxItem } from '@/lib/approvals-inbox';

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function item(id: string, over: Partial<InboxItem> = {}): InboxItem {
  return {
    id, decisionId: `d-${id}`, status: 'PENDING', requiredRole: 'DPO', createdAt: '2026-10-01T00:00:00Z',
    policyModule: 'guard.refund', policyFunction: 'decide', tenantId: 'team1', tenantName: 'Team One', canAct: true,
    ...over,
  };
}

function renderWith(items: InboxItem[], highlightDecisionId: string | null = null) {
  return render(
    <ApprovalsContent locale="en" initialStatus="PENDING" initialItems={items} initialUnavailable={[]}
      highlightDecisionId={highlightDecisionId} />,
  );
}

describe('ApprovalsContent', () => {
  it('可审身份：渲染批准/驳回按钮', () => {
    renderWith([item('a1')]);
    expect(screen.getByRole('button', { name: 'approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'reject' })).toBeTruthy();
    expect(screen.queryByText('readOnly')).toBeNull();
  });

  it('只读身份（owner/admin 无角色）：无操作按钮，显示只读与所需角色提示', () => {
    renderWith([item('a1', { canAct: false })]);
    expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'reject' })).toBeNull();
    expect(screen.getByText('readOnly').getAttribute('title')).toContain('"role":"DPO"');
  });

  it('空列表：渲染空态，无操作按钮', () => {
    renderWith([]);
    expect(screen.getByText('empty')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
  });

  it('?decisionId= 命中的行高亮，其他行不高亮；个人租户显示本地化名称', () => {
    const { container } = renderWith([item('a1'), item('a2', { tenantId: 'u1', tenantName: '' })], 'd-a2');
    const rows = container.querySelectorAll('tbody tr');
    expect(rows[0].getAttribute('data-highlighted')).toBeNull();
    expect(rows[1].getAttribute('data-highlighted')).toBe('true');
    expect(screen.getByText('personalTenant')).toBeTruthy();
  });

  it('驳回无理由：本地提示 commentRequired，不发请求', () => {
    renderWith([item('a1')]);
    fireEvent.click(screen.getByRole('button', { name: 'reject' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirmReject' }));
    expect(screen.getByRole('alert').textContent).toBe('commentRequired');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('api 403 role_mismatch：提示所需角色与已验证角色', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'role_mismatch', message: 'x', verifiedRoles: ['CISO'] }),
    });
    renderWith([item('a1')]);
    fireEvent.click(screen.getByRole('button', { name: 'approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirmApprove' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('errors.role_mismatch:{"role":"DPO","roles":"CISO"}'));
    expect(fetchMock).toHaveBeenCalledWith('/api/approvals/team1/a1/approve', expect.objectContaining({ method: 'POST' }));
  });

  it('驳回成功后按当前 tab 重新拉取列表', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ decisionId: 'd-a1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [], unavailableTenants: [] }) });
    renderWith([item('a1')]);
    fireEvent.click(screen.getByRole('button', { name: 'reject' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'too risky' } });
    fireEvent.click(screen.getByRole('button', { name: 'confirmReject' }));

    await waitFor(() => expect(screen.getByText('empty')).toBeTruthy());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ comment: 'too risky' });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/approvals?status=PENDING');
  });

  it('提交时网络异常：显示通用错误，按钮恢复可用', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderWith([item('a1')]);
    fireEvent.click(screen.getByRole('button', { name: 'approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirmApprove' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('errors.generic'));
    expect((screen.getByRole('button', { name: 'confirmApprove' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('本地 403 forbidden（非租户成员）：显示本地化文案而非 api 原文', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden', message: 'Not a member of this tenant.' }),
    });
    renderWith([item('a1')]);
    fireEvent.click(screen.getByRole('button', { name: 'approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirmApprove' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('errors.forbidden'));
  });

  it('切换 tab 时网络异常：提示 loadFailed', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    renderWith([item('a1')]);
    fireEvent.click(screen.getByRole('tab', { name: 'status.APPROVED' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('loadFailed'));
  });

  it('快速切换 tab：旧请求被中止，晚到的旧响应不覆盖新 tab 的列表', async () => {
    let resolveOld!: (v: unknown) => void;
    fetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [], unavailableTenants: [] }) });
    renderWith([item('a1')]);

    fireEvent.click(screen.getByRole('tab', { name: 'status.APPROVED' }));
    fireEvent.click(screen.getByRole('tab', { name: 'status.REJECTED' }));
    await waitFor(() => expect(screen.getByText('empty')).toBeTruthy());

    const oldSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(oldSignal.aborted).toBe(true);
    resolveOld({ ok: true, json: async () => ({ items: [item('stale', { status: 'APPROVED', canAct: false })], unavailableTenants: [] }) });
    await new Promise((r) => setTimeout(r, 0));

    expect(screen.getByText('empty')).toBeTruthy();
    expect(screen.queryByText('status.APPROVED', { selector: 'span' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
