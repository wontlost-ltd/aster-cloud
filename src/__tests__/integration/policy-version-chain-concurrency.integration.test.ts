// #646：同一策略并发建版本时版本链不分叉（真实 Postgres）。
// 空链没有链尾行可 FOR UPDATE；此前两个事务都读到"无链尾"，各自写出 version=1、prevHash=null。
// 修复后按策略取事务级 advisory lock 串行化，后到者等前者提交后接在其后；
// (policyId, version) 唯一索引（迁移 0062）作为最后一道防线。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-version-chain-concurrency

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn(async () => false) }));

import { createDb } from '@/db';
import { policies, policyVersions, securityEvents, users } from '@/lib/prisma';
import { createVersion } from '@/services/policy/version-manager';

const USER = 'user-version-chain-it';
const POLICY = 'pol-version-chain-it';
const SOURCE_A = 'Module chain.a.\n\nRule decide given amount as Int, produce Int:\n  Return amount.\n';
const SOURCE_B = 'Module chain.b.\n\nRule decide given amount as Int, produce Int:\n  Return 0.\n';
const SOURCE_C = 'Module chain.c.\n\nRule decide given amount as Int, produce Int:\n  Return 1.\n';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.delete(securityEvents).where(eq(securityEvents.policyId, POLICY));
  await db.delete(policyVersions).where(eq(policyVersions.policyId, POLICY));
  await db.delete(policies).where(eq(policies.id, POLICY));
  await db.delete(users).where(eq(users.id, USER));
}

async function chain(db: Db) {
  return db
    .select({
      version: policyVersions.version,
      prevHash: policyVersions.prevHash,
      sourceHash: policyVersions.sourceHash,
      envelope: policyVersions.sourceEnvelopeSha256,
    })
    .from(policyVersions)
    .where(eq(policyVersions.policyId, POLICY))
    .orderBy(asc(policyVersions.version));
}

function params(source: string) {
  return { policyId: POLICY, source, createdBy: USER, locale: 'en-US', scopesJson: '' };
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('并发建版本的哈希链（#646）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 6 });

  beforeAll(() => {
    globalForDb.__asterLocalDevDb = db;
  });

  beforeEach(async () => {
    await cleanup(db);
    await db.insert(users).values({ id: USER, email: `${USER}@example.test`, updatedAt: new Date() });
    await db.insert(policies).values({ id: POLICY, userId: USER, name: 'chain', content: SOURCE_A, updatedAt: new Date() });
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  it('空链：前一事务未提交时后到者等待，提交后接成 v2，链接指向 v1', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let firstInserted!: () => void;
    const inserted = new Promise<void>((resolve) => { firstInserted = resolve; });

    const first = db.transaction(async (tx) => {
      const created = await createVersion({ ...params(SOURCE_A), dbClient: tx });
      firstInserted();
      await held;
      return created;
    });
    await inserted;

    let secondSettled = false;
    const second = createVersion(params(SOURCE_B)).finally(() => { secondSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // 前一事务持锁未提交：后到者必须阻塞，而不是读到空链自行写出 v1
    expect(secondSettled).toBe(false);

    release();
    const [v1, v2] = await Promise.all([first, second]);
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);

    const rows = await chain(db);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0].prevHash).toBeNull();
    expect(rows[1].prevHash).toBe(rows[0].envelope ?? rows[0].sourceHash);
    expect(rows.filter((r) => r.prevHash === null)).toHaveLength(1);
  });

  it('空链：多个并发请求全部成功，版本号连续、各自链到前一版本', async () => {
    const created = await Promise.all([SOURCE_A, SOURCE_B, SOURCE_C].map((s) => createVersion(params(s))));
    expect(created.map((c) => c.version).sort()).toEqual([1, 2, 3]);

    const rows = await chain(db);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(rows[0].prevHash).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].prevHash).toBe(rows[i - 1].envelope ?? rows[i - 1].sourceHash);
    }
  });

  it('已有链尾：单次创建照常接在链尾之后', async () => {
    const v1 = await createVersion(params(SOURCE_A));
    const v2 = await createVersion(params(SOURCE_B));
    expect([v1.version, v2.version]).toEqual([1, 2]);
    const rows = await chain(db);
    expect(rows[1].prevHash).toBe(rows[0].envelope ?? rows[0].sourceHash);
  });

  it('(policyId, version) 唯一索引拒绝重复版本号', async () => {
    await createVersion(params(SOURCE_A));
    await expect(
      db.insert(policyVersions).values({
        id: `${POLICY}-dup`, policyId: POLICY, version: 1, content: SOURCE_B, source: SOURCE_B, status: 'DRAFT',
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});
