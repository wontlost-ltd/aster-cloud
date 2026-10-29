/**
 * Service-layer unit tests for domain-vocabulary.
 *
 * These tests mock `@/lib/prisma` (the db client + schema re-exports) and
 * `@/lib/usage` / `@/lib/audit-log` so we can exercise the orchestration paths
 * (quota check → upsert → insert link → audit log) without touching a real DB.
 *
 * Drizzle's fluent chain is mocked with returning-aware stubs so the service
 * code can call `db.select(...).from(...).innerJoin(...).where(...).orderBy(...).limit(...).offset(...)`
 * and `db.transaction(fn)` the same way it would against postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --------------------------------------------------------------------------
// Drizzle/db mock plumbing
// --------------------------------------------------------------------------

interface ChainBuilder {
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  offset: ReturnType<typeof vi.fn>;
  result: unknown;
}

function makeChain(result: unknown): ChainBuilder {
  const chain: ChainBuilder = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    offset: vi.fn(),
    result,
  };
  // Each step returns the same chain object (Drizzle is a builder).
  // Terminal awaits resolve to `result`. We achieve this by returning a
  // thenable from the chain.
  const thenable = {
    ...chain,
    then: (resolve: (v: unknown) => void) => resolve(chain.result),
  };
  chain.from.mockReturnValue(thenable);
  chain.innerJoin.mockReturnValue(thenable);
  chain.where.mockReturnValue(thenable);
  chain.orderBy.mockReturnValue(thenable);
  chain.limit.mockReturnValue(thenable);
  chain.offset.mockReturnValue(thenable);
  return chain;
}

const hoisted = vi.hoisted(() => {
  const transaction = vi.fn();
  const select = vi.fn();
  const insert = vi.fn();
  const update = vi.fn();
  const findFirst = vi.fn();

  return {
    transaction,
    select,
    insert,
    update,
    findFirst,
  };
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
      query: {
        domainTerms: { findFirst: hoisted.findFirst },
      },
    },
    domainTerms: tableMock,
    userDomainTerms: tableMock,
  };
});

vi.mock('@/lib/usage', () => ({
  getLexiconQuota: vi.fn(),
}));

vi.mock('@/lib/audit-log', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  VocabularyError,
  addUserVocabularyTerm,
  modifyUserVocabularyTerm,
  restoreUserVocabularyTerm,
  softDeleteUserVocabularyTerm,
  type TermInput,
} from '@/lib/domain-vocabulary';
import { getLexiconQuota } from '@/lib/usage';
import { parseVocabularyValidationMessage } from '@/lib/vocabulary-validation-message';
import { logAuditEvent } from '@/lib/audit-log';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const baseInput: TermInput = {
  domain: 'finance.loan',
  locale: 'en-US',
  kind: 'struct',
  canonical: 'Loan',
  localized: 'Loan',
};

function joinedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    termId: 'term-1',
    userId: 'user-1',
    domain: 'finance.loan',
    locale: 'en-US',
    kind: 'struct',
    canonical: 'Loan',
    localized: 'Loan',
    parentCanonical: null,
    aliases: [],
    description: null,
    source: 'user',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * Service code uses two `db.select(...)` shapes:
 *   - getTermLink:  select(fields).from(udt).innerJoin(dt).where(...).limit(1)
 *   - countActiveTerms / listUserVocabularyTerms count branch:
 *                  select({count}).from(udt).where(...)
 * `selectQueue` lets a test enqueue results for each select call in order.
 */
const selectQueue: unknown[] = [];

function queueSelectResult(result: unknown) {
  selectQueue.push(result);
}

function makeInsertChain(returning: unknown[]) {
  const ret = vi.fn().mockResolvedValue(returning);
  const onConflict = vi.fn().mockReturnValue({ returning: ret });
  return {
    chain: {
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: onConflict,
        returning: ret,
      }),
    },
    returning: ret,
    onConflict,
  };
}

function makeUpdateChain(returningRows: unknown[] = [{ id: 'link-1' }]) {
  const returning = vi.fn().mockResolvedValue(returningRows);
  // Both terminal-where and where-then-returning shapes are supported so
  // a single helper works for both modify (where as terminal) and
  // softDelete (where then returning).
  const where = vi.fn().mockImplementation(() => {
    const whenAwaited = Promise.resolve(undefined);
    return Object.assign(whenAwaited, { returning });
  });
  return {
    chain: {
      set: vi.fn().mockReturnValue({ where }),
    },
    where,
    returning,
  };
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

  // Default transaction: invoke the callback with a mock tx that exposes the
  // same hoisted mocks so individual tests can queue results/assert calls.
  // tx.execute is the advisory-lock acquire path; tx.select satisfies the
  // in-transaction quota count read.
  hoisted.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    return fn({
      execute: vi.fn().mockResolvedValue(undefined),
      insert: hoisted.insert,
      update: hoisted.update,
      select: hoisted.select,
      query: {
        domainTerms: { findFirst: hoisted.findFirst },
      },
    });
  });
});

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('addUserVocabularyTerm', () => {
  it('inserts a global term and the user link when the dedup key is new', async () => {
    // countActiveTerms → 0
    queueSelectResult([{ count: 0 }]);
    // 作用域冲突校验：同分组无其它词条
    queueSelectResult([]);
    // getTermLink (post-insert reload) → link row
    queueSelectResult([joinedRow()]);

    const termInsert = makeInsertChain([{ id: 'term-new' }]);
    const linkInsert = makeInsertChain([{ id: 'link-new' }]);
    hoisted.insert
      .mockReturnValueOnce(termInsert.chain)
      .mockReturnValueOnce(linkInsert.chain);

    const result = await addUserVocabularyTerm('user-1', baseInput);

    expect(result.createdGlobalTerm).toBe(true);
    expect(result.link.id).toBe('link-1');
    expect(termInsert.chain.values).toHaveBeenCalled();
    expect(linkInsert.chain.values).toHaveBeenCalled();
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'lexicon.term.add',
        resource: 'domain-term',
      }),
    );
  });

  it('reuses an existing global term when the dedup key matches', async () => {
    queueSelectResult([{ count: 0 }]);
    queueSelectResult([]);
    queueSelectResult([joinedRow()]);

    const termInsert = makeInsertChain([]); // ON CONFLICT DO NOTHING returned 0 rows
    const linkInsert = makeInsertChain([{ id: 'link-new' }]);
    hoisted.insert
      .mockReturnValueOnce(termInsert.chain)
      .mockReturnValueOnce(linkInsert.chain);

    hoisted.findFirst.mockResolvedValue({ id: 'existing-term' });

    const result = await addUserVocabularyTerm('user-1', baseInput);

    expect(result.createdGlobalTerm).toBe(false);
    expect(hoisted.findFirst).toHaveBeenCalled();
  });

  it('throws plan_gate_required when custom lexicon is unavailable', async () => {
    vi.mocked(getLexiconQuota).mockResolvedValue({
      maxTerms: 0,
      bulkAsync: false,
      allowed: false,
    });

    await expect(addUserVocabularyTerm('user-1', baseInput)).rejects.toMatchObject({
      code: 'plan_gate_required',
    });
    expect(hoisted.transaction).not.toHaveBeenCalled();
  });

  it('throws quota_exceeded inside the transaction when the user has filled the quota', async () => {
    vi.mocked(getLexiconQuota).mockResolvedValue({
      maxTerms: 2,
      bulkAsync: false,
      allowed: true,
    });
    // In-transaction count read → 2 → meets cap → throw quota_exceeded.
    queueSelectResult([{ count: 2 }]);

    await expect(addUserVocabularyTerm('user-1', baseInput)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    // Quota check happens inside the txn, so transaction IS invoked but no
    // insert should be issued.
    expect(hoisted.transaction).toHaveBeenCalled();
    expect(hoisted.insert).not.toHaveBeenCalled();
  });

  it('rejects invalid canonical identifiers without ever touching the DB', async () => {
    await expect(
      addUserVocabularyTerm('user-1', { ...baseInput, canonical: '贷款' }),
    ).rejects.toBeInstanceOf(VocabularyError);
    expect(getLexiconQuota).not.toHaveBeenCalled();
  });
});

describe('作用域冲突校验（ADR 0051 §8）', () => {
  const field = (canonical: string, localized: string) => ({
    ...baseInput, domain: 'grades', locale: 'de', kind: 'field' as const, canonical, localized, parentCanonical: 'Driver',
  });

  it('Stufe（类型）已存在时可保存 stufe（字段）', async () => {
    queueSelectResult([{ count: 1 }]);
    queueSelectResult([joinedRow({ id: 'link-0', domain: 'grades', locale: 'de', canonical: 'Level', localized: 'Stufe' })]);
    queueSelectResult([joinedRow({ kind: 'field', canonical: 'level', localized: 'stufe', parentCanonical: 'Driver' })]);
    hoisted.insert
      .mockReturnValueOnce(makeInsertChain([{ id: 'term-new' }]).chain)
      .mockReturnValueOnce(makeInsertChain([{ id: 'link-new' }]).chain);

    const result = await addUserVocabularyTerm('user-1', field('level', 'stufe'));

    expect(result.link.localized).toBe('stufe');
    expect(hoisted.insert).toHaveBeenCalledTimes(2);
  });

  it('同父结构下写法相同、规范名不同的字段被拒，消息可识别为 scopeConflict', async () => {
    queueSelectResult([{ count: 1 }]);
    queueSelectResult([
      joinedRow({ id: 'link-0', domain: 'grades', locale: 'de', kind: 'field', canonical: 'age', localized: 'alter', parentCanonical: 'Driver' }),
    ]);

    const error = await addUserVocabularyTerm('user-1', field('years', 'alter')).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'validation_failed' });
    expect(parseVocabularyValidationMessage((error as Error).message)?.reason).toBe('scopeConflict');
    expect(hoisted.insert).not.toHaveBeenCalled();
  });

  it('枚举成员与字段一样必须指定父类型（ADR 0051 §14 第 3 条）', async () => {
    const error = await addUserVocabularyTerm('user-1', {
      ...baseInput, kind: 'enum_value', canonical: 'High', localized: 'Hoch',
    }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'validation_failed', message: 'parentCanonical is required for kind=enum_value' });
    expect(parseVocabularyValidationMessage((error as Error).message)?.reason).toBe('parentRequired');
    expect(getLexiconQuota).not.toHaveBeenCalled();
  });

  it('修改时排除链接自身，不与自己的旧写法冲突', async () => {
    queueSelectResult([joinedRow({ id: 'link-1', kind: 'field', canonical: 'age', localized: 'alter', parentCanonical: 'Driver' })]);
    queueSelectResult([joinedRow({ id: 'link-1', kind: 'field', canonical: 'age', localized: 'alter', parentCanonical: 'Driver' })]);
    queueSelectResult([joinedRow({ id: 'link-1', kind: 'field', canonical: 'years', localized: 'alter', parentCanonical: 'Driver' })]);
    hoisted.insert.mockReturnValueOnce(makeInsertChain([{ id: 'term-new' }]).chain);
    hoisted.update.mockReturnValueOnce(makeUpdateChain().chain);

    const result = await modifyUserVocabularyTerm('user-1', 'link-1', field('years', 'alter'));

    expect(result.link.canonical).toBe('years');
  });
});

describe('modifyUserVocabularyTerm', () => {
  it('repoints the link to a new term and audits the change', async () => {
    // getTermLink (existing) → returns current row with termId='term-old'
    queueSelectResult([joinedRow({ termId: 'term-old' })]);
    // 作用域冲突校验：分组里只有被修改的链接自身（应被排除）
    queueSelectResult([joinedRow({ termId: 'term-old', localized: 'Loan V2', canonical: 'Other' })]);
    // getTermLink (post-update reload) → returns row with new termId
    queueSelectResult([joinedRow({ termId: 'term-new' })]);

    const termInsert = makeInsertChain([{ id: 'term-new' }]);
    hoisted.insert.mockReturnValueOnce(termInsert.chain);

    const updateChain = makeUpdateChain();
    hoisted.update.mockReturnValueOnce(updateChain.chain);

    const result = await modifyUserVocabularyTerm('user-1', 'link-1', {
      ...baseInput,
      canonical: 'LoanV2',
      localized: 'Loan V2',
    });

    expect(result.repointed).toBe(true);
    expect(result.createdGlobalTerm).toBe(true);
    expect(updateChain.chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ termId: 'term-new' }),
    );
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'lexicon.term.modify',
        metadata: expect.objectContaining({
          previousTermId: 'term-old',
          newTermId: 'term-new',
          repointed: true,
        }),
      }),
    );
  });

  it('throws not_found when the link does not exist or is deleted', async () => {
    queueSelectResult([]);

    await expect(
      modifyUserVocabularyTerm('user-1', 'missing', baseInput),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(hoisted.transaction).not.toHaveBeenCalled();
  });
});

describe('softDeleteUserVocabularyTerm', () => {
  it('marks the link deleted and writes an audit entry', async () => {
    queueSelectResult([joinedRow()]);

    const updateChain = makeUpdateChain();
    hoisted.update.mockReturnValueOnce(updateChain.chain);

    const result = await softDeleteUserVocabularyTerm('user-1', 'link-1', 'cleanup');

    expect(result.deletedAt).toBeInstanceOf(Date);
    expect(updateChain.chain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedBy: 'user-1',
        deletedReason: 'cleanup',
      }),
    );
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lexicon.term.delete' }),
    );
  });

  it('throws not_found when the link is missing', async () => {
    queueSelectResult([]);

    await expect(softDeleteUserVocabularyTerm('user-1', 'link-1')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('restoreUserVocabularyTerm', () => {
  it('clears deletedAt and reloads the link', async () => {
    // includeDeleted lookup → returns row
    queueSelectResult([joinedRow()]);
    // 作用域冲突校验：分组内无同写法条目
    queueSelectResult([]);
    // post-update reload → returns row
    queueSelectResult([joinedRow()]);

    const updateChain = makeUpdateChain();
    hoisted.update.mockReturnValueOnce(updateChain.chain);

    const result = await restoreUserVocabularyTerm('user-1', 'link-1');

    expect(result.link.id).toBe('link-1');
    expect(updateChain.chain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedAt: null,
        deletedBy: null,
        deletedReason: null,
      }),
    );
    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lexicon.term.restore' }),
    );
  });

  it('throws not_found when the link is missing', async () => {
    queueSelectResult([]);

    await expect(restoreUserVocabularyTerm('user-1', 'link-1')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
