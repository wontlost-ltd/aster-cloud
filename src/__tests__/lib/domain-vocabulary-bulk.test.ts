/**
 * Service-layer tests for bulkAddUserVocabularyTerms (B10).
 *
 * Reuses the chain-mock pattern from domain-vocabulary.test.ts so the
 * fluent Drizzle calls (select/insert/transaction) are exercised against
 * predictable resolved values. Focus is on the rollup arithmetic and the
 * quota cap path because the per-row machinery is shared with the
 * single-term add we already covered.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ThenableChain {
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  offset: ReturnType<typeof vi.fn>;
  then: (resolve: (value: unknown) => void) => void;
}

function makeChain(result: unknown): ThenableChain {
  const chain = {} as ThenableChain;
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.offset = vi.fn().mockReturnValue(chain);
  chain.then = (resolve) => resolve(result);
  return chain;
}

const hoisted = vi.hoisted(() => {
  const transaction = vi.fn();
  const select = vi.fn();
  const insert = vi.fn();
  const update = vi.fn();
  const findFirst = vi.fn();
  return { transaction, select, insert, update, findFirst };
});

vi.mock('@/lib/prisma', () => {
  const tableMock = new Proxy(
    {},
    {
      get: () => ({}),
    },
  );
  return {
    db: {
      transaction: hoisted.transaction,
      select: hoisted.select,
      insert: hoisted.insert,
      update: hoisted.update,
      query: { domainTerms: { findFirst: hoisted.findFirst } },
    },
    domainTerms: tableMock,
    userDomainTerms: tableMock,
    lexiconBulkJobs: tableMock,
  };
});

vi.mock('@/lib/usage', () => ({ getLexiconQuota: vi.fn() }));

vi.mock('@/lib/audit-log', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  BULK_SYNC_MAX_ROWS,
  bulkAddUserVocabularyTerms,
  type TermInput,
} from '@/lib/domain-vocabulary';
import { getLexiconQuota } from '@/lib/usage';
import { computeDedupKey, normalizeTermInput } from '@/lib/domain-vocabulary-validation';

/** 与服务端同一算法的 dedupKey，用来构造「已有词条」的查询结果。 */
function key(row: TermInput): string {
  return computeDedupKey(normalizeTermInput(row));
}

function failingInsertChain(error: Error) {
  const ret = vi.fn().mockRejectedValue(error);
  return { values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockReturnValue({ returning: ret }) }) };
}

const baseRow: TermInput = {
  domain: 'finance.loan',
  locale: 'en-US',
  kind: 'struct',
  canonical: 'Loan',
  localized: 'Loan',
};

const selectQueue: unknown[] = [];

function queueSelect(result: unknown) {
  selectQueue.push(result);
}

function makeInsertChain(returning: unknown[]) {
  const ret = vi.fn().mockResolvedValue(returning);
  const onConflict = vi.fn().mockReturnValue({ returning: ret });
  const valuesFn = vi
    .fn()
    .mockReturnValue({ onConflictDoNothing: onConflict, returning: ret });
  return {
    chain: { values: valuesFn },
    values: valuesFn,
    returning: ret,
  };
}

/**
 * 计数口径（#629）：每行恰好是 added / reused / skipped 之一，skipped 与行级错误一一对应；
 * 同步导入返回时所有行都已处理。
 */
function expectConsistentCounts(result: Awaited<ReturnType<typeof bulkAddUserVocabularyTerms>>) {
  const { added, reused, skipped, errorCount } = result.rollup;
  expect(result.processed).toBe(result.rowCount);
  expect(added + reused + skipped).toBe(result.rowCount);
  expect(errorCount).toBe(skipped);
  expect(result.errors).toHaveLength(errorCount);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  vi.mocked(getLexiconQuota).mockResolvedValue({
    maxTerms: 5000,
    bulkAsync: true,
    allowed: true,
  });
  hoisted.select.mockImplementation(() => {
    const next = selectQueue.shift() ?? [];
    return makeChain(next);
  });
  hoisted.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    // 嵌套 tx.transaction 即 SAVEPOINT：mock 里直接复用同一个 tx 执行回调，
    // 失败时把异常原样抛给 landBulkRow，模拟「只回滚本行」。
    const tx: Record<string, unknown> = {
      execute: vi.fn().mockResolvedValue(undefined),
      insert: hoisted.insert,
      update: hoisted.update,
      select: hoisted.select,
      query: { domainTerms: { findFirst: hoisted.findFirst } },
    };
    tx.transaction = vi.fn(async (inner: (sp: unknown) => unknown) => inner(tx));
    return fn(tx);
  });
});

describe('bulkAddUserVocabularyTerms', () => {
  it('throws validation_failed when the input array is empty', async () => {
    await expect(bulkAddUserVocabularyTerms('user-1', [])).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('throws validation_failed when input exceeds the sync cap', async () => {
    const rows = Array.from({ length: BULK_SYNC_MAX_ROWS + 1 }, () => baseRow);
    await expect(bulkAddUserVocabularyTerms('user-1', rows)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('throws plan_gate_required when the user cannot use customLexicon', async () => {
    vi.mocked(getLexiconQuota).mockResolvedValue({
      maxTerms: 0,
      bulkAsync: false,
      allowed: false,
    });
    await expect(
      bulkAddUserVocabularyTerms('user-1', [baseRow]),
    ).rejects.toMatchObject({ code: 'plan_gate_required' });
  });

  // 批量路径（landBulkChunk）的语句顺序：锁 → 配额计数 → 查已有词条 → （有词条时）查已有活跃链接
  // → 批量补建词条 → 批量建链接；最后写一条 sync 任务记录。
  it('counts add vs reused for two distinct rows', async () => {
    const borrower = { ...baseRow, canonical: 'Borrower', localized: 'Borrower' };
    queueSelect([{ count: 0 }]);
    queueSelect([{ id: 'term-b', dedupKey: key(borrower) }]); // Borrower 的全局词条已存在
    queueSelect([]); // 但用户还没有链接它
    hoisted.insert
      .mockReturnValueOnce(makeInsertChain([{ id: 'term-l', dedupKey: key(baseRow) }]).chain)
      .mockReturnValueOnce(makeInsertChain([{ termId: 'term-l' }, { termId: 'term-b' }]).chain)
      .mockReturnValueOnce(makeInsertChain([]).chain); // job row

    const result = await bulkAddUserVocabularyTerms('user-1', [baseRow, borrower]);

    expect(result.status).toBe('completed');
    expect(result.rowCount).toBe(2);
    expect(result.processed).toBe(2);
    expect(result.rollup).toMatchObject({ added: 1, reused: 1, skipped: 0, errorCount: 0 });
    expect(result.errors).toEqual([]);
    expectConsistentCounts(result);
  });

  it('skips trailing rows that would exceed the plan quota', async () => {
    vi.mocked(getLexiconQuota).mockResolvedValue({ maxTerms: 2, bulkAsync: false, allowed: true });
    // 用户已有 1 条，3 行里只能再落 1 行，其余两行报 quota_exceeded。
    queueSelect([{ count: 1 }]);
    queueSelect([]); // 无已有词条 → 不查链接
    const termInsert = makeInsertChain([{ id: 'term-1', dedupKey: key(baseRow) }]);
    hoisted.insert
      .mockReturnValueOnce(termInsert.chain)
      .mockReturnValueOnce(makeInsertChain([{ termId: 'term-1' }]).chain)
      .mockReturnValueOnce(makeInsertChain([]).chain); // job row

    const result = await bulkAddUserVocabularyTerms('user-1', [
      baseRow,
      { ...baseRow, canonical: 'Borrower', localized: 'Borrower' },
      { ...baseRow, canonical: 'Lender', localized: 'Lender' },
    ]);

    expect(result.rollup).toMatchObject({ added: 1, skipped: 2, errorCount: 2 });
    expect(result.errors.map((e) => [e.row, e.code])).toEqual([
      [1, 'quota_exceeded'],
      [2, 'quota_exceeded'],
    ]);
    expectConsistentCounts(result);
    // 超配额的行不应顺手建全局词条。
    expect(termInsert.values.mock.calls[0][0]).toHaveLength(1);
  });

  it('reports row-level validation errors without aborting valid rows', async () => {
    const lender = { ...baseRow, canonical: 'Lender', localized: 'Lender' };
    queueSelect([{ count: 0 }]);
    queueSelect([]);
    hoisted.insert
      .mockReturnValueOnce(makeInsertChain([{ id: 'term-1', dedupKey: key(lender) }]).chain)
      .mockReturnValueOnce(makeInsertChain([{ termId: 'term-1' }]).chain)
      .mockReturnValueOnce(makeInsertChain([]).chain); // job row

    const result = await bulkAddUserVocabularyTerms('user-1', [{ ...baseRow, canonical: '贷款' }, lender]);

    expect(result.rollup.added).toBe(1);
    expect(result.rollup.errorCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ row: 0, code: 'validation_failed' });
    // 校验失败的行也计入 processed（#629：此前同步路径漏算，出现 processed < skipped）
    expect(result.processed).toBe(2);
    expectConsistentCounts(result);
  });

  it('一行重复不拖垮整个 chunk：其余行照常导入，重复行报 duplicate_link（#606）', async () => {
    const ph = { ...baseRow, canonical: 'Policyholder', localized: 'Policyholder' };
    const driver = { ...baseRow, canonical: 'Driver', localized: 'Driver' };
    const premium = { ...baseRow, canonical: 'premium', localized: 'premium' };
    queueSelect([{ count: 0 }]);
    queueSelect([{ id: 'term-driver', dedupKey: key(driver) }]);
    queueSelect([{ termId: 'term-driver' }]); // Driver 已在用户词汇里
    const linkInsert = makeInsertChain([{ termId: 'term-ph' }, { termId: 'term-pr' }]);
    hoisted.insert
      .mockReturnValueOnce(
        makeInsertChain([
          { id: 'term-ph', dedupKey: key(ph) },
          { id: 'term-pr', dedupKey: key(premium) },
        ]).chain,
      )
      .mockReturnValueOnce(linkInsert.chain)
      .mockReturnValueOnce(makeInsertChain([]).chain); // job row

    const result = await bulkAddUserVocabularyTerms('user-1', [
      ph,
      driver,
      premium,
      { ...baseRow, canonical: '9bad', localized: '9bad' },
      ph, // 同批内重复
    ]);

    expect(result.rollup).toMatchObject({ added: 2, reused: 0, skipped: 3, errorCount: 3 });
    expect(result.errors.map((e) => [e.row, e.code])).toEqual([
      [1, 'duplicate_link'],
      [3, 'validation_failed'],
      [4, 'duplicate_link'],
    ]);
    expectConsistentCounts(result);
    // 重复行不会被送去插入，唯一约束根本不会触发。
    expect(linkInsert.values.mock.calls[0][0]).toHaveLength(2);
  });

  it('批量路径意外失败时退回逐行 SAVEPOINT，坏行只影响自己且不泄露数据库原文（#606）', async () => {
    const lender = { ...baseRow, canonical: 'Lender', localized: 'Lender' };
    const pgError = Object.assign(new Error('deadlock detected on relation "DomainTerm"'), {
      code: '40P01',
    });
    queueSelect([{ count: 0 }]);
    queueSelect([]);
    hoisted.insert
      .mockReturnValueOnce(failingInsertChain(pgError)) // 批量补建词条失败 → 回滚 SAVEPOINT
      .mockReturnValueOnce(failingInsertChain(pgError)) // 逐行：第 0 行仍失败
      .mockReturnValueOnce(makeInsertChain([{ id: 'term-2' }]).chain) // 第 1 行词条
      .mockReturnValueOnce(makeInsertChain([{ id: 'link-2' }]).chain) // 第 1 行链接
      .mockReturnValueOnce(makeInsertChain([]).chain); // job row
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await bulkAddUserVocabularyTerms('user-1', [baseRow, lender]);
    consoleSpy.mockRestore();

    expect(result.rollup.added).toBe(1);
    expect(result.errors).toEqual([
      { row: 0, code: 'row_failed', message: 'This row could not be saved. Please retry.' },
    ]);
    expectConsistentCounts(result);
  });

  it('整 chunk 失败时只返回通用消息（#606）', async () => {
    hoisted.transaction.mockRejectedValueOnce(
      new Error('duplicate key value violates unique constraint "UserDomainTerm_active_unique"'),
    );
    hoisted.insert.mockReturnValueOnce(makeInsertChain([]).chain); // job row
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await bulkAddUserVocabularyTerms('user-1', [baseRow]);
    consoleSpy.mockRestore();

    expect(result.errors).toEqual([
      { row: 0, code: 'chunk_failed', message: 'This batch could not be saved. Please retry.' },
    ]);
    expectConsistentCounts(result);
  });

  it('domain / locale 格式不合法的行报 validation_failed，合法 locale 规范大小写（#612）', async () => {
    queueSelect([{ count: 0 }]);
    queueSelect([]);
    const termInsert = makeInsertChain([{ id: 'term-1', dedupKey: key(baseRow) }]);
    hoisted.insert
      .mockReturnValueOnce(termInsert.chain)
      .mockReturnValueOnce(makeInsertChain([{ termId: 'term-1' }]).chain)
      .mockReturnValueOnce(makeInsertChain([]).chain); // job row

    const result = await bulkAddUserVocabularyTerms('user-1', [
      { ...baseRow, domain: 'E2E 1026' },
      { ...baseRow, locale: 'xx_INVALID!!' },
      { ...baseRow, locale: 'en-us' },
    ]);

    expect(result.errors.map((e) => [e.row, e.code])).toEqual([
      [0, 'validation_failed'],
      [1, 'validation_failed'],
    ]);
    expect(result.errors[0].message).toMatch(/domain/);
    expect(result.errors[1].message).toMatch(/BCP-47/);
    expect(termInsert.values).toHaveBeenCalledWith([expect.objectContaining({ locale: 'en-US' })]);
    expectConsistentCounts(result);
  });

  it('生产复现（#629）：有效 + 非法 domain + 非法 locale + 重复 → 计数自洽，持久化的任务行同口径', async () => {
    const driver = { ...baseRow, canonical: 'Driver', localized: 'Driver' };
    queueSelect([{ count: 0 }]);
    queueSelect([{ id: 'term-driver', dedupKey: key(driver) }]);
    queueSelect([{ termId: 'term-driver' }]); // Driver 已在用户词汇里
    const jobInsert = makeInsertChain([]);
    hoisted.insert
      .mockReturnValueOnce(makeInsertChain([{ id: 'term-l', dedupKey: key(baseRow) }]).chain)
      .mockReturnValueOnce(makeInsertChain([{ termId: 'term-l' }]).chain)
      .mockReturnValueOnce(jobInsert.chain); // job row

    const result = await bulkAddUserVocabularyTerms('user-1', [
      baseRow,
      { ...baseRow, domain: 'E2E 1027' },
      { ...baseRow, locale: 'xx_INVALID!!' },
      driver,
    ]);

    // 修复前：rowCount 4、processed 2、skipped 3
    expect(result).toMatchObject({ rowCount: 4, processed: 4 });
    expect(result.rollup).toMatchObject({ added: 1, reused: 0, skipped: 3, errorCount: 3 });
    expectConsistentCounts(result);
    expect(jobInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'sync', rowCount: 4, processed: 4 }),
    );
  });
});
