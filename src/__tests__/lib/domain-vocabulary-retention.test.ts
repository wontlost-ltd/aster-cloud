/**
 * Retention + DSAR tests (B13).
 *
 * Focus:
 *   - archiveDowngradedUserVocabulary scans users and is idempotent when a
 *     scanned user has no active links.
 *   - purgeUserVocabulary deletes snapshots + bulk jobs + idempotency keys,
 *     because those tables either have no FK (snapshots) or only cascade
 *     when the user row itself is deleted (the others).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  selectChain: vi.fn(),
  insertValues: vi.fn().mockResolvedValue(undefined),
  insert: vi.fn(() => ({ values: hoisted.insertValues })),
  updateReturning: vi.fn(),
  updateWhere: vi.fn(() => ({ returning: hoisted.updateReturning })),
  updateSet: vi.fn(() => ({ where: hoisted.updateWhere })),
  update: vi.fn(() => ({ set: hoisted.updateSet })),
  deleteReturning: vi.fn(),
  deleteWhere: vi.fn(() => ({ returning: hoisted.deleteReturning })),
  delete: vi.fn(() => ({ where: hoisted.deleteWhere })),
  execute: vi.fn(),
  transaction: vi.fn(),
  savepoint: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tableProxy = new Proxy({}, { get: () => ({}) });
  return {
    db: {
      select: hoisted.selectChain,
      insert: hoisted.insert,
      update: hoisted.update,
      delete: hoisted.delete,
      execute: hoisted.execute,
      transaction: hoisted.transaction,
      query: {
        userVocabularySnapshots: { findFirst: hoisted.findFirst },
      },
    },
    users: tableProxy,
    userDomainTerms: tableProxy,
    userVocabularySnapshots: tableProxy,
    userVocabularyVersions: tableProxy,
    lexiconBulkJobs: tableProxy,
    lexiconIdempotencyKeys: tableProxy,
  };
});

vi.mock('@/lib/audit-log', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  archiveDowngradedUserVocabulary,
  purgeUserVocabulary,
} from '@/lib/domain-vocabulary-retention';

interface ThenChain {
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  then: (resolve: (v: unknown) => void) => void;
}

function makeChain(result: unknown): ThenChain {
  const chain = {} as ThenChain;
  chain.from = vi.fn().mockReturnValue(chain);
  chain.innerJoin = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.then = (resolve) => resolve(result);
  return chain;
}

const selectQueue: unknown[] = [];

function queueSelect(result: unknown) {
  selectQueue.push(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  hoisted.selectChain.mockImplementation(() => makeChain(selectQueue.shift() ?? []));
  hoisted.insert.mockImplementation(() => ({ values: hoisted.insertValues }));
  hoisted.insertValues.mockResolvedValue(undefined);
  hoisted.update.mockImplementation(() => ({ set: hoisted.updateSet }));
  hoisted.updateSet.mockImplementation(() => ({ where: hoisted.updateWhere }));
  hoisted.updateWhere.mockImplementation(() => ({ returning: hoisted.updateReturning }));
  hoisted.updateReturning.mockResolvedValue([]);
  hoisted.delete.mockImplementation(() => ({ where: hoisted.deleteWhere }));
  hoisted.deleteWhere.mockImplementation(() => ({ returning: hoisted.deleteReturning }));
  hoisted.deleteReturning.mockResolvedValue([]);
  hoisted.execute.mockResolvedValue({ rows: [] });
  hoisted.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const tx: Record<string, unknown> = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      insert: hoisted.insert,
      update: hoisted.update,
      select: hoisted.selectChain,
      delete: hoisted.delete,
      query: {
        userVocabularySnapshots: { findFirst: hoisted.findFirst },
      },
    };
    // 嵌套 transaction = 保存点；在 mock 里直接复用同一个 tx。
    tx.transaction = hoisted.savepoint;
    hoisted.savepoint.mockImplementation(async (inner: (sp: unknown) => unknown) => inner(tx));
    return fn(tx);
  });
});

describe('archiveDowngradedUserVocabulary', () => {
  it('returns zero counts when no downgraded users exist', async () => {
    queueSelect([]); // findDowngradedUsers → empty

    const outcome = await archiveDowngradedUserVocabulary(new Date('2026-05-01T00:00:00Z'));

    expect(outcome.usersScanned).toBe(0);
    expect(outcome.usersArchived).toBe(0);
    expect(outcome.linksArchived).toBe(0);
  });

  it('scans candidates but skips users with no active links', async () => {
    queueSelect([{ id: 'user-1' }]);
    // archiveLinksForUser now uses tx.execute for the joined active-link
    // query — the default tx mock returns { rows: [] } so the function
    // takes the empty-rows early-return branch.

    const outcome = await archiveDowngradedUserVocabulary(new Date('2026-05-01T00:00:00Z'));

    expect(outcome.usersScanned).toBe(1);
    expect(outcome.usersArchived).toBe(0);
    expect(outcome.linksArchived).toBe(0);
  });
});

describe('purgeUserVocabulary', () => {
  it('deletes links, bulk jobs, idempotency keys, and snapshots inside one transaction', async () => {
    // The new ordering is: UserDomainTerm (no returning) →
    // LexiconBulkJob (returning) → LexiconIdempotencyKey (returning) →
    // UserVocabularySnapshot (returning). We must script the deleteWhere
    // mock in that exact order.
    hoisted.deleteReturning
      .mockResolvedValueOnce([{ id: 'b1' }]) // bulk jobs
      .mockResolvedValueOnce([{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }]) // idempotency
      .mockResolvedValueOnce([{ id: 's1' }, { id: 's2' }]); // snapshots
    hoisted.deleteWhere
      // First call: UserDomainTerm (no returning) — represent as a thenable.
      .mockReturnValueOnce(
        Promise.resolve(undefined) as unknown as { returning: typeof hoisted.deleteReturning },
      )
      .mockReturnValueOnce({ returning: hoisted.deleteReturning })
      .mockReturnValueOnce({ returning: hoisted.deleteReturning })
      .mockReturnValueOnce({ returning: hoisted.deleteReturning })
      // 最后：UserVocabularyVersion（必须在删词条之后，否则 DELETE 触发器会重建它）。
      .mockReturnValueOnce(
        Promise.resolve(undefined) as unknown as { returning: typeof hoisted.deleteReturning },
      );

    const outcome = await purgeUserVocabulary('user-1');

    expect(outcome.snapshotsDeleted).toBe(2);
    expect(outcome.bulkJobsDeleted).toBe(1);
    expect(outcome.idempotencyDeleted).toBe(3);
    expect(hoisted.delete).toHaveBeenCalledTimes(5);
    expect(hoisted.transaction).toHaveBeenCalledTimes(1);
    // 版本行删除放在保存点里，迁移窗口内缺表不会毁掉外层事务。
    expect(hoisted.savepoint).toHaveBeenCalledTimes(1);
  });

  // 迁移窗口：Worker 已部署而 0059 未应用，UserVocabularyVersion 不存在。
  function scriptPurgeWithVersionDelete(versionDeleteError: unknown) {
    hoisted.deleteReturning
      .mockResolvedValueOnce([{ id: 'b1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 's1' }]);
    hoisted.deleteWhere
      .mockReturnValueOnce(
        Promise.resolve(undefined) as unknown as { returning: typeof hoisted.deleteReturning },
      )
      .mockReturnValueOnce({ returning: hoisted.deleteReturning })
      .mockReturnValueOnce({ returning: hoisted.deleteReturning })
      .mockReturnValueOnce({ returning: hoisted.deleteReturning })
      // 惰性构造 rejected promise，避免在被 await 之前就成为未处理的拒绝。
      .mockImplementationOnce(
        () => Promise.reject(versionDeleteError) as unknown as { returning: typeof hoisted.deleteReturning },
      );
  }

  it('迁移窗口：版本表缺失（42P01）时跳过该步，其余清理照常提交', async () => {
    const undefinedTable = Object.assign(new Error('Failed query: delete from "UserVocabularyVersion"'), {
      cause: { code: '42P01' },
    });
    scriptPurgeWithVersionDelete(undefinedTable);

    const outcome = await purgeUserVocabulary('user-1');

    expect(outcome).toEqual({ snapshotsDeleted: 1, bulkJobsDeleted: 1, idempotencyDeleted: 0 });
    expect(hoisted.savepoint).toHaveBeenCalledTimes(1);
  });

  it('版本行删除遇到 42P01 以外的错误照常抛出，整个清理回滚', async () => {
    scriptPurgeWithVersionDelete(Object.assign(new Error('boom'), { code: '08006' }));

    await expect(purgeUserVocabulary('user-1')).rejects.toThrow('boom');
  });
});
