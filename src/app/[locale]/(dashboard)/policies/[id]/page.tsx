import { getSession } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { db, policyVersions, executions, users, teams } from '@/lib/prisma';
import { eq, and, desc, sql } from 'drizzle-orm';
import { getTranslations } from 'next-intl/server';
import { isPolicyFrozen } from '@/lib/policy-freeze';
import { isPolicySharingEnabled } from '@/lib/platform-settings';
import { getEffectiveLimits, type PlanType } from '@/lib/plans';
import { resolveRetention } from '@/lib/retention/execution-retention';
import { loadVersionReviewContext } from '@/services/policy/version-manager';
import { PolicyDetailContent } from './policy-detail-content';
import { localizedTitle } from '@/lib/page-metadata';
import { loadPolicyForAction } from '@/lib/policy-access';
import { policyCapabilities } from '@/lib/policy-access-matrix';
import { planHolderForTeam } from '@/lib/team-plan';
import { findDefaultExecutableVersion } from '@/services/policy/default-executable-version';
import { checkCedarExportability } from '@/lib/cedar-exportability';
import { loadPackageExportState } from '@/lib/package-export-state';
import { loadVersionLayout } from '@/lib/policy-layout/store';
import type { StoredLayout } from '@/lib/policy-layout/types';
import { layoutForCanonical } from '@/lib/policy-layout/reconcile';

export const generateMetadata = localizedTitle('pageTitles', 'policyDetail');

/**
 * 活跃版本的治理档案 id（ADR 0046 §6；未声明档案或旧版本为 null）与显示排版（ADR 0058 §7.2）。
 *
 * <p>排版在存储层已按版本源码复验；源码卡片显示的是 `Policy.content`，两者若不一致（resolver 迁移等）
 * 同样按 inconsistent 处理，绝不在 canonical 旁边显示一份对不上的排版。
 */
async function loadActiveVersionView(
  policyId: string,
  version: number,
  content: string,
): Promise<{ profile: string | null; layout: StoredLayout }> {
  const activeVersion = await db.query.policyVersions.findFirst({
    where: and(eq(policyVersions.policyId, policyId), eq(policyVersions.version, version)),
    columns: { id: true, profile: true },
  });
  if (!activeVersion) return { profile: null, layout: { status: 'none' } };
  const profile = activeVersion.profile ?? null;
  const stored = await loadVersionLayout(activeVersion.id);
  const layout = layoutForCanonical(stored, content);
  if (layout.status !== stored.status) {
    console.error('[policy-layout] inconsistent', { versionId: activeVersion.id, check: 'policy_content' });
  }
  return { profile, layout };
}

// 所属团队（团队策略）；个人策略或团队已删除返回 null
async function loadPolicyTeam(teamId: string | null): Promise<{ id: string; name: string } | null> {
  if (!teamId) return null;
  const team = await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { id: true, name: true } });
  return team ?? null;
}

/**
 * 「导出为 Cedar」的显示与可用（#786）。
 * - 有可执行版本（与导出路由同一选择函数）：按该版本的可导出性决定是否显示，按钮可用；
 * - 没有：按最新版本判定，可导出时显示禁用的按钮并提示先批准（批准后即可导出），否则不显示。
 * 可导出性未知（aster-api 超时 / 尚无检查端点）时照旧显示，由导出本身说明原因。
 */
async function loadCedarExportState(
  policy: { id: string; userId: string; teamId: string | null },
  userId: string,
  executableVersion: ReturnType<typeof findDefaultExecutableVersion>,
): Promise<{ show: boolean; hasExecutableVersion: boolean }> {
  const executable = await executableVersion;
  const target = executable ?? await db.query.policyVersions.findFirst({
    where: eq(policyVersions.policyId, policy.id),
    orderBy: desc(policyVersions.version),
  });
  if (!target) return { show: false, hasExecutableVersion: false };
  const exportability = await checkCedarExportability({ policy, version: target, userId });
  return { show: exportability !== 'not-exportable', hasExecutableVersion: executable !== null };
}

// 服务端数据获取：与 GET /api/policies/[id] 同一授权（团队策略任一当前成员，个人策略只认所有者，#669 #670）
async function getPolicyData(userId: string, policyId: string) {
  const access = await loadPolicyForAction(policyId, { userId }, 'view');
  if (!access.ok) {
    return null;
  }
  // 复用授权时已查到的团队角色算按钮能力，不再重复查成员行
  const capabilities = policyCapabilities({ actorId: userId, policy: access.policy, teamRole: access.decision.teamRole });
  const versions = await db.query.policyVersions.findMany({
    where: eq(policyVersions.policyId, policyId),
    orderBy: desc(policyVersions.version),
    limit: 10,
  });
  const policy = { ...access.policy, versions };

  // 获取执行次数
  const [{ count: executionCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(executions)
    .where(eq(executions.policyId, policyId));

  return {
    id: policy.id,
    name: policy.name,
    description: policy.description,
    content: policy.content,
    version: policy.version,
    isPublic: policy.isPublic,
    shareSlug: policy.shareSlug,
    piiFields: policy.piiFields as string[] | null,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
    versions: policy.versions.map((v) => ({
      id: v.id,
      version: v.version,
      content: v.content,
      comment: v.comment,
      createdAt: v.createdAt.toISOString(),
    })),
    _count: { executions: executionCount },
    ownerId: policy.userId,
    teamId: policy.teamId,
    capabilities,
  };
}

export default async function PolicyDetailPage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>;
}) {
  const { id, locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  const policy = await getPolicyData(session.user.id, id);

  if (!policy) {
    notFound();
  }

  // 冻结状态：套餐降级超限后该策略只读（不可执行/编辑）。
  // 详情页据此禁用按钮并展示冻结横幅，与列表页一致。
  // 冻结取决于策略所有者（创建者）的套餐，与查看者无关。
  const freeze = await isPolicyFrozen(policy.ownerId, id);

  // What-If 权益（ADR 0034 §7.2）：free 档 concurrentReplayBatches=0 表示
  // **没有这个功能**，不是「限流为 0」。
  // ★在 server component 读，不新增客户端 fetch、不新增端点——
  //   同 approve/route.ts 的既有模式。
  const planUser = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: { plan: true, priceLockedAt: true, legacyTier: true },
  });
  // 团队策略按团队 owner 的套餐判定 What-If 权益（#672，与 whatif-batches 路由的租户口径一致）
  const planHolderId = await planHolderForTeam(session.user.id, policy.teamId);
  const whatIfPlanUser = planHolderId === session.user.id
    ? planUser
    : await db.query.users.findFirst({
        where: eq(users.id, planHolderId),
        columns: { plan: true, priceLockedAt: true, legacyTier: true },
      });
  const whatIfEntitled = whatIfPlanUser
    ? getEffectiveLimits({
        plan: whatIfPlanUser.plan as PlanType,
        priceLockedAt: whatIfPlanUser.priceLockedAt,
        legacyTier: whatIfPlanUser.legacyTier,
      }).concurrentReplayBatches !== 0
    : false;   // 查不到用户按无权益处理（fail-closed）

  // 执行日志留存天数（issue #396）：用于裁掉「必然拿不到数据」的 What-If 窗口档位。
  // ★复用上面同一次 users 查询，不新增查询、不新增端点。
  //   What-If 要真回放就得读 Execution.input，而 input 随执行日志按 plan 被留存 GC
  //   删除。此前四个窗口档位对所有档位一视同仁，于是 free（7 天留存）点「最近一年」
  //   必然空窗、而选项还在那里——那套窗口实际只适用于留存期最长的企业级用户。
  const retentionDays = resolveRetention(planUser?.plan).executionDays;

  // Cedar 与策略包导出选的是同一个版本（执行路径会选中的已批准版本），只查一次
  const exportPolicy = { id, userId: policy.ownerId, teamId: policy.teamId };
  const executableVersion = findDefaultExecutableVersion(id);
  const [activeVersionView, cedarExport, packageExport, review, sharingEnabled, policyTeam] = await Promise.all([
    loadActiveVersionView(id, policy.version, policy.content),
    loadCedarExportState(exportPolicy, session.user.id, executableVersion),
    // 策略包选项（ADR 0059 P2）：开关关、套餐不允许或无已批准版本时为 null，不调 aster-api
    loadPackageExportState(exportPolicy, session.user.id, executableVersion),
    // 版本面板的批准/驳回按审批规则显示（团队策略按当前用户的团队角色）
    loadVersionReviewContext(id, session.user.id),
    // 共享开关在服务端读一次并下发（同列表页 shared-with-me 的做法）：关闭时客户端不挂载共享卡片，
    // 不再请求对关闭态有意回 404 的 GET /shares（#630）
    isPolicySharingEnabled(),
    loadPolicyTeam(policy.teamId),
  ]);

  const t = await getTranslations('policies');

  // 预渲染翻译字符串
  const translations = {
    executeAction: t('executeAction'),
    edit: t('edit'),
    delete: t('delete'),
    confirmDelete: t('confirmDelete'),
    failedToDelete: t('failedToDelete'),
    public: t('public'),
    private: t('private'),
    detail: {
      version: t('detail.version'),
      executions: t('detail.executions'),
      viewLogs: t('detail.viewLogs'),
      piiFields: t('detail.piiFields'),
      status: t('detail.status'),
      piiWarning: t('detail.piiWarning'),
      piiWarningMessage: t('detail.piiWarningMessage'),
      policyContent: t('detail.policyContent'),
      versionHistory: t('detail.versionHistory'),
      backToPolicies: t('detail.backToPolicies'),
      profile: t('detail.profile'),
    },
    // verified 保留 {count} 占位符，由面板按探针数替换
    cedarExport: {
      button: t('cedarExport.button'),
      exporting: t('cedarExport.exporting'),
      verified: t.raw('cedarExport.verified') as string,
      notExportable: t('cedarExport.notExportable'),
      failed: t('cedarExport.failed'),
      busy: t('cedarExport.busy'),
      noExecutableVersion: t('cedarExport.noExecutableVersion'),
      versionsLink: t('detail.versionHistory'),
      schemaNote: t('cedarExport.schemaNote'),
      chooseRule: t('cedarExport.chooseRule'),
      exportRule: t('cedarExport.exportRule'),
    },
    // 策略包导出（ADR 0059 P2）；downloaded 保留 {sha256} 占位符，由面板替换
    packageExport: {
      menu: t('packageExport.menu'),
      cedarItem: t('packageExport.cedarItem'),
      cedarHint: t('packageExport.cedarHint'),
      jreItem: t('packageExport.jreItem'),
      jreHint: t('packageExport.jreHint'),
      nodeItem: t('packageExport.nodeItem'),
      nodeHint: t('packageExport.nodeHint'),
      exporting: t('packageExport.exporting'),
      downloaded: t.raw('packageExport.downloaded') as string,
      unsigned: t('packageExport.unsigned'),
      notExportable: t('packageExport.notExportable'),
      showReasons: t('packageExport.showReasons'),
      chooseEntry: t('packageExport.chooseEntry'),
      exportEntry: t('packageExport.exportEntry'),
      planRequired: t('packageExport.planRequired'),
      busy: t('packageExport.busy'),
      unavailable: t('packageExport.unavailable'),
      failed: t('packageExport.failed'),
      noExecutableVersion: t('packageExport.noExecutableVersion'),
      copy: t('packageExport.copy'),
      copied: t('packageExport.copied'),
      reasons: {
        E730: t('packageExport.reasons.E730'),
        E731: t('packageExport.reasons.E731'),
        E732: t('packageExport.reasons.E732'),
        E733: t('packageExport.reasons.E733'),
        E734: t('packageExport.reasons.E734'),
        E735: t('packageExport.reasons.E735'),
        E737: t('packageExport.reasons.E737'),
        E738: t('packageExport.reasons.E738'),
        E739: t('packageExport.reasons.E739'),
        other: t('packageExport.reasons.other'),
      },
    },
    deleteDialog: {
      title: t('deleteDialog.title'),
      description: t('deleteDialog.description', { name: policy.name }),
      confirm: t('deleteDialog.confirm'),
      cancel: t('deleteDialog.cancel'),
    },
    freeze: {
      badge: t('freeze.badge'),
      title: t('freeze.title'),
      message: t('freeze.message', {
        frozen: freeze.frozenCount,
        total: freeze.totalPolicies,
        limit: freeze.activePoliciesLimit,
      }),
      cannotExecute: t('freeze.cannotExecute'),
      cannotEdit: t('freeze.cannotEdit'),
      upgradeLink: t('freeze.upgradeLink'),
    },
  };

  return (
    <PolicyDetailContent
      whatIfEntitled={whatIfEntitled}
      retentionDays={retentionDays}
      policy={{ ...policy, isFrozen: freeze.isFrozen }}
      capabilities={policy.capabilities}
      /* What-If 属主限定（ADR 0034 §4.3）：调用者是创建者但当前角色不够时同样不可用 */
      whatIfOwnerOnly={!policy.capabilities.whatif}
      profile={activeVersionView.profile}
      activeLayout={activeVersionView.layout}
      hasExecutableVersion={cedarExport.hasExecutableVersion}
      showCedarExport={cedarExport.show}
      packageExport={packageExport}
      sharingEnabled={sharingEnabled}
      team={policyTeam ? { id: policyTeam.id, label: t('detail.teamBadge', { name: policyTeam.name }) } : null}
      review={review ? {
        policyOwnerId: review.policyOwnerId,
        policyTeamId: review.policyTeamId,
        reviewerTeamRole: review.reviewerTeamRole,
      } : undefined}
      translations={translations}
      locale={locale}
    />
  );
}
