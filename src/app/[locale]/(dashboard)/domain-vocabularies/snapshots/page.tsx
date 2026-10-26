import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { listOwnerSnapshots } from '@/lib/domain-vocabulary-snapshot';
import { getLexiconQuota } from '@/lib/usage';
import {
  buildListUrl,
  clampPage,
  parseListUrlState,
  type ListUrlOptions,
} from '@/lib/list-search-params';
import { SnapshotsContent, type SerializableSnapshot } from './snapshots-content';
import { localizedTitle } from '@/lib/page-metadata';

// 与其它应用内页面一致：标签页标题复用页面大标题（#640）。
export const generateMetadata = localizedTitle('domainVocabularies.snapshotsView', 'title');

const SNAPSHOTS_URL_OPTS: ListUrlOptions = {
  defaultPageSize: 25,
  allowedPageSizes: [25, 50, 100],
  filterKeys: [],
};

/**
 * /domain-vocabularies/snapshots — server shell.
 *
 * Pagination + search are URL-canonical (?page, ?pageSize, ?q). The
 * client lazily fetches a snapshot's diff when the user opens it; we
 * only ship the requested page's metadata here so a user with hundreds
 * of snapshots doesn't pay for them at SSR time.
 */
export default async function SnapshotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session?.user?.id) redirect('/login');

  let allowed = false;
  try {
    const quota = await getLexiconQuota(session.user.id);
    allowed = quota.allowed;
  } catch (err) {
    console.error('[snapshots page] quota lookup failed', err);
  }
  if (!allowed) {
    redirect('/domain-vocabularies');
  }

  const params = await searchParams;
  const urlState = parseListUrlState(params, SNAPSHOTS_URL_OPTS);

  // Fail-soft list: if the snapshot table is transient missing, render
  // an empty page rather than 500. Errors are still logged.
  let serialized: SerializableSnapshot[] = [];
  let total = 0;
  let page = urlState.page;
  let pageSize = urlState.pageSize;
  try {
    const result = await listOwnerSnapshots(session.user.id, {
      page: urlState.page,
      pageSize: urlState.pageSize,
    });
    serialized = result.items.map((s) => ({
      ...s,
      createdAt: s.createdAt.toISOString(),
    }));
    total = result.total;
    page = result.page;
    pageSize = result.pageSize;
  } catch (err) {
    console.error('[snapshots page] list failed', err);
  }

  // Out-of-range clamp: redirect to the canonical last page. Outside
  // the try so the redirect throw isn't swallowed.
  if (total > 0) {
    const { clamped, totalPages } = clampPage(urlState.page, total, urlState.pageSize);
    if (clamped !== urlState.page && totalPages >= 1) {
      redirect(
        buildListUrl(
          '/domain-vocabularies/snapshots',
          urlState,
          { page: clamped, resetPage: false },
          SNAPSHOTS_URL_OPTS,
        ),
      );
    }
  }

  return (
    <SnapshotsContent
      initialSnapshots={serialized}
      initialTotal={total}
      initialPage={page}
      initialPageSize={pageSize}
      initialQuery={urlState.q ?? ''}
    />
  );
}
