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

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.selectQueue.length = 0;
  vi.mocked(getLexiconQuota).mockResolvedValue({ maxTerms: -1, bulkAsync: true, allowed: true });
  hoisted.select.mockImplementation(() => selectChain(hoisted.selectQueue.shift() ?? []));
  hoisted.txUpdateReturning.mockResolvedValue([{ id: 'job-1' }]);
  hoisted.txUpdateSet.mockReturnValue({
    where: vi.fn().mockReturnValue({ returning: hoisted.txUpdateReturning }),
  });
  hoisted.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const tx: Record<string, unknown> = {
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
    // 事务回调抛错 = 真实数据库里整个 chunk（含刚建的链接）回滚。
    await expect(hoisted.transaction.mock.results[0].value).rejects.toThrow(/claim lost/);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});
