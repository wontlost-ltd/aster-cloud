/**
 * Async bulk import jobs (B11)
 *
 * Sits next to the sync path in domain-vocabulary.ts but covers the larger
 * upload window (≤10k rows). The job lifecycle is:
 *
 *   queued (enqueue)
 *     → running (worker claim)
 *       → completed | failed | cancelled
 *
 * Each worker tick processes ONE chunk so we fit in Cloudflare Workers'
 * scheduled() budget. Subsequent ticks reclaim the same row by status and
 * advance `processed` until it equals rowCount, at which point the worker
 * marks the job completed.
 *
 * Claim safety: the SQL is an atomic update on (status='queued') that flips
 * to 'running' and returns the row. Concurrent workers issue the same query;
 * only one gets a row back.
 */

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, lexiconBulkJobs } from '@/lib/prisma';
import { logAuditEvent } from '@/lib/audit-log';
import { bypassQueryCache } from '@/db/fresh-read';
import { getLexiconQuota } from '@/lib/usage';
import {
  BULK_ASYNC_MAX_ROWS,
  VocabularyError,
} from '@/lib/domain-vocabulary';

/**
 * 每个 tick 停止认领新 chunk 的时间预算。Workers 单次请求的 CPU/墙钟都有限，
 * 一块 250 行在批量路径下只需个位数条语句，20s 足够推进多块又远离上限。
 */
export const TICK_BUDGET_MS = 20_000;

/**
 * running 超过此时长视为 worker 已死、回收为 queued。必须远大于「预算 + 单块耗时」，
 * 否则仍在处理的 chunk 会被回收；即便发生，提交时的认领校验（ownedClaim）也会让旧 worker
 * 的提交落空，不会出现两份进度。
 */
export const STALE_RUNNING_AGE_MS = 5 * 60_000;

export interface EnqueuedJob {
  jobId: string;
  status: 'queued';
  mode: 'async';
  rowCount: number;
}

export interface JobView {
  id: string;
  userId: string;
  status: string;
  mode: string;
  rowCount: number;
  processed: number;
  rollup: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

/**
 * Enqueue an async bulk import. Returns the job id immediately; the worker
 * (driven by /api/cron/domain-vocabulary-bulk-worker) processes it later.
 *
 * The route handler is responsible for plan-gate + auth checks before
 * calling this; we just do quota-eligibility (async-flag) and row-count
 * bounds.
 */
export async function enqueueBulkJob(
  userId: string,
  rows: readonly unknown[],
  idempotencyKey?: string,
): Promise<EnqueuedJob> {
  if (rows.length === 0) {
    throw new VocabularyError(
      'validation_failed',
      'async bulk import requires at least one term',
    );
  }
  if (rows.length > BULK_ASYNC_MAX_ROWS) {
    throw new VocabularyError(
      'validation_failed',
      `async bulk import accepts at most ${BULK_ASYNC_MAX_ROWS} rows`,
    );
  }

  const quota = await getLexiconQuota(userId);
  if (!quota.allowed) {
    throw new VocabularyError(
      'plan_gate_required',
      'Custom domain vocabulary requires an eligible plan',
    );
  }
  if (!quota.bulkAsync) {
    throw new VocabularyError(
      'plan_gate_required',
      'Async bulk import requires a Pro plan or higher',
    );
  }

  const jobId = crypto.randomUUID();
  await db.insert(lexiconBulkJobs).values({
    id: jobId,
    userId,
    idempotencyKey: idempotencyKey ?? null,
    status: 'queued',
    mode: 'async',
    rowCount: rows.length,
    processed: 0,
    rollup: {},
    errors: [],
    inputJson: rows as Array<unknown>,
  });

  await logAuditEvent({
    userId,
    action: 'lexicon.term.add',
    resource: 'domain-term-bulk',
    resourceId: jobId,
    metadata: { mode: 'async', rowCount: rows.length, status: 'queued' },
  });

  return { jobId, status: 'queued', mode: 'async', rowCount: rows.length };
}

/** Read a job's current state (caller is the owner; admin paths bypass this). */
export async function getBulkJob(userId: string, jobId: string): Promise<JobView | null> {
  const row = await db.query.lexiconBulkJobs.findFirst({
    // 进度轮询是写后读：绕过 Hyperdrive 查询缓存，否则进度会卡在 60s 前的值。
    where: and(eq(lexiconBulkJobs.id, jobId), eq(lexiconBulkJobs.userId, userId), bypassQueryCache()),
  });
  if (!row) return null;
  return mapJob(row);
}

/** 列表默认/最大条数：只服务于「刷新后找回任务」和近期导入回顾，不做深分页。 */
export const BULK_JOB_LIST_DEFAULT_LIMIT = 20;
export const BULK_JOB_LIST_MAX_LIMIT = 50;

/**
 * 列出调用者最近的批量导入任务（#605：刷新页面后仍能找回 queued/running 的任务）。
 *
 * - 按 createdAt 倒序；`activeOnly` 只返回 queued/running。
 * - 不读取 inputJson（最大 4 MiB），列表只需要进度与汇总。
 */
export async function listBulkJobs(
  userId: string,
  opts: { activeOnly?: boolean; limit?: number } = {},
): Promise<JobView[]> {
  const limit = Math.min(
    BULK_JOB_LIST_MAX_LIMIT,
    Math.max(1, opts.limit ?? BULK_JOB_LIST_DEFAULT_LIMIT),
  );
  // 刷新后找回任务同样是写后读，必须绕过 Hyperdrive 查询缓存。
  const conditions = [eq(lexiconBulkJobs.userId, userId), bypassQueryCache()];
  if (opts.activeOnly) conditions.push(inArray(lexiconBulkJobs.status, ['queued', 'running']));
  const rows = await db.query.lexiconBulkJobs.findMany({
    where: and(...conditions),
    columns: { inputJson: false },
    orderBy: [desc(lexiconBulkJobs.createdAt)],
    limit,
  });
  return rows.map(mapJob);
}

function mapJob(row: Omit<typeof lexiconBulkJobs.$inferSelect, 'inputJson'>): JobView {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    mode: row.mode,
    rowCount: row.rowCount,
    processed: row.processed,
    rollup: (row.rollup as Record<string, unknown> | null) ?? {},
    errors: (row.errors as Array<Record<string, unknown>> | null) ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

/**
 * Atomic claim: flip exactly one queued row to running and return it.
 *
 * Postgres `UPDATE ... WHERE status='queued' ... RETURNING` is the single
 * write that decides which worker owns the row, so no extra locking is
 * required. The LIMIT 1 + ORDER BY ensures FIFO ordering across workers.
 */
async function claimNextJob(claimToken: string): Promise<typeof lexiconBulkJobs.$inferSelect | null> {
  const claimedAt = new Date();
  const result = await db.execute(sql`
    UPDATE "LexiconBulkJob"
       SET status = 'running',
           "claimedBy" = ${claimToken},
           "claimedAt" = ${claimedAt.toISOString()},
           "updatedAt" = ${claimedAt.toISOString()}
     WHERE id IN (
       SELECT id FROM "LexiconBulkJob"
        WHERE status = 'queued'
        ORDER BY "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `);
  const rows = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (result as unknown as Array<Record<string, unknown>>);
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0] as unknown as typeof lexiconBulkJobs.$inferSelect;
}

/**
 * Re-queue jobs that have been "running" for more than STALE_RUNNING_AGE_MS
 * (likely from a worker that died mid-chunk). This is a best-effort sweep
 * that runs at the top of each worker tick.
 */
async function recoverStaleRunning(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_RUNNING_AGE_MS);
  const updated = await db
    .update(lexiconBulkJobs)
    .set({ status: 'queued', claimedBy: null, claimedAt: null, updatedAt: new Date() })
    .where(and(eq(lexiconBulkJobs.status, 'running'), lt(lexiconBulkJobs.claimedAt, cutoff)))
    .returning({ id: lexiconBulkJobs.id });
  return updated.length;
}

interface ProcessSummary {
  scanned: number;
  claimed: number;
  completed: number;
  failed: number;
  recovered: number;
  /** 提交时认领已失效（被取消 / 被回收）的 chunk 数。 */
  lost: number;
}

/**
 * Process up to `maxJobs` queued jobs in one worker tick.
 *
 * We import the chunk processor lazily to avoid a circular dependency
 * with domain-vocabulary.ts (which exports the same upsert primitives).
 */
export async function processQueuedBulkJobs(opts: {
  workerId: string;
  maxJobs?: number;
  /** 超过该时长（ms）后不再认领新 chunk；默认 {@link TICK_BUDGET_MS}。 */
  budgetMs?: number;
}): Promise<ProcessSummary> {
  const maxJobs = Math.max(1, opts.maxJobs ?? 4);
  const budgetMs = opts.budgetMs ?? TICK_BUDGET_MS;
  const startedAt = Date.now();
  const recovered = await recoverStaleRunning();
  const summary: ProcessSummary = {
    scanned: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    recovered,
    lost: 0,
  };

  // Lazy import to dodge the cycle between this file and domain-vocabulary.ts.
  const { ownedClaim, processBulkJobChunk } = await import('@/lib/domain-vocabulary-job-runner');

  for (let i = 0; i < maxJobs && Date.now() - startedAt < budgetMs; i += 1) {
    summary.scanned += 1;
    // 每次认领一个独立令牌：同一 tick 内连续处理同一任务的多个 chunk 也互不混淆。
    const claimToken = `${opts.workerId}:${crypto.randomUUID()}`;
    const job = await claimNextJob(claimToken);
    if (!job) break;
    summary.claimed += 1;

    try {
      const outcome = await processBulkJobChunk(job, { deadline: startedAt + budgetMs });
      if (outcome.lostClaim) summary.lost += 1;
      else if (outcome.finished) summary.completed += 1;
    } catch (err) {
      summary.failed += 1;
      await failClaimedJob(job, claimToken, err, ownedClaim);
    }
  }

  return summary;
}

/**
 * worker 崩溃时把任务标为 failed——只在仍持有认领时生效，绝不覆盖用户的取消。
 */
async function failClaimedJob(
  job: { id: string; userId: string },
  claimToken: string,
  err: unknown,
  ownedClaim: (jobId: string, token: string) => ReturnType<typeof and>,
): Promise<void> {
  console.error('[domain-vocabulary-bulk-worker] chunk failed', err);
  const failed = await db
    .update(lexiconBulkJobs)
    .set({
      status: 'failed',
      updatedAt: new Date(),
      completedAt: new Date(),
      errors: sql`COALESCE("errors", '[]'::jsonb) || ${JSON.stringify([
        { row: -1, code: 'worker_crash', message: 'The import stopped unexpectedly. Please retry.' },
      ])}::jsonb`,
    })
    .where(ownedClaim(job.id, claimToken))
    .returning({ id: lexiconBulkJobs.id });
  if (failed.length === 0) return;
  await logAuditEvent({
    userId: job.userId,
    action: 'lexicon.term.add',
    resource: 'domain-term-bulk',
    resourceId: job.id,
    metadata: { mode: 'async', status: 'failed', reason: 'worker_crash' },
  });
}

/**
 * Cancel a queued or running job from the user's side. Workers honour the
 * status flip at chunk boundaries.
 */
export async function cancelBulkJob(userId: string, jobId: string): Promise<{ cancelled: boolean }> {
  const updated = await db
    .update(lexiconBulkJobs)
    .set({ status: 'cancelled', updatedAt: new Date(), completedAt: new Date() })
    .where(
      and(
        eq(lexiconBulkJobs.id, jobId),
        eq(lexiconBulkJobs.userId, userId),
        // Only queued or running jobs can be cancelled; terminal states are no-ops.
        sql`${lexiconBulkJobs.status} IN ('queued', 'running')`,
      ),
    )
    .returning({ id: lexiconBulkJobs.id });
  if (updated.length === 0) {
    return { cancelled: false };
  }
  await logAuditEvent({
    userId,
    action: 'lexicon.term.delete',
    resource: 'domain-term-bulk',
    resourceId: jobId,
    metadata: { mode: 'async', status: 'cancelled' },
  });
  return { cancelled: true };
}

