/*
 * 审批收件箱客户端（ADR 0042 §5.2）：按 canAct 区分可审/只读、空列表、?decisionId= 高亮，
 * 驳回本地要求理由，api 403 role_mismatch 带 verifiedRoles 提示，成功后按当前 tab 重新拉取。
 * 策略版本审批分区（生产 E2E Q1）：列出策略名/版本/提交人/提交时间，链接到既有版本页，作者本人只读。
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
import type { PendingVersionApproval } from '@/lib/version-approvals-inbox';

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

function renderWith(items: InboxItem[], highlightDecisionId: string | null = null, versionApprovals: PendingVersionApproval[] = []) {
  return render(
    <ApprovalsContent locale="en" initialStatus="PENDING" initialItems={items} initialUnavailable={[]}
      versionApprovals={versionApprovals} highlightDecisionId={highlightDecisionId} />,
  );
}

function versionItem(over: Partial<PendingVersionApproval> = {}): PendingVersionApproval {
  return {
    versionId: 'v1', policyId: 'p1', policyName: 'loan-evaluation', version: 2, submittedBy: 'Sam',
    submittedAt: '2026-10-22T08:30:00Z', canAct: true, teamId: null, noEligibleReviewer: false, ...over,
  };
}

describe('ApprovalsContent — 策略版本审批分区', () => {
  it('分区标题可见；空时显示空态，不影响 Action-Guard 列表', () => {
    renderWith([item('a1')]);
    expect(screen.getByRole('heading', { name: 'versions.title' })).toBeTruthy();
    expect(screen.getByText('versions.empty')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'guardTitle' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'approve' })).toBeTruthy();
  });

  it('可审条目：显示策略名、版本、提交人、提交时间，并链接到既有版本页审批', () => {
    const { container } = renderWith([], null, [versionItem()]);
    const row = container.querySelector('[data-version-id="v1"]') as HTMLElement;
    expect(row.textContent).toContain('loan-evaluation');
    expect(row.textContent).toContain('v2');
    expect(row.textContent).toContain('Sam');
    expect(row.textContent).toContain('UTC');
    const link = screen.getByRole('link', { name: /versions\.review/ });
    expect(link.getAttribute('href')).toBe('/policies/p1/versions');
    expect(screen.queryByText('versions.awaitingOthers')).toBeNull();
  });

  it('作者本人的提交：只读，标注等待他人审批，链接文案为查看', () => {
    renderWith([], null, [versionItem({ canAct: false, submittedBy: null })]);
    expect(screen.getByText('versions.awaitingOthers')).toBeTruthy();
    expect(screen.getByText('versions.unknownUser')).toBeTruthy();
    expect(screen.getByRole('link', { name: /versions\.view/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /versions\.review/ })).toBeNull();
  });

  it('★团队里除作者外没有 owner/admin（review I3）：提示任命管理员并链接到团队成员管理', () => {
    renderWith([], null, [versionItem({ canAct: false, teamId: 'team1', noEligibleReviewer: true })]);
    const hint = screen.getByTestId('no-eligible-reviewer');
    expect(hint.textContent).toBe('versions.noEligibleReviewer');
    expect(hint.getAttribute('href')).toBe('/teams/team1/members');
    expect(screen.queryByText('versions.awaitingOthers')).toBeNull();
  });
});

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

  it('创建时间与运行时区无关（服务端 UTC 与浏览器本地时区渲染一致，避免 hydration mismatch）', () => {
    const prevTz = process.env.TZ;
    const createdCell = (tz: string) => {
      process.env.TZ = tz;
      const { container } = renderWith([item('a1', { createdAt: '2026-10-12T22:29:08Z' })]);
      const text = container.querySelector('tbody tr td:nth-child(5)')?.textContent;
      cleanup();
      return text;
    };
    try {
      const utc = createdCell('UTC');
      expect(createdCell('Pacific/Auckland')).toBe(utc);
      expect(createdCell('America/Los_Angeles')).toBe(utc);
      expect(utc).toContain('UTC');
    } finally {
      process.env.TZ = prevTz;
    }
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
