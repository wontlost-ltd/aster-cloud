// ADR 0065 §4 第 3 步的本地全栈端到端：真实 aster-api（含通知源与对账）+ 真实 Postgres，
// 在进程内调用 notifyOrphansDetected()，覆盖「首条通知 / 只计新增 / 安静期合并 / key 不一致」。
//
// 前置（缺 E2E_ASTER_API_URL 时整组跳过）：
// - aster-api 可经 E2E_ASTER_API_URL 访问，对账每分钟一轮：
//   ASTER_GUARD_RECONCILIATION_CRON='0 * * * * ?'、ASTER_GUARD_RECONCILIATION_MIN_INTERVAL=PT0S；
// - aster-api 与本进程共用 ASTER_PLAN_GATE_HMAC_KEY；
// - aster-api 的 ASTER_CLOUD_INTERNAL_URL 指向一个连着同一 DATABASE_URL 的 cloud 服务：
//   用例把团队 API key 直接写进 ApiKey 表，aster-api 经 cloud /api/internal/apikey/verify 校验它；
// - aster-api 的库专供本用例（通知源跨租户聚合，别的租户残留的 OPEN critical 会混进 tick 计数）。
//
// Run: E2E_ASTER_API_URL=http://localhost:8865 ASTER_PLAN_GATE_HMAC_KEY=… LICENSE_E2E=1 DATABASE_URL=… \
//   pnpm exec vitest run --config vitest.integration.config.ts guard-orphan-notify-e2e

import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';

vi.mock('server-only', () => ({}));

import { createDb } from '@/db';
import { apiKeys, guardOrphanNotifyState, notifications, teamMembers, teams, users } from '@/db/schema';
import { hashApiKey } from '@/lib/api-keys';
import { notifyOrphansDetected } from '@/lib/guard-notifications';
import { OrphanFeedError } from '@/lib/guard-orphan-notify/feed-client';
import type { GuardOrphansDetectedNotification } from '@/lib/notifications';
import { PLATFORM_SETTING_KEYS, setSetting } from '@/lib/platform-settings';

const API = process.env.E2E_ASTER_API_URL;
const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
const PREFIX = `e2e-orphan-${RUN}-`;
const TEAM = `${PREFIX}team`;
const U = { owner: `${PREFIX}owner`, admin: `${PREFIX}admin`, member: `${PREFIX}member` };
const KEY = { member: `ak_${randomBytes(32).toString('hex')}`, admin: `ak_${randomBytes(32).toString('hex')}` };
const KIND = 'side_effect_without_decision';
const FLAG = PLATFORM_SETTING_KEYS.GUARD_ORPHAN_NOTIFICATIONS_ENABLED;
const ACTOR = 'e2e-guard-orphan-notify';
/** 对账每分钟一轮；留出一轮错过与 API key 冷校验的余量。 */
const WAIT_ORPHAN_MS = 120_000;
const STEP_TIMEOUT_MS = 180_000;
const QUIET_EXPIRED_MS = 61 * 60_000;

type Db = ReturnType<typeof createDb>;
const globalForDb = globalThis as unknown as { __asterLocalDevDb?: Db | null };

interface OrphanView {
  id: number;
  kind: string;
  severity: string;
  status: string;
}

describe.skipIf(!API)('孤儿通知端到端（真实 aster-api + Postgres）', () => {
  const previousDb = globalForDb.__asterLocalDevDb;
  const previousApiUrl = process.env.ASTER_API_INTERNAL_URL;
  const db: Db = createDb(undefined, { max: 4 });
  let effectSeq = 0;

  async function api(path: string, key: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${API}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...init.headers },
    });
  }

  /** 以 MEMBER key 上报 n 条不带 decisionId 的副作用（ADR 0054 §10.2）。 */
  async function reportSideEffects(n: number): Promise<void> {
    const effects = Array.from({ length: n }, () => ({
      effectId: `${PREFIX}effect-${++effectSeq}`,
      source: 'e2e-orphan-notify',
      occurredAt: new Date().toISOString(),
      action: { name: 'e2e.delete_record' },
    }));
    const res = await api('/api/v1/guard/side-effects', KEY.member, { method: 'POST', body: JSON.stringify({ effects }) });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ accepted: n, duplicates: 0 });
  }

  async function openOrphans(): Promise<OrphanView[]> {
    const res = await api('/api/v1/guard/reconciliation/orphans?status=OPEN&severity=critical&limit=200', KEY.member);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { items: OrphanView[] }).items;
  }

  /** 轮询直到 id 大于 afterId 的 OPEN side_effect_without_decision 达到 count 条，返回按 id 升序的这些行。 */
  async function waitForOrphans(afterId: number, count: number): Promise<OrphanView[]> {
    const deadline = Date.now() + WAIT_ORPHAN_MS;
    for (;;) {
      const fresh = (await openOrphans()).filter((o) => o.kind === KIND && o.id > afterId).sort((a, b) => a.id - b.id);
      if (fresh.length >= count) {
        expect(fresh).toHaveLength(count);
        return fresh;
      }
      if (Date.now() > deadline) throw new Error(`等待孤儿超时：期望 ${count} 条，实际 ${fresh.length} 条`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async function acknowledge(id: number): Promise<void> {
    const res = await api(`/api/v1/guard/reconciliation/orphans/${id}/ack`, KEY.admin, {
      method: 'POST',
      body: JSON.stringify({ comment: 'e2e: 已核实' }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
  }

  const noticeRows = async () =>
    (await db.select().from(notifications).where(like(notifications.id, `guard-orphans:${TEAM}:%`))).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  const stateRow = async () =>
    (await db.select().from(guardOrphanNotifyState).where(eq(guardOrphanNotifyState.tenantId, TEAM)))[0];
  /** 把 lastNoticeAt 挪到安静期之外，模拟 61 分钟后的 tick。 */
  const expireQuietPeriod = () =>
    db
      .update(guardOrphanNotifyState)
      .set({ lastNoticeAt: new Date(Date.now() - QUIET_EXPIRED_MS) })
      .where(eq(guardOrphanNotifyState.tenantId, TEAM));

  /** 某个 maxOrphanId 对应的那一组通知：收件人与载荷。 */
  async function noticeBatch(maxOrphanId: number) {
    const rows = (await noticeRows()).filter((r) => r.id.startsWith(`guard-orphans:${TEAM}:${maxOrphanId}:`));
    return {
      userIds: rows.map((r) => r.userId).sort(),
      kinds: [...new Set(rows.map((r) => r.kind))],
      data: rows.map((r) => r.data as GuardOrphansDetectedNotification),
    };
  }

  async function cleanupCloud() {
    await db.delete(notifications).where(like(notifications.id, `guard-orphans:${PREFIX}%`));
    await db.delete(guardOrphanNotifyState).where(like(guardOrphanNotifyState.tenantId, `${PREFIX}%`));
    await db.delete(apiKeys).where(like(apiKeys.id, `${PREFIX}%`));
    await db.delete(teamMembers).where(like(teamMembers.teamId, `${PREFIX}%`));
    await db.delete(teams).where(like(teams.id, `${PREFIX}%`));
    await db.delete(users).where(like(users.id, `${PREFIX}%`));
  }

  beforeAll(async () => {
    globalForDb.__asterLocalDevDb = db;
    process.env.ASTER_API_INTERNAL_URL = API;
    expect(process.env.ASTER_PLAN_GATE_HMAC_KEY, '需与 aster-api 共用 ASTER_PLAN_GATE_HMAC_KEY').toBeTruthy();

    await db.insert(users).values(
      Object.values(U).map((id) => ({ id, email: `${id}@example.test`, updatedAt: new Date() }) as typeof users.$inferInsert),
    );
    await db.insert(teams).values({ id: TEAM, name: 'E2E Orphan Team', slug: `${PREFIX}slug`, ownerId: U.owner });
    await db.insert(teamMembers).values([
      { id: `${PREFIX}m-owner`, teamId: TEAM, userId: U.owner, role: 'owner' as const },
      { id: `${PREFIX}m-admin`, teamId: TEAM, userId: U.admin, role: 'admin' as const },
      { id: `${PREFIX}m-member`, teamId: TEAM, userId: U.member, role: 'member' as const },
    ]);
    await db.insert(apiKeys).values([
      { id: `${PREFIX}key-member`, userId: U.member, teamId: TEAM, name: 'e2e member', key: hashApiKey(KEY.member), prefix: KEY.member.slice(3, 11) },
      { id: `${PREFIX}key-admin`, userId: U.admin, teamId: TEAM, name: 'e2e admin', key: hashApiKey(KEY.admin), prefix: KEY.admin.slice(3, 11) },
    ]);
    await setSetting(FLAG, true, ACTOR);
  }, 30_000);

  afterAll(async () => {
    try {
      await setSetting(FLAG, false, ACTOR);
      // 确认本租户剩下的 OPEN 孤儿，下次运行的 tick 不会再看到它们
      for (const o of await openOrphans().catch(() => [])) await acknowledge(o.id).catch(() => undefined);
      await cleanupCloud();
    } finally {
      process.env.ASTER_API_INTERNAL_URL = previousApiUrl;
      globalForDb.__asterLocalDevDb = previousDb;
      await db.$client.end();
    }
  }, 60_000);

  let first: OrphanView;
  let second: OrphanView;

  it('首条：owner / admin 各一条 guard.orphans_detected，member 不收，newTotal = 1', async () => {
    await reportSideEffects(1);
    [first] = await waitForOrphans(0, 1);
    expect(first.severity).toBe('critical');

    const report = await notifyOrphansDetected();
    expect(report).toMatchObject({ ran: true, tenantsWithNew: 1, noticesCreated: 1, recipients: 2, summaryFailed: 0 });

    const batch = await noticeBatch(first.id);
    expect(batch.userIds).toEqual([U.admin, U.owner].sort());
    expect(batch.kinds).toEqual(['guard.orphans_detected']);
    for (const data of batch.data) {
      expect(data).toMatchObject({
        tenantId: TEAM,
        tenantName: 'E2E Orphan Team',
        newTotal: 1,
        byKind: { [KIND]: 1 },
        maxOrphanId: first.id,
      });
    }
    expect((await noticeRows()).some((r) => r.userId === U.member)).toBe(false);
    const state = await stateRow();
    expect(state.notifiedThroughId).toBe(first.id);
    expect(state.lastNoticeAt).not.toBeNull();
    expect(state.pendingSince).toBeNull();
  }, STEP_TIMEOUT_MS);

  it('确认后再报一条：安静期满后的第二条通知只计新增，maxOrphanId 更大', async () => {
    await acknowledge(first.id);
    await reportSideEffects(1);
    [second] = await waitForOrphans(first.id, 1);
    await expireQuietPeriod();

    const report = await notifyOrphansDetected();
    expect(report).toMatchObject({ ran: true, noticesCreated: 1, recipients: 2 });

    const batch = await noticeBatch(second.id);
    expect(second.id).toBeGreaterThan(first.id);
    expect(batch.userIds).toEqual([U.admin, U.owner].sort());
    for (const data of batch.data) expect(data).toMatchObject({ newTotal: 1, maxOrphanId: second.id });
    expect(await noticeRows()).toHaveLength(4);
    expect((await stateRow()).notifiedThroughId).toBe(second.id);
  }, STEP_TIMEOUT_MS);

  it('安静期内连报两条：tick 不发、水位不动；期满后合并为一条 newTotal = 2', async () => {
    await reportSideEffects(1);
    await reportSideEffects(1);
    const fresh = await waitForOrphans(second.id, 2);

    const quiet = await notifyOrphansDetected();
    expect(quiet).toMatchObject({ ran: true, noticesCreated: 0, deferredQuiet: 1 });
    const deferred = await stateRow();
    expect(deferred.notifiedThroughId).toBe(second.id);
    expect(deferred.pendingSince).not.toBeNull();
    expect(await noticeRows()).toHaveLength(4);

    await expireQuietPeriod();
    const merged = await notifyOrphansDetected();
    expect(merged).toMatchObject({ ran: true, noticesCreated: 1, recipients: 2 });
    const maxId = fresh[1].id;
    const batch = await noticeBatch(maxId);
    expect(batch.userIds).toEqual([U.admin, U.owner].sort());
    for (const data of batch.data) expect(data).toMatchObject({ newTotal: 2, byKind: { [KIND]: 2 }, maxOrphanId: maxId });
    const state = await stateRow();
    expect(state.notifiedThroughId).toBe(maxId);
    expect(state.pendingSince).toBeNull();
  }, STEP_TIMEOUT_MS);

  it('cloud 侧 key 与 aster-api 不一致：tick 抛 401，状态表与通知行都不变', async () => {
    // 先制造一条待通知的新增，确认失败的 tick 确实「本该」改状态
    const lastNotified = (await stateRow()).notifiedThroughId;
    await reportSideEffects(1);
    const [pending] = await waitForOrphans(lastNotified, 1);
    await expireQuietPeriod();
    const before = await stateRow();
    const rowsBefore = await noticeRows();

    const goodKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
    process.env.ASTER_PLAN_GATE_HMAC_KEY = randomBytes(32).toString('hex');
    try {
      const err = await notifyOrphansDetected().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(OrphanFeedError);
      expect((err as OrphanFeedError).status).toBe(401);
    } finally {
      process.env.ASTER_PLAN_GATE_HMAC_KEY = goodKey;
    }

    expect(await stateRow()).toEqual(before);
    expect(await noticeRows()).toEqual(rowsBefore);
    expect(pending.id).toBeGreaterThan(before.notifiedThroughId);
  }, STEP_TIMEOUT_MS);
});
