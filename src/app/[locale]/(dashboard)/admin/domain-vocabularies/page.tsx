import { setRequestLocale } from 'next-intl/server';
import {
  getRecentBulkJobAggregates,
  getTopVocabularyUsers,
  getVocabularyAdminOverview,
} from '@/lib/domain-vocabulary-admin';
import { VocabularyAdminContent } from './admin-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('admin.vocab', 'title');

type Props = {
  params: Promise<{ locale: string }>;
};

/**
 * /admin/domain-vocabularies — operator dashboard for the F9 surface.
 *
 * Read-only at-a-glance numbers + a top-N user table + recent bulk job
 * status rollup. Auth is handled by the admin/layout.tsx gate; we just
 * fetch + render.
 */
export const dynamic = 'force-dynamic';

export default async function AdminDomainVocabulariesPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Each panel is fail-soft: a single failed query renders an empty card
  // rather than 500-ing the whole page (mirrors /admin/page.tsx pattern).
  const [overviewResult, topUsersResult, jobAggregatesResult] = await Promise.allSettled([
    getVocabularyAdminOverview(),
    getTopVocabularyUsers(10),
    getRecentBulkJobAggregates(),
  ]);

  // 内容组件自持 Container + PageHeader（与同级 admin 子页一致）；本页仅取数透传。
  return (
    <VocabularyAdminContent
      overview={
        overviewResult.status === 'fulfilled' ? overviewResult.value : null
      }
      topUsers={
        topUsersResult.status === 'fulfilled' ? topUsersResult.value : []
      }
      jobAggregates={
        jobAggregatesResult.status === 'fulfilled'
          ? jobAggregatesResult.value
          : []
      }
      overviewError={
        overviewResult.status === 'rejected' ? String(overviewResult.reason) : null
      }
    />
  );
}
