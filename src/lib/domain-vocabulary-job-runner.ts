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
import { db, lexiconBulkJobs } from '@/lib/prisma';
import { logAuditEvent } from '@/lib/audit-log';
import { getLexiconQuota } from '@/lib/usage';
import {
  applyVocabularyScopeFormat,
  normalizeTermInput,
  assembleDomainVocabularyFromLinks,
  requiresParent,
  validateDomainVocabulary,
  type NormalizedTermInput,
  type TermKind,
} from '@/lib/domain-vocabulary-validation';
import {
  landBulkChunk,
  lockUserQuotaAndCountRemaining,
  VocabularyError,
  type BulkChunkRow,
} from '@/lib/domain-vocabulary';

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

const QUOTA_MESSAGE = 'Plan quota reached while processing async chunk';

type PreparedRow =
  | { ok: true; value: NormalizedTermInput }
  | { ok: false; code: 'validation_failed'; message: string };

function invalid(message: string): PreparedRow {
  return { ok: false, code: 'validation_failed', message };
}

/**
 * 行级校验（与同步路径同一口径）：结构 → 必填 → domain/locale 格式（#612）→
 * 上游词汇校验。全部是纯函数，不触碰数据库。
 */
function prepareRow(raw: unknown): PreparedRow {
  const parsed = tryNormalize(raw);
  if (!parsed.ok) return invalid(parsed.error);
  const normalized = normalizeTermInput(parsed.value);
  if (!normalized.canonical || !normalized.localized) {
    return invalid('canonical and localized are required');
  }
  const formatted = applyVocabularyScopeFormat(normalized);
  if (!formatted.ok) return invalid(formatted.message);
  const value = formatted.value;
  if (requiresParent(value.kind) && !value.parentCanonical) {
    return invalid(`parentCanonical is required for kind=${value.kind}`);
  }
  const validation = validateDomainVocabulary(
    assembleDomainVocabularyFromLinks(
      [
        {
          domainTermId: 'preview',
          domain: value.domain,
          locale: value.locale,
          kind: value.kind,
          canonical: value.canonical,
          localized: value.localized,
          parentCanonical: value.parentCanonical,
          aliases: value.aliases,
          description: value.description,
        },
      ],
      { domain: value.domain, locale: value.locale },
    ),
  );
  if (!validation.valid) return invalid(validation.errors.join('; '));
  return { ok: true, value };
}

interface ChunkOutcome {
  processedDelta: number;
  rollupDelta: RollupShape;
  errorsDelta: RowError[];
  finished: boolean;
  /** 提交时认领已失效（被取消或被回收后由别的 worker 认领），本 chunk 未生效。 */
  lostClaim: boolean;
}

/**
 * 认领所有权谓词（#605 复审）：任务仍是 running 且仍由本次认领持有。
 *
 * 所有由 worker 发起的状态迁移（推进进度、完成、失败）都必须带上它：
 * - 用户在 chunk 处理中途取消 → status 已是 cancelled，迁移命中 0 行，取消不会被覆盖；
 * - 认领超时被回收并由别的 worker 重新认领 → claimedBy 已换人，旧 worker 的提交命中 0 行。
 */
export function ownedClaim(jobId: string, claimToken: string) {
  return and(
    eq(lexiconBulkJobs.id, jobId),
    eq(lexiconBulkJobs.status, 'running'),
    eq(lexiconBulkJobs.claimedBy, claimToken),
  );
}

/** 提交进度时发现认领已失效：抛出以回滚整个 chunk 事务（本 chunk 的链接一并撤销）。 */
class LostClaimError extends Error {
  constructor() {
    super('bulk job claim lost before chunk commit');
  }
}

interface ClaimedJob {
  id: string;
  userId: string;
  rowCount: number;
  processed: number;
  rollup: unknown;
  errors: unknown;
  inputJson: unknown;
  /** claimNextJob 写入的认领令牌（LexiconBulkJob.claimedBy）。 */
  claimedBy: string | null;
}


/**
 * 处理一个 chunk。`deadline`（epoch ms）只约束逐行退路：批量路径整块只需个位数语句；
 * 退路每行约 4 次往返，超时就只提交已处理的行，余下留给下一次认领。
 * 两条路径的最坏耗时都远小于超时回收阈值（5 分钟），回收不会与正常处理重叠。
 */
export async function processBulkJobChunk(
  job: ClaimedJob,
  opts: { deadline?: number } = {},
): Promise<ChunkOutcome> {
  const claimToken = job.claimedBy ?? '';
  const inputRows = parseInput(job.inputJson);
  const startIndex = job.processed;
  const chunk = inputRows.slice(startIndex, Math.min(inputRows.length, startIndex + CHUNK_SIZE));
  const rollupDelta = emptyRollup();
  const errorsDelta: RowError[] = [];

  if (chunk.length === 0) {
    const done = await markJobCompleted(job.id, claimToken);
    return { processedDelta: 0, rollupDelta, errorsDelta, finished: done, lostClaim: !done };
  }

  const quota = await getLexiconQuota(job.userId);
  if (!quota.allowed) {
    await markJobFailed(job.id, claimToken, 'Custom domain vocabulary requires an eligible plan');
    throw new VocabularyError('plan_gate_required', 'Plan no longer allows custom vocabulary');
  }
  // 行级校验（纯内存）先做，失败行直接记错误；合法行整块交给 landBulkChunk。
  const valid: BulkChunkRow[] = [];
  chunk.forEach((raw, i) => {
    const prepared = prepareRow(raw);
    if (prepared.ok) valid.push({ row: startIndex + i, normalized: prepared.value });
    else errorsDelta.push({ row: startIndex + i, code: prepared.code, message: prepared.message });
  });

  let processedNow = startIndex + chunk.length;
  let finished = processedNow >= job.rowCount;
  let mergedRollup: RollupShape = emptyRollup();

  try {
    await db.transaction(async (tx) => {
      // 与单条新增、同步批量同一把用户配额锁，并在锁内计数（复审 P1）：
      // 锁外计数会让并发写入看见同一个余量而越过套餐上限。
      const remainingQuota = await lockUserQuotaAndCountRemaining(tx, job.userId, quota.maxTerms);
      const landed = await landBulkChunk(
        tx,
        job.userId,
        valid,
        remainingQuota,
        QUOTA_MESSAGE,
        opts.deadline,
      );
      if (landed.stoppedAt !== undefined) {
        // 逐行退路超时提前停下：进度只推进到第一条未处理的行，之后行的校验错误也留到下次。
        processedNow = valid[landed.stoppedAt].row;
        finished = false;
        const kept = errorsDelta.filter((e) => e.row < processedNow);
        errorsDelta.length = 0;
        errorsDelta.push(...kept);
      }
      errorsDelta.push(...landed.errors);
      errorsDelta.sort((a, b) => a.row - b.row);
      rollupDelta.added = landed.added;
      rollupDelta.reused = landed.reused;
      rollupDelta.skipped = errorsDelta.length;
      rollupDelta.errorCount = errorsDelta.length;
      mergedRollup = mergeRollupAtomic(job.rollup, rollupDelta);

      // 进度与链接在同一事务里提交，且只在仍持有认领时生效（原子 UPDATE … RETURNING）。
      // 非最后一块把任务放回 queued 并清空认领，下一次认领会刷新 claimedAt（相当于续租）。
      const committed = await tx
        .update(lexiconBulkJobs)
        .set({
          processed: processedNow,
          rollup: mergedRollup,
          errors: mergeErrorsAtomic(job.errors, errorsDelta),
          status: finished ? 'completed' : 'queued',
          claimedBy: null,
          claimedAt: null,
          completedAt: finished ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(ownedClaim(job.id, claimToken))
        .returning({ id: lexiconBulkJobs.id });
      if (committed.length === 0) throw new LostClaimError();
    });
  } catch (err) {
    if (!(err instanceof LostClaimError)) throw err;
    return { processedDelta: 0, rollupDelta: emptyRollup(), errorsDelta: [], finished: false, lostClaim: true };
  }

  if (finished) {
    await logAuditEvent({
      userId: job.userId,
      action: 'lexicon.term.add',
      resource: 'domain-term-bulk',
      resourceId: job.id,
      metadata: { mode: 'async', status: 'completed', rowCount: job.rowCount, ...mergedRollup },
    });
  }

  return { processedDelta: processedNow - startIndex, rollupDelta, errorsDelta, finished, lostClaim: false };
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

async function markJobCompleted(jobId: string, claimToken: string): Promise<boolean> {
  const updated = await db
    .update(lexiconBulkJobs)
    .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
    .where(ownedClaim(jobId, claimToken))
    .returning({ id: lexiconBulkJobs.id });
  return updated.length > 0;
}

async function markJobFailed(jobId: string, claimToken: string, message: string): Promise<void> {
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
    .where(ownedClaim(jobId, claimToken));
}
