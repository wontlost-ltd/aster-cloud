// 审批与永久删除对快照引用的串行化（#628），真实 Postgres。
//
// 约定：审批事务先 FOR UPDATE 锁策略行并确认未删除，purge 的 DELETE … RETURNING 争同一把锁；
// 于是「审批给版本加引用」与「删除按版本放引用」不会交错，删除后的策略也不会再被审批加引用。
// 计数不变式：快照 refCount = 仍存在策略的已批准版本对它的引用次数（被删策略的版本不计）。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-approve-purge-lock

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));

import { createDb } from '@/db';
import {
  domainTerms,
  policies,
  policyApprovals,
  policyRecycleBins,
  policyVersions,
  securityEvents,
  userDomainTerms,
  users,
  userVocabularySnapshots,
} from '@/lib/prisma';
import { approveVersion, PolicyAccessDeniedError } from '@/services/policy/version-manager';
import { permanentDeletePolicy } from '@/lib/policy-lifecycle';

const USER = 'user-approve-purge-it';
const POLICY = 'pol-approve-purge-it';
const SOURCE = `Modul e2e1027.lock.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.delete(policyApprovals).where(sql`${policyApprovals.versionId} LIKE ${`${POLICY}%`}`);
  await db.delete(securityEvents).where(eq(securityEvents.policyId, POLICY));
  await db.delete(policyVersions).where(eq(policyVersions.policyId, POLICY));
  await db.delete(policyRecycleBins).where(eq(policyRecycleBins.policyId, POLICY));
  await db.delete(policies).where(eq(policies.id, POLICY));
  await db.delete(userVocabularySnapshots).where(eq(userVocabularySnapshots.ownerId, USER));
}

function term(id: string, kind: string, canonical: string, localized: string, parentCanonical: string | null) {
  return {
    id: `dt-approve-purge-it-${id}`,
    domain: 'e2e1027',
    locale: 'de',
    kind,
    canonical,
    canonicalNorm: canonical.toLowerCase(),
    localized,
    localizedNorm: localized.toLowerCase(),
    parentCanonical,
    source: 'user',
    dedupKey: `approve-purge-it-${id}`,
  } as typeof domainTerms.$inferInsert;
}

async function seedPolicyWithPendingVersions(db: Db): Promise<void> {
  await db.insert(policies).values({
    id: POLICY, userId: USER, name: 'approve-purge-it', content: SOURCE, version: 2, updatedAt: new Date(),
  } as typeof policies.$inferInsert);
  for (const version of [1, 2]) {
    await db.insert(policyVersions).values({
      id: `${POLICY}-v${version}`, policyId: POLICY, version, content: SOURCE, source: SOURCE,
      status: 'PENDING_APPROVAL', createdBy: USER,
    });
  }
}

async function snapshotRefCounts(db: Db): Promise<number[]> {
  const rows = await db
    .select({ refCount: userVocabularySnapshots.refCount })
    .from(userVocabularySnapshots)
    .where(eq(userVocabularySnapshots.ownerId, USER));
  return rows.map((r) => r.refCount);
}

async function versionStatus(db: Db, version: number): Promise<string> {
  const [row] = await db
    .select({ status: policyVersions.status })
    .from(policyVersions)
    .where(eq(policyVersions.id, `${POLICY}-v${version}`));
  return row.status;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.env.LICENSE_E2E !== '1')('审批与永久删除对快照引用串行化（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 6 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.delete(userDomainTerms).where(eq(userDomainTerms.userId, USER));
    await db.delete(domainTerms).where(sql`${domainTerms.id} LIKE 'dt-approve-purge-it-%'`);
    await db.delete(users).where(eq(users.id, USER));
    await db.insert(users).values({ id: USER, email: `${USER}@example.test`, updatedAt: new Date() } as typeof users.$inferInsert);
    await db.insert(domainTerms).values([
      term('driver', 'struct', 'Driver', 'Fahrer', null),
      term('age', 'field', 'age', 'alter', 'Driver'),
    ]);
    await db.insert(userDomainTerms).values(
      ['driver', 'age'].map((id) => ({
        id: `udt-approve-purge-it-${id}`, userId: USER, termId: `dt-approve-purge-it-${id}`,
        domain: 'e2e1027', locale: 'de', kind: id === 'driver' ? 'struct' : 'field',
      })),
    );
  });

  beforeEach(async () => {
    await cleanup(db);
    await seedPolicyWithPendingVersions(db);
    await approveVersion({ policyId: POLICY, version: 1, approverId: USER, decision: 'APPROVED' });
    expect(await snapshotRefCounts(db)).toEqual([1]);
  });

  afterAll(async () => {
    await cleanup(db);
    await db.delete(userDomainTerms).where(eq(userDomainTerms.userId, USER));
    await db.delete(domainTerms).where(sql`${domainTerms.id} LIKE 'dt-approve-purge-it-%'`);
    await db.delete(users).where(eq(users.id, USER));
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  it('审批先提交、再永久删除：两个版本的引用都被释放，refCount 归 0', async () => {
    await approveVersion({ policyId: POLICY, version: 2, approverId: USER, decision: 'APPROVED' });
    expect(await snapshotRefCounts(db)).toEqual([2]);
    await db.update(policies).set({ deletedAt: new Date(), deletedBy: USER }).where(eq(policies.id, POLICY));

    expect((await permanentDeletePolicy(POLICY, USER)).success).toBe(true);
    expect(await snapshotRefCounts(db)).toEqual([0]);
  });

  it('审批已过权限检查、等锁期间策略被软删：拿到锁后拒绝审批，不给即将删除的策略加引用', async () => {
    let releaseHolder!: () => void;
    const gate = new Promise<void>((resolve) => { releaseHolder = resolve; });
    let holderLocked!: () => void;
    const locked = new Promise<void>((resolve) => { holderLocked = resolve; });

    // 另一个事务先拿到策略行锁，之后在同一事务里软删策略（模拟用户在审批进行中删除）
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM "Policy" WHERE id = ${POLICY} FOR UPDATE`);
      holderLocked();
      await gate;
      await tx.update(policies).set({ deletedAt: new Date(), deletedBy: USER }).where(eq(policies.id, POLICY));
    });
    await locked;

    const approving = approveVersion({ policyId: POLICY, version: 2, approverId: USER, decision: 'APPROVED' });
    const approvingSettled = approving.then(() => 'approved', (err) => err);
    await sleep(300); // 让审批走过权限检查并阻塞在策略行锁上
    releaseHolder();
    await holder;

    expect(await approvingSettled).toBeInstanceOf(PolicyAccessDeniedError);
    expect(await versionStatus(db, 2)).toBe('PENDING_APPROVAL');
    expect(await snapshotRefCounts(db)).toEqual([1]);

    expect((await permanentDeletePolicy(POLICY, USER)).success).toBe(true);
    expect(await snapshotRefCounts(db)).toEqual([0]);
  });

  it('同一版本被并发审批：只有一个成功，refCount 只 +1', async () => {
    for (let round = 0; round < 5; round += 1) {
      if (round > 0) {
        await cleanup(db);
        await seedPolicyWithPendingVersions(db);
        await approveVersion({ policyId: POLICY, version: 1, approverId: USER, decision: 'APPROVED' });
      }
      const attempts = await Promise.allSettled([
        approveVersion({ policyId: POLICY, version: 2, approverId: USER, decision: 'APPROVED' }),
        approveVersion({ policyId: POLICY, version: 2, approverId: USER, decision: 'APPROVED' }),
        approveVersion({ policyId: POLICY, version: 2, approverId: USER, decision: 'APPROVED' }),
      ]);
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      expect(await versionStatus(db, 2)).toBe('APPROVED');
      expect(await snapshotRefCounts(db)).toEqual([2]);
      const approvals = await db
        .select({ id: policyApprovals.id })
        .from(policyApprovals)
        .where(eq(policyApprovals.versionId, `${POLICY}-v2`));
      expect(approvals).toHaveLength(1);
    }
  });

  it('并发审批与删除（多轮）：结束时 refCount 恒等于存活策略的引用数（此处为 0）', async () => {
    for (let round = 0; round < 5; round += 1) {
      if (round > 0) {
        await cleanup(db);
        await seedPolicyWithPendingVersions(db);
        await approveVersion({ policyId: POLICY, version: 1, approverId: USER, decision: 'APPROVED' });
      }
      const purge = (async () => {
        await db.update(policies).set({ deletedAt: new Date(), deletedBy: USER }).where(eq(policies.id, POLICY));
        return permanentDeletePolicy(POLICY, USER);
      })();
      const approve = approveVersion({ policyId: POLICY, version: 2, approverId: USER, decision: 'APPROVED' })
        .then(() => true, () => false);
      const [purged] = await Promise.all([purge, approve]);
      expect(purged.success).toBe(true);
      expect(await snapshotRefCounts(db)).toEqual([0]);
    }
  });
});
