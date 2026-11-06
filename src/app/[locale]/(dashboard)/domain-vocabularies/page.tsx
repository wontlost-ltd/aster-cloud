import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import {
  countActiveUserVocabularyTerms,
  listUserVocabularyTerms,
  userOwner,
  type TermLink,
  type VocabularyOwner,
} from '@/lib/domain-vocabulary';
import {
  listVocabularyTeams,
  teamVocabularyAbilities,
  type VocabularyTeamOption,
} from '@/lib/domain-vocabulary-team';
import { db, teams as teamsTable } from '@/lib/prisma';
import { eq } from 'drizzle-orm';
import { listBulkJobs } from '@/lib/domain-vocabulary-jobs';
import { getLexiconQuotaWithContext } from '@/lib/usage';
import {
  buildListUrl,
  clampPage,
  parseListUrlState,
  type ListUrlOptions,
} from '@/lib/list-search-params';
import {
  VocabulariesContent,
  type SerializableTermLink,
  type VocabularyScope,
} from './vocabularies-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('dashboardNav', 'domainVocabularies');

const VOCAB_URL_OPTS: ListUrlOptions = {
  defaultPageSize: 50,
  allowedPageSizes: [25, 50, 100],
  // teamId 与筛选一起往返 URL：切换团队即切换词汇归属（ADR 0017），且翻页 / 筛选时不丢。
  filterKeys: ['domain', 'locale', 'kind', 'teamId'],
};

const FREE_QUOTA_CONTEXT: Awaited<ReturnType<typeof getLexiconQuotaWithContext>> = {
  maxTerms: 0,
  bulkAsync: false,
  allowed: false,
  plan: 'free',
  downgraded: false,
  trialEndsAt: null,
};

/**
 * 解析页面的词汇归属：无 teamId 为个人；teamId 须是调用者当前所在团队，否则回退到个人
 * （团队外 / 已离队用户看不到团队词汇，与 API 的 403 同一口径）。
 */
function resolveScope(
  userId: string,
  teamId: string | undefined,
  myTeams: readonly VocabularyTeamOption[],
): { owner: VocabularyOwner; scope: VocabularyScope } {
  const team = teamId ? myTeams.find((option) => option.id === teamId) : undefined;
  if (!team) {
    return { owner: userOwner(userId), scope: { teamId: null, teams: [...myTeams], currentUserId: userId, canCreate: true, canManage: true } };
  }
  return {
    owner: { type: 'team', teamId: team.id },
    scope: { teamId: team.id, teams: [...myTeams], currentUserId: userId, ...teamVocabularyAbilities(team.role) },
  };
}

/**
 * /domain-vocabularies — server shell.
 *
 * Resolves session + plan quota + the requested page of the user's
 * active links and forwards them to the client. `?teamId=` switches to the
 * team-shared vocabulary (ADR 0017): quota then follows the team owner's plan. Pagination is
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

  let myTeams: VocabularyTeamOption[] = [];
  try {
    myTeams = await listVocabularyTeams(userId);
  } catch (err) {
    console.error('[domain-vocabularies page] team lookup failed', err);
  }
  const { owner, scope } = resolveScope(userId, urlState.filters.teamId, myTeams);

  // ensureSchemaApplied() in the dashboard layout self-heals the vocab
  // tables on cold start, but treat any service failure as "no vocab"
  // so the page renders the empty/Pro-gate state instead of a 500.
  let ctx: Awaited<ReturnType<typeof getLexiconQuotaWithContext>>;
  try {
    // 团队词汇的额度看团队 owner 的套餐（ADR 0017 §3）。
    const holder = owner.type === 'team'
      ? (await db.query.teams.findFirst({ where: eq(teamsTable.id, owner.teamId), columns: { ownerId: true } }))?.ownerId
      : userId;
    ctx = holder ? await getLexiconQuotaWithContext(holder) : FREE_QUOTA_CONTEXT;
  } catch (err) {
    console.error('[domain-vocabularies page] quota lookup failed', err);
    ctx = FREE_QUOTA_CONTEXT;
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
      }, owner);
      initialTerms = result.items.map(serialize);
      total = result.total;
      const deleted = await listUserVocabularyTerms(userId, { page: 1, pageSize: 200, deletedOnly: true }, owner);
      initialDeletedTerms = deleted.items.map(serialize);
      initialDeletedCount = deleted.total;
      resolvedPage = result.page;
      // 配额卡用不受筛选影响的总数（#616）；无筛选/搜索时与 total 相同，省一次查询。
      const unfiltered =
        !urlState.q && !urlState.filters.domain && !urlState.filters.locale && !urlState.filters.kind;
      activeCount = unfiltered ? total : await countActiveUserVocabularyTerms(userId, owner);
      // 刷新后找回仍在排队/运行的异步导入（#605）。批量导入只作用于个人词汇。
      if (owner.type === 'user') {
        const [activeJob] = await listBulkJobs(userId, { activeOnly: true, limit: 1 });
        initialActiveJobId = activeJob?.id ?? null;
      }
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
        teamId: scope.teamId ?? '',
      }}
      scope={scope}
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
