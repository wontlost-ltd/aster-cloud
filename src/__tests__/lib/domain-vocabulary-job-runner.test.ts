/**
 * processBulkJobChunk（异步批量 worker 的单 chunk 处理）：
 * - 与同步路径同一套行级语义：重复行报 duplicate_link（#606），格式非法报 validation_failed（#612）；
 * - 进度只在仍持有认领时提交（复审 P1）：处理中被取消 / 被别的 worker 接管时整块回滚。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  insert: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  txUpdateSet: vi.fn(),
  txUpdateReturning: vi.fn(),
  execute: vi.fn(),
  selectQueue: [] as unknown[],
}));

vi.mock('@/lib/prisma', () => {
  const tableProxy = new Proxy({}, { get: () => ({}) });
  return {
    db: {
      insert: hoisted.insert,
      select: hoisted.select,
      transaction: hoisted.transaction,
      update: vi.fn(),
    },
    domainTerms: tableProxy,
    userDomainTerms: tableProxy,
    lexiconBulkJobs: tableProxy,
  };
});

vi.mock('@/lib/usage', () => ({ getLexiconQuota: vi.fn() }));
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { processBulkJobChunk } from '@/lib/domain-vocabulary-job-runner';
import { computeDedupKey, normalizeTermInput } from '@/lib/domain-vocabulary-validation';
import { getLexiconQuota } from '@/lib/usage';
import { logAuditEvent } from '@/lib/audit-log';

function selectChain(result: unknown) {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
}

function insertChain(returning: unknown[]) {
  const ret = vi.fn().mockResolvedValue(returning);
  return { values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockReturnValue({ returning: ret }) }) };
}

const row = (canonical: string, extra: Record<string, unknown> = {}) => ({
  domain: 'insurance.auto',
  locale: 'de',
  kind: 'struct' as const,
  canonical,
  localized: canonical,
  ...extra,
});
const key = (r: ReturnType<typeof row>) => computeDedupKey(normalizeTermInput(r));

const job = (inputJson: unknown[]) => ({
  id: 'job-1',
  userId: 'user-1',
  rowCount: inputJson.length,
  processed: 0,
  rollup: {},
  errors: [],
  inputJson,
  claimedBy: 'worker-a:claim-1',
});

type Outcome = Awaited<ReturnType<typeof processBulkJobChunk>>;

/**
 * #629 计数口径：本次推进的每一行恰好是 added / reused / skipped 之一，
 * skipped 与行级错误一一对应（lost claim 时整块不生效，各项都是 0）。
 */
function expectDeltaInvariant(outcome: Outcome) {
  const { added, reused, skipped, errorCount } = outcome.rollupDelta;
  expect(added + reused + skipped).toBe(outcome.processedDelta);
  expect(errorCount).toBe(skipped);
  expect(outcome.errorsDelta).toHaveLength(errorCount);
}

/** 写回任务行的 processed / rollup / errors（取最近一次提交）。 */
function persisted() {
  const calls = hoisted.txUpdateSet.mock.calls;
  return calls[calls.length - 1][0] as {
    processed: number;
    rollup: { added: number; reused: number; skipped: number; errorCount: number };
    errors: unknown[];
    status: string;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.selectQueue.length = 0;
  vi.mocked(getLexiconQuota).mockResolvedValue({ maxTerms: -1, bulkAsync: true, allowed: true });
  hoisted.select.mockImplementation(() => selectChain(hoisted.selectQueue.shift() ?? []));
  hoisted.txUpdateReturning.mockResolvedValue([{ id: 'job-1' }]);
  hoisted.execute.mockResolvedValue(undefined);
  hoisted.txUpdateSet.mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: hoisted.txUpdateReturning }),
  });
  hoisted.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const tx: Record<string, unknown> = {
      execute: hoisted.execute,
      insert: hoisted.insert,
      select: hoisted.select,
      update: vi.fn(() => ({ set: hoisted.txUpdateSet })),
    };
    tx.transaction = vi.fn(async (inner: (sp: unknown) => unknown) => inner(tx));
    return fn(tx);
  });
});

describe('processBulkJobChunk', () => {
  it('重复行只记 duplicate_link，同 chunk 其余行照常导入并完成任务', async () => {
    const driver = row('Driver');
    hoisted.selectQueue.push([{ id: 'term-driver', dedupKey: key(driver) }], [{ termId: 'term-driver' }]);
    hoisted.insert
      .mockReturnValueOnce(
        insertChain([
          { id: 'term-ph', dedupKey: key(row('Policyholder')) },
          { id: 'term-pr', dedupKey: key(row('premium')) },
        ]),
      )
      .mockReturnValueOnce(insertChain([{ termId: 'term-ph' }, { termId: 'term-pr' }]));

    const outcome = await processBulkJobChunk(
      job([row('Policyholder'), driver, row('premium'), row('Claim', { locale: 'xx_INVALID!!' })]),
    );

    expect(outcome).toMatchObject({ finished: true, lostClaim: false });
    expect(outcome.rollupDelta).toMatchObject({ added: 2, reused: 0, skipped: 2, errorCount: 2 });
    expectDeltaInvariant(outcome);
    expect(outcome.errorsDelta.map((e) => [e.row, e.code])).toEqual([
      [1, 'duplicate_link'],
      [3, 'validation_failed'],
    ]);
    expect(hoisted.txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', processed: 4, claimedBy: null }),
    );
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ status: 'completed' }) }),
    );
  });

  it('chunk 处理期间任务被取消：提交命中 0 行 → 整块回滚，不覆盖 cancelled', async () => {
    hoisted.selectQueue.push([]);
    hoisted.insert
      .mockReturnValueOnce(insertChain([{ id: 'term-1', dedupKey: key(row('Vehicle')) }]))
      .mockReturnValueOnce(insertChain([{ termId: 'term-1' }]));
    hoisted.txUpdateReturning.mockResolvedValueOnce([]); // status 已是 cancelled / 认领已换人

    const outcome = await processBulkJobChunk(job([row('Vehicle')]));

    expect(outcome).toMatchObject({ lostClaim: true, finished: false, processedDelta: 0 });
    expectDeltaInvariant(outcome);
    // 事务回调抛错 = 真实数据库里整个 chunk（含刚建的链接）回滚。
    await expect(hoisted.transaction.mock.results[0].value).rejects.toThrow(/claim lost/);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it('配额锁在 chunk 事务内获取（与单条新增、同步批量同一把锁）', async () => {
    hoisted.selectQueue.push([]);
    hoisted.insert
      .mockReturnValueOnce(insertChain([{ id: 'term-1', dedupKey: key(row('Vehicle')) }]))
      .mockReturnValueOnce(insertChain([{ termId: 'term-1' }]));

    await processBulkJobChunk(job([row('Vehicle')]));

    expect(hoisted.execute).toHaveBeenCalledTimes(1);
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const lockSql = new PgDialect().sqlToQuery(hoisted.execute.mock.calls[0][0]).sql;
    expect(lockSql).toContain('pg_advisory_xact_lock');
  });

  it('批量路径失败转逐行退路且超出 deadline：只提交已处理的行，余下留给下次', async () => {
    const failing = {
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error('batch failed')),
        }),
      }),
    };
    hoisted.selectQueue.push([]);
    hoisted.insert
      .mockReturnValueOnce(failing) // 批量补建词条失败 → 退回逐行
      .mockReturnValueOnce(insertChain([{ id: 'term-a' }])) // 第 0 行词条
      .mockReturnValueOnce(insertChain([{ id: 'link-a' }])); // 第 0 行链接
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await processBulkJobChunk(
      job([row('Alpha'), row('Bad', { domain: 'Bad Domain' }), row('Gamma')]),
      { deadline: 0 }, // 早已过期：处理完第一行就停
    );
    spy.mockRestore();

    expect(outcome).toMatchObject({ processedDelta: 2, finished: false, lostClaim: false });
    expect(outcome.rollupDelta).toMatchObject({ added: 1 });
    expectDeltaInvariant(outcome);
    // 第 1 行校验失败、位于停止点之前 → 保留；Gamma 未处理，留给下次。
    expect(outcome.errorsDelta.map((e) => [e.row, e.code])).toEqual([[1, 'validation_failed']]);
    expect(hoisted.txUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ processed: 2, status: 'queued' }),
    );
  });
  it('#629 跨两次认领（超时停下 → 下次续跑）：完成时 processed = rowCount = added + reused + skipped', async () => {
    const failing = {
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockRejectedValue(new Error('batch failed')),
        }),
      }),
    };
    const input = [row('Alpha'), row('Bad', { domain: 'Bad Domain' }), row('Gamma')];
    hoisted.selectQueue.push([]);
    hoisted.insert
      .mockReturnValueOnce(failing)
      .mockReturnValueOnce(insertChain([{ id: 'term-a' }]))
      .mockReturnValueOnce(insertChain([{ id: 'link-a' }]));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await processBulkJobChunk(job(input), { deadline: 0 });
    spy.mockRestore();
    expectDeltaInvariant(first);
    const afterFirst = persisted();

    // 第二次认领：从 processed=2 续跑，带着第一次写回的 rollup / errors
    hoisted.selectQueue.push([]);
    hoisted.insert
      .mockReturnValueOnce(insertChain([{ id: 'term-g', dedupKey: key(row('Gamma')) }]))
      .mockReturnValueOnce(insertChain([{ termId: 'term-g' }]));
    const second = await processBulkJobChunk({
      ...job(input),
      processed: afterFirst.processed,
      rollup: afterFirst.rollup,
      errors: afterFirst.errors,
    });
    expectDeltaInvariant(second);

    const final = persisted();
    expect(final).toMatchObject({ status: 'completed', processed: 3 });
    expect(final.rollup.added + final.rollup.reused + final.rollup.skipped).toBe(3);
    expect(final.rollup.errorCount).toBe(final.rollup.skipped);
    expect(final.errors).toHaveLength(final.rollup.errorCount);
  });

  it('#629 chunk 事务意外失败：异常上抛、进度与计数都不写回（下次认领整块重做，不会重复计数）', async () => {
    hoisted.transaction.mockRejectedValueOnce(new Error('connection reset'));
    await expect(processBulkJobChunk(job([row('Vehicle')]))).rejects.toThrow('connection reset');
    expect(hoisted.txUpdateSet).not.toHaveBeenCalled();
  });
});
