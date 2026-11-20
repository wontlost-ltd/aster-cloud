// @vitest-environment node
// 跨租户对账摘要（ADR 0061 §3.7）：单租户失败隔离、viewer 团队不出现、按 critical / openTotal / 个人租户排序、并发 ≤ 4。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  tenants: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('@/lib/guard-reconciliation/access', () => ({
  listReconciliationTenants: (u: string) => h.tenants(u),
  createReconciliationClient: (t: string, u: string) => h.createClient(t, u),
}));

const { listReconciliationOverview, OVERVIEW_CONCURRENCY } = await import('@/lib/guard-reconciliation/overview');

const member = { role: 'member', canView: true, canAck: false };
const admin = { role: 'admin', canView: true, canAck: true };
const owner = { role: 'owner', canView: true, canAck: true };

function summary(open: Record<string, number>, finishedAt: string | null = '2026-11-20T01:00:00Z') {
  const openTotal = Object.values(open).reduce((a, b) => a + b, 0);
  return {
    lastRun: finishedAt ? { runId: 1, finishedAt, windowStart: 'a', windowEnd: 'b', newOrphans: 0, resolvedOrphans: 0, openOrphans: openTotal } : null,
    open, openTotal, resultGrace: 'PT15M', lookback: 'P7D',
  };
}

describe('listReconciliationOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('一个租户上游抛错 → 进 unavailableTenants，其余正常；severity 计数由 kind 表算出', async () => {
    h.tenants.mockResolvedValue([
      { id: 'u1', name: '', access: owner },
      { id: 'team-a', name: 'Alpha', access: admin },
      { id: 'team-b', name: 'Beta', access: member },
    ]);
    const sums: Record<string, unknown> = {
      u1: summary({ allow_unconsumed: 3 }, null),
      'team-b': summary({ side_effect_mismatch: 2, consumed_without_result: 1, orphan_receipt: 4 }),
    };
    h.createClient.mockImplementation(async (t: string) => ({
      api: { summary: async () => { if (t === 'team-a') throw new Error('down'); return sums[t]; } },
      access: t === 'u1' ? owner : t === 'team-a' ? admin : member,
    }));

    const res = await listReconciliationOverview('u1');

    expect(res.unavailableTenants).toEqual(['team-a']);
    expect(res.tenants).toEqual([
      {
        tenantId: 'team-b', tenantName: 'Beta', canAck: false, lastRunAt: '2026-11-20T01:00:00Z',
        openBySeverity: { critical: 2, warning: 1, info: 4 }, openTotal: 7,
      },
      {
        tenantId: 'u1', tenantName: '', canAck: true, lastRunAt: null,
        openBySeverity: { critical: 0, warning: 0, info: 3 }, openTotal: 3,
      },
    ]);
    expect(h.createClient).toHaveBeenCalledWith('team-b', 'u1');
  });

  it('只汇总 listReconciliationTenants 给出的租户（viewer 团队已被排除）；两次读角色之间失去权限的租户不出现', async () => {
    h.tenants.mockResolvedValue([{ id: 'u1', name: '', access: owner }, { id: 'team-x', name: 'X', access: member }]);
    h.createClient.mockImplementation(async (t: string) =>
      t === 'team-x' ? null : { api: { summary: async () => summary({}) }, access: owner });
    const res = await listReconciliationOverview('u1');
    expect(res.tenants.map((t) => t.tenantId)).toEqual(['u1']);
    expect(res.unavailableTenants).toEqual([]);
  });

  it('排序：critical 降序 → openTotal 降序 → 个人租户优先', async () => {
    h.tenants.mockResolvedValue([
      { id: 'team-1', name: 'One', access: member },
      { id: 'u1', name: '', access: owner },
      { id: 'team-2', name: 'Two', access: member },
      { id: 'team-3', name: 'Three', access: member },
    ]);
    const sums: Record<string, unknown> = {
      'team-1': summary({ allow_unconsumed: 9 }),
      u1: summary({ allow_unconsumed: 9 }),
      'team-2': summary({ side_effect_mismatch: 1 }),
      'team-3': summary({ allow_unconsumed: 20 }),
    };
    h.createClient.mockImplementation(async (t: string) => ({ api: { summary: async () => sums[t] }, access: member }));
    const res = await listReconciliationOverview('u1');
    expect(res.tenants.map((t) => t.tenantId)).toEqual(['team-2', 'team-3', 'u1', 'team-1']);
  });

  it(`并发不超过 ${4}`, async () => {
    expect(OVERVIEW_CONCURRENCY).toBe(4);
    const tenants = Array.from({ length: 10 }, (_, i) => ({ id: `team-${i}`, name: `T${i}`, access: member }));
    h.tenants.mockResolvedValue(tenants);
    let inFlight = 0;
    let peak = 0;
    h.createClient.mockImplementation(async () => ({
      api: {
        summary: async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return summary({});
        },
      },
      access: member,
    }));
    const res = await listReconciliationOverview('u1');
    expect(res.tenants).toHaveLength(10);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});
