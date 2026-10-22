import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db, policies } from '@/lib/prisma';
import { and, eq, isNull } from 'drizzle-orm';
import { loadTeamReviewerIds, loadVersionReviewContext } from '@/services/policy/version-manager';
import { canReviewPolicyVersions } from '@/services/policy/version-approval-rules';
import { VersionsContent } from './versions-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('policies.versions', 'title');

interface RouteParams {
  params: Promise<{ locale: string; id: string }>;
}

/**
 * 版本列表的服务端外壳。
 *
 * 解析策略 id 与读权限（所有者，或审阅该团队策略版本的团队 owner/admin），并带上审阅上下文；
 * 客户端组件经 SWR 从 /api/v1/policies/[id]/versions 拉取版本表，审批状态变化无需整页刷新。
 */
export default async function VersionsPage({ params }: RouteParams) {
  const { locale, id } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  const [policy, review] = await Promise.all([
    db.query.policies.findFirst({
      where: and(eq(policies.id, id), isNull(policies.deletedAt)),
      columns: { id: true, name: true },
    }),
    loadVersionReviewContext(id, session.user.id),
  ]);

  // 所有者，或有权审阅的人（团队策略的团队 owner/admin），其余一律当作不存在
  const readable = review && (review.policyOwnerId === session.user.id || canReviewPolicyVersions(review));
  if (!policy || !review || !readable) {
    redirect(`/${locale}/policies`);
  }

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
