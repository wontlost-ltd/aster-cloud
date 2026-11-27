// ADR 0065 §3.4.3：GuardOrphanNotifyState / GuardOrphanEmailState 表结构与比较后写 SQL，真实 Postgres。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts guard-orphan-notify-schema

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { like, sql } from 'drizzle-orm';

import { createDb } from '@/db';
import { guardOrphanEmailState, guardOrphanNotifyState } from '@/lib/prisma';

const PREFIX = 'it-orphan-notify-';
const TENANT = `${PREFIX}tenant-1`;

type Db = ReturnType<typeof createDb>;

/** 取出 drizzle 包装错误里 Postgres 的原始报错文本，便于断言约束名。 */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string; constraint?: string } };
    return `${err.message ?? ''} ${err.cause?.message ?? ''} ${err.cause?.constraint ?? ''}`;
  }
  throw new Error('期望写入被拒绝，但成功了');
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('Guard 孤儿通知状态表（真实 Postgres）', () => {
  const db: Db = createDb(undefined, { max: 2 });

  async function cleanup() {
    await db.delete(guardOrphanNotifyState).where(like(guardOrphanNotifyState.tenantId, `${PREFIX}%`));
    await db.delete(guardOrphanEmailState).where(like(guardOrphanEmailState.tenantId, `${PREFIX}%`));
  }

  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
  });

  it('两张表存在', async () => {
    const rows = await db.execute(
      sql`SELECT table_name FROM information_schema.tables
          WHERE table_name IN ('GuardOrphanNotifyState', 'GuardOrphanEmailState') ORDER BY table_name`,
    );
    expect(rows.rows.map((r) => r.table_name)).toEqual(['GuardOrphanEmailState', 'GuardOrphanNotifyState']);
  });

  it('notifiedThroughId 缺省 0，可空列缺省 NULL，updatedAt 有默认值', async () => {
    await db.insert(guardOrphanNotifyState).values({ tenantId: TENANT });
    const [row] = await db.select().from(guardOrphanNotifyState).where(like(guardOrphanNotifyState.tenantId, TENANT));
    expect(row.notifiedThroughId).toBe(0);
    expect(row.lastNoticeAt).toBeNull();
    expect(row.pendingSince).toBeNull();
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it('重复 tenantId 违反主键', async () => {
    await db.insert(guardOrphanNotifyState).values({ tenantId: TENANT });
    const msg = await rejection(db.insert(guardOrphanNotifyState).values({ tenantId: TENANT }));
    expect(msg).toMatch(/duplicate key|GuardOrphanNotifyState_pkey/);
  });

  it('GuardOrphanEmailState 的 (tenantId, userId) 唯一，不同收件人或租户互不冲突', async () => {
    const at = new Date('2026-11-28T00:00:00Z');
    await db.insert(guardOrphanEmailState).values({ tenantId: TENANT, userId: 'u1', lastEmailAt: at });
    await db.insert(guardOrphanEmailState).values({ tenantId: TENANT, userId: 'u2', lastEmailAt: at });
    await db.insert(guardOrphanEmailState).values({ tenantId: `${TENANT}-b`, userId: 'u1', lastEmailAt: at });
    const msg = await rejection(
      db.insert(guardOrphanEmailState).values({ tenantId: TENANT, userId: 'u1', lastEmailAt: at }),
    );
    expect(msg).toMatch(/duplicate key|GuardOrphanEmailState_tenantId_userId_pk/);
  });

  it('lastEmailAt 不可为空', async () => {
    const msg = await rejection(
      db.execute(sql`INSERT INTO "GuardOrphanEmailState" ("tenantId", "userId") VALUES (${TENANT}, 'u1')`),
    );
    expect(msg).toMatch(/null value|not-null/i);
  });

  it('比较后写：期望旧值与实际一致时更新，不一致时返回 0 行', async () => {
    await db.insert(guardOrphanNotifyState).values({ tenantId: TENANT, notifiedThroughId: 7 });

    const upsert = (expected: number, next: number) =>
      db.execute(sql`
        INSERT INTO "GuardOrphanNotifyState" ("tenantId", "notifiedThroughId")
        VALUES (${TENANT}, ${next})
        ON CONFLICT ("tenantId") DO UPDATE SET "notifiedThroughId" = EXCLUDED."notifiedThroughId"
        WHERE "GuardOrphanNotifyState"."notifiedThroughId" = ${expected}
        RETURNING "notifiedThroughId"`);

    const stale = await upsert(5, 12);
    expect(stale.rowCount).toBe(0);

    const fresh = await upsert(7, 12);
    expect(fresh.rowCount).toBe(1);
    expect(Number(fresh.rows[0].notifiedThroughId)).toBe(12);
  });
});
