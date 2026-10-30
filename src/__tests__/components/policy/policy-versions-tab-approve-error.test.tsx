/*
 * 策略详情页版本面板的操作失败提示。
 *
 * 所有版本操作（设默认 / 废弃 / 归档 / 提交 / 批准 / 驳回）失败时，标签页抛 VersionActionError：
 * 列表组件只提示一次原因，并保持对话框打开、保留用户填写的说明（第 4 轮生产复测：批准失败时对话框关闭、
 * 说明丢失；提交 / 驳回 toast 显示的是错误码而不是 message）。
 * 列表组件在这里用探针替代，按真实 handleConfirmAction 的约定处理：成功关闭对话框，
 * VersionActionError 显示其 message，其他异常显示通用提示。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  approve: vi.fn(), submit: vi.fn(), reject: vi.fn(), setDefault: vi.fn(), deprecate: vi.fn(), archive: vi.fn(),
  toastError: vi.fn(), toastSuccess: vi.fn(), dialogClosed: vi.fn(), clearActionError: vi.fn(),
  actionError: null as string | null,
}));

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/components/ui', () => ({ toast: { error: h.toastError, success: h.toastSuccess } }));
vi.mock('@/hooks/use-policy-versions', () => ({
  usePolicyVersions: () => ({
    versions: [{ id: 'v1', version: 2, status: 'PENDING_APPROVAL', createdBy: 'author' }],
    loading: false, error: null, actionError: h.actionError, clearActionError: h.clearActionError, refresh: vi.fn(),
    setDefault: h.setDefault, deprecate: h.deprecate, archive: h.archive,
    submitForApproval: h.submit, approve: h.approve, reject: h.reject,
  }),
}));

type Handlers = Record<string, (...a: unknown[]) => Promise<void>>;
vi.mock('@/components/policy/policy-version-list', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/policy/policy-version-list')>();
  const run = (p: Promise<void>) => p.then(
    () => h.dialogClosed(),
    (e: Error) => h.toastError(e.name === 'VersionActionError' ? e.message : 'generic'),
  );
  return {
    VersionActionError: actual.VersionActionError,
    PolicyVersionList: (p: Handlers) => (
      <>
        <button type="button" onClick={() => run(p.onApprove('v1', 'my note'))}>approve-v1</button>
        <button type="button" onClick={() => run(p.onSubmitForApproval('v1', 'release'))}>submit-v1</button>
        <button type="button" onClick={() => run(p.onReject('v1', 'why'))}>reject-v1</button>
        <button type="button" onClick={() => run(p.onSetDefault(2))}>default-v1</button>
        <button type="button" onClick={() => run(p.onDeprecate(2, 'old'))}>deprecate-v1</button>
        <button type="button" onClick={() => run(p.onArchive(2, 'gone'))}>archive-v1</button>
      </>
    ),
  };
});
vi.mock('@/components/policy/version-detail-panel', () => ({ VersionDetailPanel: () => null }));
vi.mock('@/components/policy/version-compare-panel', () => ({ VersionComparePanel: () => null }));

import { PolicyVersionsTab } from '@/components/policy/policy-versions-tab';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.actionError = null;
});

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('PolicyVersionsTab 批准失败：只提示一次，对话框保持打开', () => {
  it.each([
    ['segregation_of_duties', 'policies.versions.approvalErrorCodes.segregation_of_duties'],
    ['vocabulary_changed_since_save', 'policies.versions.approvalErrorCodes.vocabulary_changed_since_save'],
  ])('★%s → 本地化原因，对话框不关闭（说明保留）', async (errorCode, text) => {
    h.approve.mockResolvedValue({ ok: false, errorCode, message: 'raw' });
    render(<PolicyVersionsTab policyId="p1" />);
    click('approve-v1');
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(h.toastError).toHaveBeenCalledWith(text);
    expect(h.dialogClosed).not.toHaveBeenCalled();
    expect(h.approve).toHaveBeenCalledWith(2, 'my note');
  });

  it('未知错误码显示服务端 message', async () => {
    h.approve.mockResolvedValue({ ok: false, errorCode: 'other', message: 'Approval conflict' });
    render(<PolicyVersionsTab policyId="p1" />);
    click('approve-v1');
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Approval conflict'));
    expect(h.dialogClosed).not.toHaveBeenCalled();
  });

  it('invite_reviewer_required：弹邀请框，不报错', async () => {
    h.approve.mockResolvedValue({ ok: false, errorCode: 'invite_reviewer_required', message: 'x', cta: { label: 'l', href: '/teams/new' } });
    render(<PolicyVersionsTab policyId="p1" />);
    click('approve-v1');
    await waitFor(() => expect(h.dialogClosed).toHaveBeenCalled());
    expect(h.toastError).not.toHaveBeenCalled();
  });

  it('批准成功：成功 toast，对话框关闭', async () => {
    h.approve.mockResolvedValue({ ok: true });
    render(<PolicyVersionsTab policyId="p1" />);
    click('approve-v1');
    await waitFor(() => expect(h.dialogClosed).toHaveBeenCalled());
    expect(h.toastSuccess).toHaveBeenCalled();
    expect(h.toastError).not.toHaveBeenCalled();
  });
});

describe('PolicyVersionsTab 其余操作失败：显示服务端原因一次，对话框保持打开', () => {
  it.each([
    ['submit-v1', 'submit'],
    ['reject-v1', 'reject'],
    ['default-v1', 'setDefault'],
    ['deprecate-v1', 'deprecate'],
    ['archive-v1', 'archive'],
  ] as const)('★%s 失败', async (button, fn) => {
    h[fn].mockResolvedValue({ ok: false, message: 'Server says no' });
    render(<PolicyVersionsTab policyId="p1" />);
    click(button);
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(h.toastError).toHaveBeenCalledWith('Server says no');
    expect(h.dialogClosed).not.toHaveBeenCalled();
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ['submit-v1', 'submit'],
    ['reject-v1', 'reject'],
    ['default-v1', 'setDefault'],
    ['deprecate-v1', 'deprecate'],
    ['archive-v1', 'archive'],
  ] as const)('%s 成功：成功 toast，对话框关闭', async (button, fn) => {
    h[fn].mockResolvedValue({ ok: true });
    render(<PolicyVersionsTab policyId="p1" />);
    click(button);
    await waitFor(() => expect(h.dialogClosed).toHaveBeenCalled());
    expect(h.toastSuccess).toHaveBeenCalledTimes(1);
  });
});

describe('PolicyVersionsTab 创建失败横幅', () => {
  it('actionError 显示在列表上方，版本列表仍在，可关闭', () => {
    h.actionError = 'Create failed';
    render(<PolicyVersionsTab policyId="p1" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Create failed');
    expect(screen.getByRole('button', { name: 'approve-v1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actionErrorDismiss' }));
    expect(h.clearActionError).toHaveBeenCalled();
  });
});
