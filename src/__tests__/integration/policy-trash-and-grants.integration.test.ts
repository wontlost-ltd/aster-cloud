// 回收站永久删除一致性（#603）与结构词授权写后即读（#614），真实 Postgres。
//
// #603：PolicyRecycleBin.policyId 现有外键 ON DELETE CASCADE（迁移 0058），且三条删除路径
//       在同一事务内显式删回收站行。这里验证删除后回收站列表不再 500、无孤儿残留，
//       以及外键本身拒绝孤儿写入、物理删策略会级联。
// #614：授予改为 INSERT … ON CONFLICT DO NOTHING，依赖 partial UNIQUE(userId) WHERE revokedAt IS NULL；
//       这里验证真实索引下重复授予幂等、撤销后可再授予、各读路径即时一致。
//       Hyperdrive 缓存本地无法复现，SQL 守卫见 lib/hyperdrive-fresh-reads.test.ts。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts policy-trash-and-grants

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'it-trash-admin' })) }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn(async () => null) }));

import { createDb } from '@/db';
import { policies, policyRecycleBins, structuralAliasGrants, users } from '@/lib/prisma';
import {
  cleanupExpiredTrashItems,
  emptyTrash,
  getTrashItems,
  permanentDeletePolicy,
  softDeletePolicy,
} from '@/lib/policy-lifecycle';
import { getStructuralAliasGrant } from '@/lib/structural-alias-grants';
import { DELETE, GET, POST } from '@/app/api/admin/structural-alias-grants/route';

const ADMIN = 'it-trash-admin';
const OWNER = 'it-trash-owner';
const USER_IDS = [ADMIN, OWNER];

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

async function cleanup(db: Db): Promise<void> {
  await db.delete(structuralAliasGrants).where(inArray(structuralAliasGrants.userId, USER_IDS));
  await db.delete(policyRecycleBins).where(eq(policyRecycleBins.userId, OWNER));
  await db.delete(policies).where(eq(policies.userId, OWNER));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

async function seedPolicy(db: Db, id: string): Promise<void> {
  await db.insert(policies).values({
    id,
    userId: OWNER,
    name: id,
    content: 'Module it.trash.',
    updatedAt: new Date(),
  } as typeof policies.$inferInsert);
}

function grantRequest(method: 'POST' | 'DELETE', userId: string): Request {
  return new Request('http://localhost/api/admin/structural-alias-grants', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
}

async function grantedInAdminList(userId: string): Promise<boolean> {
  const res = await GET();
  const body = (await res.json()) as { users: Array<{ userId: string; granted: boolean }> };
  return body.users.find((u) => u.userId === userId)?.granted ?? false;
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('回收站与结构词授权（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  const db = createDb(undefined, { max: 4 });

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    await cleanup(db);
    await db.insert(users).values(
      USER_IDS.map((id) => ({ id, email: `${id}@example.test`, updatedAt: new Date() })) as Array<
        typeof users.$inferInsert
      >,
    );
  });

  beforeEach(async () => {
    await db.delete(structuralAliasGrants).where(inArray(structuralAliasGrants.userId, USER_IDS));
    await db.delete(policyRecycleBins).where(eq(policyRecycleBins.userId, OWNER));
    await db.delete(policies).where(eq(policies.userId, OWNER));
  });

  afterAll(async () => {
    await cleanup(db);
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end({ timeout: 1 });
  });

  describe('#603 回收站', () => {
    it('永久删除后回收站行一并消失，列表正常返回', async () => {
      await seedPolicy(db, 'it-trash-p1');
      await seedPolicy(db, 'it-trash-p2');
      expect((await softDeletePolicy('it-trash-p1', OWNER)).success).toBe(true);
      expect((await softDeletePolicy('it-trash-p2', OWNER)).success).toBe(true);
      expect((await getTrashItems(OWNER)).map((i) => i.policyId).sort()).toEqual(['it-trash-p1', 'it-trash-p2']);

      expect(await permanentDeletePolicy('it-trash-p1', OWNER)).toEqual({ success: true, policyId: 'it-trash-p1' });

      const bins = await db.select().from(policyRecycleBins).where(eq(policyRecycleBins.policyId, 'it-trash-p1'));
      expect(bins).toHaveLength(0);
      expect((await getTrashItems(OWNER)).map((i) => i.policyId)).toEqual(['it-trash-p2']);
    });

    it('过期清理删除策略与回收站行，未过期项不受影响', async () => {
      await seedPolicy(db, 'it-trash-expired');
      await seedPolicy(db, 'it-trash-fresh');
      await softDeletePolicy('it-trash-expired', OWNER);
      await softDeletePolicy('it-trash-fresh', OWNER);
      await db
        .update(policyRecycleBins)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(policyRecycleBins.policyId, 'it-trash-expired'));

      const r = await cleanupExpiredTrashItems();
      expect(r.errors).toEqual([]);
      expect(r.deletedCount).toBeGreaterThanOrEqual(1);

      const left = await db.select({ id: policies.id }).from(policies).where(eq(policies.userId, OWNER));
      expect(left.map((p) => p.id)).toEqual(['it-trash-fresh']);
      expect((await getTrashItems(OWNER)).map((i) => i.policyId)).toEqual(['it-trash-fresh']);
    });

    it('清空回收站不留孤儿', async () => {
      await seedPolicy(db, 'it-trash-e1');
      await softDeletePolicy('it-trash-e1', OWNER);
      expect(await emptyTrash(OWNER)).toEqual({ deletedCount: 1, errors: [] });
      expect(await db.select().from(policyRecycleBins).where(eq(policyRecycleBins.userId, OWNER))).toHaveLength(0);
      expect(await getTrashItems(OWNER)).toEqual([]);
    });

    it('外键：绕过业务层直接删策略也会级联删除回收站行', async () => {
      await seedPolicy(db, 'it-trash-raw');
      await softDeletePolicy('it-trash-raw', OWNER);
      await db.delete(policies).where(eq(policies.id, 'it-trash-raw'));
      expect(await db.select().from(policyRecycleBins).where(eq(policyRecycleBins.policyId, 'it-trash-raw'))).toHaveLength(0);
    });

    it('外键：不允许写入指向不存在策略的回收站行', async () => {
      await expect(
        db.insert(policyRecycleBins).values({
          id: 'it-trash-orphan',
          policyId: 'it-trash-missing',
          userId: OWNER,
          snapshot: {},
          deletedBy: OWNER,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23503' }) });
    });
  });

  describe('#614 结构词授权写后即读', () => {
    it('授予 → 撤销 → 再授予，每一步管理列表与编辑器读路径立即一致', async () => {
      expect((await POST(grantRequest('POST', OWNER))).status).toBe(200);
      expect(await grantedInAdminList(OWNER)).toBe(true);
      expect(await getStructuralAliasGrant(OWNER)).toBe(true);

      expect((await DELETE(grantRequest('DELETE', OWNER))).status).toBe(200);
      expect(await grantedInAdminList(OWNER)).toBe(false);
      expect(await getStructuralAliasGrant(OWNER)).toBe(false);

      expect((await POST(grantRequest('POST', OWNER))).status).toBe(200);
      expect(await grantedInAdminList(OWNER)).toBe(true);
      expect(await getStructuralAliasGrant(OWNER)).toBe(true);
    });

    it('重复与并发授予幂等：至多一条活跃授权', async () => {
      const results = await Promise.all([
        POST(grantRequest('POST', OWNER)),
        POST(grantRequest('POST', OWNER)),
        POST(grantRequest('POST', OWNER)),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect((await POST(grantRequest('POST', OWNER))).status).toBe(200);

      const active = await db
        .select({ id: structuralAliasGrants.id })
        .from(structuralAliasGrants)
        .where(and(eq(structuralAliasGrants.userId, OWNER), isNull(structuralAliasGrants.revokedAt)));
      expect(active).toHaveLength(1);
    });
  });
});
