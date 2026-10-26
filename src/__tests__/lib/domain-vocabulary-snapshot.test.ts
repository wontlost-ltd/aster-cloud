/**
 * Snapshot service tests for B12. Focused on:
 *   - createSnapshotsForOwner returns one ref per (domain, locale) group the policy uses
 *   - approval freezes only the policy's own domain/locale (#610)
 *   - loadVocabularyForExecution only merges in-scope snapshots
 *   - dedup hits bump refCount instead of inserting a new row
 *   - rollback reactivates missing termIds and soft-deletes extras
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  transaction: vi.fn(),
  selectChain: vi.fn(),
  insertValues: vi.fn().mockResolvedValue(undefined),
  insert: vi.fn(() => ({ values: hoisted.insertValues })),
  updateWhere: vi.fn().mockResolvedValue(undefined),
  updateSet: vi.fn(() => ({ where: hoisted.updateWhere })),
  update: vi.fn(() => ({ set: hoisted.updateSet })),
  findFirstSnapshot: vi.fn(),
  findManySnapshots: vi.fn(),
  findFirstUdt: vi.fn(),
  findFirstDt: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const tableProxy = new Proxy({}, { get: () => ({}) });
  return {
    db: {
      transaction: hoisted.transaction,
      select: hoisted.selectChain,
      insert: hoisted.insert,
      update: hoisted.update,
      query: {
        userVocabularySnapshots: {
          findFirst: hoisted.findFirstSnapshot,
          findMany: hoisted.findManySnapshots,
        },
        userDomainTerms: { findFirst: hoisted.findFirstUdt },
        domainTerms: { findFirst: hoisted.findFirstDt },
      },
    },
    domainTerms: tableProxy,
    policyVersions: tableProxy,
    userDomainTerms: tableProxy,
    userVocabularySnapshots: tableProxy,
  };
});

vi.mock('@/lib/audit-log', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  createSnapshotsForOwner,
  loadVocabularyForExecution,
  rollbackToSnapshot,
  snapshotOnPolicyApprove,
} from '@/lib/domain-vocabulary-snapshot';
import { assembleDomainVocabularyFromLinks } from '@/lib/domain-vocabulary-assemble';
import { VocabularyError } from '@/lib/domain-vocabulary';

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
  hoisted.updateWhere.mockResolvedValue(undefined);
  hoisted.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      execute: vi.fn().mockResolvedValue(undefined),
      insert: hoisted.insert,
      update: hoisted.update,
      select: hoisted.selectChain,
      query: {
        userVocabularySnapshots: { findFirst: hoisted.findFirstSnapshot },
        userDomainTerms: { findFirst: hoisted.findFirstUdt },
        domainTerms: { findFirst: hoisted.findFirstDt },
      },
    }),
  );
});

function termRow(
  termId: string,
  domain: string,
  locale: string,
  kind: string,
  canonical: string,
  localized: string,
  parentCanonical: string | null = null,
) {
  return { termId, domain, locale, kind, canonical, localized, parentCanonical, aliases: [], description: null };
}

const LOAN_EN = termRow('term-a', 'finance.loan', 'en-US', 'struct', 'Loan', 'Credit');
const LOAN_ZH = termRow('term-b', 'finance.loan', 'zh-CN', 'struct', 'Loan', '贷款');
const APPLICANT_EN = termRow('term-c', 'hr', 'en-US', 'struct', 'Applicant', 'Candidate');

// 生产复现数据（2026-10-26 e2e）：德语策略只用 e2e1026/de 的 Fahrer/alter。
const PROD_ROWS = [
  termRow('t-driver', 'e2e1026', 'de', 'struct', 'Driver', 'Fahrer'),
  termRow('t-age', 'e2e1026', 'de', 'field', 'age', 'alter', 'Driver'),
  termRow('t-bad', 'e2e1026', 'xx_INVALID!!', 'struct', 'Licensed', 'lizenziert'),
  termRow('t-upper', 'E2E 1026', 'de', 'struct', 'Vehicle', 'Fahrzeug'),
  termRow('t-app', 'e2etest', 'en', 'struct', 'Applicant', 'Antragsteller'),
];
const DE_POLICY = `Modul e2e1026.vocab.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben fahrer als Fahrer liefert Ganzzahl:
  wenn fahrer.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;

describe('createSnapshotsForOwner', () => {
  it('returns no refs when the user has no active vocab', async () => {
    queueSelect([]); // active link join → empty

    const refs = await createSnapshotsForOwner(
      { ownerType: 'user', ownerId: 'user-1' },
      { source: 'Rule r given credit as Credit, produce Int: Return 1.', locale: 'en-US' },
    );

    expect(refs).toEqual([]);
    expect(hoisted.transaction).not.toHaveBeenCalled();
  });

  it('inserts one snapshot per (domain, locale) group the policy uses', async () => {
    queueSelect([LOAN_EN, LOAN_ZH, APPLICANT_EN]);
    // Two in-scope groups → two inner transactions → next-version max query each.
    queueSelect([{ max: null }]);
    queueSelect([{ max: null }]);
    hoisted.findFirstSnapshot.mockResolvedValue(undefined);

    const refs = await createSnapshotsForOwner(
      { ownerType: 'user', ownerId: 'user-1' },
      { source: 'Define Credit has amount. Define Candidate has score.', locale: 'en-US' },
    );

    expect(refs.map((r) => `${r.domain}|${r.locale}`).sort()).toEqual([
      'finance.loan|en-US',
      'hr|en-US',
    ]);
    expect(hoisted.insert).toHaveBeenCalledTimes(2);
  });

  it('bumps refCount on dedup hit instead of inserting again', async () => {
    queueSelect([LOAN_EN]);
    hoisted.findFirstSnapshot.mockResolvedValueOnce({ id: 'snap-existing' });

    const refs = await createSnapshotsForOwner(
      { ownerType: 'user', ownerId: 'user-1' },
      { source: 'Define Credit has amount.', locale: 'en-US' },
    );

    expect(refs[0].snapshotId).toBe('snap-existing');
    expect(hoisted.update).toHaveBeenCalled();
    expect(hoisted.insert).not.toHaveBeenCalled();
  });
});

describe('snapshotOnPolicyApprove (#610)', () => {
  it('approving a de policy freezes only its own domain/locale', async () => {
    queueSelect(PROD_ROWS);
    queueSelect([{ max: null }]);
    hoisted.findFirstSnapshot.mockResolvedValue(undefined);

    const refs = await snapshotOnPolicyApprove({
      policyVersionId: 'pv-1',
      policyAuthorId: 'user-1',
      policy: { source: DE_POLICY, locale: 'de-DE' },
    });

    expect(refs.map((r) => `${r.domain}|${r.locale}`)).toEqual(['e2e1026|de']);
    expect(hoisted.insert).toHaveBeenCalledTimes(1);
    const inserted = hoisted.insertValues.mock.calls[0]![0] as { termIds: string[] };
    expect(inserted.termIds).toEqual(['t-driver', 't-age']);
    // 版本只记录这一个快照引用。
    expect(hoisted.updateSet).toHaveBeenCalledWith({ vocabularySnapshotIds: refs });
  });

  it('approving a policy that uses no vocabulary freezes nothing and bumps no refCount', async () => {
    queueSelect(PROD_ROWS);

    const refs = await snapshotOnPolicyApprove({
      policyVersionId: 'pv-2',
      policyAuthorId: 'user-1',
      policy: { source: 'Rule r given age as Int, produce Int: Return age multiplied by 3.', locale: 'en-US' },
    });

    expect(refs).toEqual([]);
    expect(hoisted.transaction).not.toHaveBeenCalled();
    expect(hoisted.updateSet).toHaveBeenCalledWith({ vocabularySnapshotIds: [] });
  });
});

describe('loadVocabularyForExecution', () => {
  const snapshotJson = (rows: ReturnType<typeof termRow>[], domain: string, locale: string) =>
    assembleDomainVocabularyFromLinks(
      rows.map((r) => ({ ...r, domainTermId: r.termId })),
      { domain, locale },
    );

  it('returns null without refs', async () => {
    expect(await loadVocabularyForExecution([], { source: DE_POLICY, locale: 'de-DE' })).toBeNull();
    expect(hoisted.findManySnapshots).not.toHaveBeenCalled();
  });

  it('ignores unrelated snapshots frozen by legacy approvals and aligns locale', async () => {
    hoisted.findManySnapshots.mockResolvedValue([
      { vocabularyJson: snapshotJson(PROD_ROWS.slice(0, 2), 'e2e1026', 'de') },
      { vocabularyJson: snapshotJson([PROD_ROWS[4]!], 'e2etest', 'en') },
      { vocabularyJson: snapshotJson([PROD_ROWS[3]!], 'E2E 1026', 'de') },
    ]);

    const vocab = await loadVocabularyForExecution(
      [
        { snapshotId: 's1', domain: 'e2e1026', locale: 'de' },
        { snapshotId: 's2', domain: 'e2etest', locale: 'en' },
        { snapshotId: 's3', domain: 'E2E 1026', locale: 'de' },
      ],
      { source: DE_POLICY, locale: 'de-DE' },
    );

    expect(vocab).not.toBeNull();
    expect(vocab!.locale).toBe('de-DE');
    expect(vocab!.structs.map((m) => m.canonical)).toEqual(['Driver']);
    expect(vocab!.fields.map((m) => `${m.parent}.${m.canonical}=${m.localized}`)).toEqual([
      'Driver.age=alter',
    ]);
  });
});

describe('rollbackToSnapshot', () => {
  it('throws not_found when the snapshot is missing or not owned', async () => {
    hoisted.findFirstSnapshot.mockResolvedValue(undefined);

    await expect(rollbackToSnapshot('user-1', 'snap-x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws snapshot_archived when the snapshot is archived', async () => {
    hoisted.findFirstSnapshot.mockResolvedValue({
      id: 'snap-1',
      ownerType: 'user',
      ownerId: 'user-1',
      archivedAt: new Date(),
      termIds: ['t1'],
    });

    await expect(rollbackToSnapshot('user-1', 'snap-1')).rejects.toBeInstanceOf(VocabularyError);
  });

  it('soft-deletes extras and inserts missing termIds within the snapshot scope only', async () => {
    hoisted.findFirstSnapshot.mockResolvedValue({
      id: 'snap-1',
      ownerType: 'user',
      ownerId: 'user-1',
      archivedAt: null,
      domain: 'finance.loan',
      locale: 'en-US',
      termIds: ['t-new'],
    });
    // Inside the transaction:
    //   1) current active rows for the snapshot's scope only → user has t-old
    //      to remove.
    queueSelect([{ id: 'link-old', termId: 't-old' }]);
    // dormant lookup for t-new (scoped) → none → insert path
    hoisted.findFirstUdt.mockResolvedValue(undefined);
    hoisted.findFirstDt.mockResolvedValue({
      domain: 'finance.loan',
      locale: 'en-US',
      kind: 'struct',
    });

    const result = await rollbackToSnapshot('user-1', 'snap-1');

    expect(result.removed).toBe(1);
    expect(result.added).toBe(1);
    expect(result.unchanged).toBe(0);
  });

  it('refuses to insert a termId that belongs to a different (domain, locale) scope', async () => {
    hoisted.findFirstSnapshot.mockResolvedValue({
      id: 'snap-2',
      ownerType: 'user',
      ownerId: 'user-1',
      archivedAt: null,
      domain: 'finance.loan',
      locale: 'en-US',
      termIds: ['t-wrong-scope'],
    });
    queueSelect([]); // no active rows in this scope
    hoisted.findFirstUdt.mockResolvedValue(undefined); // no dormant in this scope
    hoisted.findFirstDt.mockResolvedValue({
      // Global term row belongs to a different domain/locale; rollback
      // should skip rather than insert into the wrong scope.
      domain: 'insurance.policy',
      locale: 'zh-CN',
      kind: 'struct',
    });

    const result = await rollbackToSnapshot('user-1', 'snap-2');

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
  });
});
