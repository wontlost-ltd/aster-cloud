/**
 * Service layer for the policies list page.
 *
 * Extracted out of /policies/page.tsx so the route can stay focused on
 * shell concerns (auth, locale, translation strings, JSX) while this
 * module owns the database contract. The split also makes it possible
 * to evolve list semantics (e.g. team-shared policies, future cursor
 * support) without re-touching every page that mentions policies.
 *
 * The default page size matches the URL helper used by the page:
 * pageSize=25, with 25/50/100 as the only allowed values.
 */
import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db, executions, policies, policyGroups, teams } from '@/lib/prisma';
import { escapeLikePattern } from '@/lib/sql-escape';
import {
  authorizePolicyActions,
  isPersonalPolicy,
  ownPoliciesVisibleTo,
  policiesVisibleTo,
  teamsAllowing,
  type PolicyAction,
} from '@/lib/policy-access';
import { getBatchPolicyFreezeStatus } from '@/lib/policy-freeze';

export interface PolicyGroupRef {
  id: string;
  name: string;
  icon: string | null;
  parentId: string | null;
}

/** 列表行所属团队；个人策略为 null。 */
export interface PolicyTeamRef {
  id: string;
  name: string;
}

/** 列表行上的操作按钮所需的授权结果（authorizePolicyActions 判定，页面据此禁用按钮）。 */
export type PolicyRowCapabilities = Record<'execute' | 'update' | 'delete', boolean>;

export interface PolicyListEntry {
  id: string;
  /** 创建者；团队策略的冻结状态按创建者的套餐配额计算 */
  userId: string;
  teamId: string | null;
  team: PolicyTeamRef | null;
  name: string;
  description: string | null;
  content: string;
  isPublic: boolean;
  piiFields: string[] | null;
  groupId: string | null;
  group: PolicyGroupRef | null;
  createdAt: string;
  updatedAt: string;
  executionCount: number;
}

export interface PolicyListResult {
  items: PolicyListEntry[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListPoliciesOptions {
  page?: number;
  pageSize?: number;
  /**
   * Group filter. Accepts a real groupId, the literal "ungrouped" (no
   * group assigned), or undefined / null for "all groups". Descendant
   * resolution (when a parent group is selected we include children)
   * is the caller's job: pass the already-flattened set via descendants.
   */
  groupId?: string | null;
  /**
   * If groupId is set and you want to include the descendant subtree,
   * pre-compute the descendant ids and pass them here. We don't
   * recursively query in this layer to keep the query cost stable.
   */
  descendantIds?: readonly string[];
  /** Free-text search across policy name + description. */
  q?: string;
  /**
   * 归属筛选：undefined = 全部，'personal' = 仅本人个人策略，其余值 = 该团队的团队策略。
   * 只在可见集合内收窄，不授予访问。
   */
  scope?: string | null;
}

/** 归属筛选的「仅个人策略」取值（URL 参数 scope=personal）。 */
export const PERSONAL_SCOPE = 'personal';

/**
 * 「策略」列表的可见集合：本人的个人策略 + 本人当前角色可查看的团队的全部团队策略（含队友创建的）。
 * 与团队页 /api/teams/[teamId]/policies 的可见口径一致（policiesVisibleTo(view)）；离队即不可见。
 */
export function policyListPredicate(userId: string, scope?: string | null): SQL {
  const visible = policiesVisibleTo(userId, 'view');
  if (!scope) return visible;
  return and(visible, scope === PERSONAL_SCOPE ? isPersonalPolicy() : eq(policies.teamId, scope))!;
}

/** 本人当前角色可查看策略的团队（归属筛选的选项），按名称排序。 */
export async function listViewablePolicyTeams(userId: string): Promise<PolicyTeamRef[]> {
  return db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(inArray(teams.id, teamsAllowing(userId, 'view')))
    .orderBy(teams.name);
}

const ROW_ACTIONS = ['execute', 'update', 'delete'] as const satisfies readonly PolicyAction[];

/**
 * 列表行的冻结状态与操作授权。
 * 冻结按**创建者**的套餐配额计算（getBatchPolicyFreezeStatus），与详情 / 编辑 / 执行页的
 * isPolicyFrozen(policy.userId) 同一口径：队友创建的团队策略是否冻结取决于队友的配额，而非查看者。
 */
export async function policyRowMeta(
  userId: string,
  rows: ReadonlyArray<{ id: string; userId: string; teamId: string | null }>,
): Promise<Map<string, { isFrozen: boolean; capabilities: PolicyRowCapabilities }>> {
  const [frozenByOwner, ...decisions] = await Promise.all([
    getBatchPolicyFreezeStatus(rows.map((r) => r.userId)),
    ...ROW_ACTIONS.map((action) => authorizePolicyActions({ userId }, rows, action)),
  ]);
  return new Map(rows.map((row) => {
    const capabilities = Object.fromEntries(
      ROW_ACTIONS.map((action, i) => [action, decisions[i].get(row.id)?.allowed ?? false]),
    ) as PolicyRowCapabilities;
    return [row.id, { isFrozen: frozenByOwner.get(row.userId)?.has(row.id) ?? false, capabilities }];
  }));
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

function normalizePage(page?: number): number {
  return Number.isInteger(page) && page && page > 0 ? page : 1;
}

function normalizePageSize(pageSize?: number): number {
  if (!Number.isInteger(pageSize) || !pageSize || pageSize <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(pageSize, MAX_PAGE_SIZE);
}

/**
 * List one page of the caller's policies. Returns `{ items, total,
 * page, pageSize }` — same shape as the vocabulary list endpoint so
 * the client can plug into the same Pagination primitive without
 * special-casing.
 */
export async function listUserPolicies(
  userId: string,
  opts: ListPoliciesOptions = {},
): Promise<PolicyListResult> {
  const page = normalizePage(opts.page);
  const pageSize = normalizePageSize(opts.pageSize);

  const conditions: SQL[] = [
    policyListPredicate(userId, opts.scope),
    isNull(policies.deletedAt),
  ];

  if (opts.groupId === 'ungrouped') {
    conditions.push(isNull(policies.groupId));
  } else if (opts.groupId) {
    const allIds = opts.descendantIds && opts.descendantIds.length > 0
      ? [opts.groupId, ...opts.descendantIds]
      : [opts.groupId];
    conditions.push(inArray(policies.groupId, allIds));
  }

  const trimmedQ = opts.q?.trim();
  if (trimmedQ) {
    const pattern = `%${escapeLikePattern(trimmedQ)}%`;
    const search = or(
      sql`${policies.name} ILIKE ${pattern}`,
      sql`${policies.description} ILIKE ${pattern}`,
    );
    if (search) conditions.push(search);
  }

  const predicate = and(...conditions);

  const [rows, totals] = await Promise.all([
    db.query.policies.findMany({
      where: predicate,
      orderBy: desc(policies.updatedAt),
      limit: pageSize,
      offset: (page - 1) * pageSize,
      with: {
        group: {
          columns: {
            id: true,
            name: true,
            icon: true,
            parentId: true,
          },
        },
        team: { columns: { id: true, name: true } },
      },
    }),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(policies)
      .where(predicate),
  ]);

  // Execution count is only resolved for the current page slice so we
  // never pay for the full set's executions. Empty page → empty map,
  // skip the DB call entirely.
  const policyIds = rows.map((r) => r.id);
  const execRows = policyIds.length === 0
    ? []
    : await db
        .select({
          policyId: executions.policyId,
          c: sql<number>`count(*)::int`,
        })
        .from(executions)
        .where(inArray(executions.policyId, policyIds))
        .groupBy(executions.policyId);
  const execCountByPolicy = new Map<string, number>(
    execRows.map((r) => [r.policyId, r.c]),
  );

  const items: PolicyListEntry[] = rows.map((policy) => ({
    id: policy.id,
    userId: policy.userId,
    teamId: policy.teamId,
    team: policy.team ?? null,
    name: policy.name,
    description: policy.description,
    content: policy.content,
    isPublic: policy.isPublic,
    piiFields: policy.piiFields as string[] | null,
    groupId: policy.groupId,
    group: policy.group ?? null,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
    executionCount: execCountByPolicy.get(policy.id) ?? 0,
  }));

  return {
    items,
    total: totals[0]?.count ?? 0,
    page,
    pageSize,
  };
}

export interface PolicyGroupWithCount {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  parentId: string | null;
  isSystem: boolean;
  sortOrder: number;
  policyCount: number;
}

/**
 * Sidebar groups + per-group policy counts. This list is unpaginated
 * because the sidebar shows a tree; we want every group visible so the
 * user can navigate independently of the policies pagination state.
 *
 * Group ownership: user-owned groups (userId match) + system groups
 * (curated by Aster). The previous inline query mixed these via OR
 * which is correct; we preserve that here.
 */
export async function listPolicyGroupsWithCounts(
  userId: string,
): Promise<PolicyGroupWithCount[]> {
  const groups = await db.query.policyGroups.findMany({
    where: or(eq(policyGroups.userId, userId), eq(policyGroups.isSystem, true)),
    orderBy: [policyGroups.sortOrder, policyGroups.name],
  });

  const groupIds = groups.map((g) => g.id);
  // Per-group count is scoped to THIS user — a system group's count is
  // the number of *this user's* policies in it, not the global one.
  const countRows = groupIds.length === 0
    ? []
    : await db
        .select({
          groupId: policies.groupId,
          c: sql<number>`count(*)::int`,
        })
        .from(policies)
        .where(
          and(
            ownPoliciesVisibleTo(userId),
            isNull(policies.deletedAt),
            inArray(policies.groupId, groupIds),
          ),
        )
        .groupBy(policies.groupId);
  const countByGroup = new Map<string, number>(
    countRows
      .filter((r): r is { groupId: string; c: number } => r.groupId !== null)
      .map((r) => [r.groupId, r.c]),
  );

  return groups.map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    icon: group.icon,
    parentId: group.parentId,
    isSystem: group.isSystem,
    sortOrder: group.sortOrder,
    policyCount: countByGroup.get(group.id) ?? 0,
  }));
}

/**
 * Walk the flat group list and resolve the descendant ids for a given
 * parent. Used by the page so descendant rows show up when the user
 * selects a parent in the sidebar.
 */
export function collectDescendantIds(
  groups: readonly PolicyGroupWithCount[],
  rootId: string,
): string[] {
  const byParent = new Map<string | null, string[]>();
  for (const g of groups) {
    const arr = byParent.get(g.parentId) ?? [];
    arr.push(g.id);
    byParent.set(g.parentId, arr);
  }
  const out: string[] = [];
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const next = stack.pop()!;
    for (const child of byParent.get(next) ?? []) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}
