/**
 * Lexicon observability metrics (B14) — Prometheus text exposition.
 *
 * Mirrors src/lib/license-metrics.ts conventions:
 *   - Own Registry so we do not pollute the default prom-client registry
 *   - Low-cardinality labels only (op + status, source); never user IDs or
 *     raw vocabulary text
 *   - Helpers exported for the service layer to record per-mutation events
 *     and for the admin metrics route to render the latest gauges
 */

import { Counter, Gauge, Histogram, Registry } from 'prom-client';

const registry = new Registry();

const termTotal = new Gauge({
  name: 'aster_lexicon_term_total',
  help: 'Total DomainTerm rows by source.',
  labelNames: ['source'] as const,
  registers: [registry],
});

const userLinkTotal = new Gauge({
  name: 'aster_lexicon_user_link_total',
  help: 'Active UserDomainTerm links (excluding soft-deleted and archived).',
  registers: [registry],
});

const opTotal = new Counter({
  name: 'aster_lexicon_op_total',
  help: 'Lexicon mutation outcome count by operation and status.',
  labelNames: ['op', 'status'] as const,
  registers: [registry],
});

const opDurationSeconds = new Histogram({
  name: 'aster_lexicon_op_duration_seconds',
  help: 'Per-operation duration buckets for lexicon mutations.',
  labelNames: ['op'] as const,
  registers: [registry],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

const bulkJobDurationSeconds = new Histogram({
  name: 'aster_lexicon_bulk_job_duration_seconds',
  help: 'End-to-end bulk job duration buckets (sync and async terminal).',
  labelNames: ['mode'] as const,
  registers: [registry],
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 3600],
});

const bulkJobRowsProcessedTotal = new Counter({
  name: 'aster_lexicon_bulk_job_rows_processed_total',
  help: 'Bulk job rows successfully processed (added or reused), labelled by mode.',
  labelNames: ['mode'] as const,
  registers: [registry],
});

const snapshotTotal = new Gauge({
  name: 'aster_lexicon_snapshot_total',
  help: 'Current UserVocabularySnapshot row count.',
  registers: [registry],
});

const snapshotDedupRatio = new Gauge({
  name: 'aster_lexicon_snapshot_dedup_ratio',
  help: 'Snapshot dedup hit ratio over the lifetime of this process (0..1).',
  registers: [registry],
});

// #638：带词汇的执行前提取输入类型的结果；failed 表示执行被拒（422），需要排查源码与解析器差异。
const inputTypeExtractionTotal = new Counter({
  name: 'aster_lexicon_input_type_extraction_total',
  help: 'Execution-time input type extraction outcomes for policies executed with a vocabulary.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

let snapshotCreateAttempts = 0;
let snapshotCreateHits = 0;

export type LexiconOp =
  | 'term.add'
  | 'term.modify'
  | 'term.delete'
  | 'term.restore'
  | 'bulk.sync'
  | 'bulk.async_enqueue'
  | 'bulk.async_chunk'
  | 'snapshot.create'
  | 'snapshot.release'
  | 'snapshot.rollback';

export type LexiconOpStatus = 'success' | 'error' | 'partial';

/** Record a single mutation outcome. */
export function recordLexiconOp(op: LexiconOp, status: LexiconOpStatus): void {
  opTotal.inc({ op, status });
}

/**
 * Record a mutation duration. Use with `process.hrtime.bigint()` (ns) or
 * Date.now() (ms) — caller converts to seconds.
 */
export function observeLexiconOpDuration(op: LexiconOp, seconds: number): void {
  if (Number.isFinite(seconds) && seconds >= 0) {
    opDurationSeconds.observe({ op }, seconds);
  }
}

export function observeBulkJobDuration(mode: 'sync' | 'async', seconds: number): void {
  if (Number.isFinite(seconds) && seconds >= 0) {
    bulkJobDurationSeconds.observe({ mode }, seconds);
  }
}

export function recordBulkJobRowsProcessed(mode: 'sync' | 'async', rows: number): void {
  if (Number.isFinite(rows) && rows > 0) {
    bulkJobRowsProcessedTotal.inc({ mode }, rows);
  }
}

/**
 * Track snapshot create attempts and dedup hits. The gauge ratio is updated
 * after every attempt so the latest scrape always reflects the running
 * process-lifetime ratio.
 */
export function recordSnapshotCreate(opts: { dedupHit: boolean }): void {
  snapshotCreateAttempts += 1;
  if (opts.dedupHit) snapshotCreateHits += 1;
  const ratio =
    snapshotCreateAttempts > 0 ? snapshotCreateHits / snapshotCreateAttempts : 0;
  snapshotDedupRatio.set(Number.isFinite(ratio) ? ratio : 0);
}

/** 记录一次执行前输入类型提取的结果（#638）。 */
export function recordInputTypeExtraction(outcome: 'ok' | 'extraction_failed' | 'entry_ambiguous'): void {
  inputTypeExtractionTotal.inc({ outcome });
}

/** Setter for the term-total gauge by source. Caller derives the count. */
export function setLexiconTermTotal(source: string, count: number): void {
  termTotal.set({ source }, count);
}

/** Setter for the active user-link gauge. Caller derives the count. */
export function setLexiconUserLinkTotal(count: number): void {
  userLinkTotal.set(count);
}

/** Setter for the snapshot total gauge. Caller derives the count. */
export function setLexiconSnapshotTotal(count: number): void {
  snapshotTotal.set(count);
}

/** Prometheus content type, as advertised by prom-client. */
export function lexiconMetricsContentType(): string {
  return registry.contentType;
}

/** Render the full lexicon registry as Prometheus text exposition. */
export async function renderLexiconMetrics(): Promise<string> {
  return registry.metrics();
}

/** Snapshot of the in-process counters, used by tests. */
export function snapshotCounters(): {
  snapshotCreateAttempts: number;
  snapshotCreateHits: number;
} {
  return { snapshotCreateAttempts, snapshotCreateHits };
}

/** Reset all counters/gauges. Test-only. */
export function _resetLexiconMetricsForTest(): void {
  registry.resetMetrics();
  snapshotCreateAttempts = 0;
  snapshotCreateHits = 0;
}
