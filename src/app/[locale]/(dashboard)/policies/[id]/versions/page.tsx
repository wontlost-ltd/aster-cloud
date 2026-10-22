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
 * Versions list — server shell.
 *
 * Resolves the policy id and read access (owner, or a team owner/admin who
 * reviews the team policy's versions); client component hydrates
 * the versions table from /api/v1/policies/[id]/versions via SWR so
 * approval state changes refresh without a full page reload.
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
