// 批量授权与分组放置（#699）：一次查询取调用者在各团队的角色，不再逐条查成员（N+1）；
// 团队策略只能放进同一团队的分组，创建者身份不放行（ADR 0016）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as Array<{ teamId: string; role: string }>, selects: 0, getTeamMemberRole: vi.fn() }));

vi.mock('@/lib/prisma', () => {
  const chain = {
    from: () => chain,
    where: async () => h.rows,
  };
  return {
    db: { select: vi.fn(() => { h.selects += 1; return chain; }), query: { policies: { findFirst: vi.fn() } } },
    policies: {},
    teamMembers: { teamId: 'tm.teamId', userId: 'tm.userId', role: 'tm.role' },
  };
});
vi.mock('@/db/fresh-read', () => ({ bypassQueryCache: () => ({ op: 'fresh' }) }));
vi.mock('@/lib/team-permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/team-permissions')>()),
  getTeamMemberRole: h.getTeamMemberRole,
}));

import { authorizePolicyActions, canPlaceInGroup } from '@/lib/policy-access';

const ACTOR = { userId: 'u1' };

beforeEach(() => {
  h.rows = [];
  h.selects = 0;
  h.getTeamMemberRole.mockReset();
});

describe('authorizePolicyActions', () => {
  it('多条策略、多个团队：只查一次成员表，不逐条调用 getTeamMemberRole', async () => {
    h.rows = [{ teamId: 't1', role: 'member' }, { teamId: 't2', role: 'viewer' }];
    const list = [
      { id: 'a', userId: 'x', teamId: 't1' },
      { id: 'b', userId: 'u1', teamId: 't1' },
      { id: 'c', userId: 'x', teamId: 't2' },
      { id: 'd', userId: 'x', teamId: 't3' },
      { id: 'e', userId: 'u1', teamId: null },
      { id: 'f', userId: 'x', teamId: null },
    ];
    const decisions = await authorizePolicyActions(ACTOR, list, 'update');
    expect(h.selects).toBe(1);
    expect(h.getTeamMemberRole).not.toHaveBeenCalled();
    expect(Object.fromEntries([...decisions].map(([id, d]) => [id, d.allowed ? 'ok' : d.status]))).toEqual({
      a: 'ok', b: 'ok', c: 403, d: 404, e: 'ok', f: 404,
    });
  });

  it('全是个人策略：不查库', async () => {
    const decisions = await authorizePolicyActions(ACTOR, [{ id: 'e', userId: 'u1', teamId: null }], 'update');
    expect(h.selects).toBe(0);
    expect(decisions.get('e')?.allowed).toBe(true);
  });
});

describe('canPlaceInGroup', () => {
  const allowed = { allowed: true, via: 'team', teamRole: 'member' } as const;
  const owner = { allowed: true, via: 'owner', teamRole: null } as const;

  it('团队策略：只能放进同一团队的分组，创建者也不例外', () => {
    const policy = { userId: 'u1', teamId: 't1' };
    expect(canPlaceInGroup(allowed, policy, { teamId: 't1' })).toBe(true);
    expect(canPlaceInGroup(allowed, policy, { teamId: null })).toBe(false);
    expect(canPlaceInGroup(allowed, policy, { teamId: 't2' })).toBe(false);
  });

  it('个人策略：有 update（即所有者）可放进其可访问的分组', () => {
    const policy = { userId: 'u1', teamId: null };
    expect(canPlaceInGroup(owner, policy, { teamId: null })).toBe(true);
    expect(canPlaceInGroup(owner, policy, { teamId: 't1' })).toBe(true);
  });

  it('无 update 权限一律不可放置', () => {
    const denied = { allowed: false, status: 403, code: 'insufficient_team_role', error: 'x' } as const;
    expect(canPlaceInGroup(denied, { userId: 'u1', teamId: 't1' }, { teamId: 't1' })).toBe(false);
  });
});
