/**
 * Bulk job chunk processor (B11)
 *
 * One worker invocation per call. Processes up to CHUNK_SIZE rows from the
 * job's stored inputJson, then either keeps the row in `running` for the
 * next tick (more rows to go) or flips it to `completed` if everything
 * landed.
 *
 * Quota cap is checked once per chunk to avoid landing more rows than the
 * plan allows. Excess rows are reported as quota_exceeded skips.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  domainTerms,
  lexiconBulkJobs,
  userDomainTerms,
} from '@/lib/prisma';
import { logAuditEvent } from '@/lib/audit-log';
import { getLexiconQuota } from '@/lib/usage';
import {
  computeDedupKey,
  normalizeTermInput,
  assembleDomainVocabularyFromLinks,
  validateDomainVocabulary,
  type TermKind,
} from '@/lib/domain-vocabulary-validation';
import {
  VocabularyError,
} from '@/lib/domain-vocabulary';
import { isUniqueViolation } from '@/lib/pg-errors';

const CHUNK_SIZE = 250;

interface RowInput {
  domain: string;
  locale: string;
  kind: TermKind;
  canonical: string;
  localized: string;
  parentCanonical?: string;
  description?: string;
  aliases?: string[];
}

interface RollupShape {
  added: number;
  reused: number;
  modified: number;
  skipped: number;
  errorCount: number;
}

interface RowError {
  row: number;
  code: string;
  message: string;
}

function emptyRollup(): RollupShape {
  return { added: 0, reused: 0, modified: 0, skipped: 0, errorCount: 0 };
}


function parseInput(rawJson: unknown): unknown[] {
  if (!Array.isArray(rawJson)) {
    throw new Error('LexiconBulkJob.inputJson is missing or not an array');
  }
  return rawJson as unknown[];
}

function tryNormalize(raw: unknown): { ok: true; value: RowInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'row must be an object' };
  }
  const r = raw as Record<string, unknown>;
  const required = (key: string): string | null => {
    const v = r[key];
    return typeof v === 'string' && v.trim() !== '' ? v : null;
  };
  const kind = required('kind');
  if (!kind || !['struct', 'field', 'function', 'enum_value'].includes(kind)) {
    return { ok: false, error: 'kind must be struct|field|function|enum_value' };
  }
  const domain = required('domain');
  const locale = required('locale');
  const canonical = required('canonical');
  const localized = required('localized');
  if (!domain || !locale || !canonical || !localized) {
    return { ok: false, error: 'domain/locale/canonical/localized are required' };
  }
  return {
    ok: true,
    value: {
      domain,
      locale,
      kind: kind as TermKind,
      canonical,
      localized,
      parentCanonical: typeof r.parentCanonical === 'string' ? r.parentCanonical : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
      aliases: Array.isArray(r.aliases) && r.aliases.every((a) => typeof a === 'string')
        ? (r.aliases as string[])
        : undefined,
    },
  };
}

interface ChunkOutcome {
  processedDelta: number;
  rollupDelta: RollupShape;
  errorsDelta: RowError[];
  finished: boolean;
}

export async function processBulkJobChunk(job: {
  id: string;
  userId: string;
  rowCount: number;
  processed: number;
  rollup: unknown;
  errors: unknown;
  inputJson: unknown;
}): Promise<ChunkOutcome> {
  const inputRows = parseInput(job.inputJson);
  const startIndex = job.processed;
  const endIndex = Math.min(inputRows.length, startIndex + CHUNK_SIZE);
  const chunk = inputRows.slice(startIndex, endIndex);

  const rollupDelta = emptyRollup();
  const errorsDelta: RowError[] = [];

  if (chunk.length === 0) {
    await markJobCompleted(job.id);
    return { processedDelta: 0, rollupDelta, errorsDelta, finished: true };
  }

  const quota = await getLexiconQuota(job.userId);
  if (!quota.allowed) {
    await markJobFailed(job.id, 'Custom domain vocabulary requires an eligible plan');
    throw new VocabularyError('plan_gate_required', 'Plan no longer allows custom vocabulary');
  }

  let remainingQuota = quota.maxTerms === -1 ? Number.POSITIVE_INFINITY : 0;
  if (quota.maxTerms !== -1) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(userDomainTerms)
      .where(
        and(
          eq(userDomainTerms.userId, job.userId),
          sql`${userDomainTerms.deletedAt} IS NULL AND ${userDomainTerms.archivedAt} IS NULL`,
        ),
      );
    remainingQuota = Math.max(0, quota.maxTerms - (count ?? 0));
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < chunk.length; i += 1) {
      const absoluteIndex = startIndex + i;
      const parsed = tryNormalize(chunk[i]);
      if (!parsed.ok) {
        errorsDelta.push({
          row: absoluteIndex,
          code: 'validation_failed',
          message: parsed.error,
        });
        rollupDelta.skipped += 1;
        rollupDelta.errorCount += 1;
        continue;
      }
      const normalized = normalizeTermInput(parsed.value);
      if (!normalized.canonical || !normalized.localized) {
        errorsDelta.push({
          row: absoluteIndex,
          code: 'validation_failed',
          message: 'canonical and localized are required',
        });
        rollupDelta.skipped += 1;
        rollupDelta.errorCount += 1;
        continue;
      }
      const validation = validateDomainVocabulary(
        assembleDomainVocabularyFromLinks(
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
        ),
      );
      if (!validation.valid) {
        errorsDelta.push({
          row: absoluteIndex,
          code: 'validation_failed',
          message: validation.errors.join('; '),
        });
        rollupDelta.skipped += 1;
        rollupDelta.errorCount += 1;
        continue;
      }
      if (remainingQuota <= 0) {
        errorsDelta.push({
          row: absoluteIndex,
          code: 'quota_exceeded',
          message: 'Plan quota reached while processing async chunk',
        });
        rollupDelta.skipped += 1;
        rollupDelta.errorCount += 1;
        continue;
      }

      const dedupKey = computeDedupKey(normalized);
      const upserted = await tx
        .insert(domainTerms)
        .values({
          id: crypto.randomUUID(),
          domain: normalized.domain,
          locale: normalized.locale,
          kind: normalized.kind,
          canonical: normalized.canonical,
          canonicalNorm: normalized.canonicalNorm,
          localized: normalized.localized,
          localizedNorm: normalized.localizedNorm,
          parentCanonical: normalized.parentCanonical ?? null,
          parentCanonicalNorm: normalized.parentCanonicalNorm || null,
          description: normalized.description ?? null,
          aliases: normalized.aliases,
          source: 'user',
          status: 'active',
          dedupKey,
        })
        .onConflictDoNothing({ target: domainTerms.dedupKey })
        .returning({ id: domainTerms.id });

      let termId: string;
      let created: boolean;
      if (upserted[0]) {
        termId = upserted[0].id;
        created = true;
      } else {
        const existing = await tx.query.domainTerms.findFirst({
          where: eq(domainTerms.dedupKey, dedupKey),
          columns: { id: true },
        });
        if (!existing) {
          errorsDelta.push({
            row: absoluteIndex,
            code: 'dedup_race_lost',
            message: 'Domain term upsert raced and could not be re-read',
          });
          rollupDelta.skipped += 1;
          rollupDelta.errorCount += 1;
          continue;
        }
        termId = existing.id;
        created = false;
      }

      try {
        const linkInsert = await tx
          .insert(userDomainTerms)
          .values({
            id: crypto.randomUUID(),
            userId: job.userId,
            termId,
            ownerType: 'user',
            domain: normalized.domain,
            locale: normalized.locale,
            kind: normalized.kind,
          })
          .returning({ id: userDomainTerms.id });
        if (linkInsert.length === 0) {
          errorsDelta.push({
            row: absoluteIndex,
            code: 'link_create_failed',
            message: 'Could not create vocabulary link',
          });
          rollupDelta.skipped += 1;
          rollupDelta.errorCount += 1;
          continue;
        }
        if (created) rollupDelta.added += 1;
        else rollupDelta.reused += 1;
        remainingQuota -= 1;
      } catch (linkErr) {
        if (isUniqueViolation(linkErr)) {
          errorsDelta.push({
            row: absoluteIndex,
            code: 'duplicate_link',
            message: 'You already have this term in your vocabulary',
          });
          rollupDelta.skipped += 1;
          rollupDelta.errorCount += 1;
          continue;
        }
        throw linkErr;
      }
    }
  });

  const processedNow = startIndex + chunk.length;
  const finished = processedNow >= job.rowCount;

  const mergedRollup = mergeRollupAtomic(job.rollup, rollupDelta);
  const mergedErrors = mergeErrorsAtomic(job.errors, errorsDelta);

  // Non-final chunks return the job to `queued` and clear the claim so the
  // next worker tick can pick it up normally. Stale recovery should be
  // reserved for genuine crashes, not the normal continuation path.
  await db
    .update(lexiconBulkJobs)
    .set({
      processed: processedNow,
      rollup: mergedRollup,
      errors: mergedErrors,
      status: finished ? 'completed' : 'queued',
      claimedBy: null,
      claimedAt: null,
      completedAt: finished ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(lexiconBulkJobs.id, job.id));

  if (finished) {
    await logAuditEvent({
      userId: job.userId,
      action: 'lexicon.term.add',
      resource: 'domain-term-bulk',
      resourceId: job.id,
      metadata: {
        mode: 'async',
        status: 'completed',
        rowCount: job.rowCount,
        ...mergedRollup,
      },
    });
  }

  return {
    processedDelta: chunk.length,
    rollupDelta,
    errorsDelta,
    finished,
  };
}

function mergeRollupAtomic(prior: unknown, delta: RollupShape): RollupShape {
  const base: RollupShape =
    prior && typeof prior === 'object'
      ? {
          added: Number((prior as RollupShape).added ?? 0),
          reused: Number((prior as RollupShape).reused ?? 0),
          modified: Number((prior as RollupShape).modified ?? 0),
          skipped: Number((prior as RollupShape).skipped ?? 0),
          errorCount: Number((prior as RollupShape).errorCount ?? 0),
        }
      : emptyRollup();
  return {
    added: base.added + delta.added,
    reused: base.reused + delta.reused,
    modified: base.modified + delta.modified,
    skipped: base.skipped + delta.skipped,
    errorCount: base.errorCount + delta.errorCount,
  };
}

function mergeErrorsAtomic(prior: unknown, delta: RowError[]): RowError[] {
  const base = Array.isArray(prior) ? (prior as RowError[]) : [];
  return [...base, ...delta];
}

async function markJobCompleted(jobId: string): Promise<void> {
  await db
    .update(lexiconBulkJobs)
    .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
    .where(eq(lexiconBulkJobs.id, jobId));
}

async function markJobFailed(jobId: string, message: string): Promise<void> {
  await db
    .update(lexiconBulkJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      updatedAt: new Date(),
      errors: sql`COALESCE("errors", '[]'::jsonb) || ${JSON.stringify([
        { row: -1, code: 'plan_gate_required', message },
      ])}::jsonb`,
    })
    .where(eq(lexiconBulkJobs.id, jobId));
}
