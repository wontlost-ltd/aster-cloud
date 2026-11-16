// ADR 0058 §4.4：resolveEntitlement 的判定顺序（unavailable → disabled → plan_required → not_granted）。
// 只核对顺序与短路（前一步失败时不调用下一层）；授权 SQL 本身由 PG 集成测试覆盖。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  grantRows: [] as Array<{ id: string; userId: string | null; teamId: string | null; delegatingTeamId: string | null }>,
  selects: 0,
  isAdmin: false,
}));

// freshDb 桩：select().from().leftJoin()….where().orderBy() 链，返回 h.grantRows，并计数查询次数。
vi.mock('@/db/fresh-read', () => {
  const chain = {
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: async () => h.grantRows,
  };
  return {
    freshDb: {
      select: () => {
        h.selects += 1;
        return chain;
      },
      query: { users: { findFirst: async () => ({ isAdmin: h.isAdmin }) } },
    },
  };
});
vi.mock('@/lib/platform-settings', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/lib/platform-settings')),
  getSetting: vi.fn(async (key: string) => h.settings[key]),
}));
vi.mock('@/lib/team-plan', () => ({ planHolderForTeam: vi.fn() }));
vi.mock('@/lib/usage', () => ({ hasFeatureAccess: vi.fn() }));

import { resolveEntitlement } from '@/lib/capabilities/resolve';
import { CAPABILITIES } from '@/lib/capabilities/registry';
import { PLATFORM_SETTING_KEYS } from '@/lib/platform-settings';
import { planHolderForTeam } from '@/lib/team-plan';
import { hasFeatureAccess } from '@/lib/usage';

const ENABLED = PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_ENABLED;
const DELEGATION = PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_TEAM_DELEGATION;
const directRow = { id: 'g-direct', userId: 'u1', teamId: null, delegatingTeamId: null };

beforeEach(() => {
  h.settings = { [ENABLED]: true, [DELEGATION]: true };
  h.grantRows = [];
  h.selects = 0;
  h.isAdmin = false;
  vi.mocked(planHolderForTeam).mockReset().mockImplementation(async (userId) => userId);
  vi.mocked(hasFeatureAccess).mockReset().mockResolvedValue(true);
});

describe('resolveEntitlement 判定顺序', () => {
  it('switch OFF with a direct grant → disabled, sources [], 不查套餐与授权', async () => {
    h.settings[ENABLED] = false;
    h.grantRows = [directRow];
    expect(await resolveEntitlement('u1', 'structured_authoring', { teamId: null })).toEqual({
      allowed: false,
      denial: 'disabled',
      sources: [],
    });
    expect(hasFeatureAccess).not.toHaveBeenCalled();
    expect(planHolderForTeam).not.toHaveBeenCalled();
    expect(h.selects).toBe(0);
  });

  it('precondition 不满足 → unavailable，连开关都不读', async () => {
    // 测试内替换注册项（不给生产代码加钩子），finally 里还原
    const original = CAPABILITIES.structured_authoring;
    CAPABILITIES.structured_authoring = { ...original, precondition: () => false };
    try {
      expect(await resolveEntitlement('u1', 'structured_authoring', { teamId: null })).toEqual({
        allowed: false,
        denial: 'unavailable',
        sources: [],
      });
      expect(hasFeatureAccess).not.toHaveBeenCalled();
      expect(h.selects).toBe(0);
    } finally {
      CAPABILITIES.structured_authoring = original;
    }
  });

  it('free plan holder with direct grant → plan_required，仍返回授权来源', async () => {
    vi.mocked(hasFeatureAccess).mockResolvedValue(false);
    h.grantRows = [directRow];
    expect(await resolveEntitlement('u1', 'structured_authoring', { teamId: null })).toEqual({
      allowed: false,
      denial: 'plan_required',
      sources: [{ kind: 'direct', grantId: 'g-direct' }],
    });
    expect(h.selects).toBe(1);
  });

  it('pro, no grants → not_granted', async () => {
    expect(await resolveEntitlement('u1', 'structured_authoring', { teamId: null })).toEqual({
      allowed: false,
      denial: 'not_granted',
      sources: [],
    });
  });

  it('pro with grants → allowed，来源按行映射', async () => {
    h.grantRows = [
      directRow,
      { id: 'g-team', userId: null, teamId: 't1', delegatingTeamId: null },
      { id: 'g-del', userId: 'u1', teamId: null, delegatingTeamId: 't2' },
    ];
    expect(await resolveEntitlement('u1', 'structured_authoring', { teamId: null })).toEqual({
      allowed: true,
      sources: [
        { kind: 'direct', grantId: 'g-direct' },
        { kind: 'team', grantId: 'g-team', teamId: 't1' },
        { kind: 'delegated', grantId: 'g-del', teamId: 't2' },
      ],
    });
  });

  it('team policy uses team owner as plan holder', async () => {
    vi.mocked(planHolderForTeam).mockResolvedValue('owner-1');
    h.grantRows = [directRow];
    await resolveEntitlement('u1', 'structured_authoring', { teamId: 'team-9' });
    expect(planHolderForTeam).toHaveBeenCalledWith('u1', 'team-9');
    expect(hasFeatureAccess).toHaveBeenCalledWith('owner-1', 'structuredAuthoring');
  });

  it('implicitForPlatformAdmin 的能力：平台管理员得到 admin 来源；注册项为 false 时不看 isAdmin', async () => {
    h.isAdmin = true;
    expect(await resolveEntitlement('u1', 'structured_authoring', { teamId: null })).toMatchObject({
      allowed: false,
      denial: 'not_granted',
    });
    const original = CAPABILITIES.structured_authoring;
    CAPABILITIES.structured_authoring = { ...original, implicitForPlatformAdmin: true };
    try {
      expect(await resolveEntitlement('u1', 'structured_authoring', { teamId: null })).toEqual({
        allowed: true,
        sources: [{ kind: 'admin' }],
      });
    } finally {
      CAPABILITIES.structured_authoring = original;
    }
  });
});
