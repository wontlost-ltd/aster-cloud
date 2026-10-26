/**
 * Job-service tests for B11. Focused on:
 *   - enqueue rejects unsupported plans + bad row counts
 *   - getBulkJob returns scoped row (or null on mismatch)
 *   - cancelBulkJob flips status when allowed and is a no-op otherwise
 *
 * The chunk processor is exercised through processQueuedBulkJobs with a
 * mocked db so we don't try to exercise full Drizzle relational queries.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  findFirst: vi.fn(),
  findMany: vi.fn(),
  insertValues: vi.fn().mockResolvedValue(undefined),
  insert: vi.fn(() => ({ values: hoisted.insertValues })),
  updateReturning: vi.fn(),
  updateWhere: vi.fn(() => ({ returning: hoisted.updateReturning })),
  updateSet: vi.fn(() => ({ where: hoisted.updateWhere })),
  update: vi.fn(() => ({ set: hoisted.updateSet })),
  execute: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tableProxy = new Proxy({}, { get: () => ({}) });
  return {
    db: {
      insert: hoisted.insert,
      update: hoisted.update,
      execute: hoisted.execute,
      query: {
        lexiconBulkJobs: { findFirst: hoisted.findFirst, findMany: hoisted.findMany },
      },
    },
    lexiconBulkJobs: tableProxy,
    userDomainTerms: tableProxy,
  };
});

vi.mock('@/lib/usage', () => ({ getLexiconQuota: vi.fn() }));

vi.mock('@/lib/audit-log', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/domain-vocabulary-job-runner', () => ({
  processBulkJobChunk: vi.fn(),
  ownedClaim: vi.fn((jobId: string, token: string) => ({ ownedClaim: [jobId, token] })),
}));

import {
  cancelBulkJob,
  enqueueBulkJob,
  getBulkJob,
  listBulkJobs,
  processQueuedBulkJobs,
} from '@/lib/domain-vocabulary-jobs';
import { getLexiconQuota } from '@/lib/usage';
import { ownedClaim, processBulkJobChunk } from '@/lib/domain-vocabulary-job-runner';
import { VocabularyError } from '@/lib/domain-vocabulary';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLexiconQuota).mockResolvedValue({
    maxTerms: 5000,
    bulkAsync: true,
    allowed: true,
  });
  hoisted.insert.mockImplementation(() => ({ values: hoisted.insertValues }));
  hoisted.insertValues.mockResolvedValue(undefined);
  hoisted.update.mockImplementation(() => ({ set: hoisted.updateSet }));
  hoisted.updateSet.mockImplementation(() => ({ where: hoisted.updateWhere }));
  hoisted.updateWhere.mockImplementation(() => ({ returning: hoisted.updateReturning }));
  hoisted.updateReturning.mockResolvedValue([]);
  hoisted.execute.mockResolvedValue({ rows: [] });
});

describe('enqueueBulkJob', () => {
  it('rejects empty inputs with validation_failed', async () => {
    await expect(enqueueBulkJob('user-1', [])).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('rejects rows above the async ceiling', async () => {
    await expect(enqueueBulkJob('user-1', Array.from({ length: 10_001 }, () => ({}))))
      .rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects when plan disables custom lexicon', async () => {
    vi.mocked(getLexiconQuota).mockResolvedValue({
      maxTerms: 0,
      bulkAsync: false,
      allowed: false,
    });
    await expect(enqueueBulkJob('user-1', [{ foo: 'bar' }])).rejects.toBeInstanceOf(
      VocabularyError,
    );
  });

  it('rejects when plan does not allow async bulk', async () => {
    vi.mocked(getLexiconQuota).mockResolvedValue({
      maxTerms: 500,
      bulkAsync: false,
      allowed: true,
    });
    await expect(enqueueBulkJob('user-1', [{ foo: 'bar' }])).rejects.toMatchObject({
      code: 'plan_gate_required',
    });
  });

  it('persists a queued row when accepted', async () => {
    const result = await enqueueBulkJob('user-1', [{ foo: 'bar' }, { foo: 'baz' }]);

    expect(result.status).toBe('queued');
    expect(result.mode).toBe('async');
    expect(result.rowCount).toBe(2);
    expect(hoisted.insert).toHaveBeenCalled();
    expect(hoisted.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued', rowCount: 2 }),
    );
  });
});

describe('getBulkJob', () => {
  it('returns null when the row does not belong to the user', async () => {
    hoisted.findFirst.mockResolvedValue(undefined);

    const result = await getBulkJob('user-1', 'job-1');

    expect(result).toBeNull();
  });

  it('maps the row to the JobView shape', async () => {
    hoisted.findFirst.mockResolvedValue({
      id: 'job-1',
      userId: 'user-1',
      status: 'running',
      mode: 'async',
      rowCount: 100,
      processed: 50,
      rollup: { added: 50 },
      errors: [],
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T01:00:00Z'),
      completedAt: null,
    });

    const result = await getBulkJob('user-1', 'job-1');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('job-1');
    expect(result?.status).toBe('running');
    expect(result?.processed).toBe(50);
  });
});

describe('cancelBulkJob', () => {
  it('returns cancelled=false when the row is missing or already terminal', async () => {
    hoisted.updateReturning.mockResolvedValue([]);

    const result = await cancelBulkJob('user-1', 'job-1');

    expect(result.cancelled).toBe(false);
  });

  it('returns cancelled=true when the update flips a row', async () => {
    hoisted.updateReturning.mockResolvedValue([{ id: 'job-1' }]);

    const result = await cancelBulkJob('user-1', 'job-1');

    expect(result.cancelled).toBe(true);
  });
});

describe('processQueuedBulkJobs', () => {
  it('returns zero claims when no queued jobs are available', async () => {
    // recoverStaleRunning uses update().set().where().returning() — no rows.
    // Every claimNextJob iteration returns empty rows from db.execute.
    hoisted.execute.mockResolvedValue({ rows: [] });

    const summary = await processQueuedBulkJobs({ workerId: 'worker-1', maxJobs: 2 });

    expect(summary.claimed).toBe(0);
    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.scanned).toBe(1);
  });

  const queuedRow = {
    id: 'job-1',
    userId: 'user-1',
    rowCount: 1,
    processed: 0,
    rollup: {},
    errors: [],
    inputJson: [],
  };

  it('chunk 处理器抛错时只在仍持有认领时标 failed，且不把原始错误写给用户', async () => {
    hoisted.execute.mockResolvedValueOnce({ rows: [queuedRow] }).mockResolvedValue({ rows: [] });
    hoisted.updateReturning.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'job-1' }]);
    vi.mocked(processBulkJobChunk).mockRejectedValueOnce(new Error('connection to 10.0.0.1 lost'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const summary = await processQueuedBulkJobs({ workerId: 'worker-1', maxJobs: 2 });
    spy.mockRestore();

    expect(summary.claimed).toBe(1);
    expect(summary.failed).toBe(1);
    // 认领令牌 = workerId + 每次认领独立的 UUID；失败迁移带着它。
    const [jobId, token] = vi.mocked(ownedClaim).mock.calls[0];
    expect(jobId).toBe('job-1');
    expect(token).toMatch(/^worker-1:[0-9a-f-]{36}$/);
    expect(hoisted.updateWhere).toHaveBeenLastCalledWith({ ownedClaim: ['job-1', token] });
    expect(JSON.stringify(hoisted.updateSet.mock.calls.at(-1))).not.toContain('10.0.0.1');
  });

  it('认领失效（处理中被取消）计入 lost，不当作失败', async () => {
    hoisted.execute.mockResolvedValueOnce({ rows: [queuedRow] }).mockResolvedValue({ rows: [] });
    vi.mocked(processBulkJobChunk).mockResolvedValueOnce({
      processedDelta: 0,
      rollupDelta: { added: 0, reused: 0, modified: 0, skipped: 0, errorCount: 0 },
      errorsDelta: [],
      finished: false,
      lostClaim: true,
    });

    const summary = await processQueuedBulkJobs({ workerId: 'worker-1', maxJobs: 1 });

    expect(summary).toMatchObject({ claimed: 1, lost: 1, failed: 0, completed: 0 });
  });

  it('超过时间预算后不再认领新 chunk', async () => {
    hoisted.execute.mockResolvedValue({ rows: [queuedRow] });
    vi.mocked(processBulkJobChunk).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 15));
      return {
        processedDelta: 1,
        rollupDelta: { added: 1, reused: 0, modified: 0, skipped: 0, errorCount: 0 },
        errorsDelta: [],
        finished: false,
        lostClaim: false,
      };
    });

    const summary = await processQueuedBulkJobs({ workerId: 'worker-1', maxJobs: 100, budgetMs: 10 });

    expect(summary.claimed).toBe(1);
  });
});

describe('listBulkJobs（#605）', () => {
  const row = {
    id: 'job-1',
    userId: 'user-1',
    status: 'queued',
    mode: 'async',
    rowCount: 3,
    processed: 0,
    rollup: null,
    errors: null,
    createdAt: new Date('2026-10-26T00:00:00Z'),
    updatedAt: new Date('2026-10-26T00:00:00Z'),
    completedAt: null,
  };

  it('不读取 inputJson，并把空 rollup/errors 规范成空值', async () => {
    hoisted.findMany.mockResolvedValue([row]);
    const jobs = await listBulkJobs('user-1', { activeOnly: true, limit: 1 });
    expect(jobs).toEqual([{ ...row, rollup: {}, errors: [] }]);
    const args = hoisted.findMany.mock.calls[0][0];
    expect(args.columns).toEqual({ inputJson: false });
    expect(args.limit).toBe(1);
  });

  it('limit 截在 1..50', async () => {
    hoisted.findMany.mockResolvedValue([]);
    await listBulkJobs('user-1', { limit: 999 });
    await listBulkJobs('user-1', { limit: 0 });
    expect(hoisted.findMany.mock.calls.map((c) => c[0].limit)).toEqual([50, 1]);
  });
});
