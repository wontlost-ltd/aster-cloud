import { getSession } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { db, policyVersions, executions, users } from '@/lib/prisma';
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

export const generateMetadata = localizedTitle('pageTitles', 'policyDetail');

// 活跃版本保存时落库的治理档案 id（ADR 0046 §6）；未声明档案或旧版本为 null
async function loadActiveProfile(policyId: string, version: number): Promise<string | null> {
  const activeVersion = await db.query.policyVersions.findFirst({
    where: and(eq(policyVersions.policyId, policyId), eq(policyVersions.version, version)),
    columns: { profile: true },
  });
  return activeVersion?.profile ?? null;
}

// 是否存在批准版本：与 findDefaultExecutableVersion 同一口径（只有 APPROVED 版本可执行/可导出），
// 这里只需判存在，故只取 id。
async function hasApprovedVersion(policyId: string): Promise<boolean> {
  const approved = await db.query.policyVersions.findFirst({
    where: and(eq(policyVersions.policyId, policyId), eq(policyVersions.status, 'APPROVED')),
    columns: { id: true },
  });
  return approved !== undefined;
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
  const whatIfEntitled = planUser
    ? getEffectiveLimits({
        plan: planUser.plan as PlanType,
        priceLockedAt: planUser.priceLockedAt,
        legacyTier: planUser.legacyTier,
      }).concurrentReplayBatches !== 0
    : false;   // 查不到用户按无权益处理（fail-closed）

  // 执行日志留存天数（issue #396）：用于裁掉「必然拿不到数据」的 What-If 窗口档位。
  // ★复用上面同一次 users 查询，不新增查询、不新增端点。
  //   What-If 要真回放就得读 Execution.input，而 input 随执行日志按 plan 被留存 GC
  //   删除。此前四个窗口档位对所有档位一视同仁，于是 free（7 天留存）点「最近一年」
  //   必然空窗、而选项还在那里——那套窗口实际只适用于留存期最长的企业级用户。
  const retentionDays = resolveRetention(planUser?.plan).executionDays;

  const [profile, hasExecutableVersion, review, sharingEnabled] = await Promise.all([
    loadActiveProfile(id, policy.version),
    hasApprovedVersion(id),
    // 版本面板的批准/驳回按审批规则显示（团队策略按当前用户的团队角色）
    loadVersionReviewContext(id, session.user.id),
    // 共享开关在服务端读一次并下发（同列表页 shared-with-me 的做法）：关闭时客户端不挂载共享卡片，
    // 不再请求对关闭态有意回 404 的 GET /shares（#630）
    isPolicySharingEnabled(),
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
      noExecutableVersion: t('cedarExport.noExecutableVersion'),
      versionsLink: t('detail.versionHistory'),
      schemaNote: t('cedarExport.schemaNote'),
      chooseRule: t('cedarExport.chooseRule'),
      exportRule: t('cedarExport.exportRule'),
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
      profile={profile}
      hasExecutableVersion={hasExecutableVersion}
      sharingEnabled={sharingEnabled}
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
