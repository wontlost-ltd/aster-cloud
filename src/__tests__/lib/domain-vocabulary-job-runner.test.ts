/**
 * processBulkJobChunk（异步批量 worker 的单 chunk 处理）：
 * 与同步路径同一套行级语义——重复行报 duplicate_link 而不是拖垮整个 chunk（#606），
 * domain/locale 格式非法的行报 validation_failed（#612）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  insert: vi.fn(),
  select: vi.fn(),
  findFirst: vi.fn(),
  transaction: vi.fn(),
  updateSet: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tableProxy = new Proxy({}, { get: () => ({}) });
  return {
    db: {
      insert: hoisted.insert,
      select: hoisted.select,
      transaction: hoisted.transaction,
      update: vi.fn(() => ({ set: hoisted.updateSet })),
      query: { domainTerms: { findFirst: hoisted.findFirst } },
    },
    domainTerms: tableProxy,
    userDomainTerms: tableProxy,
    lexiconBulkJobs: tableProxy,
  };
});

vi.mock('@/lib/usage', () => ({ getLexiconQuota: vi.fn() }));
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: vi.fn().mockResolvedValue(undefined) }));

import { processBulkJobChunk } from '@/lib/domain-vocabulary-job-runner';
import { getLexiconQuota } from '@/lib/usage';

function insertChain(returning: unknown[]) {
  const ret = vi.fn().mockResolvedValue(returning);
  return { values: vi.fn().mockReturnValue({ onConflictDoNothing: vi.fn().mockReturnValue({ returning: ret }) }) };
}

const row = (canonical: string, extra: Record<string, unknown> = {}) => ({
  domain: 'insurance.auto',
  locale: 'de',
  kind: 'struct',
  canonical,
  localized: canonical,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLexiconQuota).mockResolvedValue({ maxTerms: -1, bulkAsync: true, allowed: true });
  hoisted.updateSet.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  hoisted.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const tx: Record<string, unknown> = {
      insert: hoisted.insert,
      query: { domainTerms: { findFirst: hoisted.findFirst } },
    };
    tx.transaction = vi.fn(async (inner: (sp: unknown) => unknown) => inner(tx));
    return fn(tx);
  });
});

describe('processBulkJobChunk', () => {
  it('重复行只记 duplicate_link，同 chunk 其余行照常导入并完成任务', async () => {
    hoisted.insert
      .mockReturnValueOnce(insertChain([{ id: 'term-ph' }]))
      .mockReturnValueOnce(insertChain([{ id: 'link-ph' }]))
      .mockReturnValueOnce(insertChain([]))
      .mockReturnValueOnce(insertChain([]))
      .mockReturnValueOnce(insertChain([{ id: 'term-pr' }]))
      .mockReturnValueOnce(insertChain([{ id: 'link-pr' }]));
    hoisted.findFirst.mockResolvedValueOnce({ id: 'term-driver' });

    const outcome = await processBulkJobChunk({
      id: 'job-1',
      userId: 'user-1',
      rowCount: 4,
      processed: 0,
      rollup: {},
      errors: [],
      inputJson: [
        row('Policyholder'),
        row('Driver'),
        row('premium'),
        row('Claim', { locale: 'xx_INVALID!!' }),
      ],
    });

    expect(outcome.finished).toBe(true);
    expect(outcome.rollupDelta).toMatchObject({ added: 2, reused: 0, skipped: 2, errorCount: 2 });
    expect(outcome.errorsDelta.map((e) => [e.row, e.code])).toEqual([
      [1, 'duplicate_link'],
      [3, 'validation_failed'],
    ]);
    expect(hoisted.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', processed: 4 }),
    );
  });
});
