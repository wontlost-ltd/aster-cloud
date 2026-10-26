/**
 * Vocabulary retention + DSAR (B13)
 *
 * Two operations:
 *
 *   1. archiveDowngradedUserVocabulary — daily sweep that finds users on the
 *      free plan with downgradedAt past the 90-day window and archives their
 *      active links. Archived rows are kept (NOT physically deleted) so the
 *      user can restore them by upgrading back to Pro. An archive-time
 *      snapshot is captured so restore is exact.
 *
 *   2. purgeUserVocabulary — invoked by the user-purge cron / DSAR delete
 *      path. UserDomainTerm + LexiconBulkJob + LexiconIdempotencyKey cascade
 *      on users.id (FK ON DELETE CASCADE) so the user-purge transaction
 *      already removes them; UserVocabularySnapshot is owner-scoped via
 *      (ownerType, ownerId) but has no FK, so we must delete it explicitly
 *      to honour right-to-erasure.
 */

import { createHash } from 'node:crypto';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  db,
  lexiconBulkJobs,
  lexiconIdempotencyKeys,
  userDomainTerms,
  userVocabularySnapshots,
  userVocabularyVersions,
  users,
} from '@/lib/prisma';
import { logAuditEvent } from '@/lib/audit-log';
import { isUndefinedTable } from '@/lib/pg-errors';
import { assembleDomainVocabularyFromLinks } from '@/lib/domain-vocabulary-validation';

const RETENTION_DAYS = 90;

export interface ArchiveOutcome {
  usersScanned: number;
  usersArchived: number;
  linksArchived: number;
  snapshotsCreated: number;
}

export interface PurgeOutcome {
  snapshotsDeleted: number;
  bulkJobsDeleted: number;
  idempotencyDeleted: number;
}

interface JoinedTermRow {
  termId: string;
  domain: string;
  locale: string;
  kind: string;
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

/**
 * Group joined link rows by (domain, locale) so we create one archive
 * snapshot per scope — matches the runtime snapshot semantics, so a future
 * upgrade-restore flow can use the same rollback machinery.
 */
function groupByScope(rows: JoinedTermRow[]): Map<string, JoinedTermRow[]> {
  const groups = new Map<string, JoinedTermRow[]>();
  for (const r of rows) {
    const key = `${r.domain}|${r.locale}`;
    const existing = groups.get(key);
    if (existing) existing.push(r);
    else groups.set(key, [r]);
  }
  return groups;
}

async function findDowngradedUsers(now: Date) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400_000);
  return db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.plan, 'free'),
        lt(users.downgradedAt, cutoff),
      ),
    );
}

/**
 * Compute a stable 64-bit advisory-lock key for a user. Reuses the same
 * hashing pattern the service layer uses for quota locks so the archive
 * sweep and concurrent add/delete operations serialize against each other.
 */
function userArchiveLockKey(userId: string): bigint {
  const hash = createHash('sha256').update(`lexicon-archive:${userId}`).digest('hex');
  return BigInt.asIntN(64, BigInt(`0x${hash.slice(0, 16)}`));
}

async function archiveLinksForUser(
  userId: string,
  now: Date,
): Promise<{ linksArchived: number; snapshotsCreated: number }> {
  // One per-user transaction with an advisory lock so concurrent
  // add/modify/delete operations cannot land between the snapshot read and
  // the archive flip. The lock keys on the user id, so other users' archive
  // passes are unaffected.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${userArchiveLockKey(userId)})`);

    // Read the join in a single SQL statement so the snapshot exactly mirrors
    // the rows we will archive below. We pin the working set by capturing
    // (linkId, termId) under the lock — any concurrent add that snuck in
    // before the lock acquired is naturally outside this set.
    const joinedResult = (await tx.execute(sql`
      SELECT udt.id            AS "id",
             udt."termId"      AS "termId",
             udt.domain        AS "domain",
             udt.locale        AS "locale",
             udt.kind          AS "kind",
             dt.canonical      AS "canonical",
             dt.localized      AS "localized",
             dt."parentCanonical" AS "parentCanonical",
             dt.aliases        AS "aliases",
             dt.description    AS "description"
        FROM "UserDomainTerm" udt
        JOIN "DomainTerm" dt ON dt.id = udt."termId"
       WHERE udt."userId"    = ${userId}
         AND udt."deletedAt" IS NULL
         AND udt."archivedAt" IS NULL
       ORDER BY udt.id
    `)) as unknown;
    const joinedRows = (
      (joinedResult as { rows?: JoinedTermRow[] }).rows ??
      (joinedResult as JoinedTermRow[])
    ) as Array<JoinedTermRow & { id: string }>;

    if (joinedRows.length === 0) {
      return { linksArchived: 0, snapshotsCreated: 0 };
    }

    let snapshotsCreated = 0;
    // (linkId → snapshotId) so we can write archiveSnapshotId per-row in one
    // batched update.
    const linkToSnapshot = new Map<string, string>();

    for (const [key, scopeRows] of groupByScope(joinedRows)) {
      const [domain, locale] = key.split('|');
      const termIds = scopeRows.map((r) => r.termId).sort();
      const contentHash = hashContent(termIds);

      // Dedup by content hash to keep refCount accurate when an archive
      // captures the same set as a previous publish snapshot.
      const existing = await tx.query.userVocabularySnapshots.findFirst({
        where: and(
          eq(userVocabularySnapshots.ownerType, 'user'),
          eq(userVocabularySnapshots.ownerId, userId),
          eq(userVocabularySnapshots.domain, domain),
          eq(userVocabularySnapshots.locale, locale),
          eq(userVocabularySnapshots.contentHash, contentHash),
        ),
        columns: { id: true },
      });

      let snapshotId: string;
      if (existing) {
        await tx
          .update(userVocabularySnapshots)
          .set({ refCount: sql`${userVocabularySnapshots.refCount} + 1` })
          .where(eq(userVocabularySnapshots.id, existing.id));
        snapshotId = existing.id;
      } else {
        const maxRow = await tx
          .select({ max: sql<number | null>`max(${userVocabularySnapshots.version})` })
          .from(userVocabularySnapshots)
          .where(
            and(
              eq(userVocabularySnapshots.ownerType, 'user'),
              eq(userVocabularySnapshots.ownerId, userId),
              eq(userVocabularySnapshots.domain, domain),
              eq(userVocabularySnapshots.locale, locale),
            ),
          );
        const version = (maxRow[0]?.max ?? 0) + 1;
        snapshotId = crypto.randomUUID();
        const vocabJson = assembleDomainVocabularyFromLinks(
          scopeRows.map((r) => ({
            domainTermId: r.termId,
            domain: r.domain,
            locale: r.locale,
            kind: r.kind,
            canonical: r.canonical,
            localized: r.localized,
            parentCanonical: r.parentCanonical,
            aliases: parseAliases(r.aliases),
            description: r.description,
          })),
          { domain, locale },
        );
        await tx.insert(userVocabularySnapshots).values({
          id: snapshotId,
          ownerType: 'user',
          ownerId: userId,
          domain,
          locale,
          version,
          vocabularyJson: vocabJson,
          termIds,
          contentHash,
          refCount: 1,
        });
        snapshotsCreated += 1;
      }

      for (const row of scopeRows as Array<JoinedTermRow & { id: string }>) {
        linkToSnapshot.set(row.id, snapshotId);
      }
    }

    // Archive only the link IDs we captured. Concurrent inserts that landed
    // before the lock acquired are not in this set, so they stay active.
    // We do one update per snapshot (small N) to keep archiveSnapshotId
    // accurate, batching link IDs that share a snapshot.
    const snapshotToLinks = new Map<string, string[]>();
    for (const [linkId, snapshotId] of linkToSnapshot) {
      const existingArr = snapshotToLinks.get(snapshotId);
      if (existingArr) existingArr.push(linkId);
      else snapshotToLinks.set(snapshotId, [linkId]);
    }
    let linksArchived = 0;
    for (const [snapshotId, linkIds] of snapshotToLinks) {
      const updated = await tx
        .update(userDomainTerms)
        .set({ archivedAt: now, archiveSnapshotId: snapshotId, updatedAt: now })
        .where(inArray(userDomainTerms.id, linkIds))
        .returning({ id: userDomainTerms.id });
      linksArchived += updated.length;
    }

    return { linksArchived, snapshotsCreated };
  });
}

/**
 * Append the retention audit entry AFTER archiveLinksForUser commits. Audit
 * uses the outer `db` connection; running it inside the txn would deadlock
 * on the Workers max=1 pool.
 */
async function appendArchiveAudit(
  userId: string,
  linksArchived: number,
  snapshotsCreated: number,
): Promise<void> {
  if (linksArchived === 0) return;
  await logAuditEvent({
    userId,
    action: 'lexicon.term.delete',
    resource: 'domain-term',
    metadata: {
      reason: 'retention_90d',
      linksArchived,
      snapshotsCreated,
    },
  });
}

/**
 * Daily sweep entry point. Idempotent: re-runs against the same downgraded
 * user are no-ops once links are archived (the active-link filter returns 0
 * rows).
 */
export async function archiveDowngradedUserVocabulary(now: Date = new Date()): Promise<ArchiveOutcome> {
  const candidates = await findDowngradedUsers(now);
  const outcome: ArchiveOutcome = {
    usersScanned: candidates.length,
    usersArchived: 0,
    linksArchived: 0,
    snapshotsCreated: 0,
  };

  for (const candidate of candidates) {
    const { linksArchived, snapshotsCreated } = await archiveLinksForUser(candidate.id, now);
    if (linksArchived > 0) {
      outcome.usersArchived += 1;
      outcome.linksArchived += linksArchived;
      outcome.snapshotsCreated += snapshotsCreated;
    }
    await appendArchiveAudit(candidate.id, linksArchived, snapshotsCreated);
  }

  return outcome;
}

/**
 * DSAR / user-purge hook: physically delete all vocabulary-scoped rows
 * owned by a user. UserDomainTerm + LexiconBulkJob + LexiconIdempotencyKey
 * cascade via FK; UserVocabularySnapshot has no FK so we delete it here.
 *
 * Safe to call multiple times: re-runs touch zero rows.
 */
export async function purgeUserVocabulary(userId: string): Promise<PurgeOutcome> {
  // FK ordering matters here: UserDomainTerm.archiveSnapshotId references
  // UserVocabularySnapshot.id with no ON DELETE behaviour, so deleting
  // snapshots while archived links still reference them raises a FK
  // violation. Delete links first, then snapshots last.
  //
  // We also want all the lexicon-scoped tables removed atomically so a
  // partial failure does not leave residual rows that would have to be
  // hand-cleaned. Wrap in a single transaction.
  //
  // NOTE: logAuditEvent (which uses the OUTER db connection) MUST run
  // AFTER the transaction commits. The production postgres-js pool is
  // sized for Cloudflare Workers with max=1 connection; if audit ran
  // inside the txn, the outer-db insert would wait for the only pool slot
  // that the txn itself is holding → deadlock.
  const result = await db.transaction(async (tx) => {
    // 1. UserDomainTerm: clears FK references that snapshots depend on.
    //    Use a plain delete (no returning) because the count is uninteresting;
    //    user-purge path may invoke this twice (the FK cascade from
    //    DELETE FROM "User" runs separately), so idempotency is required.
    await tx.delete(userDomainTerms).where(eq(userDomainTerms.userId, userId));

    // 2. LexiconBulkJob + LexiconIdempotencyKey: cascade-on-user-delete in
    //    the schema, but DSAR flows that retain the user need explicit cleanup.
    const bulkJobsDeleted = (
      await tx
        .delete(lexiconBulkJobs)
        .where(eq(lexiconBulkJobs.userId, userId))
        .returning({ id: lexiconBulkJobs.id })
    ).length;
    const idempotencyDeleted = (
      await tx
        .delete(lexiconIdempotencyKeys)
        .where(eq(lexiconIdempotencyKeys.userId, userId))
        .returning({ id: lexiconIdempotencyKeys.id })
    ).length;

    // 3. UserVocabularySnapshot: no FK from users.id, so explicit delete is
    //    the only path that satisfies GDPR right-to-erasure. Runs last
    //    because step 1 cleared the inbound FK references.
    const snapshotsDeleted = (
      await tx
        .delete(userVocabularySnapshots)
        .where(
          and(
            eq(userVocabularySnapshots.ownerType, 'user'),
            eq(userVocabularySnapshots.ownerId, userId),
          ),
        )
        .returning({ id: userVocabularySnapshots.id })
    ).length;

    // 4. UserVocabularyVersion：保留用户的 DSAR 清理也要抹掉版本行（复审 P2）。
    //    必须放在第 1 步删词条之后——那一步的 DELETE 触发器会为仍存在的用户
    //    upsert 版本行，先删就会被它重新建出来。
    //    迁移窗口容错：0059 尚未应用时表不存在（42P01）。放进保存点里执行，
    //    出错只回滚保存点；直接在外层事务里吞掉异常会让整个事务进入 aborted 状态，
    //    COMMIT 被 Postgres 静默改成 ROLLBACK，前面三步清理全部丢失。
    //    表不存在即无版本行可删，跳过即可；其他错误照常抛出回滚整个清理。
    try {
      await tx.transaction(async (sp) => {
        await sp.delete(userVocabularyVersions).where(eq(userVocabularyVersions.userId, userId));
      });
    } catch (error) {
      if (!isUndefinedTable(error)) throw error;
    }

    return { snapshotsDeleted, bulkJobsDeleted, idempotencyDeleted };
  });

  // Audit log runs AFTER the txn commits to avoid pool-exhaustion deadlock
  // on Workers (max=1). See the note in purgeUserVocabulary above.
  await logAuditEvent({
    userId,
    action: 'lexicon.term.delete',
    resource: 'domain-term',
    metadata: {
      reason: 'dsar_purge',
      snapshotsDeleted: result.snapshotsDeleted,
      bulkJobsDeleted: result.bulkJobsDeleted,
      idempotencyDeleted: result.idempotencyDeleted,
    },
  });

  return result;
}

/** Test-only constant export so the test suite can reference the window. */
export const RETENTION_DAYS_EXPORT = RETENTION_DAYS;
