'use client';

import { useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import type { PolicyVersionStatus } from '@/lib/prisma';
import { VersionStatusBadge } from './version-status-badge';
import { ConfirmDialog } from '@/components/ui';

interface PolicyVersionInfo {
  id: string;
  version: number;
  sourceHash: string | null;
  status: PolicyVersionStatus;
  isDefault: boolean;
  releaseNote: string | null;
  createdBy: string;
  createdAt: string;
  deprecatedAt: string | null;
  deprecatedBy: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  _count?: { approvals: number };
}

interface PolicyVersionListProps {
  versions: PolicyVersionInfo[];
  loading?: boolean;
  currentUserId?: string;
  onSetDefault?: (version: number) => Promise<void>;
  onDeprecate?: (version: number, reason?: string) => Promise<void>;
  onArchive?: (version: number, reason?: string) => Promise<void>;
  onSubmitForApproval?: (versionId: string) => Promise<void>;
  onApprove?: (versionId: string, comment?: string) => Promise<void>;
  onReject?: (versionId: string, comment?: string) => Promise<void>;
  onViewSource?: (version: number) => void;
}

type ActionType = 'set-default' | 'deprecate' | 'archive' | 'submit' | 'approve' | 'reject';

interface ActionDialogState {
  open: boolean;
  type: ActionType | null;
  version: PolicyVersionInfo | null;
}

export function PolicyVersionList({
  versions,
  loading = false,
  currentUserId,
  onSetDefault,
  onDeprecate,
  onArchive,
  onSubmitForApproval,
  onApprove,
  onReject,
  onViewSource,
}: PolicyVersionListProps) {
  const t = useTranslations('policies.versions');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const [actionDialog, setActionDialog] = useState<ActionDialogState>({
    open: false,
    type: null,
    version: null,
  });
  const [actionLoading, setActionLoading] = useState(false);
  const [comment, setComment] = useState('');

  const openActionDialog = useCallback((type: ActionType, version: PolicyVersionInfo) => {
    setActionDialog({ open: true, type, version });
    setComment('');
  }, []);

  const closeActionDialog = useCallback(() => {
    if (actionLoading) return;
    setActionDialog({ open: false, type: null, version: null });
    setComment('');
  }, [actionLoading]);

  const handleConfirmAction = useCallback(async () => {
    if (!actionDialog.version || !actionDialog.type) return;

    setActionLoading(true);
    try {
      switch (actionDialog.type) {
        case 'set-default':
          await onSetDefault?.(actionDialog.version.version);
          break;
        case 'deprecate':
          await onDeprecate?.(actionDialog.version.version, comment || undefined);
          break;
        case 'archive':
          await onArchive?.(actionDialog.version.version, comment || undefined);
          break;
        case 'submit':
          await onSubmitForApproval?.(actionDialog.version.id);
          break;
        case 'approve':
          await onApprove?.(actionDialog.version.id, comment || undefined);
          break;
        case 'reject':
          await onReject?.(actionDialog.version.id, comment || undefined);
          break;
      }
      closeActionDialog();
    } catch (error) {
      console.error('Action failed:', error);
    } finally {
      setActionLoading(false);
    }
  }, [
    actionDialog,
    comment,
    onSetDefault,
    onDeprecate,
    onArchive,
    onSubmitForApproval,
    onApprove,
    onReject,
    closeActionDialog,
  ]);

  const getDialogConfig = useCallback(() => {
    const v = actionDialog.version;
    const n = v?.version ?? 0;
    switch (actionDialog.type) {
      case 'set-default':
        return {
          title: t('setDefaultDialog.title', { n }),
          description: t('setDefaultDialog.body', { n }),
          confirmLabel: t('setDefaultDialog.confirm'),
          variant: 'info' as const,
          showComment: false,
        };
      case 'deprecate':
        return {
          title: t('deprecateDialog.title', { n }),
          description: t('deprecateDialog.body', { n }),
          confirmLabel: t('deprecateDialog.confirm'),
          variant: 'warning' as const,
          showComment: true,
          commentPlaceholder: t('deprecateDialog.reasonLabel'),
        };
      case 'archive':
        return {
          title: t('archiveDialog.title', { n }),
          description: t('archiveDialog.body', { n }),
          confirmLabel: t('archiveDialog.confirm'),
          variant: 'danger' as const,
          showComment: true,
          commentPlaceholder: t('archiveDialog.reasonLabel'),
        };
      case 'submit':
        return {
          title: t('submitDialogTitle', { n }),
          description: t('submitDialogBody', { n }),
          confirmLabel: t('submitForApproval'),
          variant: 'info' as const,
          showComment: false,
        };
      case 'approve':
        return {
          title: t('approveDialog.title', { n }),
          description: t('approveDialog.body', { n }),
          confirmLabel: t('approveDialog.confirm'),
          variant: 'info' as const,
          showComment: true,
          commentPlaceholder: t('approveDialog.commentPlaceholder'),
        };
      case 'reject':
        return {
          title: t('rejectDialog.title', { n }),
          description: t('rejectDialog.body', { n }),
          confirmLabel: t('rejectDialog.confirm'),
          variant: 'danger' as const,
          showComment: true,
          commentPlaceholder: t('rejectDialog.commentPlaceholder'),
          commentRequired: true,
        };
      default:
        return {
          title: '',
          description: '',
          confirmLabel: tCommon('confirm'),
          variant: 'info' as const,
          showComment: false,
        };
    }
  }, [actionDialog, t, tCommon]);

  const dialogConfig = getDialogConfig();

  // Check if user can approve (four-eyes principle: creator cannot approve)
  const canApprove = useCallback(
    (version: PolicyVersionInfo) => {
      return currentUserId && version.createdBy !== currentUserId;
    },
    [currentUserId]
  );

  if (loading) {
    return (
      <div className="animate-pulse space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-20 bg-bg-muted dark:bg-gray-700 rounded-lg" />
        ))}
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="text-center py-8 text-fg-muted dark:text-fg-subtle">
        {t('noVersions')}
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {versions.map((version) => (
          <div
            key={version.id}
            className="bg-bg dark:bg-gray-800 rounded-lg shadow-sm border border-border dark:border-gray-700 p-4"
          >
            {/* 移动端纵向堆叠（信息在上、操作按钮在下换行），桌面端横向并排——
                否则窄屏时右侧一排按钮（查看源码/提交审批/…）挤出卡片边界。 */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <span className="text-lg font-semibold text-fg dark:text-white">
                    v{version.version}
                  </span>
                  <VersionStatusBadge status={version.status} isDefault={version.isDefault} />
                </div>

                {version.releaseNote && (
                  <p className="mt-1 text-sm text-fg-muted dark:text-fg-subtle">
                    {version.releaseNote}
                  </p>
                )}

                <div className="mt-2 flex items-center gap-4 text-xs text-fg-muted dark:text-fg-muted">
                  <span>
                    {t('createdOn', {
                      date: new Date(version.createdAt).toLocaleString(locale),
                    })}
                  </span>
                  {version.sourceHash && (
                    <span className="font-mono">
                      {version.sourceHash.substring(0, 16)}...
                    </span>
                  )}
                  {version._count?.approvals !== undefined && version._count.approvals > 0 && (
                    <span>{t('approvalCount', { count: version._count.approvals })}</span>
                  )}
                </div>

                {version.deprecatedAt && (
                  <p className="mt-1 text-xs text-orange-600 dark:text-orange-400">
                    {t('deprecatedOn', { date: new Date(version.deprecatedAt).toLocaleString(locale) })}
                  </p>
                )}

                {version.archivedAt && (
                  <p className="mt-1 text-xs text-fg-muted dark:text-fg-muted">
                    {t('archivedOn', { date: new Date(version.archivedAt).toLocaleString(locale) })}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 sm:flex-shrink-0">
                {/* View Source */}
                {onViewSource && (
                  <button
                    onClick={() => onViewSource(version.version)}
                    className="text-sm text-fg-muted dark:text-fg-subtle hover:text-fg dark:hover:text-white px-2 py-1"
                  >
                    {t('viewSource')}
                  </button>
                )}

                {/* Status-specific actions */}
                {version.status === 'DRAFT' && onSubmitForApproval && (
                  <button
                    onClick={() => openActionDialog('submit', version)}
                    className="text-sm bg-primary hover:bg-primary-hover text-white px-3 py-1.5 rounded-md"
                  >
                    {t('submitForApproval')}
                  </button>
                )}

                {version.status === 'PENDING_APPROVAL' && canApprove(version) && (
                  <>
                    <button
                      onClick={() => openActionDialog('approve', version)}
                      className="text-sm bg-green-600 hover:bg-green-700 text-white px-3 py-1.5 rounded-md"
                    >
                      {t('actions.approve')}
                    </button>
                    <button
                      onClick={() => openActionDialog('reject', version)}
                      className="text-sm bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-md"
                    >
                      {t('actions.reject')}
                    </button>
                  </>
                )}

                {version.status === 'PENDING_APPROVAL' && !canApprove(version) && (
                  <span className="text-xs text-yellow-600 dark:text-yellow-400">
                    {t('awaitingOthers')}
                  </span>
                )}

                {version.status === 'APPROVED' && !version.isDefault && onSetDefault && (
                  <button
                    onClick={() => openActionDialog('set-default', version)}
                    className="text-sm bg-primary-subtle dark:bg-primary-active text-primary-hover dark:text-primary-fg hover:bg-primary-subtle dark:hover:bg-primary-hover px-3 py-1.5 rounded-md"
                  >
                    {t('actions.setDefault')}
                  </button>
                )}

                {version.status === 'APPROVED' && !version.isDefault && onDeprecate && (
                  <button
                    onClick={() => openActionDialog('deprecate', version)}
                    className="text-sm text-orange-600 dark:text-orange-400 hover:text-orange-700 dark:hover:text-orange-300 px-2 py-1"
                  >
                    {t('actions.deprecate')}
                  </button>
                )}

                {(version.status === 'APPROVED' || version.status === 'DEPRECATED') &&
                  !version.isDefault &&
                  onArchive && (
                    <button
                      onClick={() => openActionDialog('archive', version)}
                      className="text-sm text-fg-muted dark:text-fg-subtle hover:text-fg dark:hover:text-gray-300 px-2 py-1"
                    >
                      {t('actions.archive')}
                    </button>
                  )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Action Dialog */}
      <ConfirmDialog
        isOpen={actionDialog.open}
        onCancel={closeActionDialog}
        onConfirm={handleConfirmAction}
        title={dialogConfig.title}
        description={
          dialogConfig.showComment ? (
            <div className="space-y-3">
              <p>{dialogConfig.description}</p>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={dialogConfig.commentPlaceholder}
                className="w-full px-3 py-2 border border-border-strong dark:border-gray-600 rounded-md text-sm bg-bg dark:bg-gray-800 text-fg dark:text-white placeholder-gray-500"
                rows={3}
              />
            </div>
          ) : (
            dialogConfig.description
          )
        }
        confirmLabel={dialogConfig.confirmLabel}
        cancelLabel={tCommon('cancel')}
        variant={dialogConfig.variant}
        isLoading={actionLoading}
      />
    </>
  );
}

export type { PolicyVersionInfo };
