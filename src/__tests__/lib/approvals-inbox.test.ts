// @vitest-environment node
// 审批收件箱聚合（ADR 0042 §5.2）：跨租户合并、单租户失败隔离、canAct 提示规则、createdAt 倒序。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  membersFind: vi.fn(),
  loadBusinessRoles: vi.fn(),
  listGuardApprovals: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: { query: { teamMembers: { findMany: h.membersFind } } },
  teamMembers: { userId: { name: 'userId' } },
}));
vi.mock('drizzle-orm', () => ({ eq: (col: { name: string }, v: unknown) => ({ eq: [col.name, v] }) }));
vi.mock('@/lib/business-roles', () => ({
  loadBusinessRoles: (userId: string, tenantId: string) => h.loadBusinessRoles(userId, tenantId),
}));
// 客户端以 (租户, 用户, 角色) 构造：记录构造参数，列表调用转发到 h.listGuardApprovals(tenantId, ...)
vi.mock('@/services/policy/policy-api', () => ({
  PolicyApiClient: class {
    private readonly tenantId: string;
    constructor(...args: unknown[]) {
      h.createClient(...args);
      this.tenantId = args[0] as string;
    }
    listGuardApprovals(...args: unknown[]) {
      return h.listGuardApprovals(this.tenantId, ...args);
    }
  },
}));

import { INBOX_CONCURRENCY, listUserApprovals } from '@/lib/approvals-inbox';

function approval(id: string, over: Record<string, unknown> = {}) {
  return { id, decisionId: `d-${id}`, status: 'PENDING', requiredRole: 'DPO', createdAt: '2026-10-01T00:00:00Z', ...over };
}

describe('listUserApprovals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.membersFind.mockResolvedValue([{ teamId: 'team1', team: { name: 'Team One' } }]);
  });

  it('team1 拉取失败 → unavailableTenants=[team1]，个人租户项仍返回', async () => {
    h.loadBusinessRoles.mockResolvedValue(['DPO']);
    h.listGuardApprovals.mockImplementation(async (tenantId: string) => {
      if (tenantId === 'team1') throw new Error('boom');
      return { items: [approval('a1')], page: 0, size: 200 };
    });

    const res = await listUserApprovals('u1', 'PENDING');

    expect(res.unavailableTenants).toEqual(['team1']);
    expect(res.items.map((i) => [i.id, i.tenantId, i.tenantName])).toEqual([['a1', 'u1', '']]);
    expect(h.listGuardApprovals).toHaveBeenCalledWith('u1', 'PENDING', 0, 200);
    expect(h.membersFind).toHaveBeenCalledWith(expect.objectContaining({ where: { eq: ['userId', 'u1'] } }));
  });

  it('canAct：PENDING+角色命中 true、不命中 false、requiredRole null true、非 PENDING false；按租户角色判定', async () => {
    h.loadBusinessRoles.mockImplementation(async (_u: string, tenantId: string) => (tenantId === 'u1' ? ['DPO'] : []));
    h.listGuardApprovals.mockImplementation(async (tenantId: string) =>
      tenantId === 'u1'
        ? { items: [approval('hit'), approval('miss', { requiredRole: 'CISO' }), approval('done', { status: 'APPROVED' })] }
        : { items: [approval('esc', { requiredRole: null }), approval('teamDpo')] }
    );

    const res = await listUserApprovals('u1', 'PENDING');
    const canAct = Object.fromEntries(res.items.map((i) => [i.id, i.canAct]));

    expect(canAct).toEqual({ hit: true, miss: false, done: false, esc: true, teamDpo: false });
    expect(res.items.find((i) => i.id === 'esc')?.tenantName).toBe('Team One');
  });

  it('合并后按 createdAt 倒序', async () => {
    h.loadBusinessRoles.mockResolvedValue([]);
    h.listGuardApprovals.mockImplementation(async (tenantId: string) =>
      tenantId === 'u1'
        ? { items: [approval('old', { createdAt: '2026-10-01T00:00:00Z' }), approval('newest', { createdAt: '2026-10-05T00:00:00Z' })] }
        : { items: [approval('mid', { createdAt: '2026-10-03T00:00:00Z' })] }
    );

    const res = await listUserApprovals('u1', 'PENDING');

    expect(res.items.map((i) => i.id)).toEqual(['newest', 'mid', 'old']);
  });

  it('每租户角色只查一次，并以同一份角色构造签名客户端（canAct 与签名同一快照）', async () => {
    h.loadBusinessRoles.mockImplementation(async (_u: string, tenantId: string) => (tenantId === 'u1' ? ['DPO'] : ['CISO']));
    h.listGuardApprovals.mockResolvedValue({ items: [] });

    await listUserApprovals('u1', 'PENDING');

    expect(h.loadBusinessRoles).toHaveBeenCalledTimes(2);
    expect(h.createClient).toHaveBeenCalledWith('u1', 'u1', 'member', 'unknown', ['DPO']);
    expect(h.createClient).toHaveBeenCalledWith('team1', 'u1', 'member', 'unknown', ['CISO']);
  });

  it('真实限流器：9 个租户时 api 在途峰值恰为 4', async () => {
    h.membersFind.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ teamId: `team${i}`, team: { name: `T${i}` } }))
    );
    h.loadBusinessRoles.mockResolvedValue([]);
    let inFlight = 0;
    let peak = 0;
    h.listGuardApprovals.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return { items: [] };
    });

    const res = await listUserApprovals('u1', 'PENDING');

    expect(h.listGuardApprovals).toHaveBeenCalledTimes(9);
    expect(peak).toBe(INBOX_CONCURRENCY);
    expect(peak).toBe(4);
    expect(res.unavailableTenants).toEqual([]);
  });
});
