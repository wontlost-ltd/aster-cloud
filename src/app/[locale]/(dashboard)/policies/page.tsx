import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { getTranslations } from 'next-intl/server';
import { getPolicyFreezeStatus } from '@/lib/policy-freeze';
import {
  listPolicyGroupsWithCounts,
  listUserPolicies,
  type PolicyGroupWithCount,
} from '@/lib/policies';
import {
  buildListUrl,
  clampPage,
  parseListUrlState,
  type ListUrlOptions,
} from '@/lib/list-search-params';
import { PoliciesContent } from './policies-content';
import type { PolicyGroup } from '@/components/policy/policy-group-tree';
import { buildGroupTree } from '@/lib/policy-group-hierarchy';

const POLICIES_URL_OPTS: ListUrlOptions = {
  defaultPageSize: 25,
  allowedPageSizes: [25, 50, 100],
  filterKeys: ['group'],
};

type SidebarGroup = PolicyGroupWithCount & { _count: { policies: number } };

/** 组装 PolicyGroupTree 所需的侧栏树（环上的分组落在顶层，见 buildGroupTree）。 */
function toSidebarTree(groups: SidebarGroup[]): PolicyGroup[] {
  return buildGroupTree(groups, (g): PolicyGroup => ({
    id: g.id,
    name: g.name,
    description: g.description,
    icon: g.icon,
    parentId: g.parentId,
    isSystem: g.isSystem,
    sortOrder: g.sortOrder,
    _count: { policies: g._count.policies },
    children: [],
  }));
}

export default async function PoliciesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  const userId = session.user.id;
  const sp = await searchParams;
  const urlState = parseListUrlState(sp, POLICIES_URL_OPTS);

  // Sidebar + freeze status are independent of the policies pagination
  // state — load them in parallel with the page slice so a heavy
  // execution-count query doesn't gate the sidebar render.
  const [groupsRaw, freezeStatus] = await Promise.all([
    listPolicyGroupsWithCounts(userId),
    getPolicyFreezeStatus(userId),
  ]);

  // ★文件夹式导航（2026-07-15）：选中某组时，右侧只显示**直属该组**的策略（不再把子分组
  // 的策略递归带进父视图）——子分组作为可下钻的项显示在右侧顶部（见 policies-content）。
  // 故不再传 descendantIds（listUserPolicies 只按 groupId 精确过滤）。ungrouped 语义不变。
  const groupFilter = urlState.filters.group;

  const { items: pagePolicies, total, page, pageSize } = await listUserPolicies(
    userId,
    {
      page: urlState.page,
      pageSize: urlState.pageSize,
      groupId: groupFilter ?? null,
      descendantIds: [],
      q: urlState.q,
    },
  );

  // Out-of-range clamp: redirect to the last valid page. Outside the
  // listUserPolicies await so redirect's thrown signal isn't caught.
  if (total > 0) {
    const { clamped, totalPages } = clampPage(
      urlState.page,
      total,
      urlState.pageSize,
    );
    if (clamped !== urlState.page && totalPages >= 1) {
      redirect(
        buildListUrl(
          `/${locale}/policies`,
          urlState,
          { page: clamped, resetPage: false },
          POLICIES_URL_OPTS,
        ),
      );
    }
  }

  // Reshape the policies into the shape PoliciesContent currently
  // expects — keeping the wire format stable means we don't have to
  // touch every renderer that reads `_count.executions` and `isFrozen`.
  const policiesForClient = pagePolicies.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    content: p.content,
    isPublic: p.isPublic,
    piiFields: p.piiFields,
    groupId: p.groupId,
    group: p.group,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    isFrozen: freezeStatus.frozenPolicyIds.has(p.id),
    _count: { executions: p.executionCount },
  }));

  const groupsForClient: SidebarGroup[] = groupsRaw.map((g) => ({
    ...g,
    _count: { policies: g.policyCount },
  }));
  const groupTree = toSidebarTree(groupsForClient);

  const freezeInfo = {
    limit: freezeStatus.limit,
    total: freezeStatus.totalPolicies,
    frozenCount: freezeStatus.frozenCount,
  };

  const t = await getTranslations('policies');

  const translations = {
    title: t('title'),
    subtitle: t('subtitle'),
    newPolicy: t('newPolicy'),
    trash: t('trash.title'),
    failedToLoad: t('failedToLoad'),
    failedToDelete: t('failedToDelete'),
    confirmDelete: t('confirmDelete'),
    freeze: {
      title: t('freeze.title'),
      messageTemplate: t.raw('freeze.message'),
      upgradeLink: t('freeze.upgradeLink'),
      badge: t('freeze.badge'),
      cannotExecute: t('freeze.cannotExecute'),
      cannotEdit: t('freeze.cannotEdit'),
    },
    noPolicies: t('noPolicies'),
    getStarted: t('getStarted'),
    piiFieldsTemplate: t.raw('piiFields'),
    public: t('public'),
    executionsTemplate: t.raw('executions'),
    executeAction: t('executeAction'),
    edit: t('edit'),
    delete: t('delete'),
    updatedTemplate: t.raw('updated'),
    groups: {
      allPolicies: t('groups.allPolicies'),
      ungrouped: t('groups.ungrouped'),
      newGroup: t('groups.newGroup'),
      newSubgroup: t('groups.newSubgroup'),
      edit: t('groups.edit'),
      delete: t('groups.delete'),
      policiesCount: t.raw('groups.policiesCount'),
      createTitle: t('groups.createTitle'),
      editTitle: t('groups.editTitle'),
      nameLabel: t('groups.nameLabel'),
      namePlaceholder: t('groups.namePlaceholder'),
      descriptionLabel: t('groups.descriptionLabel'),
      descriptionPlaceholder: t('groups.descriptionPlaceholder'),
      save: t('groups.save'),
      cancel: t('groups.cancel'),
      deleteConfirm: t('groups.deleteConfirm'),
      deleteWarning: t('groups.deleteWarning'),
      saving: t('groups.saving'),
      deleting: t('groups.deleting'),
    },
  };

  return (
    <PoliciesContent
      initialPolicies={policiesForClient}
      initialGroups={groupTree}
      freezeInfo={freezeInfo}
      translations={translations}
      locale={locale}
      pagination={{
        page,
        pageSize,
        total,
        selectedGroupId: groupFilter ?? null,
        query: urlState.q ?? '',
      }}
    />
  );
}
