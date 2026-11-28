// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { OrphanFeed, OrphanFeedSummary } from '@/lib/guard-orphan-notify/feed-client';
import type { NotifyState } from '@/lib/guard-orphan-notify/state';
import {
  MAX_INDEX_PAGES,
  runOrphanNotifyTick,
  type OrphanNotifyDeps,
} from '@/lib/guard-orphan-notify/tick';

const NOW = new Date('2026-11-28T12:00:00.000Z');
const MIN = 60_000;
const FIRST = '2026-11-28T10:00:00.000Z';

const tid = (n: number) => `t${String(n).padStart(3, '0')}`;
const summaryOf = (tenantId: string, maxId: number, total = 2): OrphanFeedSummary => ({
  tenantId,
  maxId,
  total,
  byKind: { executor_missing: total },
  firstDetectedAt: FIRST,
  lastDetectedAt: '2026-11-28T11:00:00.000Z',
  runIds: [1],
});
const state = (tenantId: string, over: Partial<NotifyState> = {}): NotifyState => ({
  tenantId,
  notifiedThroughId: 0,
  lastNoticeAt: null,
  pendingSince: null,
  ...over,
});

interface Harness {
  deps: OrphanNotifyDeps;
  tenants: ReturnType<typeof vi.fn>;
  summary: ReturnType<typeof vi.fn>;
  loadStates: ReturnType<typeof vi.fn>;
  markPending: ReturnType<typeof vi.fn>;
  clearPending: ReturnType<typeof vi.fn>;
  clearStalePending: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  recipients: ReturnType<typeof vi.fn>;
  states: Map<string, NotifyState>;
  index: { tenantId: string; maxId: number }[];
  summaries: Map<string, OrphanFeedSummary>;
}

function harness(): Harness {
  const h = {
    states: new Map<string, NotifyState>(),
    index: [] as { tenantId: string; maxId: number }[],
    summaries: new Map<string, OrphanFeedSummary>(),
  } as Harness;
  h.tenants = vi.fn(async () => ({ items: h.index }));
  h.summary = vi.fn(async (q: { tenantId: string }) => h.summaries.get(q.tenantId) ?? summaryOf(q.tenantId, 10));
  h.loadStates = vi.fn(async () => h.states);
  h.markPending = vi.fn(async () => undefined);
  h.clearPending = vi.fn(async () => undefined);
  h.clearStalePending = vi.fn(async () => undefined);
  h.commit = vi.fn(async () => 'committed');
  h.recipients = vi.fn(async () => ({ kind: 'team', tenantName: 'Team', userIds: ['u1', 'u2'] }));
  h.deps = {
    inAppEnabled: async () => true,
    feed: { tenants: h.tenants, summary: h.summary } as unknown as OrphanFeed,
    loadStates: h.loadStates as OrphanNotifyDeps['loadStates'],
    markPending: h.markPending as OrphanNotifyDeps['markPending'],
    clearPending: h.clearPending as OrphanNotifyDeps['clearPending'],
    clearStalePending: h.clearStalePending as OrphanNotifyDeps['clearStalePending'],
    commit: h.commit as OrphanNotifyDeps['commit'],
    recipients: h.recipients as OrphanNotifyDeps['recipients'],
  };
  return h;
}

function seed(h: Harness, n: number, startAt = 0, maxId = 10) {
  for (let i = startAt; i < startAt + n; i++) h.index.push({ tenantId: tid(i), maxId });
}

describe('runOrphanNotifyTick', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('disabled does nothing', async () => {
    h.deps.inAppEnabled = async () => false;
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(r.ran).toBe(false);
    expect(r.maxLagSeconds).toBeNull();
    expect(r.oldestPendingSeconds).toBeNull();
    expect(h.tenants).not.toHaveBeenCalled();
    expect(h.loadStates).not.toHaveBeenCalled();
    expect(h.clearStalePending).not.toHaveBeenCalled();
  });

  it('first enable sends one summary per tenant, then nothing once the watermark advanced', async () => {
    seed(h, 3);
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(h.commit).toHaveBeenCalledTimes(3);
    for (const [arg] of h.commit.mock.calls) {
      expect(arg.expectedThroughId).toBe(0);
      expect(arg.newThroughId).toBe(10);
      expect(arg.notices.map((n: { userId: string }) => n.userId)).toEqual(['u1', 'u2']);
    }
    expect(r).toMatchObject({ ran: true, tenantsIndexed: 3, pages: 1, tenantsWithNew: 3, noticesCreated: 3, recipients: 6 });

    h.summary.mockClear();
    for (const i of h.index) h.states.set(i.tenantId, state(i.tenantId, { notifiedThroughId: 10 }));
    const r2 = await runOrphanNotifyTick(h.deps, NOW);
    expect(h.summary).not.toHaveBeenCalled();
    expect(r2.tenantsWithNew).toBe(0);
    expect(r2.oldestPendingSeconds).toBeNull();
    expect(h.markPending).not.toHaveBeenCalled();
  });

  it('notified orphan never re-sent', async () => {
    seed(h, 1, 0, 10);
    h.states.set(tid(0), state(tid(0), { notifiedThroughId: 10 }));
    await runOrphanNotifyTick(h.deps, NOW);
    expect(h.summary).not.toHaveBeenCalled();
  });

  it('quiet period defers without advancing, then merges after expiry', async () => {
    seed(h, 1, 0, 14);
    h.states.set(tid(0), state(tid(0), { notifiedThroughId: 10, lastNoticeAt: new Date(NOW.getTime() - 30 * MIN) }));
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(h.summary).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.markPending).toHaveBeenCalledWith([tid(0)], NOW);
    expect(r.deferredQuiet).toBe(1);

    h.states.set(tid(0), state(tid(0), { notifiedThroughId: 10, lastNoticeAt: new Date(NOW.getTime() - 61 * MIN) }));
    h.summaries.set(tid(0), summaryOf(tid(0), 14, 4));
    const r2 = await runOrphanNotifyTick(h.deps, NOW);
    expect(h.summary).toHaveBeenCalledWith(expect.objectContaining({ tenantId: tid(0), afterId: 10 }));
    expect(h.commit).toHaveBeenCalledWith(expect.objectContaining({ expectedThroughId: 10, newThroughId: 14 }));
    expect(r2.deferredQuiet).toBe(0);
  });

  it('first notice ignores quiet period', async () => {
    seed(h, 1);
    h.states.set(tid(0), state(tid(0), { lastNoticeAt: null }));
    await runOrphanNotifyTick(h.deps, NOW);
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it('cap 50 and backlog, with summary concurrency <= 4', async () => {
    seed(h, 60);
    let inflight = 0;
    let peak = 0;
    h.summary.mockImplementation(async (q: { tenantId: string }) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 2));
      inflight--;
      return summaryOf(q.tenantId, 10);
    });
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(h.summary).toHaveBeenCalledTimes(50);
    const called = h.summary.mock.calls.map(([q]) => q.tenantId).sort();
    expect(called).toEqual(Array.from({ length: 50 }, (_, i) => tid(i)));
    expect(r.deferredBacklog).toBe(10);
    expect(h.markPending).toHaveBeenCalledTimes(1);
    expect(h.markPending.mock.calls[0][0].sort()).toEqual(Array.from({ length: 10 }, (_, i) => tid(50 + i)));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('backlog is FIFO, not starved by smaller tenant ids', async () => {
    const t1 = new Date(NOW.getTime() - 5 * MIN);
    // 第二 tick：旧的 10 个（id 最大，pendingSince = t1）+ 50 个 id 更小的新候选
    seed(h, 10, 200);
    // 新候选 id 更小：tid(0..49)
    seed(h, 50, 0);
    for (let i = 200; i < 210; i++) h.states.set(tid(i), state(tid(i), { pendingSince: t1 }));
    await runOrphanNotifyTick(h.deps, NOW);
    const order = h.summary.mock.calls.map(([q]) => q.tenantId);
    expect(order).toHaveLength(50);
    const oldOnes = Array.from({ length: 10 }, (_, i) => tid(200 + i));
    expect(order.slice(0, 10)).toEqual(oldOnes);
    expect(order.slice(10)).toEqual(Array.from({ length: 40 }, (_, i) => tid(i)));
  });

  it('detectedSince has skew margin and is reused within a tick', async () => {
    seed(h, 2);
    h.tenants.mockResolvedValueOnce({ items: h.index.slice(0, 1), next: 'cursor' });
    h.tenants.mockResolvedValueOnce({ items: h.index.slice(1) });
    const r = await runOrphanNotifyTick(h.deps, NOW);
    const expected = new Date(NOW.getTime() - 7 * 24 * 3600_000 - 5 * MIN).toISOString();
    expect(r.pages).toBe(2);
    expect(h.tenants.mock.calls[0][0]).toEqual({ detectedSince: expected });
    expect(h.tenants.mock.calls[1][0]).toEqual({ detectedSince: expected, afterTenant: 'cursor' });
    for (const [q] of h.summary.mock.calls) expect(q.detectedSince).toBe(expected);
  });

  it('index failure changes nothing', async () => {
    seed(h, 2);
    h.tenants.mockResolvedValueOnce({ items: h.index, next: 'c' });
    h.tenants.mockRejectedValueOnce(new Error('boom'));
    await expect(runOrphanNotifyTick(h.deps, NOW)).rejects.toThrow('boom');
    expect(h.summary).not.toHaveBeenCalled();
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.markPending).not.toHaveBeenCalled();
  });

  it('single summary failure skips that tenant', async () => {
    seed(h, 3);
    h.summary.mockImplementation(async (q: { tenantId: string }) => {
      if (q.tenantId === tid(1)) throw new Error('summary down');
      return summaryOf(q.tenantId, 10);
    });
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(r.summaryFailed).toBe(1);
    expect(h.commit).toHaveBeenCalledTimes(2);
  });

  it('failed summary is marked pending and drives oldestPendingSeconds', async () => {
    seed(h, 2);
    h.states.set(tid(1), state(tid(1), { pendingSince: new Date(NOW.getTime() - 2 * 3600_000) }));
    h.summary.mockImplementation(async (q: { tenantId: string }) => {
      if (q.tenantId === tid(1)) throw new Error('down');
      return summaryOf(q.tenantId, 10);
    });
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(h.markPending).toHaveBeenCalledTimes(1);
    expect(h.markPending).toHaveBeenCalledWith([tid(1)], NOW);
    expect(r.oldestPendingSeconds).toBe(7200);
  });

  it('failed commit is marked pending; markPending error does not fail the tick', async () => {
    seed(h, 1);
    h.commit.mockRejectedValue(new Error('db'));
    h.markPending.mockRejectedValue(new Error('mark down'));
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(r.summaryFailed).toBe(1);
    expect(h.markPending).toHaveBeenCalledWith([tid(0)], NOW);
    expect(r.oldestPendingSeconds).toBe(0);
  });

  it('cas lost tenants are not marked pending', async () => {
    seed(h, 1);
    h.commit.mockResolvedValue('cas_lost');
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(h.markPending).not.toHaveBeenCalled();
    expect(r.oldestPendingSeconds).toBeNull();
  });

  it('commit throwing a non-CAS error counts as failed and does not stop others', async () => {
    seed(h, 2);
    h.commit.mockRejectedValueOnce(new Error('db down'));
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(r.summaryFailed).toBe(1);
    expect(r.noticesCreated).toBe(1);
  });

  it('all acknowledged before summary sends nothing', async () => {
    seed(h, 1);
    h.summaries.set(tid(0), summaryOf(tid(0), 0, 0));
    await runOrphanNotifyTick(h.deps, NOW);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.clearPending).toHaveBeenCalledWith(tid(0));
    expect(h.recipients).not.toHaveBeenCalled();
  });

  it('tenant without admins advances watermark only', async () => {
    seed(h, 1);
    h.recipients.mockResolvedValue({ kind: 'team', tenantName: 'T', userIds: [] });
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(h.commit).toHaveBeenCalledWith(expect.objectContaining({ notices: [], newThroughId: 10 }));
    expect(r.noRecipients).toBe(1);
    expect(r.noticesCreated).toBe(0);
    expect(r.maxLagSeconds).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('unknown tenant advances watermark only and warns once', async () => {
    seed(h, 1);
    h.recipients.mockResolvedValue({ kind: 'unknown' });
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(h.commit).toHaveBeenCalledWith(expect.objectContaining({ notices: [] }));
    expect(r.noRecipients).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith('[guard-orphan-notify] unknown tenant', { tenantId: tid(0) });
  });

  it('personal tenant uses empty tenantName', async () => {
    seed(h, 1);
    h.recipients.mockResolvedValue({ kind: 'personal', userIds: ['u9'] });
    await runOrphanNotifyTick(h.deps, NOW);
    const [arg] = h.commit.mock.calls[0];
    expect(arg.notices[0].data.tenantName).toBe('');
  });

  it('uses summary maxId, not index maxId', async () => {
    seed(h, 1, 0, 10);
    h.summaries.set(tid(0), summaryOf(tid(0), 12));
    await runOrphanNotifyTick(h.deps, NOW);
    const [arg] = h.commit.mock.calls[0];
    expect(arg.newThroughId).toBe(12);
    expect(arg.notices[0].id).toBe(`guard-orphans:${tid(0)}:12:u1`);
    expect(arg.notices[0].data.maxOrphanId).toBe(12);
  });

  it('cas lost is counted not thrown', async () => {
    seed(h, 1);
    h.commit.mockResolvedValue('cas_lost');
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(r.casLost).toBe(1);
    expect(r.noticesCreated).toBe(0);
    expect(r.recipients).toBe(0);
  });

  it('afterCommit runs on committed notices and its failure is only logged', async () => {
    seed(h, 2);
    const afterCommit = vi.fn(async () => {
      throw new Error('mail down');
    });
    h.deps.afterCommit = afterCommit;
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(afterCommit).toHaveBeenCalledTimes(2);
    expect(afterCommit).toHaveBeenCalledWith(expect.objectContaining({ userIds: ['u1', 'u2'] }));
    expect(r.summaryFailed).toBe(0);
    expect(r.noticesCreated).toBe(2);
  });

  it('report fields: maxLagSeconds and oldestPendingSeconds in whole seconds', async () => {
    // t0 已通知过且在安静期内（pendingSince = now - 90.9s），t1 正常发送
    seed(h, 2);
    h.states.set(
      tid(0),
      state(tid(0), { lastNoticeAt: new Date(NOW.getTime() - 10 * MIN), pendingSince: new Date(NOW.getTime() - 90_900) }),
    );
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(r.deferredQuiet).toBe(1);
    expect(r.oldestPendingSeconds).toBe(90);
    // firstDetectedAt = 10:00:00，now = 12:00:00
    expect(r.maxLagSeconds).toBe(7200);
  });

  it('stale pendingSince cleared when tenant no longer above watermark', async () => {
    // t000 缺席索引、t001 在索引但 maxId <= 水位：都不在保留名单；t002 是真实候选。
    h.index.push({ tenantId: tid(1), maxId: 5 }, { tenantId: tid(2), maxId: 10 });
    h.states.set(tid(0), state(tid(0), { pendingSince: new Date(NOW.getTime() - 3600_000) }));
    h.states.set(tid(1), state(tid(1), { notifiedThroughId: 5, pendingSince: new Date(NOW.getTime() - 3600_000) }));
    await runOrphanNotifyTick(h.deps, NOW);
    expect(h.clearStalePending).toHaveBeenCalledTimes(1);
    expect(h.clearStalePending).toHaveBeenCalledWith([tid(2)], NOW);
  });

  it('clearStalePending keeps tenants whose summary later fails', async () => {
    seed(h, 2);
    h.summary.mockRejectedValueOnce(new Error('down'));
    await runOrphanNotifyTick(h.deps, NOW);
    expect(h.clearStalePending.mock.calls[0][0]).toEqual([tid(0), tid(1)]);
  });

  it('clearStalePending rejection does not fail the tick', async () => {
    seed(h, 1);
    h.clearStalePending.mockRejectedValueOnce(new Error('db down'));
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(r.noticesCreated).toBe(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
  });

  it('summary for a different tenant is that tenant failure', async () => {
    seed(h, 2);
    h.summary.mockImplementation(async (q: { tenantId: string }) =>
      summaryOf(q.tenantId === tid(0) ? 'someone-else' : q.tenantId, 10),
    );
    const r = await runOrphanNotifyTick(h.deps, NOW);
    expect(r.summaryFailed).toBe(1);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.markPending).toHaveBeenCalledWith([tid(0)], NOW);
  });

  it('repeated or non-increasing page cursor fails the whole tick', async () => {
    seed(h, 1);
    h.tenants.mockResolvedValueOnce({ items: h.index, next: 'c5' });
    h.tenants.mockResolvedValueOnce({ items: [], next: 'c5' });
    await expect(runOrphanNotifyTick(h.deps, NOW)).rejects.toThrow(/cursor/);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.markPending).not.toHaveBeenCalled();
  });

  it('decreasing page cursor fails the whole tick', async () => {
    h.tenants.mockResolvedValueOnce({ items: [], next: 'c5' });
    h.tenants.mockResolvedValueOnce({ items: [], next: 'c4' });
    await expect(runOrphanNotifyTick(h.deps, NOW)).rejects.toThrow(/cursor/);
  });

  it('page count above the cap fails the whole tick', async () => {
    let n = 0;
    h.tenants.mockImplementation(async () => ({ items: [], next: `c${String(++n).padStart(8, '0')}` }));
    await expect(runOrphanNotifyTick(h.deps, NOW)).rejects.toThrow(/pages/);
    expect(h.tenants).toHaveBeenCalledTimes(MAX_INDEX_PAGES);
  });
});
