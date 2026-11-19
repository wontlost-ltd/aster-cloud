'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ConfirmDialog, Container, PageHeader, Breadcrumbs } from '@/components/ui';
import { PolicyVersionsTab } from '@/components/policy/policy-versions-tab';
import type { VersionReviewContext } from '@/services/policy/version-approval-rules';
import { PolicyReviewPanel } from '@/components/policy/policy-review-panel';
import type { PolicyCapabilities } from '@/lib/policy-access-matrix';
import { ShareWithTeamsCard } from '@/components/policy/share-with-teams-card';
import { PolicyAnalyticsSection } from '@/components/policy/policy-analytics-section';
import { PolicyProfileBadge } from '@/components/policy/policy-profile-badge';
import { CedarExportProvider, CedarExportStatus, type CedarExportLabels } from '@/components/policy/cedar-export-panel';
import { PackageExportProvider, PackageExportStatus, type PackageExportLabels } from '@/components/policy/package-export-panel';
import { PolicyExportMenu, visiblePackageTargets } from '@/components/policy/policy-export-menu';
import type { PackageExportMenuState } from '@/lib/package-export-state';
import { LayoutReadTabs } from '@/components/policy/layout/layout-read-tabs';
import type { StoredLayout } from '@/lib/policy-layout/types';

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
    profile: string;
  };
  cedarExport: CedarExportLabels;
  packageExport: PackageExportLabels;
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
  /** 执行日志留存天数（#396），透传给 What-If 面板裁剪窗口 */
  retentionDays?: number | null;
  policy: Policy;
  /** 活跃版本落库的治理档案 id（ADR 0046 §6）。 */
  profile?: string | null;
  /** 是否已有批准版本（决定「导出为 Cedar」可用与否）；缺省按可用处理，由导出路由的 409 兜底。 */
  hasExecutableVersion?: boolean;
  /**
   * 是否显示「导出为 Cedar」（#786）：服务端按可导出性判定（lib/cedar-exportability），确定不可导出时为 false。
   * 在服务端定好再下发，客户端没有「加载中」状态，按钮不会先出现再消失。
   */
  showCedarExport?: boolean;
  /**
   * 「导出」菜单里的策略包选项（ADR 0059 P2）：服务端按开关、套餐、已批准版本与 check 判定（lib/package-export-state）；
   * null 时没有任何包选项，操作组与引入策略包导出之前相同。
   */
  packageExport?: PackageExportMenuState | null;
  /** 版本审批判定上下文（见 version-approval-rules） */
  review?: Omit<VersionReviewContext, 'reviewerId'>;
  /**
   * 平台「策略共享」开关（policy_sharing.enabled），由 server component 读出下发。
   * 关闭时不挂载共享卡片：其 GET /shares 对关闭态有意回 404，挂载就会在控制台留下 404 噪音。
   */
  sharingEnabled?: boolean;
  /**
   * 调用者对该策略可做的动作（授权矩阵，服务端按当前团队角色算出）。缺省视为全部可用，
   * 真正的拦截始终在 API 层；这里只决定按钮是否出现（viewer 不显示执行 / 编辑 / 删除）。
   */
  capabilities?: Pick<PolicyCapabilities, 'execute' | 'update' | 'delete'>;
  /** What-If 属主限定（ADR 0034 §4.3）：调用者不能运行时面板显示说明 */
  whatIfOwnerOnly?: boolean;
  /** 所属团队（团队策略）；个人策略为 null。状态卡据此标出团队，区分个人策略与团队策略（#681）。 */
  team?: { id: string; label: string } | null;
  /**
   * 活跃版本的显示排版（ADR 0058 §7.2，服务端读取并复验）。缺省 none：源码卡片与引入 layout 之前一致。
   * 只读查看不设能力门，公开或共享策略的读者同样看得到。
   */
  activeLayout?: StoredLayout;
  translations: Translations;
  locale: string;
}

const ALL_ACTIONS = { execute: true, update: true, delete: true } as const;
const NO_LAYOUT: StoredLayout = { status: 'none' };

export function PolicyDetailContent({
  whatIfEntitled = false,
  retentionDays = null,
  policy,
  profile = null,
  hasExecutableVersion = true,
  showCedarExport = false,
  packageExport = null,
  review,
  sharingEnabled = false,
  capabilities = ALL_ACTIONS,
  whatIfOwnerOnly = false,
  team = null,
  activeLayout = NO_LAYOUT,
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

  const content = (
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
          // 窄屏四个按钮放不下一行：折行，行距 / 列距 0.75rem，移动端撑到 44px 的点击区（globals.css）互不重叠
          <div className="flex flex-wrap gap-3" data-testid="policy-actions">
            {/* 冻结策略只读：Execute/Edit 渲染为禁用态（与列表页一致）；
                Delete 仍允许——删除是用户解除冻结（降到限额内）的途径。 */}
            {!capabilities.execute ? null : policy.isFrozen ? (
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
                className="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-fg shadow-sm hover:bg-primary-hover"
              >
                {t.executeAction}
              </Link>
            )}
            {!capabilities.update ? null : policy.isFrozen ? (
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
            {/* 导出（ADR 0047 §6 Cedar、ADR 0059 策略包）：只读操作，冻结策略同样可导出；放在破坏性的「删除」之前（#786）。
                只有 Cedar 时是原来的单按钮，有包选项时是下拉菜单 */}
            <PolicyExportMenu showCedar={showCedarExport} packages={packageExport} labels={t.packageExport} />
            {capabilities.delete && (
            <button
              onClick={handleDeleteClick}
              className="inline-flex items-center rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-red-700"
            >
              {t.delete}
            </button>
            )}
          </div>
        }
        className="mb-6"
      />

      {/* 导出结果 / 错误 / 「先批准」提示：紧贴页头操作组下方（#786）；导出的是执行路径实际选中的版本（默认的已批准版本，否则最新已批准版本） */}
      {showCedarExport && <CedarExportStatus />}
      <PackageExportStatus />

      {/* 治理档案徽标（ADR 0046 §6）：活跃版本声明了档案才显示 */}
      <div className="mb-4 empty:hidden">
        <PolicyProfileBadge profile={profile} locale={locale} label={t.detail.profile} />
      </div>

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

      {/* Stats —— 卡片本身是链接，不能用 <dt>/<dd>（必须在 <dl> 内，axe dlitem，#774），改用普通段落 */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-4 mb-6">
        <Link
          href={`/${locale}/policies/${policy.id}/versions`}
          className="bg-bg overflow-hidden rounded-lg shadow px-4 py-5 hover:bg-bg-subtle transition-colors block"
        >
          <p className="text-sm font-medium text-fg-muted truncate">{t.detail.version}</p>
          <div className="mt-1 text-2xl font-semibold text-fg">v{policy.version}</div>
          <p className="mt-1 text-xs text-primary">{t.detail.versionHistory} →</p>
        </Link>
        <Link
          href={`/${locale}/policies/${policy.id}/logs`}
          className="bg-bg overflow-hidden rounded-lg shadow px-4 py-5 hover:bg-bg-subtle transition-colors block"
        >
          <p className="text-sm font-medium text-fg-muted truncate">{t.detail.executions}</p>
          <div className="mt-1 text-2xl font-semibold text-fg">{policy._count.executions}</div>
          <p className="mt-1 text-xs text-primary">{t.detail.viewLogs} →</p>
        </Link>
        <div className="bg-bg overflow-hidden rounded-lg shadow px-4 py-5">
          <p className="text-sm font-medium text-fg-muted truncate">{t.detail.piiFields}</p>
          <div className="mt-1 text-2xl font-semibold text-fg">
            {policy.piiFields?.length || 0}
          </div>
        </div>
        <div className="bg-bg overflow-hidden rounded-lg shadow px-4 py-5">
          <p className="text-sm font-medium text-fg-muted truncate">{t.detail.status}</p>
          <div className="mt-1">
            {policy.isPublic ? (
              <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-sm font-medium text-green-800">
                {t.public}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-bg-muted px-2.5 py-0.5 text-sm font-medium text-fg">
                {t.private}
              </span>
            )}
            {team && (
              <Link
                href={`/${locale}/teams/${team.id}`}
                className="ml-2 inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-sm font-medium text-blue-800 hover:underline"
              >
                {team.label}
              </Link>
            )}
          </div>
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
          <LayoutReadTabs layout={activeLayout}>
            <pre tabIndex={0} className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm">
              {policy.content}
            </pre>
          </LayoutReadTabs>
        </div>
      </div>

      {/* 与团队共享：平台开关关闭时整块不挂载（不发 GET /shares，避免 404）；
          开启后卡片仍按 /shares 的返回自隐藏（非 owner 等），见
          src/components/policy/share-with-teams-card.tsx。 */}
      {sharingEnabled && (
        <div className="mt-6">
          <ShareWithTeamsCard policyId={policy.id} />
        </div>
      )}

      {/* 人工复核（ADR 0037 §14/§15）。自带 i18n 与自隐藏：
          无权查看时 return null，不渲染"你没有权限"的空壳。
          队列、计数、已落库结论都由 GET /api/policies/:id/review 一次返回。
          活跃版本有显示排版时，面板顶部说明其片段均为 canonical（ADR 0058 §7.7 第 7 条）。 */}
      <PolicyReviewPanel policyId={policy.id} hasDisplayLayout={activeLayout.status !== 'none'} />

      {/* Version Management with Approval Workflow */}
      <PolicyVersionsTab policyId={policy.id} whatIfEntitled={whatIfEntitled} retentionDays={retentionDays} review={review} whatIfOwnerOnly={whatIfOwnerOnly} />

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

  const withPackages = packageExport && visiblePackageTargets(packageExport).length > 0 ? (
    <PackageExportProvider policyId={policy.id} locale={locale} labels={t.packageExport} packages={packageExport}>
      {content}
    </PackageExportProvider>
  ) : content;
  if (!showCedarExport) return withPackages;
  return (
    <CedarExportProvider
      policyId={policy.id}
      labels={t.cedarExport}
      hasExecutableVersion={hasExecutableVersion}
      versionsHref={`/${locale}/policies/${policy.id}/versions`}
    >
      {withPackages}
    </CedarExportProvider>
  );
}
