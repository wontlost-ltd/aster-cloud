'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ConfirmDialog, Container, PageHeader, Breadcrumbs } from '@/components/ui';
import { PolicyVersionsTab } from '@/components/policy/policy-versions-tab';
import { ShareWithTeamsCard } from '@/components/policy/share-with-teams-card';
import { PolicyAnalyticsSection } from '@/components/policy/policy-analytics-section';

interface PolicyVersion {
  id: string;
  version: number;
  content: string;
  comment: string | null;
  createdAt: string;
}

interface Policy {
  id: string;
  name: string;
  description: string | null;
  content: string;
  version: number;
  isPublic: boolean;
  shareSlug: string | null;
  piiFields: string[] | null;
  createdAt: string;
  updatedAt: string;
  versions: PolicyVersion[];
  // 冻结：套餐降级超限后该策略只读（不可执行/编辑），与列表页一致。
  isFrozen: boolean;
  _count: {
    executions: number;
  };
}

interface Translations {
  executeAction: string;
  edit: string;
  delete: string;
  confirmDelete: string;
  failedToDelete: string;
  public: string;
  private: string;
  detail: {
    version: string;
    executions: string;
    viewLogs: string;
    piiFields: string;
    status: string;
    piiWarning: string;
    piiWarningMessage: string;
    policyContent: string;
    versionHistory: string;
    backToPolicies: string;
  };
  deleteDialog: {
    title: string;
    description: string;
    confirm: string;
    cancel: string;
  };
  freeze: {
    badge: string;
    title: string;
    message: string;
    cannotExecute: string;
    cannotEdit: string;
    upgradeLink: string;
  };
}

interface PolicyDetailContentProps {
  /** 租户是否拥有 What-If 权益（ADR 0034 §7.2）。server 侧读 plan 得出。 */
  whatIfEntitled?: boolean;
  policy: Policy;
  translations: Translations;
  locale: string;
}

export function PolicyDetailContent({
  whatIfEntitled = false,
  policy,
  translations: t,
  locale,
}: PolicyDetailContentProps) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteClick = useCallback(() => {
    setDeleteDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/policies/${policy.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete policy');
      setDeleteDialogOpen(false);
      router.push(`/${locale}/policies`);
    } catch (err) {
      setError(t.failedToDelete);
      console.error(err);
    } finally {
      setIsDeleting(false);
    }
  }, [policy.id, locale, router, t.failedToDelete]);

  const handleCancelDelete = useCallback(() => {
    if (isDeleting) return;
    setDeleteDialogOpen(false);
  }, [isDeleting]);

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* 详情页（deep）：保留 Breadcrumbs（放进 PageHeader 的 breadcrumbs slot），
          替代原来手抄的返回箭头链接，用作上一级导航。 */}
      <PageHeader
        title={policy.name}
        subtitle={policy.description ?? undefined}
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: t.detail.backToPolicies, href: '/policies' },
              { label: policy.name },
            ]}
          />
        }
        action={
          <div className="flex space-x-3">
            {/* 冻结策略只读：Execute/Edit 渲染为禁用态（与列表页一致）；
                Delete 仍允许——删除是用户解除冻结（降到限额内）的途径。 */}
            {policy.isFrozen ? (
              <span
                className="inline-flex items-center rounded-md bg-bg-muted px-3 py-2 text-sm font-semibold text-fg-subtle cursor-not-allowed select-none"
                aria-disabled="true"
                title={t.freeze.cannotExecute}
              >
                {t.executeAction}
              </span>
            ) : (
              <Link
                href={`/${locale}/policies/${policy.id}/execute`}
                className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover"
              >
                {t.executeAction}
              </Link>
            )}
            {policy.isFrozen ? (
              <span
                className="inline-flex items-center rounded-md bg-bg px-3 py-2 text-sm font-semibold text-fg-subtle shadow-sm ring-1 ring-inset ring-gray-300 cursor-not-allowed select-none"
                aria-disabled="true"
                title={t.freeze.cannotEdit}
              >
                {t.edit}
              </span>
            ) : (
              <Link
                href={`/${locale}/policies/${policy.id}/edit`}
                className="inline-flex items-center rounded-md bg-bg px-3 py-2 text-sm font-semibold text-fg shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-bg-subtle"
              >
                {t.edit}
              </Link>
            )}
            <button
              onClick={handleDeleteClick}
              className="inline-flex items-center rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
            >
              {t.delete}
            </button>
          </div>
        }
        className="mb-6"
      />

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-4">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* 冻结横幅：套餐降级超限后该策略只读，引导升级 */}
      {policy.isFrozen && (
        <div className="mb-6 rounded-md bg-amber-50 ring-1 ring-amber-200 p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-amber-500" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-semibold text-amber-800">
                {t.freeze.title}
                <span className="ml-2 inline-flex items-center rounded-full bg-amber-200 px-2 py-0.5 text-xs font-medium text-amber-900">
                  {t.freeze.badge}
                </span>
              </h3>
              <p className="mt-1 text-sm text-amber-700">{t.freeze.message}</p>
              <Link
                href={`/${locale}/billing`}
                className="mt-2 inline-block text-sm font-medium text-amber-800 underline hover:text-amber-900"
              >
                {t.freeze.upgradeLink} →
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-4 mb-6">
        <Link
          href={`/${locale}/policies/${policy.id}/versions`}
          className="bg-bg overflow-hidden rounded-lg shadow px-4 py-5 hover:bg-bg-subtle transition-colors block"
        >
          <dt className="text-sm font-medium text-fg-muted truncate">{t.detail.version}</dt>
          <dd className="mt-1 text-2xl font-semibold text-fg">v{policy.version}</dd>
          <p className="mt-1 text-xs text-primary">{t.detail.versionHistory} →</p>
        </Link>
        <Link
          href={`/${locale}/policies/${policy.id}/logs`}
          className="bg-bg overflow-hidden rounded-lg shadow px-4 py-5 hover:bg-bg-subtle transition-colors block"
        >
          <dt className="text-sm font-medium text-fg-muted truncate">{t.detail.executions}</dt>
          <dd className="mt-1 text-2xl font-semibold text-fg">{policy._count.executions}</dd>
          <p className="mt-1 text-xs text-primary">{t.detail.viewLogs} →</p>
        </Link>
        <div className="bg-bg overflow-hidden rounded-lg shadow px-4 py-5">
          <dt className="text-sm font-medium text-fg-muted truncate">{t.detail.piiFields}</dt>
          <dd className="mt-1 text-2xl font-semibold text-fg">
            {policy.piiFields?.length || 0}
          </dd>
        </div>
        <div className="bg-bg overflow-hidden rounded-lg shadow px-4 py-5">
          <dt className="text-sm font-medium text-fg-muted truncate">{t.detail.status}</dt>
          <dd className="mt-1">
            {policy.isPublic ? (
              <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-sm font-medium text-green-800">
                {t.public}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-bg-muted px-2.5 py-0.5 text-sm font-medium text-fg">
                {t.private}
              </span>
            )}
          </dd>
        </div>
      </div>

      {/* PII Warning */}
      {policy.piiFields && policy.piiFields.length > 0 && (
        <div className="mb-6 rounded-md bg-yellow-50 p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-800">{t.detail.piiWarning}</h3>
              <p className="mt-1 text-sm text-yellow-700">
                {t.detail.piiWarningMessage}{' '}
                <span className="font-medium">{policy.piiFields.join(', ')}</span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="bg-bg shadow sm:rounded-lg mb-6">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-fg mb-4">{t.detail.policyContent}</h3>
          <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
            {policy.content}
          </pre>
        </div>
      </div>

      {/* Share with teams — self-hides when the platform admin
          disables the policy_sharing.enabled flag, or when the
          caller isn't the policy owner. See
          src/components/policy/share-with-teams-card.tsx for the
          gating model. */}
      <div className="mt-6">
        <ShareWithTeamsCard policyId={policy.id} />
      </div>

      {/* Version Management with Approval Workflow */}
      <PolicyVersionsTab policyId={policy.id} whatIfEntitled={whatIfEntitled} />

      {/* 决策分析（Phase 1 条件漏斗 + Phase 4 What-if）。
          自带 i18n，故不走 translations prop——避免详情页把每个新面板的
          文案都摊平到 page.tsx 的预渲染对象里。 */}
      <div className="mt-6">
        <PolicyAnalyticsSection policyId={policy.id} currentVersion={policy.version} />
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteDialogOpen}
        onCancel={handleCancelDelete}
        onConfirm={handleConfirmDelete}
        title={t.deleteDialog.title}
        description={t.deleteDialog.description}
        confirmLabel={t.deleteDialog.confirm}
        cancelLabel={t.deleteDialog.cancel}
        variant="danger"
        isLoading={isDeleting}
      />
    </Container>
  );
}
