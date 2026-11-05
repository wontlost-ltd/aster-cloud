'use client';

import { useState, useCallback, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { PolicyVersionList, VersionActionError, type PolicyVersionInfo } from './policy-version-list';
import type { ApproveResult, VersionActionResult } from '@/hooks/use-policy-versions';
import { VersionDetailPanel } from './version-detail-panel';
import { VersionComparePanel } from './version-compare-panel';
import { usePolicyVersions, isVersionHookErrorCode } from '@/hooks/use-policy-versions';
import { toast } from '@/components/ui';
import type { VersionReviewContext } from '@/services/policy/version-approval-rules';

interface PolicyVersionsTabProps {
  policyId: string;
  /** 租户是否拥有 What-If 权益（ADR 0034 §7.2）；透传给比较面板。 */
  whatIfEntitled?: boolean;
  /** 执行日志留存天数（#396），透传给 What-If 面板裁剪窗口 */
  retentionDays?: number | null;
  /** 审阅判定上下文（服务端算好），决定批准/驳回是否可见及是否属于自审 */
  review?: Omit<VersionReviewContext, 'reviewerId'>;
  /** 调用者不是策略创建者：What-If 属主限定（ADR 0034 §4.3），透传给比较面板 */
  whatIfOwnerOnly?: boolean;
}

type ViewMode = 'list' | 'detail' | 'compare';

export function PolicyVersionsTab({ policyId, whatIfEntitled = false, retentionDays = null, review, whatIfOwnerOnly = false }: PolicyVersionsTabProps) {
  const { data: session } = useSession();
  const t = useTranslations('policies.versions');
  const tCommon = useTranslations('common');
  const {
    versions,
    loading,
    error,
    actionError,
    clearActionError,
    refresh,
    setDefault,
    deprecate,
    archive,
    submitForApproval,
    approve,
    reject,
  } = usePolicyVersions({ policyId });

  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [inviteModal, setInviteModal] = useState<
    | { open: false }
    | { open: true; message: string; cta: { label: string; href: string } }
  >({ open: false });

  /**
   * 所有版本操作失败都抛 VersionActionError：列表据此显示原因（只提示一次）并保持对话框打开，
   * 用户填写的说明 / 原因不丢（第 4 轮生产复测：批准失败时对话框关闭、说明丢失）。
   * 版本状态错误按稳定 code 本地化（#697），其余显示服务端原因。
   */
  const failIfNotOk = useCallback(
    (result: VersionActionResult | ApproveResult, version: number, fallback?: string): void => {
      if (result.ok) return;
      if (result.code) throw new VersionActionError(t(`versionErrorCodes.${result.code}`, { version }));
      throw new VersionActionError(result.message ?? fallback ?? tCommon('somethingWrong'));
    },
    [t, tCommon]
  );

  const handleViewSource = useCallback((version: number) => {
    setSelectedVersion(version);
    setViewMode('detail');
  }, []);

  const handleCloseDetail = useCallback(() => {
    setViewMode('list');
    setSelectedVersion(null);
  }, []);

  const handleOpenCompare = useCallback(() => {
    setViewMode('compare');
  }, []);

  const handleCloseCompare = useCallback(() => {
    setViewMode('list');
  }, []);

  // 将 version 传递给基于 version number 的 API
  const handleSetDefault = useCallback(
    async (version: number) => {
      failIfNotOk(await setDefault(version), version);
      toast.success(t('versionDefaulted', { version }));
    },
    [setDefault, failIfNotOk, t]
  );

  const handleDeprecate = useCallback(
    async (version: number, reason?: string) => {
      failIfNotOk(await deprecate(version, reason), version);
      toast.success(t('versionDeprecated', { version }));
    },
    [deprecate, failIfNotOk, t]
  );

  const handleArchive = useCallback(
    async (version: number, reason?: string) => {
      failIfNotOk(await archive(version, reason), version);
      toast.success(t('versionArchived', { version }));
    },
    [archive, failIfNotOk, t]
  );

  // 这些 API 现在需要 version number 而不是 versionId
  const handleSubmitForApproval = useCallback(
    async (versionId: string, releaseNote?: string) => {
      // 从 versions 中找到对应的 version number
      const ver = (versions as PolicyVersionInfo[]).find((v) => v.id === versionId);
      if (ver) {
        // 失败抛 VersionActionError：列表显示服务端原因（只提示一次）并保持对话框打开，发布说明不丢
        failIfNotOk(await submitForApproval(ver.version, releaseNote), ver.version);
        toast.success(t('versionSubmitted', { version: ver.version }));
      }
    },
    [versions, submitForApproval, failIfNotOk, t]
  );

  const handleApprove = useCallback(
    async (versionId: string, comment?: string) => {
      const ver = (versions as PolicyVersionInfo[]).find((v) => v.id === versionId);
      if (!ver) return;

      const result = await approve(ver.version, comment);
      if (result.ok) {
        toast.success(t('versionApproved', { version: ver.version }));
        return;
      }

      // 邀请审批人：改为弹出邀请框（替代当前对话框），不抛出
      if (result.errorCode === 'invite_reviewer_required') {
        setInviteModal({
          open: true,
          message: t('approvalErrorCodes.invite_reviewer_required'),
          cta: { label: t('approvalErrorCodes.invite_reviewer_cta'), href: result.cta?.href ?? '/teams/new' },
        });
        return;
      }
      // 其余失败：按错误码给本地化原因，抛出后由列表提示一次并保持对话框打开（批准说明不丢）
      const known = result.errorCode === 'segregation_of_duties' || result.errorCode === 'vocabulary_changed_since_save';
      if (known) throw new VersionActionError(t(`approvalErrorCodes.${result.errorCode}`));
      failIfNotOk(result, ver.version, t('approvalErrorCodes.other'));
    },
    [versions, approve, failIfNotOk, t]
  );

  const closeInviteModal = useCallback(() => setInviteModal({ open: false }), []);

  const handleReject = useCallback(
    async (versionId: string, comment?: string) => {
      const ver = (versions as PolicyVersionInfo[]).find((v) => v.id === versionId);
      if (ver && comment) {
        // 同上：失败时保留驳回意见，只提示一次
        failIfNotOk(await reject(ver.version, comment), ver.version);
        toast.success(t('versionRejected', { version: ver.version }));
      }
    },
    [versions, reject, failIfNotOk, t]
  );

  // hook 兜底给的是稳定 code（#711），按 code 本地化；服务端 message 原样显示
  const errorText = (value: string) => (isVersionHookErrorCode(value) ? t(`hookErrorCodes.${value}`) : value);

  // 只有列表本身没加载出来才整块替换；操作失败见下方 actionError 提示。
  if (error) {
    return (
      <div className="bg-bg dark:bg-gray-800 shadow sm:rounded-lg p-6">
        <div className="text-red-500 dark:text-red-400">{errorText(error)}</div>
        <button
          onClick={refresh}
          className="mt-4 text-primary dark:text-primary hover:underline"
        >
          {tCommon('retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="bg-bg dark:bg-gray-800 shadow sm:rounded-lg">
      <div className="px-4 py-5 sm:p-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-fg dark:text-white">
            {t('panelTitle')}
          </h3>
          {viewMode === 'list' && (versions as PolicyVersionInfo[]).length >= 2 && (
            <button
              onClick={handleOpenCompare}
              className="text-sm text-primary dark:text-primary hover:underline"
            >
              {t('compare')}
            </button>
          )}
        </div>

        {/* 操作失败只在列表上方提示，版本列表保持可用（列表加载失败才整块替换） */}
        {actionError && (
          <div
            role="alert"
            className="mb-4 flex items-start justify-between gap-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            <span>{errorText(actionError)}</span>
            <button type="button" onClick={clearActionError} className="shrink-0 underline hover:no-underline">
              {t('actionErrorDismiss')}
            </button>
          </div>
        )}

        {/* Content */}
        {viewMode === 'list' && (
          <PolicyVersionList
            versions={versions as PolicyVersionInfo[]}
            loading={loading}
            currentUserId={session?.user?.id}
            review={review}
            onViewSource={handleViewSource}
            onSetDefault={handleSetDefault}
            onDeprecate={handleDeprecate}
            onArchive={handleArchive}
            onSubmitForApproval={handleSubmitForApproval}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        )}

        {viewMode === 'detail' && selectedVersion !== null && (
          <VersionDetailPanel
            policyId={policyId}
            version={selectedVersion}
            onClose={handleCloseDetail}
          />
        )}

        {viewMode === 'compare' && (
          <VersionComparePanel
            policyId={policyId}
            versions={(versions as PolicyVersionInfo[]).map((v) => ({
              // ★行 id 必须透传：What-If 批次按行 id 定位版本（ADR 0034 §3.1）
              id: v.id,
              version: v.version,
              status: v.status,
              isDefault: v.isDefault,
              releaseNote: v.releaseNote,
              createdAt: v.createdAt,
            }))}
            whatIfEntitled={whatIfEntitled}
            whatIfOwnerOnly={whatIfOwnerOnly}
            retentionDays={retentionDays}
            onClose={handleCloseCompare}
          />
        )}
      </div>

      {inviteModal.open && (
        <InviteReviewerModal
          message={inviteModal.message}
          cta={inviteModal.cta}
          onClose={closeInviteModal}
        />
      )}
    </div>
  );
}

function InviteReviewerModal({
  message,
  cta,
  onClose,
}: {
  message: string;
  cta: { label: string; href: string };
  onClose: () => void;
}) {
  // P2-R20: Esc dismisses modal (WCAG 2.1.1 keyboard parity).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-bg dark:bg-gray-800 p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-fg dark:text-white">
          Invite a reviewer
        </h3>
        <p className="mt-2 text-sm text-fg-muted dark:text-gray-300">{message}</p>
        <p className="mt-3 text-xs text-fg-muted dark:text-fg-subtle">
          SOX Segregation of Duties requires a different person to approve.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-2 text-sm font-medium text-fg-muted hover:bg-bg-muted dark:text-gray-300 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <a
            href={cta.href}
            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover"
          >
            {cta.label}
          </a>
        </div>
      </div>
    </div>
  );
}
