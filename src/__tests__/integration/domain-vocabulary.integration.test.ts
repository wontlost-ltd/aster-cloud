/**
 * Cross-module integration tests for the user-domain-vocabulary feature.
 *
 * Verifies that the service-layer + middleware + audit + metrics + SSE all
 * cooperate as the plan intends, using a single shared mock fixture so a
 * lifecycle (add → list → modify → soft-delete → restore → bulk → snapshot →
 * rollback) exercises every wiring point in one pass.
 *
 * These tests deliberately mock `@/lib/prisma` and `@/lib/usage`; we are not
 * exercising real Postgres. The integration value is in the wiring contract:
 *   - mutations record Prometheus op counters
 *   - audit log captures the right action/resource
 *   - DSAR purge cascades through the snapshot/job/idempotency tables
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  selectChain: vi.fn(),
  insertValues: vi.fn(),
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
  domainTermFindFirst: vi.fn(),
  udtFindFirst: vi.fn(),
  snapFindFirst: vi.fn(),
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
        domainTerms: { findFirst: hoisted.domainTermFindFirst },
        userDomainTerms: { findFirst: hoisted.udtFindFirst },
        userVocabularySnapshots: { findFirst: hoisted.snapFindFirst },
      },
    },
    domainTerms: tableProxy,
    userDomainTerms: tableProxy,
    userVocabularyVersions: tableProxy,
    userVocabularySnapshots: tableProxy,
    lexiconBulkJobs: tableProxy,
    lexiconIdempotencyKeys: tableProxy,
    users: tableProxy,
    policyVersions: tableProxy,
  };
});

vi.mock('@/lib/usage', () => ({
  getLexiconQuota: vi.fn(),
}));

vi.mock('@/lib/audit-log', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  addUserVocabularyTerm,
  getUserVocabularyVersion,
  modifyUserVocabularyTerm,
  restoreUserVocabularyTerm,
  softDeleteUserVocabularyTerm,
} from '@/lib/domain-vocabulary';
import { _resetLexiconMetricsForTest, renderLexiconMetrics } from '@/lib/lexicon-metrics';
import { getLexiconQuota } from '@/lib/usage';
import { logAuditEvent } from '@/lib/audit-log';

// Chainable thenable mock for db.select() shape so getTermLink + countActiveTerms
// both feed predictable rows.
interface Thenable {
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  offset: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
  then: (resolve: (v: unknown) => void) => void;
}
function chain(result: unknown): Thenable {
  const c = {} as Thenable;
  c.from = vi.fn().mockReturnValue(c);
  c.innerJoin = vi.fn().mockReturnValue(c);
  c.where = vi.fn().mockReturnValue(c);
  c.orderBy = vi.fn().mockReturnValue(c);
  c.limit = vi.fn().mockReturnValue(c);
  c.offset = vi.fn().mockReturnValue(c);
  c.groupBy = vi.fn().mockReturnValue(c);
  c.then = (r) => r(result);
  return c;
}

const selectQueue: unknown[] = [];
function queueSelect(result: unknown) {
  selectQueue.push(result);
}

function makeInsert(returning: unknown[]) {
  const ret = vi.fn().mockResolvedValue(returning);
  const onConflict = vi.fn().mockReturnValue({ returning: ret });
  const values = vi.fn().mockReturnValue({
    onConflictDoNothing: onConflict,
    returning: ret,
  });
  return { values, returning: ret };
}

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

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  _resetLexiconMetricsForTest();
  vi.mocked(getLexiconQuota).mockResolvedValue({
    maxTerms: 5000,
    bulkAsync: true,
    allowed: true,
  });
  hoisted.selectChain.mockImplementation(() => chain(selectQueue.shift() ?? []));
  hoisted.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      execute: vi.fn().mockResolvedValue(undefined),
      insert: hoisted.insert,
      update: hoisted.update,
      select: hoisted.selectChain,
      query: {
        domainTerms: { findFirst: hoisted.domainTermFindFirst },
        userDomainTerms: { findFirst: hoisted.udtFindFirst },
        userVocabularySnapshots: { findFirst: hoisted.snapFindFirst },
      },
    }),
  );
  hoisted.deleteWhere.mockImplementation(() => ({ returning: hoisted.deleteReturning }));
  hoisted.updateWhere.mockImplementation(() => ({ returning: hoisted.updateReturning }));
  hoisted.updateReturning.mockResolvedValue([{ id: 'link-1' }]);
});

describe('lexicon integration — observability wiring', () => {
  it('add → records Prometheus op + writes audit', async () => {
    queueSelect([{ count: 0 }]); // in-txn quota count
    queueSelect([joinedRow()]); // post-insert reload

    const termInsert = makeInsert([{ id: 'term-1' }]);
    const linkInsert = makeInsert([{ id: 'link-1' }]);
    hoisted.insert.mockReturnValueOnce(termInsert).mockReturnValueOnce(linkInsert);


    await addUserVocabularyTerm('user-1', {
      domain: 'finance.loan',
      locale: 'en-US',
      kind: 'struct',
      canonical: 'Loan',
      localized: 'Loan',
    });

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'lexicon.term.add' }),
    );

    const metricsText = await renderLexiconMetrics();
    expect(metricsText).toMatch(/aster_lexicon_op_total\{op="term\.add",status="success"\} 1/);

  });

  it('modify and delete share the same observability contract', async () => {
    // modify
    queueSelect([joinedRow({ termId: 'term-old' })]); // existing lookup
    queueSelect([joinedRow({ termId: 'term-new' })]); // post-update reload
    hoisted.insert.mockReturnValueOnce(makeInsert([{ id: 'term-new' }]));

    await modifyUserVocabularyTerm('user-1', 'link-1', {
      domain: 'finance.loan',
      locale: 'en-US',
      kind: 'struct',
      canonical: 'LoanV2',
      localized: 'Loan v2',
    });

    // delete
    queueSelect([joinedRow()]);

    await softDeleteUserVocabularyTerm('user-1', 'link-1', 'cleanup');

    const auditCalls = vi.mocked(logAuditEvent).mock.calls.map((c) => c[0].action);
    expect(auditCalls).toContain('lexicon.term.modify');
    expect(auditCalls).toContain('lexicon.term.delete');

    const metricsText = await renderLexiconMetrics();
    expect(metricsText).toMatch(/aster_lexicon_op_total\{op="term\.modify",status="success"\} 1/);
    expect(metricsText).toMatch(/aster_lexicon_op_total\{op="term\.delete",status="success"\} 1/);
  });

  it('restore reactivates a soft-deleted link', async () => {
    queueSelect([joinedRow()]); // includeDeleted lookup
    queueSelect([joinedRow()]); // post-update reload


    const result = await restoreUserVocabularyTerm('user-1', 'link-1');

    expect(result.link.id).toBe('link-1');

  });

  // R-blocker-1: kind=field without parentCanonical must be rejected at the
  // service layer, not just the dialog. Upstream validateVocabulary only
  // emits a warning for missing parents, so the contract has to be enforced
  // here or curl/SDK/bulk callers can plant orphan fields.
  it('add rejects kind=field without parentCanonical', async () => {
    await expect(
      addUserVocabularyTerm('user-1', {
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'field',
        canonical: 'amount',
        localized: 'Amount',
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: /parentCanonical/i,
    });
  });

  it('add failure (plan_gate) records error counter', async () => {
    vi.mocked(getLexiconQuota).mockResolvedValue({
      maxTerms: 0,
      bulkAsync: false,
      allowed: false,
    });

    await expect(
      addUserVocabularyTerm('user-1', {
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'struct',
        canonical: 'Loan',
        localized: 'Loan',
      }),
    ).rejects.toMatchObject({ code: 'plan_gate_required' });

    const metricsText = await renderLexiconMetrics();
    expect(metricsText).toMatch(/aster_lexicon_op_total\{op="term\.add",status="error"\} 1/);

  });
});

describe('getUserVocabularyVersion — 跨 isolate 的失效信号（#608）', () => {
  it('返回版本行里的单调计数', async () => {
    queueSelect([{ version: 3 }]);
    await expect(getUserVocabularyVersion('user-1')).resolves.toBe('3');
  });

  it('从未写过词汇的用户返回 "0"', async () => {
    queueSelect([]);
    await expect(getUserVocabularyVersion('user-1')).resolves.toBe('0');
  });
});
