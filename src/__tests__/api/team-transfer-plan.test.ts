import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 转让团队所有权前校验新 owner 的套餐（#677）：转让后团队能力立即按新 owner 的套餐计，
 * 转给没有团队功能（Free）或成员上限容不下当前成员数的用户，团队会立刻失去邀请 / 团队 key。
 * 不合格 → 400 且不写库、不重推快照；合格 → 照常转让。
 */
const h = vi.hoisted(() => ({
  findFirst: vi.fn(),
  transaction: vi.fn(),
  eligibility: vi.fn(),
  refresh: vi.fn(),
  invalidate: vi.fn(),
  lock: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: 'u-owner' } })) }));
vi.mock('@/lib/team-permissions', () => ({
  TeamPermission: { TEAM_TRANSFER: 'team.transfer' },
  checkTeamPermission: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('@/lib/prisma', () => ({
  db: { query: { teamMembers: { findFirst: h.findFirst } }, transaction: h.transaction },
  teams: { id: {}, ownerId: {} },
  teamMembers: { teamId: {}, userId: {} },
}));
vi.mock('@/lib/api-keys', () => ({ refreshTeamKeySnapshots: h.refresh }));
vi.mock('@/lib/plan-gate-client', () => ({ invalidatePlanCache: h.invalidate }));
vi.mock('@/lib/team-plan', () => ({ checkTeamOwnerEligibility: h.eligibility, lockTeamRow: h.lock }));
vi.mock('@/services/security/security-event-service', () => ({ logSecurityAdminAction: vi.fn() }));

import { POST } from '@/app/api/teams/[teamId]/transfer/route';

const params = { params: Promise.resolve({ teamId: 't1' }) } as never;
const req = (body: unknown) =>
  new Request('http://cloud.test/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('POST /api/teams/[teamId]/transfer — 新 owner 套餐资格（#677）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findFirst.mockResolvedValue({ id: 'm2', teamId: 't1', userId: 'u2', role: 'admin' });
    h.update.mockImplementation(() => ({ set: () => ({ where: vi.fn() }) }));
    h.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ update: h.update }));
    h.lock.mockResolvedValue({ ownerId: 'u-owner' });
    h.refresh.mockResolvedValue(0);
    h.invalidate.mockResolvedValue(undefined);
  });

  it('新 owner 没有团队功能（Free）→ 400 new_owner_plan_ineligible，不转让', async () => {
    h.eligibility.mockResolvedValue({ eligible: false, code: 'new_owner_plan_ineligible' });
    const res = await POST(req({ newOwnerId: 'u2' }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('new_owner_plan_ineligible');
    // 资格判定在锁住团队行的事务内（审查 L3），不合格时不写库
    expect(h.lock).toHaveBeenCalledWith(expect.anything(), 't1');
    expect(h.eligibility).toHaveBeenCalledWith('u2', 't1', expect.anything());
    expect(h.update).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('新 owner 套餐的成员上限容不下当前成员 → 400 new_owner_seat_limit，带人数与上限', async () => {
    h.eligibility.mockResolvedValue({ eligible: false, code: 'new_owner_seat_limit', memberCount: 7, limit: 5 });
    const res = await POST(req({ newOwnerId: 'u2' }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'new_owner_seat_limit', memberCount: 7, limit: 5 });
    expect(h.update).not.toHaveBeenCalled();
  });

  it('新 owner 合格 → 200 照常转让', async () => {
    h.eligibility.mockResolvedValue({ eligible: true });
    const res = await POST(req({ newOwnerId: 'u2' }), params);
    expect(res.status).toBe(200);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledTimes(3);
    // 先锁再判定
    expect(h.lock.mock.invocationCallOrder[0]).toBeLessThan(h.eligibility.mock.invocationCallOrder[0]);
  });

  it('不是成员的目标先报 new_owner_not_member，不查套餐', async () => {
    h.findFirst.mockResolvedValue(undefined);
    const res = await POST(req({ newOwnerId: 'u-x' }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('new_owner_not_member');
    expect(h.eligibility).not.toHaveBeenCalled();
  });
});
