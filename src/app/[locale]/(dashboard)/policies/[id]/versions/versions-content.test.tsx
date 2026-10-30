/*
 * 版本页审批操作（用户裁决）：团队策略由团队 owner/admin（非作者）批准/驳回，作者与普通成员只看到「等待他人审批」；
 * 个人策略所有者可自审，确认框给出自审说明；审批路由把 SOX 错误码放在 error 字段，toast 必须显示本地化文案。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const PENDING_ROW = {
  id: 'v1', version: 2, sourceHash: 'h', status: 'PENDING_APPROVAL', isDefault: false, releaseNote: null,
  createdBy: 'author', createdAt: '2026-10-22T00:00:00Z', deprecatedAt: null, deprecatedBy: null,
  archivedAt: null, archivedBy: null, _count: { approvals: 0 },
};
const h = vi.hoisted(() => ({
  toastError: vi.fn(), toastSuccess: vi.fn(), refresh: vi.fn(),
  versions: null as unknown[] | null,
}));

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/lib/api', () => ({
  useApi: () => ({
    data: { versions: h.versions ?? [PENDING_ROW] },
    error: undefined, isLoading: false, mutate: h.refresh,
  }),
}));
vi.mock('@/components/ui', () => {
  type Col = { key: string; cell: (row: unknown) => React.ReactNode };
  return {
    Breadcrumbs: ({ items }: { items: Array<{ label: string; href?: string }> }) => (
      <nav>{items.map((i) => (i.href ? <a key={i.label} href={i.href}>{i.label}</a> : <span key={i.label}>{i.label}</span>))}</nav>
    ),
    Button: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
    Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    PageHeader: ({ breadcrumbs, action }: { breadcrumbs?: React.ReactNode; action?: React.ReactNode }) => (
      <header>{breadcrumbs}{action}</header>
    ),
    EmptyState: () => null,
    Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    Textarea: (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} />,
    IconButton: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    Dropdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownItem: ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => (
      <button type="button" onClick={onSelect}>{children}</button>
    ),
    DataTable: ({ rows, columns }: { rows: unknown[]; columns: Col[] }) => (
      <table><tbody>{rows.map((r, i) => (
        <tr key={i}>{columns.map((c) => <td key={c.key}>{c.cell(r)}</td>)}</tr>
      ))}</tbody></table>
    ),
    ConfirmDialog: ({ description, confirmLabel, onConfirm }: {
      description: React.ReactNode; confirmLabel: string; onConfirm: () => void;
    }) => (
      <div role="dialog">{description}<button type="button" onClick={onConfirm}>{confirmLabel}</button></div>
    ),
    toast: { error: h.toastError, success: h.toastSuccess },
  };
});

import { VersionsContent } from './versions-content';

const labels = { backToPolicy: 'back', policiesLink: 'policies' };

function renderAs(
  currentUserId: string,
  review: { policyOwnerId: string; policyTeamId: string | null; reviewerTeamRole: 'owner' | 'admin' | 'member' | 'viewer' | null },
  teamReviewerIds: string[] = ['author', 'admin1'],
) {
  return render(
    <VersionsContent policyId="p1" policyName="loan" locale="zh" currentUserId={currentUserId} review={review}
      teamReviewerIds={teamReviewerIds} labels={labels} />,
  );
}

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetchMock));
afterEach(() => {
  h.versions = null;
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('VersionsContent 审批操作', () => {
  it('团队 admin（非作者）：可批准/驳回，无自审说明', () => {
    renderAs('admin1', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'admin' });
    expect(screen.getByRole('button', { name: 'policies.versions.actions.reject' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actions.approve' }));
    expect(screen.queryByTestId('self-approve-note')).toBeNull();
  });

  it('团队策略作者（即使是 admin）：不能审批，显示等待他人审批', () => {
    renderAs('author', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'admin' });
    expect(screen.queryByRole('button', { name: 'policies.versions.actions.approve' })).toBeNull();
    expect(screen.getByText('policies.versions.awaitingOthers')).toBeTruthy();
  });

  it('★团队里除作者外没有 owner/admin（review I3）：提示任命管理员并链接到团队成员管理', () => {
    renderAs('author', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'owner' }, ['author']);
    const hint = screen.getByTestId('no-eligible-reviewer');
    expect(hint.textContent).toBe('policies.versions.noEligibleReviewer');
    expect(hint.getAttribute('href')).toContain('/teams/team1/members');
    expect(screen.queryByText('policies.versions.awaitingOthers')).toBeNull();
  });

  it('团队审阅人（非所有者）：策略名面包屑为纯文本，不显示「新建版本」（都是所有者专属页面）', () => {
    renderAs('admin1', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'admin' });
    expect(screen.getByText('loan').tagName).toBe('SPAN');
    expect(screen.queryByRole('link', { name: 'policies.versions.newVersion' })).toBeNull();
  });

  it('策略所有者：策略名面包屑可点击，显示「新建版本」', () => {
    renderAs('author', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'owner' });
    expect(screen.getByRole('link', { name: 'loan' }).getAttribute('href')).toBe('/policies/p1');
    expect(screen.getByRole('link', { name: 'policies.versions.newVersion' })).toBeTruthy();
  });

  it('团队普通成员：不能审批', () => {
    renderAs('m1', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'member' });
    expect(screen.queryByRole('button', { name: 'policies.versions.actions.approve' })).toBeNull();
  });

  it('个人策略所有者：可批准自己的提交，确认框显示自审说明', () => {
    renderAs('author', { policyOwnerId: 'author', policyTeamId: null, reviewerTeamRole: null });
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actions.approve' }));
    expect(screen.getByTestId('self-approve-note').textContent).toBe('policies.versions.selfApproveNote');
  });

  it('个人策略所有者驳回自己的提交：不显示自审说明（说明只针对批准）', () => {
    renderAs('author', { policyOwnerId: 'author', policyTeamId: null, reviewerTeamRole: null });
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actions.reject' }));
    expect(screen.queryByTestId('self-approve-note')).toBeNull();
  });

  it('审批被拒且错误码在 error 字段：toast 显示本地化的四眼提示', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'segregation_of_duties', message: 'x' }), { status: 403 }));
    renderAs('admin1', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'admin' });
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actions.approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.approveDialog.confirm' }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('policies.versions.sox.selfApprovalNotAllowed'));
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/policies/p1/versions/2/approve', expect.objectContaining({ method: 'POST' }));
  });

  it('审批因保存后词汇变化被拒（409）：toast 显示本地化「保存新版本」提示', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'vocabulary_changed_since_save', message: 'x' }), { status: 409 }));
    renderAs('admin1', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'admin' });
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actions.approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.approveDialog.confirm' }));

    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith('policies.versions.approvalErrorCodes.vocabulary_changed_since_save'),
    );
  });

  /* 第 4 轮生产复测：失败 toast 显示错误码而不是 message；失败时对话框须保持打开、说明不丢 */
  it('其他失败：显示服务端 message，对话框保持打开、说明保留', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'simulated_failure', message: 'Service unavailable' }), { status: 503 }));
    renderAs('admin1', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'admin' });
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actions.approve' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'r4 note' } });
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.approveDialog.confirm' }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Service unavailable'));
    expect(screen.getByRole('textbox')).toHaveValue('r4 note');
  });

  /* #662 审查 High-1：兜底 500 返回结构化 envelope（error 是对象），toast 必须收到字符串，不能把对象交给 sonner 渲染 */
  const approveWith = async (body: unknown, status: number) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
    renderAs('admin1', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'admin' });
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actions.approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.approveDialog.confirm' }));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    return h.toastError.mock.calls[0]![0] as unknown;
  };

  it('500 envelope（无顶层 message）：toast 显示 error.message 字符串', async () => {
    const shown = await approveWith(
      { error: { code: 'internal_error', message: 'Could not approve version.', requestId: 'r1' } },
      500,
    );
    expect(shown).toBe('Could not approve version.');
  });

  it('500 envelope 带顶层 message：优先显示顶层 message', async () => {
    const shown = await approveWith(
      { error: { code: 'internal_error', message: 'inner', requestId: 'r1' }, message: 'Could not approve version.' },
      500,
    );
    expect(shown).toBe('Could not approve version.');
  });

  it('envelope 里的错误码同样识别为本地化提示', async () => {
    const shown = await approveWith({ error: { code: 'segregation_of_duties', message: 'x', requestId: 'r1' } }, 403);
    expect(shown).toBe('policies.versions.sox.selfApprovalNotAllowed');
  });

  it('响应体为空或无可读文案：显示通用文案', async () => {
    const shown = await approveWith({ error: { code: 'internal_error' } }, 500);
    expect(shown).toBe('common.somethingWrong');
  });
});

describe('VersionsContent 驳回理由（#678）', () => {
  it('被驳回的版本在状态旁显示驳回理由', () => {
    h.versions = [{ ...PENDING_ROW, status: 'REJECTED', rejectionComment: 'too risky' }];
    renderAs('author', { policyOwnerId: 'author', policyTeamId: 't1', reviewerTeamRole: 'member' });
    expect(screen.getByText('policies.versions.rejectionReason')).toBeTruthy();
  });

  it('未驳回的版本不显示驳回理由', () => {
    renderAs('author', { policyOwnerId: 'author', policyTeamId: 't1', reviewerTeamRole: 'member' });
    expect(screen.queryByText('policies.versions.rejectionReason')).toBeNull();
  });
});
