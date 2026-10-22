import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db, policies } from '@/lib/prisma';
import { and, eq, isNull } from 'drizzle-orm';
import { VersionsContent } from './versions-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('policies.versions', 'title');

interface RouteParams {
  params: Promise<{ locale: string; id: string }>;
}

/**
 * Versions list — server shell.
 *
 * Resolves the policy id and basic ownership; client component hydrates
 * the versions table from /api/v1/policies/[id]/versions via SWR so
 * approval state changes refresh without a full page reload.
 */
export default async function VersionsPage({ params }: RouteParams) {
  const { locale, id } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  const policy = await db.query.policies.findFirst({
    where: and(
      eq(policies.id, id),
      eq(policies.userId, session.user.id),
      isNull(policies.deletedAt),
    ),
    columns: { id: true, name: true },
  });

  if (!policy) {
    redirect(`/${locale}/policies`);
  }

  const t = await getTranslations('policies');
  return (
    <VersionsContent
      policyId={policy.id}
      policyName={policy.name}
      locale={locale}
      currentUserId={session.user.id}
      labels={{
        backToPolicy: t('detail.backToPolicies'),
        policiesLink: t('title'),
      }}
    />
  );
}
