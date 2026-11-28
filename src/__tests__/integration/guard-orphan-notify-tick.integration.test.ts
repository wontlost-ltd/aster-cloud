// ADR 0065 §3.4.3：每 tick 编排，真实 Postgres（T-C5 / T-C6 真实实现）+ 内存假通知源。
//
// Run: LICENSE_E2E=1 DATABASE_URL=… pnpm exec vitest run --config vitest.integration.config.ts guard-orphan-notify-tick

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

import { createDb } from '@/db';
import { guardOrphanNotifyState, notifications, teamMembers, teams, users } from '@/db/schema';
import type { OrphanFeed, OrphanFeedSummary } from '@/lib/guard-orphan-notify/feed-client';
import { resolveOrphanRecipients } from '@/lib/guard-orphan-notify/recipients';
import { clearPending, clearStalePending, commitTenantNotice, loadNotifyStates, markPending } from '@/lib/guard-orphan-notify/state';
import { runOrphanNotifyTick, type OrphanNotifyDeps } from '@/lib/guard-orphan-notify/tick';

const PREFIX = 'it-orphan-tick-';
const TEAM = `${PREFIX}team`;
const ADMINS = [`${PREFIX}admin1`, `${PREFIX}admin2`];

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

/** 内存通知源：行 id 单调递增，summary 按 afterId 过滤并由同一份数据同时给出计数与 maxId。 */
class FakeFeed implements OrphanFeed {
  rows: number[] = [];
  summaryCalls: { afterId: number }[] = [];
  /** 非空时 summary 会等它 resolve，用来让两个 tick 都读到同一旧水位。 */
  gate: Promise<void> | null = null;
  onSummary: (() => void) | null = null;

  async tenants() {
    return { items: this.rows.length ? [{ tenantId: TEAM, maxId: Math.max(...this.rows) }] : [] };
  }

  async summary(q: { tenantId: string; afterId: number }): Promise<OrphanFeedSummary> {
    this.summaryCalls.push({ afterId: q.afterId });
    const mine = this.rows.filter((id) => id > q.afterId);
    this.onSummary?.();
    if (this.gate) await this.gate;
    return {
      tenantId: q.tenantId,
      maxId: mine.length ? Math.max(...mine) : q.afterId,
      total: mine.length,
      byKind: { executor_missing: mine.length },
      firstDetectedAt: '2026-11-28T10:00:00.000Z',
      lastDetectedAt: '2026-11-28T11:00:00.000Z',
      runIds: [1],
    };
  }
}

describe.skipIf(process.env.LICENSE_E2E !== '1')('孤儿通知 tick（真实 Postgres）', () => {
  const previous = globalForDb.__asterLocalDevDb;
  // 连接池 max=4：并发 tick 的两个事务占用各自独立的连接。
  const db: Db = createDb(undefined, { max: 4 });
  const now = new Date('2026-11-28T12:00:00.000Z');
  let feed: FakeFeed;

  const deps = (): OrphanNotifyDeps => ({
    inAppEnabled: async () => true,
    feed,
    loadStates: loadNotifyStates,
    markPending,
    clearPending,
    clearStalePending,
    commit: commitTenantNotice,
    recipients: resolveOrphanRecipients,
  });
  const noticeRows = () => db.select().from(notifications).where(like(notifications.id, `guard-orphans:${TEAM}:%`));
  const stateRow = async () =>
    (await db.select().from(guardOrphanNotifyState).where(eq(guardOrphanNotifyState.tenantId, TEAM)))[0];

  async function cleanup() {
    await db.delete(guardOrphanNotifyState).where(like(guardOrphanNotifyState.tenantId, `${PREFIX}%`));
    await db.delete(notifications).where(like(notifications.id, `guard-orphans:${PREFIX}%`));
    await db.delete(teamMembers).where(like(teamMembers.teamId, `${PREFIX}%`));
    await db.delete(teams).where(like(teams.id, `${PREFIX}%`));
    await db.delete(users).where(like(users.id, `${PREFIX}%`));
  }

  beforeAll(() => {
    globalForDb.__asterLocalDevDb = db;
  });
  beforeEach(async () => {
    await cleanup();
    await db.insert(users).values(
      ADMINS.map((id) => ({ id, email: `${id}@example.test`, updatedAt: new Date() }) as typeof users.$inferInsert),
    );
    await db.insert(teams).values({ id: TEAM, name: 'Tick Team', slug: `${PREFIX}slug`, ownerId: ADMINS[0] });
    await db
      .insert(teamMembers)
      .values(ADMINS.map((userId, i) => ({ id: `${PREFIX}m${i}`, teamId: TEAM, userId, role: 'admin' as const })));
    feed = new FakeFeed();
    feed.rows = [8, 9, 10];
  });
  afterAll(async () => {
    await cleanup();
    globalForDb.__asterLocalDevDb = previous;
    await db.$client.end();
  });

  it('rerun of same batch creates no second row', async () => {
    const r1 = await runOrphanNotifyTick(deps(), now);
    expect(r1).toMatchObject({ noticesCreated: 1, recipients: 2, casLost: 0 });
    expect(await noticeRows()).toHaveLength(2);

    // 模拟重放：水位回到旧值（行被删），同一 maxId 再写一次
    await db.delete(guardOrphanNotifyState).where(eq(guardOrphanNotifyState.tenantId, TEAM));
    const r2 = await runOrphanNotifyTick(deps(), now);
    expect(r2.noticesCreated).toBe(1);
    expect(await noticeRows()).toHaveLength(2);
    expect((await stateRow()).notifiedThroughId).toBe(10);
  });

  it('rows committed after summary are picked up next tick', async () => {
    await runOrphanNotifyTick(deps(), now);
    expect((await stateRow()).notifiedThroughId).toBe(10);

    feed.rows.push(11, 12);
    feed.summaryCalls = [];
    const later = new Date(now.getTime() + 2 * 3600_000);
    const r2 = await runOrphanNotifyTick(deps(), later);
    expect(feed.summaryCalls).toEqual([{ afterId: 10 }]);
    expect(r2.noticesCreated).toBe(1);
    const rows = await noticeRows();
    expect(rows).toHaveLength(4);
    const second = rows.filter((r) => r.id.includes(':12:'));
    expect(second).toHaveLength(2);
    expect((second[0].data as { newTotal: number }).newTotal).toBe(2);
    expect((await stateRow()).notifiedThroughId).toBe(12);
  });

  it('two concurrent ticks notify once', async () => {
    // 两个 tick 都进入 summary 后才放行，保证二者读到同一旧水位 0
    let arrived = 0;
    let release!: () => void;
    feed.gate = new Promise<void>((resolve) => (release = resolve));
    feed.onSummary = () => {
      if (++arrived === 2) release();
    };
    const [a, b] = await Promise.all([runOrphanNotifyTick(deps(), now), runOrphanNotifyTick(deps(), now)]);
    expect(a.casLost + b.casLost).toBe(1);
    expect(a.noticesCreated + b.noticesCreated).toBe(1);
    expect(await noticeRows()).toHaveLength(2);
    expect((await stateRow()).notifiedThroughId).toBe(10);
  });
});
