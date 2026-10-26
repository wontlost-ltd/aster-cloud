/**
 * Domain vocabulary service core
 *
 * 提供 user_domain_term 链接表的 CRUD + 软删/恢复 + 预览/重指语义。
 * 全局 DomainTerm 行永不被用户编辑改写——修改 link 永远走"加新行或复用全局"的路径，
 * 与 plan 中的 dedup-by-key 设计保持一致。
 *
 * 调用方一般是 route handler；本层抛 VocabularyError，由 route 转换为 errorEnvelope。
 */

import { createHash as nodeCreateHash } from 'node:crypto';
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  db,
  domainTerms,
  lexiconBulkJobs,
  userDomainTerms,
  type DomainTerm,
} from '@/lib/prisma';
import { escapeLikePattern } from '@/lib/sql-escape';
import { logAuditEvent } from '@/lib/audit-log';
import {
  observeBulkJobDuration,
  observeLexiconOpDuration,
  recordBulkJobRowsProcessed,
  recordLexiconOp,
} from '@/lib/lexicon-metrics';
import { getLexiconQuota } from '@/lib/usage';
import {
  applyVocabularyScopeFormat,
  assembleDomainVocabularyFromLinks,
  computeDedupKey,
  normalizeTermInput,
  validateDomainVocabulary,
  type NormalizedTermInput,
  type TermKind,
} from '@/lib/domain-vocabulary-validation';
import { isUniqueViolation } from '@/lib/pg-errors';

function createHashSync(value: string): string {
  return nodeCreateHash('sha256').update(value).digest('hex');
}


function truncateForAudit(value: string | null | undefined, max = 256): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Wrap a service call with Prometheus op counter + duration histogram.
 * Errors are surfaced unchanged so the caller's existing error handling is
 * preserved; we only tag the op outcome.
 *
 * 编辑器侧的失效感知不再靠进程内推送（#608），而是轮询
 * {@link getUserVocabularyVersion}，所以这里不需要任何发布动作。
 */
async function withOpMetrics<T>(
  op: import('@/lib/lexicon-metrics').LexiconOp,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    recordLexiconOp(op, 'success');
    observeLexiconOpDuration(op, (Date.now() - startedAt) / 1000);
    return result;
  } catch (err) {
    recordLexiconOp(op, 'error');
    observeLexiconOpDuration(op, (Date.now() - startedAt) / 1000);
    throw err;
  }
}

export interface TermInput {
  domain: string;
  locale: string;
  kind: TermKind;
  canonical: string;
  localized: string;
  parentCanonical?: string;
  description?: string;
  aliases?: string[];
}

export interface TermLink {
  id: string;
  termId: string;
  userId: string;
  domain: string;
  locale: string;
  kind: string;
  canonical: string;
  localized: string;
  parentCanonical: string | null;
  aliases: string[];
  description: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
  archivedAt?: Date | null;
}

export interface ListResult {
  items: TermLink[];
  total: number;
  page: number;
  pageSize: number;
  /** Count of links that have been archived under the 90-day retention policy. */
  archivedCount: number;
}

export interface ListOptions {
  domain?: string;
  locale?: string;
  kind?: string;
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  page?: number;
  pageSize?: number;
  /**
   * Free-text search across canonical, localized, and parentCanonical.
   * Matched case-insensitively as an ILIKE %q% pattern. Empty/whitespace
   * strings are ignored.
   */
  q?: string;
}

export class VocabularyError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'VocabularyError';
  }
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function activeLinkPredicate(): SQL {
  const predicate = and(
    isNull(userDomainTerms.deletedAt),
    isNull(userDomainTerms.archivedAt),
  );
  if (!predicate) {
    // Should be unreachable: both isNull(...) calls always yield a SQL expression.
    throw new VocabularyError('internal_error', 'Failed to build active link predicate');
  }
  return predicate;
}

function normalizePage(page?: number): number {
  return Number.isInteger(page) && page && page > 0 ? page : 1;
}

function normalizePageSize(pageSize?: number): number {
  if (!Number.isInteger(pageSize) || !pageSize || pageSize <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(pageSize, MAX_PAGE_SIZE);
}

function parseAliases(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

interface JoinedTermRow {
  id: string;
  termId: string;
  userId: string;
  domain: string;
  locale: string;
  kind: string;
  canonical: string;
  localized: string;
  parentCanonical: string | null;
  aliases: unknown;
  description: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  archivedAt: Date | null;
}

function mapJoinedRow(row: JoinedTermRow): TermLink {
  return {
    id: row.id,
    termId: row.termId,
    userId: row.userId,
    domain: row.domain,
    locale: row.locale,
    kind: row.kind,
    canonical: row.canonical,
    localized: row.localized,
    parentCanonical: row.parentCanonical,
    aliases: parseAliases(row.aliases),
    description: row.description,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    archivedAt: row.archivedAt,
  };
}

function selectTermLinkFields() {
  return {
    id: userDomainTerms.id,
    termId: userDomainTerms.termId,
    userId: userDomainTerms.userId,
    domain: userDomainTerms.domain,
    locale: userDomainTerms.locale,
    kind: userDomainTerms.kind,
    canonical: domainTerms.canonical,
    localized: domainTerms.localized,
    parentCanonical: domainTerms.parentCanonical,
    aliases: domainTerms.aliases,
    description: domainTerms.description,
    source: domainTerms.source,
    createdAt: userDomainTerms.createdAt,
    updatedAt: userDomainTerms.updatedAt,
    deletedAt: userDomainTerms.deletedAt,
    archivedAt: userDomainTerms.archivedAt,
  };
}

async function getTermLink(
  userId: string,
  linkId: string,
  options: { includeDeleted?: boolean } = {},
): Promise<TermLink | null> {
  const conditions: SQL[] = [
    eq(userDomainTerms.userId, userId),
    eq(userDomainTerms.id, linkId),
  ];
  if (!options.includeDeleted) {
    conditions.push(activeLinkPredicate());
  }

  const rows = await db
    .select(selectTermLinkFields())
    .from(userDomainTerms)
    .innerJoin(domainTerms, eq(userDomainTerms.termId, domainTerms.id))
    .where(and(...conditions))
    .limit(1);

  return rows[0] ? mapJoinedRow(rows[0] as JoinedTermRow) : null;
}

function validateInput(input: TermInput): NormalizedTermInput {
  const normalized = normalizeTermInput(input);
  if (!normalized.canonical) {
    throw new VocabularyError('validation_failed', 'canonical is required');
  }
  if (!normalized.localized) {
    throw new VocabularyError('validation_failed', 'localized is required');
  }
  if (!normalized.domain || !normalized.locale) {
    throw new VocabularyError('validation_failed', 'domain and locale are required');
  }
  const formatted = applyVocabularyScopeFormat(normalized);
  if (!formatted.ok) {
    throw new VocabularyError('validation_failed', formatted.message);
  }
  return validateNormalized(formatted.value);
}

function validateNormalized(normalized: NormalizedTermInput): NormalizedTermInput {
  // 字段必须挂在父结构体下,否则后续的 lexicon 索引会出现孤立 field。
  // 上游 validateVocabulary 只把缺 parent 当成 warning,所以在 service
  // 层强制拒绝,保证 REST API、bulk 路径、未来 SDK 调用都遵守同一契约。
  if (normalized.kind === 'field' && !normalized.parentCanonical) {
    throw new VocabularyError(
      'validation_failed',
      'parentCanonical is required for kind=field',
    );
  }

  const previewVocab = assembleDomainVocabularyFromLinks(
    [
      {
        domainTermId: 'preview',
        domain: normalized.domain,
        locale: normalized.locale,
        kind: normalized.kind,
        canonical: normalized.canonical,
        localized: normalized.localized,
        parentCanonical: normalized.parentCanonical,
        aliases: normalized.aliases,
        description: normalized.description,
      },
    ],
    { domain: normalized.domain, locale: normalized.locale },
  );
  const result = validateDomainVocabulary(previewVocab);
  if (!result.valid) {
    throw new VocabularyError('validation_failed', result.errors.join('; '));
  }
  return normalized;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function upsertDomainTerm(
  tx: Tx | typeof db,
  input: NormalizedTermInput,
): Promise<{ term: Pick<DomainTerm, 'id'>; created: boolean }> {
  const dedupKey = computeDedupKey(input);
  const inserted = await tx
    .insert(domainTerms)
    .values({
      id: crypto.randomUUID(),
      domain: input.domain,
      locale: input.locale,
      kind: input.kind,
      canonical: input.canonical,
      canonicalNorm: input.canonicalNorm,
      localized: input.localized,
      localizedNorm: input.localizedNorm,
      parentCanonical: input.parentCanonical ?? null,
      parentCanonicalNorm: input.parentCanonicalNorm || null,
      description: input.description ?? null,
      aliases: input.aliases,
      source: 'user',
      status: 'active',
      dedupKey,
    })
    .onConflictDoNothing({ target: domainTerms.dedupKey })
    .returning({ id: domainTerms.id });

  if (inserted[0]) {
    return { term: inserted[0], created: true };
  }

  const existing = await tx.query.domainTerms.findFirst({
    where: eq(domainTerms.dedupKey, dedupKey),
    columns: { id: true },
  });
  if (!existing) {
    throw new VocabularyError(
      'dedup_race_lost',
      'Domain term upsert raced and could not be re-read',
    );
  }
  return { term: existing, created: false };
}

/**
 * Read a single user vocabulary link by id. Returns null when the link
 * does not exist, or when it is soft-deleted/archived and includeDeleted
 * was not requested.
 */
export async function getUserVocabularyTerm(
  userId: string,
  linkId: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<TermLink | null> {
  return getTermLink(userId, linkId, opts);
}

/**
 * List a user's domain vocabulary links. Defaults to active rows only.
 */
export async function listUserVocabularyTerms(
  userId: string,
  opts: ListOptions = {},
): Promise<ListResult> {
  const page = normalizePage(opts.page);
  const pageSize = normalizePageSize(opts.pageSize);
  const conditions: SQL[] = [eq(userDomainTerms.userId, userId)];
  if (opts.deletedOnly) {
    conditions.push(isNotNull(userDomainTerms.deletedAt), isNull(userDomainTerms.archivedAt), sql`${userDomainTerms.deletedAt} >= now() - interval '90 days'`);
  } else if (!opts.includeDeleted) conditions.push(activeLinkPredicate());
  if (opts.domain) conditions.push(eq(userDomainTerms.domain, opts.domain));
  if (opts.locale) conditions.push(eq(userDomainTerms.locale, opts.locale));
  if (opts.kind) conditions.push(eq(userDomainTerms.kind, opts.kind));
  const trimmedQ = opts.q?.trim();
  if (trimmedQ) {
    // ILIKE is plenty for typical user vocab sizes (≤ 25k rows). If we
    // ever ship to plans with hundreds of thousands of terms, swap to a
    // trigram or full-text index in a follow-up — the join + small
    // pageSize keeps this fast today.
    const pattern = `%${escapeLikePattern(trimmedQ)}%`;
    const search = or(
      sql`${domainTerms.canonical} ILIKE ${pattern}`,
      sql`${domainTerms.localized} ILIKE ${pattern}`,
      sql`${domainTerms.parentCanonical} ILIKE ${pattern}`,
    );
    if (search) conditions.push(search);
  }

  const predicate = and(...conditions);

  // The count query has to share the same join as the list when the
  // predicate references DomainTerm columns (e.g. via q). Without the
  // join, Postgres raises 42P01 "missing FROM-clause entry for table
  // DomainTerm". We always join here so the predicate stays free to
  // reference either table without per-call branching.
  const totalsQuery = db
    .select({ count: sql<number>`count(*)::int` })
    .from(userDomainTerms)
    .innerJoin(domainTerms, eq(userDomainTerms.termId, domainTerms.id))
    .where(predicate);

  const [rows, totals, archivedRow] = await Promise.all([
    db
      .select(selectTermLinkFields())
      .from(userDomainTerms)
      .innerJoin(domainTerms, eq(userDomainTerms.termId, domainTerms.id))
      .where(predicate)
      .orderBy(desc(userDomainTerms.createdAt), asc(userDomainTerms.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    totalsQuery,
    // Surface the archived count so the UI can render "your vocab was
    // archived under the 90-day retention; upgrade to restore" without a
    // second roundtrip. Archived rows are owner-scoped, not predicate-scoped,
    // because the user wants to know about archived state across all domains.
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(userDomainTerms)
      .where(
        and(
          eq(userDomainTerms.userId, userId),
          isNotNull(userDomainTerms.archivedAt),
        ),
      ),
  ]);

  return {
    items: (rows as JoinedTermRow[]).map(mapJoinedRow),
    total: totals[0]?.count ?? 0,
    archivedCount: archivedRow[0]?.count ?? 0,
    page,
    pageSize,
  };
}

/** 用户全部活跃词条数（不受列表筛选影响），配额卡用（#616）。 */
export async function countActiveUserVocabularyTerms(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userDomainTerms)
    .where(and(eq(userDomainTerms.userId, userId), activeLinkPredicate()));
  return row?.count ?? 0;
}

/**
 * 用户词汇的「版本号」（#608）：活跃链接的条数 + 最大 updatedAt。
 *
 * Workers 上请求分散在多个 isolate，进程内 EventEmitter 推送永远到不了订阅方；
 * 改由客户端定期轮询这个值，变了就重新拉词汇。版本完全由数据推导，无需额外写入：
 * 新增 / 修改 / 恢复都会推高 max(updatedAt)，删除 / 归档会让条数下降，
 * 两者同时发生时新增那行的 updatedAt 也必然更大，因此任何可见变化都会改变版本。
 * 查询走 `UserDomainTerm_user_domain_idx`（同为活跃行部分索引），按 domain/locale
 * 收窄时也命中前缀。
 */
export async function getUserVocabularyVersion(
  userId: string,
  scope: { domain?: string; locale?: string } = {},
): Promise<string> {
  const conditions: SQL[] = [eq(userDomainTerms.userId, userId), activeLinkPredicate()];
  if (scope.domain) conditions.push(eq(userDomainTerms.domain, scope.domain));
  if (scope.locale) conditions.push(eq(userDomainTerms.locale, scope.locale));
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      latest: sql<string | null>`(extract(epoch from max(${userDomainTerms.updatedAt})) * 1000)::bigint::text`,
    })
    .from(userDomainTerms)
    .where(and(...conditions));
  return `${row?.count ?? 0}-${row?.latest ?? 0}`;
}

/**
 * Compute a stable advisory-lock key for a user. We take a 64-bit slice of a
 * SHA-256 over the userId so the lock space is well-distributed and so the
 * same user always maps to the same bucket. Postgres advisory locks are
 * per-database (not per-table), so prefix with an app-specific salt to avoid
 * accidental collisions with other features.
 */
function userQuotaLockKey(userId: string): bigint {
  const hash = createHashSync(`lexicon-quota:${userId}`);
  // Take the first 16 hex chars (64 bits) and parse as a signed bigint for
  // pg_advisory_xact_lock(bigint).
  return BigInt.asIntN(64, BigInt(`0x${hash.slice(0, 16)}`));
}

/**
 * Add a user-owned vocabulary link, reusing the global DomainTerm when the
 * normalized dedup key already exists.
 *
 * Quota enforcement and link insertion run inside a single transaction
 * gated by a per-user advisory lock so concurrent retries cannot both pass
 * the quota check and exceed the plan limit.
 */
export async function addUserVocabularyTerm(
  userId: string,
  input: TermInput,
): Promise<{ link: TermLink; createdGlobalTerm: boolean }> {
  return withOpMetrics(
    'term.add',
    () => addUserVocabularyTermInner(userId, input),
  );
}

async function addUserVocabularyTermInner(
  userId: string,
  input: TermInput,
): Promise<{ link: TermLink; createdGlobalTerm: boolean }> {
  const normalized = validateInput(input);
  const quota = await getLexiconQuota(userId);
  if (!quota.allowed) {
    throw new VocabularyError(
      'plan_gate_required',
      'Custom domain vocabulary requires an eligible plan',
    );
  }

  const transactionResult = await db.transaction(async (tx) => {
    // Per-user advisory lock prevents concurrent adds from both passing the
    // quota check. The lock auto-releases at transaction end.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${userQuotaLockKey(userId)})`);

    if (quota.maxTerms !== -1) {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(userDomainTerms)
        .where(and(eq(userDomainTerms.userId, userId), activeLinkPredicate()));
      if ((count ?? 0) >= quota.maxTerms) {
        throw new VocabularyError(
          'quota_exceeded',
          `Custom vocabulary term quota of ${quota.maxTerms} reached`,
        );
      }
    }

    const upserted = await upsertDomainTerm(tx, normalized);

    let created: { id: string } | undefined;
    try {
      const inserted = await tx
        .insert(userDomainTerms)
        .values({
          id: crypto.randomUUID(),
          userId,
          termId: upserted.term.id,
          ownerType: 'user',
          domain: normalized.domain,
          locale: normalized.locale,
          kind: normalized.kind,
        })
        .returning({ id: userDomainTerms.id });
      created = inserted[0];
    } catch (insertErr) {
      // Partial unique on (userId, termId) WHERE deletedAt IS NULL surfaces
      // here when the user already has an active link to the same global
      // term. Treat it as a duplicate so the UI can show a friendly toast.
      if (isUniqueViolation(insertErr)) {
        throw new VocabularyError(
          'duplicate_link',
          'You already have this term in your vocabulary',
        );
      }
      throw insertErr;
    }
    if (!created) {
      throw new VocabularyError('link_create_failed', 'Could not create vocabulary link');
    }
    return { linkId: created.id, createdGlobalTerm: upserted.created };
  });

  const link = await getTermLink(userId, transactionResult.linkId);
  if (!link) {
    throw new VocabularyError(
      'link_create_failed',
      'Created vocabulary link could not be loaded back',
    );
  }

  await logAuditEvent({
    userId,
    action: 'lexicon.term.add',
    resource: 'domain-term',
    resourceId: link.termId,
    metadata: {
      linkId: link.id,
      domain: link.domain,
      locale: link.locale,
      kind: link.kind,
      createdGlobalTerm: transactionResult.createdGlobalTerm,
    },
  });

  return { link, createdGlobalTerm: transactionResult.createdGlobalTerm };
}

/**
 * Modify a user vocabulary link by repointing it to a new or existing global
 * DomainTerm. The previous DomainTerm row is never mutated.
 */
export async function modifyUserVocabularyTerm(
  userId: string,
  linkId: string,
  input: TermInput,
): Promise<{ link: TermLink; repointed: boolean; createdGlobalTerm: boolean }> {
  return withOpMetrics(
    'term.modify',
    () => modifyUserVocabularyTermInner(userId, linkId, input),
  );
}

async function modifyUserVocabularyTermInner(
  userId: string,
  linkId: string,
  input: TermInput,
): Promise<{ link: TermLink; repointed: boolean; createdGlobalTerm: boolean }> {
  const normalized = validateInput(input);
  const existing = await getTermLink(userId, linkId);
  if (!existing) {
    throw new VocabularyError('not_found', 'Vocabulary term link not found');
  }

  const transactionResult = await db.transaction(async (tx) => {
    const upserted = await upsertDomainTerm(tx, normalized);
    await tx
      .update(userDomainTerms)
      .set({
        termId: upserted.term.id,
        domain: normalized.domain,
        locale: normalized.locale,
        kind: normalized.kind,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userDomainTerms.userId, userId),
          eq(userDomainTerms.id, linkId),
          activeLinkPredicate(),
        ),
      );
    return {
      newTermId: upserted.term.id,
      repointed: existing.termId !== upserted.term.id,
      createdGlobalTerm: upserted.created,
    };
  });

  const link = await getTermLink(userId, linkId);
  if (!link) {
    throw new VocabularyError(
      'not_found',
      'Updated vocabulary term link could not be loaded back',
    );
  }

  await logAuditEvent({
    userId,
    action: 'lexicon.term.modify',
    resource: 'domain-term',
    resourceId: link.termId,
    metadata: {
      linkId,
      previousTermId: existing.termId,
      newTermId: transactionResult.newTermId,
      repointed: transactionResult.repointed,
      createdGlobalTerm: transactionResult.createdGlobalTerm,
    },
  });

  return {
    link,
    repointed: transactionResult.repointed,
    createdGlobalTerm: transactionResult.createdGlobalTerm,
  };
}

/**
 * Soft-delete a user vocabulary link. The global DomainTerm row is preserved
 * for dedup reuse and historical snapshots.
 */
export async function softDeleteUserVocabularyTerm(
  userId: string,
  linkId: string,
  reason?: string,
): Promise<{ deletedAt: Date }> {
  return withOpMetrics(
    'term.delete',
    () => softDeleteUserVocabularyTermInner(userId, linkId, reason),
  );
}

async function softDeleteUserVocabularyTermInner(
  userId: string,
  linkId: string,
  reason?: string,
): Promise<{ deletedAt: Date }> {
  const existing = await getTermLink(userId, linkId);
  if (!existing) {
    throw new VocabularyError('not_found', 'Vocabulary term link not found');
  }

  const deletedAt = new Date();
  // Truncate the user-supplied reason before persisting so DSAR-sensitive
  // text and accidental secrets do not balloon the audit row size.
  const safeReason = truncateForAudit(reason);
  const updated = await db
    .update(userDomainTerms)
    .set({
      deletedAt,
      deletedBy: userId,
      deletedReason: safeReason,
      updatedAt: deletedAt,
    })
    .where(
      and(
        eq(userDomainTerms.userId, userId),
        eq(userDomainTerms.id, linkId),
        activeLinkPredicate(),
      ),
    )
    .returning({ id: userDomainTerms.id });

  if (updated.length === 0) {
    // Concurrent delete/archive landed between our read and write. Surface
    // not_found so the caller can refresh; do not write a spurious audit row.
    throw new VocabularyError('not_found', 'Vocabulary term link not found');
  }

  await logAuditEvent({
    userId,
    action: 'lexicon.term.delete',
    resource: 'domain-term',
    resourceId: existing.termId,
    metadata: {
      linkId,
      domain: existing.domain,
      locale: existing.locale,
      kind: existing.kind,
      reasonProvided: Boolean(safeReason),
    },
  });

  return { deletedAt };
}

/**
 * Restore a soft-deleted, non-archived vocabulary link. Archived rows are
 * outside the restore window and must use a separate recovery path.
 */
export async function restoreUserVocabularyTerm(
  userId: string,
  linkId: string,
): Promise<{ link: TermLink }> {
  return withOpMetrics(
    'term.restore',
    () => restoreUserVocabularyTermInner(userId, linkId),
  );
}

async function restoreUserVocabularyTermInner(
  userId: string,
  linkId: string,
): Promise<{ link: TermLink }> {
  const deleted = await getTermLink(userId, linkId, { includeDeleted: true });
  if (!deleted) {
    throw new VocabularyError('not_found', 'Vocabulary term link not found');
  }

  await db
    .update(userDomainTerms)
    .set({
      deletedAt: null,
      deletedBy: null,
      deletedReason: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userDomainTerms.userId, userId),
        eq(userDomainTerms.id, linkId),
        isNotNull(userDomainTerms.deletedAt),
        isNull(userDomainTerms.archivedAt),
      ),
    );

  const link = await getTermLink(userId, linkId);
  if (!link) {
    throw new VocabularyError(
      'restore_failed',
      'Restored vocabulary link could not be loaded back; it may be archived or already active',
    );
  }

  await logAuditEvent({
    userId,
    action: 'lexicon.term.restore',
    resource: 'domain-term',
    resourceId: link.termId,
    metadata: { linkId },
  });

  return { link };
}

/**
 * Dry-run helper: report whether adding a term would reuse an existing global
 * DomainTerm and surface any vocabulary-level validation warnings.
 */
export async function previewAddTerm(
  userId: string,
  input: TermInput,
): Promise<{
  existsInGlobal: boolean;
  existingTermId: string | null;
  collisions: string[];
}> {
  const normalized = validateInput(input);
  const dedupKey = computeDedupKey(normalized);
  const existing = await db.query.domainTerms.findFirst({
    where: eq(domainTerms.dedupKey, dedupKey),
    columns: { id: true },
  });

  const current = await listUserVocabularyTerms(userId, {
    domain: normalized.domain,
    locale: normalized.locale,
    pageSize: MAX_PAGE_SIZE,
  });
  const rows = [
    ...current.items.map((item) => ({
      domainTermId: item.termId,
      domain: item.domain,
      locale: item.locale,
      kind: item.kind,
      canonical: item.canonical,
      localized: item.localized,
      parentCanonical: item.parentCanonical,
      aliases: item.aliases,
      description: item.description,
    })),
    {
      domainTermId: 'preview',
      domain: normalized.domain,
      locale: normalized.locale,
      kind: normalized.kind,
      canonical: normalized.canonical,
      localized: normalized.localized,
      parentCanonical: normalized.parentCanonical,
      aliases: normalized.aliases,
      description: normalized.description,
    },
  ];
  const validation = validateDomainVocabulary(
    assembleDomainVocabularyFromLinks(rows, {
      domain: normalized.domain,
      locale: normalized.locale,
    }),
  );

  return {
    existsInGlobal: Boolean(existing),
    existingTermId: existing?.id ?? null,
    collisions: [...validation.errors, ...validation.warnings],
  };
}

// ---------------------------------------------------------------------------
// Bulk import (sync) — process rows in chunked transactions, rollup per-row
// outcomes into a single completed LexiconBulkJob row for auditability.
// ---------------------------------------------------------------------------

export const BULK_SYNC_MAX_ROWS = 500;
export const BULK_ASYNC_MAX_ROWS = 10_000;
const BULK_CHUNK_SIZE = 250;

export interface BulkRowError {
  row: number;
  code: string;
  message: string;
}

export interface BulkRollup {
  added: number;
  reused: number;
  modified: number;
  skipped: number;
  errorCount: number;
}

export interface BulkResult {
  jobId: string;
  status: 'completed';
  mode: 'sync';
  rowCount: number;
  processed: number;
  rollup: BulkRollup;
  errors: BulkRowError[];
}

const BULK_CHUNK_FAILED_MESSAGE = 'This batch could not be saved. Please retry.';
const BULK_ROW_FAILED_MESSAGE = 'This row could not be saved. Please retry.';

export type BulkRowLanding =
  | { ok: true; created: boolean }
  | { ok: false; code: string; message: string };

/**
 * 在独立 SAVEPOINT 里落一行批量导入（同步与异步 worker 共用，#606）。
 *
 * - 已有同一活跃链接：靠 `ON CONFLICT DO NOTHING`（不指定目标，覆盖部分唯一索引
 *   `UserDomainTerm_active_unique`）得到空结果 → `duplicate_link`，不抛错，外层事务不受影响。
 * - 其他意外错误：只回滚到本行的 SAVEPOINT，外层事务仍可继续处理后续行；
 *   原始错误只写日志，回给调用方的是不含数据库细节的通用消息。
 */
export async function landBulkRow(
  tx: Tx,
  userId: string,
  normalized: NormalizedTermInput,
): Promise<BulkRowLanding> {
  try {
    return await tx.transaction(async (sp) => {
      const upserted = await upsertDomainTerm(sp, normalized);
      const inserted = await sp
        .insert(userDomainTerms)
        .values({
          id: crypto.randomUUID(),
          userId,
          termId: upserted.term.id,
          ownerType: 'user',
          domain: normalized.domain,
          locale: normalized.locale,
          kind: normalized.kind,
        })
        .onConflictDoNothing()
        .returning({ id: userDomainTerms.id });
      if (inserted.length === 0) {
        return {
          ok: false,
          code: 'duplicate_link',
          message: 'You already have this term in your vocabulary',
        } as const;
      }
      return { ok: true, created: upserted.created } as const;
    });
  } catch (err) {
    if (err instanceof VocabularyError) {
      return { ok: false, code: err.code, message: err.message };
    }
    if (isUniqueViolation(err)) {
      return {
        ok: false,
        code: 'duplicate_link',
        message: 'You already have this term in your vocabulary',
      };
    }
    console.error('[landBulkRow] row failed', err);
    return { ok: false, code: 'row_failed', message: BULK_ROW_FAILED_MESSAGE };
  }
}

function emptyRollup(): BulkRollup {
  return { added: 0, reused: 0, modified: 0, skipped: 0, errorCount: 0 };
}

function mergeRollup(target: BulkRollup, src: BulkRollup): void {
  target.added += src.added;
  target.reused += src.reused;
  target.modified += src.modified;
  target.skipped += src.skipped;
  target.errorCount += src.errorCount;
}

function chunkRows<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size) as T[]);
  }
  return out;
}

/**
 * Bulk-add a batch of vocabulary terms in one synchronous request.
 *
 * Strategy:
 *   - Enforce per-user quota by computing the maximum number of new active
 *     links the caller can land. Rows beyond that cap are reported as
 *     `quota_exceeded` skipped errors rather than rejected outright so
 *     partial success is preserved.
 *   - Process rows in chunks of {@link BULK_CHUNK_SIZE} inside its own
 *     transaction. A chunk-level failure rolls back only that chunk; the
 *     caller still gets the rollup for chunks that succeeded.
 *   - Each accepted row goes through the same upsertDomainTerm path as the
 *     single-term add, so dedup behavior is identical.
 *
 * Always writes a `completed` LexiconBulkJob row with the final rollup so
 * admin/support can audit imports later.
 */
export async function bulkAddUserVocabularyTerms(
  userId: string,
  rawRows: readonly TermInput[],
): Promise<BulkResult> {
  const startedAt = Date.now();
  try {
    const result = await bulkAddUserVocabularyTermsInner(userId, rawRows);
    const durationSec = (Date.now() - startedAt) / 1000;
    observeBulkJobDuration('sync', durationSec);
    recordBulkJobRowsProcessed('sync', result.rollup.added + result.rollup.reused);
    const status =
      result.rollup.errorCount === 0
        ? 'success'
        : result.rollup.added + result.rollup.reused === 0
        ? 'error'
        : 'partial';
    recordLexiconOp('bulk.sync', status);
    return result;
  } catch (err) {
    recordLexiconOp('bulk.sync', 'error');
    observeBulkJobDuration('sync', (Date.now() - startedAt) / 1000);
    throw err;
  }
}

async function bulkAddUserVocabularyTermsInner(
  userId: string,
  rawRows: readonly TermInput[],
): Promise<BulkResult> {
  if (rawRows.length === 0) {
    throw new VocabularyError(
      'validation_failed',
      'bulk import requires at least one term',
    );
  }
  if (rawRows.length > BULK_SYNC_MAX_ROWS) {
    throw new VocabularyError(
      'validation_failed',
      `sync bulk import accepts at most ${BULK_SYNC_MAX_ROWS} rows`,
    );
  }

  const quota = await getLexiconQuota(userId);
  if (!quota.allowed) {
    throw new VocabularyError(
      'plan_gate_required',
      'Custom domain vocabulary requires an eligible plan',
    );
  }

  // Pre-validate each row outside the transaction so we surface row-level
  // schema errors with stable indices, regardless of chunk order.
  const validated: Array<{ row: number; normalized: NormalizedTermInput } | { row: number; error: BulkRowError }> = rawRows.map(
    (raw, index) => {
      try {
        return { row: index, normalized: validateInput(raw) };
      } catch (err) {
        if (err instanceof VocabularyError) {
          return { row: index, error: { row: index, code: err.code, message: err.message } };
        }
        return {
          row: index,
          error: {
            row: index,
            code: 'validation_failed',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  );

  const rollup = emptyRollup();
  const errors: BulkRowError[] = [];
  for (const v of validated) {
    if ('error' in v) {
      errors.push(v.error);
      rollup.skipped += 1;
      rollup.errorCount += 1;
    }
  }
  const acceptedRows = validated.filter((v): v is { row: number; normalized: NormalizedTermInput } => 'normalized' in v);

  // Quota is enforced per-chunk INSIDE the advisory lock. Counting outside
  // the lock would let a concurrent single-add or other bulk slip in
  // between the count and the insert, exceeding the plan cap.

  let processed = 0;
  for (const chunk of chunkRows(acceptedRows, BULK_CHUNK_SIZE)) {
    let chunkResult: BulkRollup | null = null;
    let chunkErrors: BulkRowError[] = [];
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${userQuotaLockKey(userId)})`);
        const localRollup = emptyRollup();
        const localErrors: BulkRowError[] = [];

        // In-lock quota count. We compute remaining capacity once at the
        // top of each chunk and decrement as we land rows; concurrent
        // mutations cannot land for this user while we hold the lock.
        let remainingQuota = Number.POSITIVE_INFINITY;
        if (quota.maxTerms !== -1) {
          const [{ count: currentActive }] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(userDomainTerms)
            .where(and(eq(userDomainTerms.userId, userId), activeLinkPredicate()));
          remainingQuota = Math.max(0, quota.maxTerms - (currentActive ?? 0));
        }

        for (const { row, normalized } of chunk) {
          if (remainingQuota <= 0) {
            localErrors.push({
              row,
              code: 'quota_exceeded',
              message: `Custom vocabulary term quota of ${quota.maxTerms} reached`,
            });
            localRollup.skipped += 1;
            localRollup.errorCount += 1;
            continue;
          }
          const landed = await landBulkRow(tx, userId, normalized);
          if (!landed.ok) {
            localErrors.push({ row, code: landed.code, message: landed.message });
            localRollup.skipped += 1;
            localRollup.errorCount += 1;
            continue;
          }
          if (landed.created) localRollup.added += 1;
          else localRollup.reused += 1;
          remainingQuota -= 1;
        }
        return { rollup: localRollup, errors: localErrors };
      });
      chunkResult = result.rollup;
      chunkErrors = result.errors;
    } catch (chunkErr) {
      // 整个 chunk 回滚（加锁/计数等非行级语句失败）：每行记 chunk_failed，计数保持确定。
      // 原始数据库报错只进日志，不回给前端（#606：曾把 PG 约束名原样泄露）。
      console.error('[bulkAddUserVocabularyTerms] chunk failed', chunkErr);
      for (const { row } of chunk) {
        errors.push({ row, code: 'chunk_failed', message: BULK_CHUNK_FAILED_MESSAGE });
      }
      rollup.skipped += chunk.length;
      rollup.errorCount += chunk.length;
      processed += chunk.length;
      continue;
    }
    mergeRollup(rollup, chunkResult);
    errors.push(...chunkErrors);
    processed += chunk.length;
  }

  // Persist a completed job row for auditability. We swallow storage errors
  // so a flaky audit write doesn't lose the import response; structured
  // logging keeps the failure visible.
  const jobId = crypto.randomUUID();
  try {
    await db.insert(lexiconBulkJobs).values({
      id: jobId,
      userId,
      status: 'completed',
      mode: 'sync',
      rowCount: rawRows.length,
      processed,
      rollup,
      errors,
      completedAt: new Date(),
    });
  } catch (auditErr) {
    console.error('[bulkAddUserVocabularyTerms] failed to persist job row', auditErr);
  }

  await logAuditEvent({
    userId,
    action: 'lexicon.term.add',
    resource: 'domain-term-bulk',
    resourceId: jobId,
    metadata: {
      mode: 'sync',
      rowCount: rawRows.length,
      added: rollup.added,
      reused: rollup.reused,
      modified: rollup.modified,
      skipped: rollup.skipped,
      errorCount: rollup.errorCount,
    },
  });

  return {
    jobId,
    status: 'completed',
    mode: 'sync',
    rowCount: rawRows.length,
    processed,
    rollup,
    errors,
  };
}
