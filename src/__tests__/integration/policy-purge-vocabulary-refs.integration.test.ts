// 策略物理删除释放词汇快照引用（#628），真实 Postgres。
//
// 审批冻结对版本引用的每个快照 refCount +1；永久删除 / 过期清理 / 清空回收站都经 purgePolicy，
// 必须在删除策略的同一事务内按引用次数递减（下限 0），删除失败时递减一并回滚。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-purge-vocabulary-refs

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, like, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

import { createDb } from '@/db';
import { policies, policyRecycleBins, policyVersions, users, userVocabularySnapshots } from '@/lib/prisma';
import {
  cleanupExpiredTrashItems,
  emptyTrash,
  permanentDeletePolicy,
  softDeletePolicy,
} from '@/lib/policy-lifecycle';

const OWNER = 'it-purge-vocab-owner';
const SNAP_SHARED = 'it-purge-vocab-snap-shared';
const SNAP_ONLY = 'it-purge-vocab-snap-only';
const SNAP_ZERO = 'it-purge-vocab-snap-zero';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.execute(sql`DROP TRIGGER IF EXISTS it_purge_vocab_fail ON "Policy"`);
  await db.execute(sql`DROP FUNCTION IF EXISTS it_purge_vocab_fail_fn()`);
  await db.delete(policyRecycleBins).where(eq(policyRecycleBins.userId, OWNER));
  await db.delete(policies).where(eq(policies.userId, OWNER));
  // PolicyVersion 与 Policy 之间没有外键，版本行不随策略删除，需单独清理
  await db.delete(policyVersions).where(like(policyVersions.policyId, 'it-purge-%'));
  await db.delete(userVocabularySnapshots).where(eq(userVocabularySnapshots.ownerId, OWNER));
}

async function seedSnapshot(db: Db, id: string, version: number, refCount: number): Promise<void> {
  await db.insert(userVocabularySnapshots).values({
    id,
    ownerType: 'user',
    ownerId: OWNER,
    domain: 'it-purge',
    locale: 'de',
    version,
    vocabularyJson: {},
    termIds: [],
    contentHash: `hash-${id}`,
    refCount,
  });
}

const ref = (snapshotId: string) => ({ snapshotId, domain: 'it-purge', locale: 'de' });

/** 建一条已软删的策略，版本按给定引用列表冻结（status=APPROVED）。 */
async function seedTrashedPolicy(db: Db, id: string, versionRefs: string[][]): Promise<void> {
  await db.insert(policies).values({
    id,
    userId: OWNER,
    name: id,
    content: 'Module it.purge.',
    updatedAt: new Date(),
  } as typeof policies.$inferInsert);
  for (const [i, refs] of versionRefs.entries()) {
    await db.insert(policyVersions).values({
      id: `${id}-v${i + 1}`,
      policyId: id,
      version: i + 1,
      content: 'Module it.purge.',
      status: 'APPROVED',
      createdBy: OWNER,
      vocabularySnapshotIds: refs.map(ref),
    });
  }
  expect((await softDeletePolicy(id, OWNER)).success).toBe(true);
}

async function refCounts(db: Db): Promise<Record<string, number>> {
  const rows = await db
    .select({ id: userVocabularySnapshots.id, refCount: userVocabularySnapshots.refCount })
    .from(userVocabularySnapshots)
    .where(inArray(userVocabularySnapshots.id, [SNAP_SHARED, SNAP_ONLY, SNAP_ZERO]));
  return Object.fromEntries(rows.map((r) => [r.id, r.refCount]));
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('策略物理删除释放词汇快照引用（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.delete(users).where(eq(users.id, OWNER));
    await db.insert(users).values({ id: OWNER, email: `${OWNER}@example.test`, updatedAt: new Date() } as typeof users.$inferInsert);
  });

  beforeEach(async () => {
    await cleanup(db);
    // SHARED 另有 2 个其他策略的引用；ONLY 只被待删策略引用；ZERO 是历史上已漏增的脏数据
    await seedSnapshot(db, SNAP_SHARED, 1, 4);
    await seedSnapshot(db, SNAP_ONLY, 2, 1);
    await seedSnapshot(db, SNAP_ZERO, 3, 0);
  });

  afterAll(async () => {
    await cleanup(db);
    await db.delete(users).where(eq(users.id, OWNER));
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  it('永久删除：按引用次数递减（同一快照被两个版本引用减 2），0 下限', async () => {
    await seedTrashedPolicy(db, 'it-purge-p1', [[SNAP_SHARED, SNAP_ONLY], [SNAP_SHARED, SNAP_ZERO]]);
    expect(await permanentDeletePolicy('it-purge-p1', OWNER)).toEqual({ success: true, policyId: 'it-purge-p1' });
    expect(await refCounts(db)).toEqual({ [SNAP_SHARED]: 2, [SNAP_ONLY]: 0, [SNAP_ZERO]: 0 });
    // 快照行本身保留
    expect(Object.keys(await refCounts(db))).toHaveLength(3);
  });

  it('清空回收站：每条策略各自释放', async () => {
    await seedTrashedPolicy(db, 'it-purge-e1', [[SNAP_SHARED]]);
    await seedTrashedPolicy(db, 'it-purge-e2', [[SNAP_SHARED, SNAP_ONLY]]);
    expect(await emptyTrash(OWNER)).toEqual({ deletedCount: 2, errors: [] });
    expect(await refCounts(db)).toMatchObject({ [SNAP_SHARED]: 2, [SNAP_ONLY]: 0 });
  });

  it('过期清理：只释放过期策略的引用', async () => {
    await seedTrashedPolicy(db, 'it-purge-expired', [[SNAP_ONLY]]);
    await seedTrashedPolicy(db, 'it-purge-fresh', [[SNAP_SHARED]]);
    await db
      .update(policyRecycleBins)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(policyRecycleBins.policyId, 'it-purge-expired'));
    const r = await cleanupExpiredTrashItems();
    expect(r.errors).toEqual([]);
    expect(await refCounts(db)).toMatchObject({ [SNAP_SHARED]: 4, [SNAP_ONLY]: 0 });
  });

  it('并发重复删除：两个事务同时永久删除同一策略，引用只释放一次', async () => {
    await seedTrashedPolicy(db, 'it-purge-race', [[SNAP_SHARED, SNAP_ONLY], [SNAP_SHARED]]);
    const results = await Promise.all([
      permanentDeletePolicy('it-purge-race', OWNER),
      permanentDeletePolicy('it-purge-race', OWNER),
      emptyTrash(OWNER),
    ]);
    // 谁先拿到行锁谁删；其余调用要么发现策略已不在（success=false，「不在回收站」），要么删到 0 行，都不报错
    const [first, second, emptied] = results as [{ success: boolean }, { success: boolean }, { errors: string[] }];
    expect(first.success || second.success || emptied.errors.length === 0).toBe(true);
    expect(emptied.errors).toEqual([]);
    expect(await db.select({ id: policies.id }).from(policies).where(eq(policies.id, 'it-purge-race'))).toHaveLength(0);
    expect(await refCounts(db)).toMatchObject({ [SNAP_SHARED]: 2, [SNAP_ONLY]: 0 });
  });

  it('被删策略的版本行作为历史证据保留、引用原样不改写，且之后不会被再次释放', async () => {
    await seedTrashedPolicy(db, 'it-purge-orphan', [[SNAP_SHARED, SNAP_ONLY]]);
    await permanentDeletePolicy('it-purge-orphan', OWNER);
    const after = await refCounts(db);

    const [orphan] = await db
      .select({ refs: policyVersions.vocabularySnapshotIds })
      .from(policyVersions)
      .where(eq(policyVersions.policyId, 'it-purge-orphan'));
    expect(orphan.refs.map((r) => r.snapshotId)).toEqual([SNAP_SHARED, SNAP_ONLY]);

    // 策略已不在：再次永久删除 / 清空 / 过期清理都碰不到它，计数不再变化
    expect((await permanentDeletePolicy('it-purge-orphan', OWNER)).success).toBe(false);
    expect(await emptyTrash(OWNER)).toEqual({ deletedCount: 0, errors: [] });
    await cleanupExpiredTrashItems();
    expect(await refCounts(db)).toEqual(after);
    expect(after).toMatchObject({ [SNAP_SHARED]: 3, [SNAP_ONLY]: 0 });
  });

  it('删除策略失败 → 事务回滚，refCount 不变、策略仍在', async () => {
    await seedTrashedPolicy(db, 'it-purge-fail', [[SNAP_SHARED, SNAP_ONLY]]);
    await db.execute(sql`
      CREATE FUNCTION it_purge_vocab_fail_fn() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'it purge forced failure'; END $$ LANGUAGE plpgsql`);
    await db.execute(sql`
      CREATE TRIGGER it_purge_vocab_fail BEFORE DELETE ON "Policy"
      FOR EACH ROW WHEN (OLD.id = 'it-purge-fail') EXECUTE FUNCTION it_purge_vocab_fail_fn()`);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await permanentDeletePolicy('it-purge-fail', OWNER);
    errSpy.mockRestore();
    expect(r.success).toBe(false);
    expect(await refCounts(db)).toMatchObject({ [SNAP_SHARED]: 4, [SNAP_ONLY]: 1 });
    expect(await db.select({ id: policies.id }).from(policies).where(eq(policies.id, 'it-purge-fail'))).toHaveLength(1);
  });
});
