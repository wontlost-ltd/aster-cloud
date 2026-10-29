/*
 * 策略详情页版本面板：批准被四眼原则拒绝（segregation_of_duties）时，显示与版本页相同的本地化 toast，
 * 而不是静默失败。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ approve: vi.fn(), toastError: vi.fn(), clearActionError: vi.fn(), actionError: null as string | null }));

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/components/ui', () => ({ toast: { error: h.toastError, success: vi.fn() } }));
vi.mock('@/hooks/use-policy-versions', () => ({
  usePolicyVersions: () => ({
    versions: [{ id: 'v1', version: 2, status: 'PENDING_APPROVAL', createdBy: 'author' }],
    loading: false, error: null, actionError: h.actionError, clearActionError: h.clearActionError, refresh: vi.fn(), setDefault: vi.fn(), deprecate: vi.fn(), archive: vi.fn(),
    submitForApproval: vi.fn(), approve: h.approve, reject: vi.fn(),
  }),
}));
vi.mock('@/components/policy/policy-version-list', () => ({
  PolicyVersionList: ({ onApprove }: { onApprove: (id: string) => Promise<void> }) => (
    <button type="button" onClick={() => onApprove('v1')}>approve-v1</button>
  ),
}));
vi.mock('@/components/policy/version-detail-panel', () => ({ VersionDetailPanel: () => null }));
vi.mock('@/components/policy/version-compare-panel', () => ({ VersionComparePanel: () => null }));

import { PolicyVersionsTab } from '@/components/policy/policy-versions-tab';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.actionError = null;
});

describe('PolicyVersionsTab 批准失败提示', () => {
  it('segregation_of_duties → 本地化四眼提示 toast', async () => {
    h.approve.mockResolvedValue({ ok: false, errorCode: 'segregation_of_duties', message: 'raw' });
    render(<PolicyVersionsTab policyId="p1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approve-v1' }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('policies.versions.approvalErrorCodes.segregation_of_duties'));
    expect(h.approve).toHaveBeenCalledWith(2, undefined);
  });

  it('vocabulary_changed_since_save → 本地化「保存新版本」提示 toast', async () => {
    h.approve.mockResolvedValue({ ok: false, errorCode: 'vocabulary_changed_since_save', message: 'raw' });
    render(<PolicyVersionsTab policyId="p1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approve-v1' }));

    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith('policies.versions.approvalErrorCodes.vocabulary_changed_since_save'),
    );
  });

  it('未知错误码回退显示服务端 message', async () => {
    h.approve.mockResolvedValue({ ok: false, errorCode: 'other', message: 'Approval conflict' });
    render(<PolicyVersionsTab policyId="p1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approve-v1' }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Approval conflict'));
  });

  it('批准成功不弹错误', async () => {
    h.approve.mockResolvedValue({ ok: true });
    render(<PolicyVersionsTab policyId="p1" />);

    fireEvent.click(screen.getByRole('button', { name: 'approve-v1' }));

    await waitFor(() => expect(h.approve).toHaveBeenCalled());
    expect(h.toastError).not.toHaveBeenCalled();
  });
});

/* 2026-10-30 生产复测 F2：操作失败曾整块替换版本列表（只剩错误 + Try again）。 */
describe('PolicyVersionsTab 操作失败提示', () => {
  it('actionError 显示在列表上方，版本列表仍在，可关闭', () => {
    h.actionError = 'Set default failed';
    render(<PolicyVersionsTab policyId="p1" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Set default failed');
    expect(screen.getByRole('button', { name: 'approve-v1' })).toBeInTheDocument();
    expect(screen.queryByText('common.retry')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'policies.versions.actionErrorDismiss' }));
    expect(h.clearActionError).toHaveBeenCalled();
  });
});
