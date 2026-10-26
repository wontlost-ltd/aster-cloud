/**
 * Vocabulary snapshot service (B12)
 *
 * Publish-time freezing: when a PolicyVersion is approved, we snapshot the
 * author's currently-active vocab so future rollbacks can reproduce exactly
 * the term set that was compiled into the executable.
 *
 * Content-hash dedup: identical (ownerType, ownerId, domain, locale, content)
 * tuples collapse to a single snapshot row with bumped refCount. The plan
 * relies on this because most policy updates do not touch vocab — repeated
 * publishes of the same vocab should reuse one row.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  db,
  domainTerms,
  userDomainTerms,
  userVocabularySnapshots,
} from '@/lib/prisma';
import { logAuditEvent } from '@/lib/audit-log';
import { publishVocabularyInvalidate } from '@/lib/domain-vocabulary-events';
import {
  observeLexiconOpDuration,
  recordLexiconOp,
  recordSnapshotCreate,
} from '@/lib/lexicon-metrics';
import {
  assembleDomainVocabularyFromLinks,
  type TermKind,
} from '@/lib/domain-vocabulary-validation';
import type { TermLikeRow } from '@/lib/domain-vocabulary-assemble';
import type { DomainVocabulary } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import {
  policyScopeMatcher,
  mergeVocabularies,
  resolvePolicyVocabularyFromRows,
  selectVocabulariesForPolicy,
  type PolicyVocabularyContext,
} from '@/lib/domain-vocabulary-scope';
import { VocabularyError } from '@/lib/domain-vocabulary';

export interface SnapshotRef {
  snapshotId: string;
  domain: string;
  locale: string;
}

interface OwnerScope {
  ownerType: 'user';
  ownerId: string;
}

interface JoinedTermRow {
  termId: string;
  domain: string;
  locale: string;
  kind: TermKind;
  canonical: string;
  localized: string;
  parentCanonical: string | null;
  aliases: unknown;
  description: string | null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function hashContent(termIds: readonly string[]): string {
  return createHash('sha256').update(canonicalJson([...termIds].sort())).digest('hex');
}

function parseAliases(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function toTermLikeRow(r: JoinedTermRow): TermLikeRow {
  return {
    domainTermId: r.termId,
    domain: r.domain,
    locale: r.locale,
    kind: r.kind,
    canonical: r.canonical,
    localized: r.localized,
    parentCanonical: r.parentCanonical,
    aliases: parseAliases(r.aliases),
    description: r.description,
  };
}

/** drizzle 事务句柄：审批把冻结与审批写入放在同一事务里。 */
export type SnapshotTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function loadActiveLinksGroupedByDomainLocale(
  scope: OwnerScope,
  exec: Pick<SnapshotTx, 'select'> = db,
): Promise<Map<string, JoinedTermRow[]>> {
  const rows = await exec
    .select({
      termId: userDomainTerms.termId,
      domain: userDomainTerms.domain,
      locale: userDomainTerms.locale,
      kind: userDomainTerms.kind,
      canonical: domainTerms.canonical,
      localized: domainTerms.localized,
      parentCanonical: domainTerms.parentCanonical,
      aliases: domainTerms.aliases,
      description: domainTerms.description,
    })
    .from(userDomainTerms)
    .innerJoin(domainTerms, eq(userDomainTerms.termId, domainTerms.id))
    .where(
      and(
        eq(userDomainTerms.userId, scope.ownerId),
        isNull(userDomainTerms.deletedAt),
        isNull(userDomainTerms.archivedAt),
      ),
    )
    .orderBy(asc(userDomainTerms.termId));

  const groups = new Map<string, JoinedTermRow[]>();
  for (const r of rows) {
    const key = `${r.domain}|${r.locale}`;
    const existing = groups.get(key);
    if (existing) existing.push(r as unknown as JoinedTermRow);
    else groups.set(key, [r as unknown as JoinedTermRow]);
  }
  return groups;
}

/**
 * Compute the next snapshot version for (ownerType, ownerId, domain, locale).
 *
 * Important: the query MUST run on the same connection as the surrounding
 * transaction so the advisory lock (pg_advisory_xact_lock) actually
 * serializes concurrent callers. Reading via the outer `db` proxy reaches
 * a different pooled connection and lets two concurrent transactions both
 * compute `version=N`, which then collide on the unique index.
 */
/**
 * The "tx" handle here has a different concrete type than `db` (it's a
 * `PgTransaction` from Drizzle, not a `PostgresJsDatabase`), but both
 * expose the same builder surface we need: `.select(...).from(...).where(...)`.
 * Using a structural subset keeps the helper transaction-aware without
 * importing the full Drizzle internal types.
 */
type SnapshotVersionReader = {
  select: typeof db.select;
};

async function nextSnapshotVersion(
  exec: SnapshotVersionReader,
  scope: OwnerScope,
  domain: string,
  locale: string,
): Promise<number> {
  const rows = await exec
    .select({ max: sql<number | null>`max(${userVocabularySnapshots.version})` })
    .from(userVocabularySnapshots)
    .where(
      and(
        eq(userVocabularySnapshots.ownerType, scope.ownerType),
        eq(userVocabularySnapshots.ownerId, scope.ownerId),
        eq(userVocabularySnapshots.domain, domain),
        eq(userVocabularySnapshots.locale, locale),
      ),
    );
  return (rows[0]?.max ?? 0) + 1;
}

/**
 * Freeze the caller's current active vocabulary into one snapshot per
 * (domain, locale) **that the policy actually uses** (see
 * domain-vocabulary-scope: same CNL language + referenced by the source).
 * Returns the snapshot refs that should be persisted on the PolicyVersion row.
 *
 * 所有读写都在调用方传入的事务 `tx` 上执行：审批把冻结（含 refCount 递增）与审批记录、
 * 状态更新放进同一事务，任何后续失败都会一并回滚，不留下多计的 refCount。
 *
 * Returns an empty array when the policy uses none of the user's vocab —
 * unrelated domains are never frozen into (or ref-counted by) the version.
 */
export async function createSnapshotsForOwner(
  scope: OwnerScope,
  policy: PolicyVocabularyContext,
  tx: SnapshotTx,
): Promise<SnapshotRef[]> {
  const groups = await loadActiveLinksGroupedByDomainLocale(scope, tx);
  const inScope = policyScopeMatcher(policy);
  const refs: SnapshotRef[] = [];

  for (const [key, rows] of groups) {
    const [domain, locale] = key.split('|') as [string, string];
    const vocabJson = assembleDomainVocabularyFromLinks(rows.map(toTermLikeRow), { domain, locale });
    if (!inScope(vocabJson)) continue;
    const ref = await upsertSnapshot(tx, scope, { domain, locale, vocabJson, termIds: rows.map((r) => r.termId) });
    refs.push({ snapshotId: ref.snapshotId, domain, locale });
    recordSnapshotCreate({ dedupHit: ref.dedupHit });
    recordLexiconOp('snapshot.create', 'success');
  }

  return refs;
}

/**
 * 按内容哈希去重写入一个 (domain, locale) 快照：已存在则 refCount + 1，否则插入新版本。
 * Per-(owner, domain, locale) advisory lock serializes concurrent approvals so two
 * callers can't both observe `version = N` and unique-violate; the unique index on
 * (ownerType, ownerId, domain, locale, contentHash) still gives us dedup.
 */
async function upsertSnapshot(
  tx: SnapshotTx,
  scope: OwnerScope,
  group: { domain: string; locale: string; vocabJson: DomainVocabulary; termIds: string[] },
): Promise<{ snapshotId: string; dedupHit: boolean }> {
  const { domain, locale, vocabJson, termIds } = group;
  const contentHash = hashContent(termIds);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`vocab-snap:${scope.ownerId}:${domain}:${locale}`}))`,
  );
  const existing = await tx.query.userVocabularySnapshots.findFirst({
    where: and(
      eq(userVocabularySnapshots.ownerType, scope.ownerType),
      eq(userVocabularySnapshots.ownerId, scope.ownerId),
      eq(userVocabularySnapshots.domain, domain),
      eq(userVocabularySnapshots.locale, locale),
      eq(userVocabularySnapshots.contentHash, contentHash),
    ),
    columns: { id: true },
  });
  if (existing) {
    await tx
      .update(userVocabularySnapshots)
      .set({ refCount: sql`${userVocabularySnapshots.refCount} + 1` })
      .where(eq(userVocabularySnapshots.id, existing.id));
    return { snapshotId: existing.id, dedupHit: true };
  }
  // Lock is held + tx is passed so the version read shares the txn.
  const version = await nextSnapshotVersion(tx, scope, domain, locale);
  const id = crypto.randomUUID();
  await tx.insert(userVocabularySnapshots).values({
    id,
    ownerType: scope.ownerType,
    ownerId: scope.ownerId,
    domain,
    locale,
    version,
    vocabularyJson: vocabJson,
    termIds,
    contentHash,
    refCount: 1,
  });
  return { snapshotId: id, dedupHit: false };
}

/**
 * 按 policyVersions.vocabularySnapshotIds 加载冻结的领域词汇，得到执行端需要的
 * 单个 DomainVocabulary（ADR 0014 线C）。
 *
 * <p>只取策略作用域内的快照（与 CNL 语言相同且被源码引用，见 domain-vocabulary-scope）：
 * 修复前审批的版本冻结了账号下所有分组（#610），这里按源码再筛一次，使旧版本执行
 * 也不会被无关领域的同名词串扰；作用域内的快照合并为一个词汇表，locale 对齐策略语言。
 *
 * @param refs policyVersions.vocabularySnapshotIds（{snapshotId,domain,locale}[]）
 * @param policy 被执行版本的源码与 CNL 语言
 * @returns 合并后的词汇表；无引用、加载不到或都不在作用域内时返回 null（执行端仅用内置词汇）
 */
export async function loadVocabularyForExecution(
  refs: ReadonlyArray<SnapshotRef> | null | undefined,
  policy: PolicyVocabularyContext,
): Promise<DomainVocabulary | null> {
  if (!Array.isArray(refs) || refs.length === 0) return null;

  const snapshotIds = refs.map((r) => r.snapshotId);
  const rows = await db.query.userVocabularySnapshots.findMany({
    where: inArray(userVocabularySnapshots.id, snapshotIds),
    columns: { vocabularyJson: true },
  });
  const vocabs = rows
    .map((r) => r.vocabularyJson as DomainVocabulary | null)
    .filter((v): v is DomainVocabulary => v != null);
  return mergeVocabularies(selectVocabulariesForPolicy(vocabs, policy), {
    locale: policy.locale,
  });
}

/**
 * 执行路径用的 best-effort 包装：加载失败不阻断执行（退化为仅内置词汇），
 * 返回值可直接作为 evaluateSource 的 vocabulary 选项。
 */
export async function loadExecutionVocabulary(
  refs: unknown,
  policy: PolicyVocabularyContext,
): Promise<Record<string, unknown> | undefined> {
  try {
    const vocab = await loadVocabularyForExecution(refs as SnapshotRef[] | null, policy);
    return vocab ? (vocab as unknown as Record<string, unknown>) : undefined;
  } catch (err) {
    console.warn('[vocabulary] failed to load frozen vocabulary for execution', err);
    return undefined;
  }
}

/**
 * 用户当前活跃词汇中该策略作用域内的部分（未冻结，供保存时编译门禁使用）。
 * 与编辑器注册的词汇同源同规则，保证「编辑器无错 ⇔ 服务端编译通过」。
 */
export async function loadLiveVocabularyForPolicy(
  ownerId: string,
  policy: PolicyVocabularyContext,
): Promise<DomainVocabulary | null> {
  const groups = await loadActiveLinksGroupedByDomainLocale({ ownerType: 'user', ownerId });
  const rows = [...groups.values()].flat().map(toTermLikeRow);
  return resolvePolicyVocabularyFromRows(rows, policy);
}

/**
 * 审批时冻结被审批版本作用域内的作者词汇（#610），返回应写入
 * PolicyVersion.vocabularySnapshotIds 的引用。必须在审批事务 `tx` 内调用，引用由调用方
 * 与状态变更在同一事务中落库；失败直接抛出（事务整体回滚）。作用域为空时不写任何快照。
 */
export async function freezeVocabularyForApproval(
  params: {
    policyAuthorId: string;
    /** 被审批版本的源码与 CNL 语言。 */
    policy: PolicyVocabularyContext;
  },
  tx: SnapshotTx,
): Promise<SnapshotRef[]> {
  return createSnapshotsForOwner(
    { ownerType: 'user', ownerId: params.policyAuthorId },
    params.policy,
    tx,
  );
}

/** 审批事务提交后记录冻结审计（事务回滚时不应留下「已冻结」的审计）。 */
export async function auditVocabularyFreeze(params: {
  policyAuthorId: string;
  policyVersionId: string;
  refs: readonly SnapshotRef[];
}): Promise<void> {
  if (params.refs.length === 0) return;
  await logAuditEvent({
    userId: params.policyAuthorId,
    action: 'lexicon.term.add',
    resource: 'vocabulary-snapshot',
    resourceId: params.policyVersionId,
    metadata: { action: 'created_on_publish', snapshotCount: params.refs.length },
  });
}

export interface RollbackResult {
  added: number;
  removed: number;
  unchanged: number;
  /** Scope the rollback applied to. Surfaced for SSE invalidate fanout. */
  domain: string;
  locale: string;
}

/**
 * Apply a snapshot's term set as the user's active vocabulary. Active links
 * whose termId is not in the snapshot are soft-deleted; missing termIds are
 * reactivated (if a soft-deleted row exists) or freshly inserted.
 *
 * Returns the diff counts so the route can include them in the response.
 */
export async function rollbackToSnapshot(
  userId: string,
  snapshotId: string,
): Promise<RollbackResult> {
  const startedAt = Date.now();
  try {
    const result = await rollbackToSnapshotInner(userId, snapshotId);
    recordLexiconOp('snapshot.rollback', 'success');
    observeLexiconOpDuration('snapshot.rollback', (Date.now() - startedAt) / 1000);
    publishVocabularyInvalidate({
      ownerType: 'user',
      ownerId: userId,
      domain: result.domain,
      locale: result.locale,
      cause: 'rollback',
    });
    return result;
  } catch (err) {
    recordLexiconOp('snapshot.rollback', 'error');
    observeLexiconOpDuration('snapshot.rollback', (Date.now() - startedAt) / 1000);
    throw err;
  }
}

async function rollbackToSnapshotInner(
  userId: string,
  snapshotId: string,
): Promise<RollbackResult> {
  const snap = await db.query.userVocabularySnapshots.findFirst({
    where: and(
      eq(userVocabularySnapshots.id, snapshotId),
      eq(userVocabularySnapshots.ownerType, 'user'),
      eq(userVocabularySnapshots.ownerId, userId),
    ),
  });
  if (!snap) {
    throw new VocabularyError('not_found', 'Snapshot not found');
  }
  if (snap.archivedAt) {
    throw new VocabularyError('snapshot_archived', 'Snapshot has been archived');
  }
  const desiredIds = new Set<string>(snap.termIds ?? []);

  // Critical: rollback is scoped to the snapshot's (domain, locale). Other
  // domains/locales the user owns must be left untouched, otherwise a
  // single-vocab rollback would wipe out unrelated work.
  const snapDomain = snap.domain;
  const snapLocale = snap.locale;

  const result = await db.transaction(async (tx) => {
    const currentActive = await tx
      .select({ id: userDomainTerms.id, termId: userDomainTerms.termId })
      .from(userDomainTerms)
      .where(
        and(
          eq(userDomainTerms.userId, userId),
          eq(userDomainTerms.domain, snapDomain),
          eq(userDomainTerms.locale, snapLocale),
          isNull(userDomainTerms.deletedAt),
          isNull(userDomainTerms.archivedAt),
        ),
      );
    const currentIds = new Set<string>(currentActive.map((r) => r.termId));

    let removed = 0;
    const now = new Date();
    for (const row of currentActive) {
      if (!desiredIds.has(row.termId)) {
        await tx
          .update(userDomainTerms)
          .set({
            deletedAt: now,
            deletedBy: userId,
            deletedReason: 'rollback',
            updatedAt: now,
          })
          .where(eq(userDomainTerms.id, row.id));
        removed += 1;
      }
    }

    let added = 0;
    const unchanged = currentActive.filter((r) => desiredIds.has(r.termId)).length;
    for (const termId of desiredIds) {
      if (currentIds.has(termId)) continue;
      // Prefer reactivating an existing soft-deleted row for this scope to
      // preserve the historical linkId. Insert a fresh row if no row exists.
      const dormant = await tx.query.userDomainTerms.findFirst({
        where: and(
          eq(userDomainTerms.userId, userId),
          eq(userDomainTerms.termId, termId),
          eq(userDomainTerms.domain, snapDomain),
          eq(userDomainTerms.locale, snapLocale),
        ),
        columns: { id: true },
      });
      if (dormant) {
        await tx
          .update(userDomainTerms)
          .set({
            deletedAt: null,
            deletedBy: null,
            deletedReason: null,
            updatedAt: now,
          })
          .where(eq(userDomainTerms.id, dormant.id));
        added += 1;
        continue;
      }
      const term = await tx.query.domainTerms.findFirst({
        where: eq(domainTerms.id, termId),
        columns: { domain: true, locale: true, kind: true },
      });
      if (!term) {
        // Snapshot references a deleted/archived global row; skip to avoid
        // a 500. This is recoverable because snapshots never hard-delete
        // referenced rows in normal operation.
        continue;
      }
      // Defensive: only reactivate rows that match the snapshot's scope.
      // Cross-scope termIds should not happen for a single-domain snapshot,
      // but skipping keeps rollback strictly scoped if it ever does.
      if (term.domain !== snapDomain || term.locale !== snapLocale) {
        continue;
      }
      await tx.insert(userDomainTerms).values({
        id: crypto.randomUUID(),
        userId,
        termId,
        ownerType: 'user',
        domain: term.domain,
        locale: term.locale,
        kind: term.kind,
      });
      added += 1;
    }

    return { added, removed, unchanged, domain: snapDomain, locale: snapLocale };
  });

  await logAuditEvent({
    userId,
    action: 'lexicon.term.restore',
    resource: 'vocabulary-snapshot',
    resourceId: snapshotId,
    metadata: {
      action: 'rollback',
      added: result.added,
      removed: result.removed,
      unchanged: result.unchanged,
      domain: result.domain,
      locale: result.locale,
    },
  });

  return result;
}

export interface SnapshotListEntry {
  id: string;
  domain: string;
  locale: string;
  version: number;
  contentHash: string;
  refCount: number;
  termCount: number;
  archived: boolean;
  createdAt: Date;
}

export interface SnapshotListResult {
  items: SnapshotListEntry[];
  total: number;
  page: number;
  pageSize: number;
}

const SNAPSHOT_DEFAULT_PAGE_SIZE = 25;
const SNAPSHOT_MAX_PAGE_SIZE = 200;

function normalizeSnapshotPage(page?: number): number {
  return Number.isInteger(page) && page && page > 0 ? page : 1;
}

function normalizeSnapshotPageSize(pageSize?: number): number {
  if (!Number.isInteger(pageSize) || !pageSize || pageSize <= 0) {
    return SNAPSHOT_DEFAULT_PAGE_SIZE;
  }
  return Math.min(pageSize, SNAPSHOT_MAX_PAGE_SIZE);
}

/**
 * Read snapshots owned by the user. Filtered by domain/locale when given.
 * Returns UI-friendly fields: termCount derived from termIds.length so the
 * snapshot list page can render without a second roundtrip.
 *
 * Sort order is descending createdAt: newest first matches what users want
 * to see when scanning a paginated list (latest publish + rollback
 * candidate sit at the top of page 1).
 */
export async function listOwnerSnapshots(
  userId: string,
  opts: {
    domain?: string;
    locale?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<SnapshotListResult> {
  const page = normalizeSnapshotPage(opts.page);
  const pageSize = normalizeSnapshotPageSize(opts.pageSize);
  const conditions = [
    eq(userVocabularySnapshots.ownerType, 'user'),
    eq(userVocabularySnapshots.ownerId, userId),
  ];
  if (opts.domain) conditions.push(eq(userVocabularySnapshots.domain, opts.domain));
  if (opts.locale) conditions.push(eq(userVocabularySnapshots.locale, opts.locale));

  const predicate = and(...conditions);

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: userVocabularySnapshots.id,
        domain: userVocabularySnapshots.domain,
        locale: userVocabularySnapshots.locale,
        version: userVocabularySnapshots.version,
        contentHash: userVocabularySnapshots.contentHash,
        refCount: userVocabularySnapshots.refCount,
        termIds: userVocabularySnapshots.termIds,
        archivedAt: userVocabularySnapshots.archivedAt,
        createdAt: userVocabularySnapshots.createdAt,
      })
      .from(userVocabularySnapshots)
      .where(predicate)
      .orderBy(desc(userVocabularySnapshots.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(userVocabularySnapshots)
      .where(predicate),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      domain: row.domain,
      locale: row.locale,
      version: row.version,
      contentHash: row.contentHash,
      refCount: row.refCount,
      termCount: Array.isArray(row.termIds) ? row.termIds.length : 0,
      archived: row.archivedAt != null,
      createdAt: row.createdAt,
    })),
    total: totals[0]?.count ?? 0,
    page,
    pageSize,
  };
}

export interface SnapshotTermEntry {
  termId: string;
  kind: string;
  canonical: string;
  localized: string;
  parentCanonical: string | null;
  aliases: string[];
  description: string | null;
}

export interface SnapshotDiff {
  snapshot: SnapshotListEntry;
  /** Terms in the snapshot, resolved with their current global content. */
  terms: SnapshotTermEntry[];
  /** Resolved content for the terms that would be removed on rollback. */
  removedTerms: SnapshotTermEntry[];
  /** Term ids active for the caller in the snapshot's (domain, locale). */
  currentTermIds: string[];
  /** Term ids present in the snapshot but not in the caller's active set. */
  addedIds: string[];
  /** Term ids present in the caller's active set but not in the snapshot. */
  removedIds: string[];
  /** Term ids present in both. */
  unchangedIds: string[];
}

/**
 * Resolve a snapshot's content for the diff viewer (F7).
 *
 * Returns the snapshot's terms with their current global presentation +
 * three set-comparison buckets against the caller's active set so the UI
 * can render a "rollback would add X, remove Y" preview.
 */
export async function getSnapshotDiff(
  userId: string,
  snapshotId: string,
): Promise<SnapshotDiff> {
  const snap = await db.query.userVocabularySnapshots.findFirst({
    where: and(
      eq(userVocabularySnapshots.id, snapshotId),
      eq(userVocabularySnapshots.ownerType, 'user'),
      eq(userVocabularySnapshots.ownerId, userId),
    ),
  });
  if (!snap) {
    throw new VocabularyError('not_found', 'Snapshot not found');
  }

  const snapshotTermIds = Array.isArray(snap.termIds) ? (snap.termIds as string[]) : [];
  const termRows = snapshotTermIds.length === 0
    ? []
    : await db
        .select({
          id: domainTerms.id,
          kind: domainTerms.kind,
          canonical: domainTerms.canonical,
          localized: domainTerms.localized,
          parentCanonical: domainTerms.parentCanonical,
          aliases: domainTerms.aliases,
          description: domainTerms.description,
        })
        .from(domainTerms)
        .where(inArray(domainTerms.id, snapshotTermIds));
  const termById = new Map(termRows.map((r) => [r.id, r]));

  const terms: SnapshotTermEntry[] = snapshotTermIds.flatMap((id) => {
    const row = termById.get(id);
    if (!row) return [];
    return [
      {
        termId: id,
        kind: row.kind,
        canonical: row.canonical,
        localized: row.localized,
        parentCanonical: row.parentCanonical,
        aliases: parseAliases(row.aliases),
        description: row.description,
      },
    ];
  });

  const activeRows = await db
    .select({ termId: userDomainTerms.termId })
    .from(userDomainTerms)
    .where(
      and(
        eq(userDomainTerms.userId, userId),
        eq(userDomainTerms.domain, snap.domain),
        eq(userDomainTerms.locale, snap.locale),
        isNull(userDomainTerms.deletedAt),
        isNull(userDomainTerms.archivedAt),
      ),
    );
  const currentSet = new Set<string>(activeRows.map((r) => r.termId));
  const snapshotSet = new Set<string>(snapshotTermIds);
  const addedIds = snapshotTermIds.filter((id) => !currentSet.has(id));
  const removedIds = activeRows.map((r) => r.termId).filter((id) => !snapshotSet.has(id));
  const unchangedIds = snapshotTermIds.filter((id) => currentSet.has(id));

  // 解析 removedIds 对应的词条内容,这样前端 diff 视图的 "Removed" 桶可以
  // 展示用户在回滚后将丢失的具体词条,而不是只显示一个数量。回滚是破坏性
  // 操作,缺少这一步会让用户在按下 Rollback 之前看不见后果。
  const removedRows = removedIds.length === 0
    ? []
    : await db
        .select({
          id: domainTerms.id,
          kind: domainTerms.kind,
          canonical: domainTerms.canonical,
          localized: domainTerms.localized,
          parentCanonical: domainTerms.parentCanonical,
          aliases: domainTerms.aliases,
          description: domainTerms.description,
        })
        .from(domainTerms)
        .where(inArray(domainTerms.id, removedIds));
  const removedTerms: SnapshotTermEntry[] = removedRows.map((r) => ({
    termId: r.id,
    kind: r.kind,
    canonical: r.canonical,
    localized: r.localized,
    parentCanonical: r.parentCanonical,
    aliases: parseAliases(r.aliases),
    description: r.description,
  }));

  return {
    snapshot: {
      id: snap.id,
      domain: snap.domain,
      locale: snap.locale,
      version: snap.version,
      contentHash: snap.contentHash,
      refCount: snap.refCount,
      termCount: snapshotTermIds.length,
      archived: snap.archivedAt != null,
      createdAt: snap.createdAt,
    },
    terms,
    removedTerms,
    currentTermIds: activeRows.map((r) => r.termId),
    addedIds,
    removedIds,
    unchangedIds,
  };
}
