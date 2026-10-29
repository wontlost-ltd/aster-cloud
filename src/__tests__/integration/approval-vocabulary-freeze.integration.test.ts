// 审批冻结词汇的原子性（真实 Postgres，外部 DATABASE_URL）。#610 复审：
// 冻结（快照插入 / refCount 递增）与审批记录、状态更新在同一事务内。审批写入失败时
// 冻结一并回滚：refCount 不变、版本仍待审批；写入成功时三者同时生效。
// ADR 0051：即将冻结的词汇与保存时封印的 sourceScopesJson 不一致时拒绝批准，不冻结任何快照。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts approval-vocabulary-freeze

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));

import { createDb } from '@/db';
import {
  domainTerms,
  policies,
  policyApprovals,
  policyVersions,
  securityEvents,
  userDomainTerms,
  users,
  userVocabularySnapshots,
} from '@/lib/prisma';
import { approveVersion, VocabularyChangedSinceSaveError } from '@/services/policy/version-manager';
import { loadLiveVocabularyForPolicy } from '@/lib/domain-vocabulary-snapshot';
import { cloudToolchainId, computeSourceEnvelope, vocabularyScopesJson } from '@/lib/policy-alias';

const USER = 'user-vocab-freeze-it';
const POLICY = 'pol-vocab-freeze-it';
const SOURCE = `Modul e2e1026.vocab.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.execute(sql`DROP TRIGGER IF EXISTS vocab_freeze_it_fail ON "PolicyApproval"`);
  await db.delete(policyApprovals).where(sql`${policyApprovals.versionId} LIKE ${`${POLICY}%`}`);
  await db.delete(securityEvents).where(eq(securityEvents.policyId, POLICY));
  await db.delete(policyVersions).where(eq(policyVersions.policyId, POLICY));
  await db.delete(policies).where(eq(policies.id, POLICY));
  await db.delete(userVocabularySnapshots).where(eq(userVocabularySnapshots.ownerId, USER));
  await db.delete(userDomainTerms).where(eq(userDomainTerms.userId, USER));
  await db.delete(domainTerms).where(sql`${domainTerms.id} LIKE 'dt-vocab-freeze-it-%'`);
  await db.delete(users).where(eq(users.id, USER));
}

function term(id: string, kind: string, canonical: string, localized: string, parentCanonical: string | null) {
  return {
    id: `dt-vocab-freeze-it-${id}`,
    domain: 'e2e1026',
    locale: 'de',
    kind,
    canonical,
    canonicalNorm: canonical.toLowerCase(),
    localized,
    localizedNorm: localized.toLowerCase(),
    parentCanonical,
    source: 'user',
    dedupKey: `vocab-freeze-it-${id}`,
  } as typeof domainTerms.$inferInsert;
}

async function pendingVersion(db: Db, version: number): Promise<void> {
  await db.insert(policyVersions).values({
    id: `${POLICY}-v${version}`,
    policyId: POLICY,
    version,
    content: SOURCE,
    source: SOURCE,
    status: 'PENDING_APPROVAL',
    createdBy: USER,
  });
}

/** 按保存时的作者现行词汇封印的待审批版本（与 createVersion 同一封印口径）。 */
async function sealedPendingVersion(db: Db, version: number): Promise<void> {
  const scopes = vocabularyScopesJson(await loadLiveVocabularyForPolicy(USER, { source: SOURCE, locale: 'de-DE' }));
  const toolchain = cloudToolchainId();
  await db.insert(policyVersions).values({
    id: `${POLICY}-v${version}`,
    policyId: POLICY,
    version,
    content: SOURCE,
    source: SOURCE,
    status: 'PENDING_APPROVAL',
    createdBy: USER,
    sourceScopesJson: scopes,
    sourceToolchainId: toolchain,
    sourceEnvelopeSha256: computeSourceEnvelope(SOURCE, null, 'de-DE', toolchain, scopes),
  });
}

async function refCount(db: Db): Promise<number[]> {
  const rows = await db
    .select({ refCount: userVocabularySnapshots.refCount })
    .from(userVocabularySnapshots)
    .where(eq(userVocabularySnapshots.ownerId, USER));
  return rows.map((r) => r.refCount);
}

async function status(db: Db, version: number) {
  const [row] = await db
    .select({ status: policyVersions.status, refs: policyVersions.vocabularySnapshotIds })
    .from(policyVersions)
    .where(eq(policyVersions.id, `${POLICY}-v${version}`));
  return row;
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('审批冻结词汇：与审批写入同一事务', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.insert(users).values({ id: USER, email: `${USER}@example.test`, updatedAt: new Date() } as typeof users.$inferInsert);
    await db.insert(domainTerms).values([
      term('driver', 'struct', 'Driver', 'Fahrer', null),
      term('age', 'field', 'age', 'alter', 'Driver'),
    ]);
    await db.insert(userDomainTerms).values(
      ['driver', 'age'].map((id) => ({
        id: `udt-vocab-freeze-it-${id}`,
        userId: USER,
        termId: `dt-vocab-freeze-it-${id}`,
        domain: 'e2e1026',
        locale: 'de',
        kind: id === 'driver' ? 'struct' : 'field',
      })),
    );
    await db.insert(policies).values({
      id: POLICY, userId: USER, name: 'vocab-freeze-it', content: SOURCE, version: 4, updatedAt: new Date(),
    } as typeof policies.$inferInsert);
    await pendingVersion(db, 1);
    await pendingVersion(db, 2);
    await sealedPendingVersion(db, 3);
    await sealedPendingVersion(db, 4);
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  it('成功审批：创建快照（refCount=1），引用与 APPROVED 状态一并落库', async () => {
    await approveVersion({ policyId: POLICY, version: 1, approverId: USER, decision: 'APPROVED' });

    expect(await refCount(db)).toEqual([1]);
    const v1 = await status(db, 1);
    expect(v1.status).toBe('APPROVED');
    expect(v1.refs.map((r) => `${r.domain}|${r.locale}`)).toEqual(['e2e1026|de']);
  });

  it('冻结后审批记录写入失败：refCount 回滚、版本仍待审批', async () => {
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION vocab_freeze_it_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'approval insert failed (test)'; END;
      $$ LANGUAGE plpgsql`);
    await db.execute(sql`
      CREATE TRIGGER vocab_freeze_it_fail BEFORE INSERT ON "PolicyApproval"
      FOR EACH ROW EXECUTE FUNCTION vocab_freeze_it_fail()`);

    await expect(
      approveVersion({ policyId: POLICY, version: 2, approverId: USER, decision: 'APPROVED' }),
    ).rejects.toThrow();

    expect(await refCount(db)).toEqual([1]);
    const v2 = await status(db, 2);
    expect(v2.status).toBe('PENDING_APPROVAL');
    expect(v2.refs).toEqual([]);

    await db.execute(sql`DROP TRIGGER vocab_freeze_it_fail ON "PolicyApproval"`);
    await approveVersion({ policyId: POLICY, version: 2, approverId: USER, decision: 'APPROVED' });
    expect(await refCount(db)).toEqual([2]);
    expect((await status(db, 2)).status).toBe('APPROVED');
  });
  it('保存后词汇未变：封印与冻结一致，照常批准', async () => {
    await approveVersion({ policyId: POLICY, version: 3, approverId: USER, decision: 'APPROVED' });
    expect((await status(db, 3)).status).toBe('APPROVED');
    expect(await refCount(db)).toEqual([3]);
  });

  it('保存后改了在用词条：拒绝批准，不冻结、不写审批记录、版本仍待审批', async () => {
    await db.update(domainTerms).set({ aliases: ['lebensalter'] }).where(eq(domainTerms.id, 'dt-vocab-freeze-it-age'));

    await expect(
      approveVersion({ policyId: POLICY, version: 4, approverId: USER, decision: 'APPROVED' }),
    ).rejects.toBeInstanceOf(VocabularyChangedSinceSaveError);

    expect(await refCount(db)).toEqual([3]);
    const v4 = await status(db, 4);
    expect(v4.status).toBe('PENDING_APPROVAL');
    expect(v4.refs).toEqual([]);
    const approvals = await db.select().from(policyApprovals).where(eq(policyApprovals.versionId, `${POLICY}-v4`));
    expect(approvals).toEqual([]);
  });
});
