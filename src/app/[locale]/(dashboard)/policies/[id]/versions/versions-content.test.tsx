/*
 * 版本页审批操作（用户裁决）：团队策略由团队 owner/admin（非作者）批准/驳回，作者与普通成员只看到「等待他人审批」；
 * 个人策略所有者可自审，确认框给出自审说明；审批路由把 SOX 错误码放在 error 字段，toast 必须显示本地化文案。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ toastError: vi.fn(), toastSuccess: vi.fn(), refresh: vi.fn() }));

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/lib/api', () => ({
  useApi: () => ({
    data: { versions: [{
      id: 'v1', version: 2, sourceHash: 'h', status: 'PENDING_APPROVAL', isDefault: false, releaseNote: null,
      createdBy: 'author', createdAt: '2026-10-22T00:00:00Z', deprecatedAt: null, deprecatedBy: null,
      archivedAt: null, archivedBy: null, _count: { approvals: 0 },
    }] },
    error: undefined, isLoading: false, mutate: h.refresh,
  }),
}));
vi.mock('@/components/ui', () => {
  type Col = { key: string; cell: (row: unknown) => React.ReactNode };
  return {
    Breadcrumbs: () => null,
    Button: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
    Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Stack: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    PageHeader: () => null,
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

  it('团队普通成员：不能审批', () => {
    renderAs('m1', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'member' });
    expect(screen.queryByRole('button', { name: 'policies.versions.actions.approve' })).toBeNull();
  });

  it('个人策略所有者：可批准自己的提交，确认框显示自审说明', () => {
    renderAs('author', { policyOwnerId: 'author', policyTeamId: null, reviewerTeamRole: null });
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actions.approve' }));
    expect(screen.getByTestId('self-approve-note').textContent).toBe('policies.versions.selfApproveNote');
  });

  it('审批被拒且错误码在 error 字段：toast 显示本地化的四眼提示', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'segregation_of_duties', message: 'x' }), { status: 403 }));
    renderAs('admin1', { policyOwnerId: 'author', policyTeamId: 'team1', reviewerTeamRole: 'admin' });
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actions.approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.approveDialog.confirm' }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('policies.versions.sox.selfApprovalNotAllowed'));
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/policies/p1/versions/2/approve', expect.objectContaining({ method: 'POST' }));
  });

  it('★SOX 套餐下个人策略自审被拒（move_to_team_required）：toast 提示移入团队而不是邀请队友（review I4）', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'move_to_team_required', message: 'x' }), { status: 403 }));
    renderAs('author', { policyOwnerId: 'author', policyTeamId: null, reviewerTeamRole: null });
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actions.approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.approveDialog.confirm' }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('policies.versions.sox.moveToTeamRequired'));
  });
});
