import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { loadPolicyForAction } from '@/lib/policy-access';
import { loadTeamReviewerIds, loadVersionReviewContext } from '@/services/policy/version-manager';
import { VersionsContent } from './versions-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('policies.versions', 'title');

interface RouteParams {
  params: Promise<{ locale: string; id: string }>;
}

/**
 * 版本列表的服务端外壳。
 *
 * 解析策略 id 与读权限（授权矩阵的 view），并带上审阅上下文（批准 / 驳回按钮按当前团队角色显示）；
 * 客户端组件经 SWR 从 /api/v1/policies/[id]/versions 拉取版本表，审批状态变化无需整页刷新。
 */
export default async function VersionsPage({ params }: RouteParams) {
  const { locale, id } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  // 与版本 API 同一授权：团队策略任一当前成员可看版本（含他人创建的，#669），
  // 非成员（含已离队的创建者，#670）与他人个人策略一律当作不存在
  const [access, review] = await Promise.all([
    loadPolicyForAction(id, { userId: session.user.id }, 'view'),
    loadVersionReviewContext(id, session.user.id),
  ]);
  if (!access.ok || !review) {
    redirect(`/${locale}/policies`);
  }
  const policy = access.policy;

  const [t, teamReviewerIds] = await Promise.all([
    getTranslations('policies'),
    loadTeamReviewerIds(review.policyTeamId),
  ]);
  return (
    <VersionsContent
      policyId={policy.id}
      policyName={policy.name}
      locale={locale}
      currentUserId={session.user.id}
      review={{
        policyOwnerId: review.policyOwnerId,
        policyTeamId: review.policyTeamId,
        reviewerTeamRole: review.reviewerTeamRole,
      }}
      teamReviewerIds={teamReviewerIds}
      labels={{
        backToPolicy: t('detail.backToPolicies'),
        policiesLink: t('title'),
      }}
    />
  );
}
