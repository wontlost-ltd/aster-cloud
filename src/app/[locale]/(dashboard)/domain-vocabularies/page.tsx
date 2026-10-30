import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import {
  countActiveUserVocabularyTerms,
  listUserVocabularyTerms,
  type TermLink,
} from '@/lib/domain-vocabulary';
import { listBulkJobs } from '@/lib/domain-vocabulary-jobs';
import { getLexiconQuotaWithContext } from '@/lib/usage';
import {
  buildListUrl,
  clampPage,
  parseListUrlState,
  type ListUrlOptions,
} from '@/lib/list-search-params';
import { VocabulariesContent, type SerializableTermLink } from './vocabularies-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('dashboardNav', 'domainVocabularies');

const VOCAB_URL_OPTS: ListUrlOptions = {
  defaultPageSize: 50,
  allowedPageSizes: [25, 50, 100],
  filterKeys: ['domain', 'locale', 'kind'],
};

/**
 * /domain-vocabularies — server shell.
 *
 * Resolves session + plan quota + the requested page of the user's
 * active links and forwards them to the client. Pagination is
 * URL-canonical: the page reads `searchParams` and never holds page
 * state in the client component. Filter/search changes route through
 * the same URL helper so a stale `?page=2` doesn't survive a filter
 * narrowing.
 */
export default async function DomainVocabulariesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const userId = session.user.id;
  const params = await searchParams;
  const urlState = parseListUrlState(params, VOCAB_URL_OPTS);

  // ensureSchemaApplied() in the dashboard layout self-heals the vocab
  // tables on cold start, but treat any service failure as "no vocab"
  // so the page renders the empty/Pro-gate state instead of a 500.
  let ctx: Awaited<ReturnType<typeof getLexiconQuotaWithContext>>;
  try {
    ctx = await getLexiconQuotaWithContext(userId);
  } catch (err) {
    console.error('[domain-vocabularies page] quota lookup failed', err);
    ctx = {
      maxTerms: 0,
      bulkAsync: false,
      allowed: false,
      plan: 'free',
      downgraded: false,
      trialEndsAt: null,
      viaTeam: false,
    };
  }

  let initialTerms: SerializableTermLink[] = [];
  let total = 0;
  let activeCount = 0;
  let initialActiveJobId: string | null = null;
  let initialDeletedTerms: SerializableTermLink[] = [];
  let initialDeletedCount = 0;
  let resolvedPage = urlState.page;

  if (ctx.allowed) {
    try {
      const result = await listUserVocabularyTerms(userId, {
        page: urlState.page,
        pageSize: urlState.pageSize,
        domain: urlState.filters.domain,
        locale: urlState.filters.locale,
        kind: urlState.filters.kind,
        q: urlState.q,
      });
      initialTerms = result.items.map(serialize);
      total = result.total;
      const deleted = await listUserVocabularyTerms(userId, { page: 1, pageSize: 200, deletedOnly: true });
      initialDeletedTerms = deleted.items.map(serialize);
      initialDeletedCount = deleted.total;
      resolvedPage = result.page;
      // 配额卡用不受筛选影响的总数（#616）；无筛选/搜索时与 total 相同，省一次查询。
      const unfiltered =
        !urlState.q && !urlState.filters.domain && !urlState.filters.locale && !urlState.filters.kind;
      activeCount = unfiltered ? total : await countActiveUserVocabularyTerms(userId);
      // 刷新后找回仍在排队/运行的异步导入（#605）。
      const [activeJob] = await listBulkJobs(userId, { activeOnly: true, limit: 1 });
      initialActiveJobId = activeJob?.id ?? null;
    } catch (err) {
      console.error('[domain-vocabularies page] list failed', err);
    }
  }

  // Out-of-range guard: when the URL points past the end of the data
  // (e.g. a stale shared link), redirect to the canonical last page so
  // the user sees rows instead of an empty pager. The redirect call
  // throws, so it MUST live outside any catch block — placing it here,
  // after the try/catch, satisfies that contract.
  if (ctx.allowed && total > 0) {
    const { clamped, totalPages } = clampPage(
      urlState.page,
      total,
      urlState.pageSize,
    );
    if (clamped !== urlState.page && totalPages >= 1) {
      redirect(
        buildListUrl(
          '/domain-vocabularies',
          urlState,
          { page: clamped, resetPage: false },
          VOCAB_URL_OPTS,
        ),
      );
    }
  }

  return (
    <VocabulariesContent
      key={JSON.stringify(initialDeletedTerms)}
      initialTerms={initialTerms}
      initialTotal={total}
      activeCount={activeCount}
      initialActiveJobId={initialActiveJobId}
      initialDeletedTerms={initialDeletedTerms}
      initialDeletedCount={initialDeletedCount}
      initialPage={resolvedPage}
      initialPageSize={urlState.pageSize}
      initialFilters={{
        domain: urlState.filters.domain ?? '',
        locale: urlState.filters.locale ?? '',
        kind: urlState.filters.kind ?? '',
      }}
      initialQuery={urlState.q ?? ''}
      quota={{
        maxTerms: ctx.maxTerms,
        bulkAsync: ctx.bulkAsync,
        allowed: ctx.allowed,
        plan: ctx.plan,
        downgraded: ctx.downgraded,
        trialEndsAt: ctx.trialEndsAt?.toISOString() ?? null,
      }}
    />
  );
}

function serialize(link: TermLink): SerializableTermLink {
  return {
    ...link,
    createdAt: link.createdAt.toISOString(),
    updatedAt: link.updatedAt.toISOString(),
    deletedAt: link.deletedAt?.toISOString() ?? null,
    archivedAt: link.archivedAt?.toISOString() ?? null,
  };
}
