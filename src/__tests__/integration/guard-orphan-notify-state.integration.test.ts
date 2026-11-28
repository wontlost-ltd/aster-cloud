// ADR 0065 §3.3 / R3：孤儿通知水位的比较后写事务，真实 Postgres。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts guard-orphan-notify-state

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

import { createDb } from '@/db';
import { guardOrphanNotifyState, notifications } from '@/db/schema';
import type { GuardOrphansDetectedNotification } from '@/lib/notifications';
import {
  clearPending,
  commitTenantNotice,
  loadNotifyStates,
  markPending,
} from '@/lib/guard-orphan-notify/state';

const PREFIX = 'it-orphan-state-';

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

function data(tenantId: string, maxOrphanId: number): GuardOrphansDetectedNotification {
  return {
    tenantId,
    tenantName: 'Tenant',
    newTotal: 1,
    byKind: { executor_missing: 1 },
    firstDetectedAt: '2026-11-28T00:00:00.000Z',
    lastDetectedAt: '2026-11-28T00:01:00.000Z',
    maxOrphanId,
    runIds: [],
  } as unknown as GuardOrphansDetectedNotification;
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('孤儿通知水位（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  // 连接池 max=4：并发用例的两个事务各占一条独立连接，而不是在单连接上串行。
  const db: Db = createDb(undefined, { max: 4 });
  const now = new Date('2026-11-28T10:20:30.123Z');
  let seq = 0;
  const newTenant = () => `${PREFIX}t${Date.now()}-${++seq}`;
  const notice = (tenantId: string, userId: string, maxId: number) => ({
    id: `guard-orphans:${tenantId}:${maxId}:${userId}`,
    userId,
    data: data(tenantId, maxId),
  });

  async function cleanup() {
    await db.delete(guardOrphanNotifyState).where(like(guardOrphanNotifyState.tenantId, `${PREFIX}%`));
    await db.delete(notifications).where(like(notifications.id, `guard-orphans:${PREFIX}%`));
  }
  const stateOf = async (tenantId: string) =>
    (await db.select().from(guardOrphanNotifyState).where(eq(guardOrphanNotifyState.tenantId, tenantId)))[0];
  const noticesOf = (tenantId: string) =>
    db.select().from(notifications).where(like(notifications.id, `guard-orphans:${tenantId}:%`));

  beforeAll(() => {
    globalForDb.__asterLocalDevDb = db;
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end();
  });

  it('first commit inserts state and notices', async () => {
    const t = newTenant();
    const result = await commitTenantNotice({
      tenantId: t,
      expectedThroughId: 0,
      newThroughId: 10,
      notices: [notice(t, 'u1', 10), notice(t, 'u2', 10)],
      now,
    });
    expect(result).toBe('committed');
    const row = await stateOf(t);
    expect(row.notifiedThroughId).toBe(10);
    expect(row.lastNoticeAt).toEqual(now);
    expect(row.updatedAt).toEqual(now);
    expect(row.pendingSince).toBeNull();
    const rows = await noticesOf(t);
    expect(rows.map((r) => r.id).sort()).toEqual([`guard-orphans:${t}:10:u1`, `guard-orphans:${t}:10:u2`]);
    expect(rows.every((r) => r.kind === 'guard.orphans_detected' && r.readAt === null)).toBe(true);
    expect(rows[0].createdAt).toEqual(now);
  });

  it('stale expectation loses', async () => {
    const t = newTenant();
    await commitTenantNotice({ tenantId: t, expectedThroughId: 0, newThroughId: 10, notices: [], now });
    const result = await commitTenantNotice({
      tenantId: t,
      expectedThroughId: 5,
      newThroughId: 12,
      notices: [notice(t, 'u1', 12)],
      now,
    });
    expect(result).toBe('cas_lost');
    expect((await stateOf(t)).notifiedThroughId).toBe(10);
    expect(await noticesOf(t)).toHaveLength(0);
  });

  it('concurrent commits advance once', async () => {
    const t = newTenant();
    const [a, b] = await Promise.all([
      commitTenantNotice({ tenantId: t, expectedThroughId: 0, newThroughId: 10, notices: [notice(t, 'ua', 10)], now }),
      commitTenantNotice({ tenantId: t, expectedThroughId: 0, newThroughId: 12, notices: [notice(t, 'ub', 12)], now }),
    ]);
    expect([a, b].sort()).toEqual(['cas_lost', 'committed']);
    const winnerIsA = a === 'committed';
    const row = await stateOf(t);
    expect(row.notifiedThroughId).toBe(winnerIsA ? 10 : 12);
    const rows = await noticesOf(t);
    expect(rows.map((r) => r.id)).toEqual([winnerIsA ? `guard-orphans:${t}:10:ua` : `guard-orphans:${t}:12:ub`]);
  });

  // 持锁事务 L 先占住冲突点，B 必然在 L 未提交时开始并被阻塞；L 提交后 B 重新评估 WHERE。
  async function raceAgainstHeldTransaction(t: string, hold: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<void>) {
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (locked = r));
    const holder = db.transaction(async (tx) => {
      await hold(tx);
      locked();
      await gate;
    });
    await held;
    let settled = false;
    const b = commitTenantNotice({
      tenantId: t,
      expectedThroughId: 0,
      newThroughId: 12,
      notices: [notice(t, 'ub', 12)],
      now,
    }).finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false); // B 确实被未提交的 A 阻塞
    release();
    await holder;
    return b;
  }

  it('overlapping commit loses while winner is uncommitted (no row yet)', async () => {
    const t = newTenant();
    const result = await raceAgainstHeldTransaction(t, async (tx) => {
      await tx.execute(sql`INSERT INTO "GuardOrphanNotifyState" ("tenantId","notifiedThroughId","lastNoticeAt","updatedAt") VALUES (${t}, 10, ${now.toISOString()}::timestamp, ${now.toISOString()}::timestamp)`);
      await tx.insert(notifications).values({ id: `guard-orphans:${t}:10:ua`, userId: 'ua', kind: 'guard.orphans_detected', data: data(t, 10) });
    });
    expect(result).toBe('cas_lost');
    expect((await stateOf(t)).notifiedThroughId).toBe(10);
    expect((await noticesOf(t)).map((r) => r.id)).toEqual([`guard-orphans:${t}:10:ua`]);
  });

  it('overlapping commit loses while winner is uncommitted (row exists)', async () => {
    const t = newTenant();
    await markPending([t], now);
    const result = await raceAgainstHeldTransaction(t, async (tx) => {
      await tx.execute(sql`UPDATE "GuardOrphanNotifyState" SET "notifiedThroughId" = 10 WHERE "tenantId" = ${t}`);
      await tx.insert(notifications).values({ id: `guard-orphans:${t}:10:ua`, userId: 'ua', kind: 'guard.orphans_detected', data: data(t, 10) });
    });
    expect(result).toBe('cas_lost');
    expect((await stateOf(t)).notifiedThroughId).toBe(10);
    expect((await noticesOf(t)).map((r) => r.id)).toEqual([`guard-orphans:${t}:10:ua`]);
  });

  it('concurrent commits really use separate connections', async () => {
    // 前提校验：池内两个并发事务拿到不同的后端 pid，否则上一个用例会平凡地串行。
    const pids = await Promise.all(
      [0, 1].map(() =>
        db.transaction(async (tx) => {
          const res = await tx.execute<{ pid: number; slept: string }>(
            // 持有事务 300ms，确保两个事务在时间上重叠
            sql`SELECT pg_backend_pid() AS "pid", pg_sleep(0.3)::text AS "slept"`,
          );
          const rows = Array.isArray(res) ? res : (res as { rows: Array<{ pid: number }> }).rows;
          return rows[0].pid;
        }),
      ),
    );
    expect(new Set(pids).size).toBe(2);
  });

  it('notice insert failure rolls back watermark', async () => {
    const t = newTenant();
    await expect(
      commitTenantNotice({
        tenantId: t,
        expectedThroughId: 0,
        newThroughId: 10,
        notices: [{ id: `guard-orphans:${t}:10:bad`, userId: null as never, data: data(t, 10) }],
        now,
      }),
    ).rejects.toThrow();
    expect(await stateOf(t)).toBeUndefined();
  });

  it('empty recipients advance only', async () => {
    const t = newTenant();
    const result = await commitTenantNotice({ tenantId: t, expectedThroughId: 0, newThroughId: 7, notices: [], now });
    expect(result).toBe('committed');
    const row = await stateOf(t);
    expect(row.notifiedThroughId).toBe(7);
    expect(row.lastNoticeAt).toBeNull();
    expect(await noticesOf(t)).toHaveLength(0);

    // 已有 lastNoticeAt 时，空收件人推进不改写它
    await commitTenantNotice({ tenantId: t, expectedThroughId: 7, newThroughId: 9, notices: [notice(t, 'u1', 9)], now });
    const later = new Date(now.getTime() + 3_600_000);
    await commitTenantNotice({ tenantId: t, expectedThroughId: 9, newThroughId: 11, notices: [], now: later });
    const after = await stateOf(t);
    expect(after.notifiedThroughId).toBe(11);
    expect(after.lastNoticeAt).toEqual(now);
  });

  it('duplicate notice id ignored', async () => {
    const t = newTenant();
    const n = notice(t, 'u1', 10);
    await db.insert(notifications).values({ id: n.id, userId: 'u1', kind: 'guard.orphans_detected', data: n.data });
    const result = await commitTenantNotice({ tenantId: t, expectedThroughId: 0, newThroughId: 10, notices: [n], now });
    expect(result).toBe('committed');
    expect(await noticesOf(t)).toHaveLength(1);
  });

  it('rejects non-increasing watermark before touching the database', async () => {
    const t = newTenant();
    await expect(
      commitTenantNotice({ tenantId: t, expectedThroughId: 5, newThroughId: 5, notices: [], now }),
    ).rejects.toThrow();
    expect(await stateOf(t)).toBeUndefined();
  });

  it('markPending keeps the earliest', async () => {
    const t = newTenant();
    const t1 = new Date('2026-11-28T09:00:00.456Z');
    const t2 = new Date('2026-11-28T09:30:00.000Z');
    await markPending([t], t1);
    await markPending([t], t2);
    const row = await stateOf(t);
    expect(row.pendingSince).toEqual(t1);
    expect(row.notifiedThroughId).toBe(0);
    expect(row.updatedAt).toEqual(t2);

    await commitTenantNotice({ tenantId: t, expectedThroughId: 0, newThroughId: 3, notices: [], now });
    expect((await stateOf(t)).pendingSince).toBeNull();
  });

  it('markPending touches updatedAt on conflict and handles empty / multiple', async () => {
    const a = newTenant();
    const b = newTenant();
    const t1 = new Date('2026-11-28T09:00:00.000Z');
    const t2 = new Date('2026-11-28T09:30:00.000Z');
    await markPending([], t1);
    await markPending([a, b], t1);
    await markPending([a], t2);
    expect((await stateOf(a)).updatedAt).toEqual(t2);
    expect((await stateOf(b)).updatedAt).toEqual(t1);
  });

  it('markPending tolerates duplicate ids and chunks large batches', async () => {
    const a = newTenant();
    await expect(markPending([a, a, a], now)).resolves.toBeUndefined();
    const ids = Array.from({ length: 450 }, () => newTenant());
    await markPending([...ids, ...ids.slice(0, 10)], now);
    expect((await loadNotifyStates(ids)).size).toBe(450);
  });

  it('clearPending clears pendingSince only', async () => {
    const t = newTenant();
    const past = new Date('2020-01-01T00:00:00.000Z');
    await markPending([t], past);
    await clearPending(t);
    const row = await stateOf(t);
    expect(row.pendingSince).toBeNull();
    expect(row.updatedAt.getTime()).toBeGreaterThan(past.getTime());
    expect(row.notifiedThroughId).toBe(0);
  });

  it('loadNotifyStates returns existing rows and ignores missing', async () => {
    const a = newTenant();
    const b = newTenant();
    const missing = newTenant();
    await commitTenantNotice({ tenantId: a, expectedThroughId: 0, newThroughId: 4, notices: [notice(a, 'u', 4)], now });
    await markPending([b], now);
    const map = await loadNotifyStates([a, b, missing]);
    expect([...map.keys()].sort()).toEqual([a, b].sort());
    expect(map.get(a)).toEqual({ tenantId: a, notifiedThroughId: 4, lastNoticeAt: now, pendingSince: null });
    expect(map.get(b)).toEqual({ tenantId: b, notifiedThroughId: 0, lastNoticeAt: null, pendingSince: now });
    expect((await loadNotifyStates([])).size).toBe(0);
  });

  it('loadNotifyStates batches beyond 200 ids', async () => {
    const ids = Array.from({ length: 450 }, () => newTenant());
    await markPending([ids[0], ids[210], ids[449]], now);
    const map = await loadNotifyStates(ids);
    expect(map.size).toBe(3);
  });
});
