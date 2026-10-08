// src/__tests__/lib/api-key-identity.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
  apiKeysFindFirst: vi.fn(),
  usersFindMany: vi.fn(),
  teamsFindMany: vi.fn(),
  teamMembersFindMany: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      apiKeys: { findFirst: m.apiKeysFindFirst },
      users: { findMany: m.usersFindMany },
      teams: { findMany: m.teamsFindMany },
      teamMembers: { findMany: m.teamMembersFindMany },
    },
  },
  apiKeys: { key: 'apiKeys.key' },
  users: { id: 'users.id' },
  teams: { id: 'teams.id' },
  teamMembers: { teamId: 'teamMembers.teamId', userId: 'teamMembers.userId' },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...c: unknown[]) => ({ op: 'and', c }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: 'in', col, vals }),
}));

const NOW = new Date('2026-10-08T00:00:00Z');
const personal = { id: 'k1', userId: 'u1', teamId: null, revokedAt: null, expiresAt: null };
const teamKey = { id: 'k2', userId: 'u2', teamId: 't1', revokedAt: null, expiresAt: null };

describe('resolveApiKeyIdentities', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(m).forEach((f) => f.mockReset());
    m.usersFindMany.mockResolvedValue([
      { id: 'u1', plan: 'pro', subscriptionStatus: 'active', businessRoles: ['DPO'] },
      { id: 'u2', plan: 'free', subscriptionStatus: null, businessRoles: ['personal-only'] },
      { id: 'owner', plan: 'team', subscriptionStatus: 'active', businessRoles: [] },
    ]);
    m.teamsFindMany.mockResolvedValue([{ id: 't1', ownerId: 'owner' }]);
    m.teamMembersFindMany.mockResolvedValue([{ teamId: 't1', userId: 'u2', role: 'member', businessRoles: ['CISO'] }]);
  });

  it('个人 key：tenantId=userId、role=owner、quotaOwnerId=userId、plan 与业务角色取本人 User', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    const r = (await resolveApiKeyIdentities([personal], NOW)).get('k1');
    expect(r).toEqual({ valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', teamId: null, quotaOwnerId: 'u1', role: 'owner', businessRoles: ['DPO'], plan: 'pro', subscriptionStatus: 'active' });
  });
  // 业务角色取持有者在该团队的 TeamMember 行（ADR 0042 §2.2），不取其个人 User.businessRoles，也不取 owner 的
  it('团队 key：tenantId=teamId、role 与业务角色取成员行、quotaOwnerId=owner、plan 取 owner', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    const r = (await resolveApiKeyIdentities([teamKey], NOW)).get('k2');
    expect(r).toEqual({ valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', teamId: 't1', quotaOwnerId: 'owner', role: 'member', businessRoles: ['CISO'], plan: 'team', subscriptionStatus: 'active' });
  });
  it('已吊销 / 已过期 优先于一切查询；同时吊销且过期按 revoked', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    const revoked = { ...teamKey, id: 'k3', revokedAt: new Date('2026-01-01T00:00:00Z') };
    const expired = { ...teamKey, id: 'k4', expiresAt: new Date('2026-01-01T00:00:00Z') };
    const both = { ...teamKey, id: 'k5', revokedAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-02T00:00:00Z') };
    const r = await resolveApiKeyIdentities([revoked, expired, both], NOW);
    expect(r.get('k3')).toEqual({ valid: false, reason: 'revoked', revokedAt: revoked.revokedAt });
    expect(r.get('k4')).toEqual({ valid: false, reason: 'expired', expiredAt: expired.expiresAt });
    expect(r.get('k5')).toEqual({ valid: false, reason: 'revoked', revokedAt: both.revokedAt });
    expect(m.usersFindMany).not.toHaveBeenCalled();
    expect(m.teamsFindMany).not.toHaveBeenCalled();
    expect(m.teamMembersFindMany).not.toHaveBeenCalled();
  });
  it('团队不存在 → team_not_found；无 membership → membership_revoked', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    m.teamsFindMany.mockResolvedValue([]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'team_not_found' });
    m.teamsFindMany.mockResolvedValue([{ id: 't1', ownerId: 'owner' }]);
    m.teamMembersFindMany.mockResolvedValue([]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'membership_revoked' });
  });
  it('成员关系按 (teamId, userId) 匹配：团队里只有别人的成员行 → membership_revoked', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    m.teamMembersFindMany.mockResolvedValue([{ teamId: 't1', userId: 'owner', role: 'owner' }]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'membership_revoked' });
  });
  it('成员关系按 (teamId, userId) 匹配：持有者与 owner 同在团队时取持有者自己的角色', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    m.teamMembersFindMany.mockResolvedValue([
      { teamId: 't1', userId: 'owner', role: 'owner', businessRoles: ['Owner Role'] },
      { teamId: 't1', userId: 'u2', role: 'viewer', businessRoles: ['DPO'] },
    ]);
    const r = (await resolveApiKeyIdentities([teamKey], NOW)).get('k2');
    expect(r).toMatchObject({ valid: true, role: 'viewer', businessRoles: ['DPO'], quotaOwnerId: 'owner', plan: 'team' });
  });
  it('失败优先级：orphan_key(持有者) > team_not_found > membership_revoked > orphan_key(owner)', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    // 持有者缺失 + 团队缺失 → 先判持有者
    m.usersFindMany.mockResolvedValue([{ id: 'owner', plan: 'team', subscriptionStatus: 'active' }]);
    m.teamsFindMany.mockResolvedValue([]);
    m.teamMembersFindMany.mockResolvedValue([]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'orphan_key' });
    // 团队缺失 + 无 membership → 先判团队
    m.usersFindMany.mockResolvedValue([{ id: 'u2', plan: 'free', subscriptionStatus: null }]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'team_not_found' });
    // 无 membership + owner 用户缺失 → 先判 membership
    m.teamsFindMany.mockResolvedValue([{ id: 't1', ownerId: 'owner' }]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'membership_revoked' });
    // 有 membership 但 owner 用户缺失 → orphan_key
    m.teamMembersFindMany.mockResolvedValue([{ teamId: 't1', userId: 'u2', role: 'member' }]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'orphan_key' });
  });
  it('持有者或 owner 用户不存在 → orphan_key', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    m.usersFindMany.mockResolvedValue([{ id: 'u2', plan: 'free', subscriptionStatus: null }]);
    expect((await resolveApiKeyIdentities([personal], NOW)).get('k1')).toEqual({ valid: false, reason: 'orphan_key' });
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'orphan_key' });
  });
  it('批量：只查一次 users/teams/teamMembers；空输入不查库', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    await resolveApiKeyIdentities([personal, teamKey], NOW);
    expect(m.usersFindMany).toHaveBeenCalledTimes(1);
    expect(m.teamsFindMany).toHaveBeenCalledTimes(1);
    expect(m.teamMembersFindMany).toHaveBeenCalledTimes(1);
    Object.values(m).forEach((f) => f.mockClear());
    expect((await resolveApiKeyIdentities([], NOW)).size).toBe(0);
    expect(m.usersFindMany).not.toHaveBeenCalled();
  });
  it('成员查询同时按 teamId 与持有者 userId 过滤', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    await resolveApiKeyIdentities([personal, teamKey], NOW);
    expect(m.teamMembersFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          op: 'and',
          c: [
            { op: 'in', col: 'teamMembers.teamId', vals: ['t1'] },
            { op: 'in', col: 'teamMembers.userId', vals: ['u1', 'u2'] },
          ],
        },
      })
    );
  });
  it('只有个人 key 时不查 teams / teamMembers', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    await resolveApiKeyIdentities([personal], NOW);
    expect(m.teamsFindMany).not.toHaveBeenCalled();
    expect(m.teamMembersFindMany).not.toHaveBeenCalled();
    expect(m.usersFindMany).toHaveBeenCalledTimes(1);
  });
});

describe('resolveApiKeyIdentity', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.values(m).forEach((f) => f.mockReset());
  });

  it('按 hash 找不到 key → not_found；不触发批量解析', async () => {
    const { resolveApiKeyIdentity } = await import('@/lib/api-key-identity');
    m.apiKeysFindFirst.mockResolvedValue(undefined);
    expect(await resolveApiKeyIdentity('a'.repeat(64), NOW)).toEqual({ valid: false, reason: 'not_found' });
    expect(m.usersFindMany).not.toHaveBeenCalled();
  });
  it('找到 key 则按解析所需列查询并委托批量解析', async () => {
    const { resolveApiKeyIdentity, API_KEY_IDENTITY_COLUMNS } = await import('@/lib/api-key-identity');
    m.apiKeysFindFirst.mockResolvedValue(personal);
    m.usersFindMany.mockResolvedValue([{ id: 'u1', plan: 'pro', subscriptionStatus: 'active', businessRoles: [] }]);
    const r = await resolveApiKeyIdentity('a'.repeat(64), NOW);
    expect(r).toEqual({ valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', teamId: null, quotaOwnerId: 'u1', role: 'owner', businessRoles: [], plan: 'pro', subscriptionStatus: 'active' });
    expect(m.apiKeysFindFirst).toHaveBeenCalledWith(expect.objectContaining({ columns: API_KEY_IDENTITY_COLUMNS }));
  });
});

// 快照体（pusher 与 snapshot/full 共用）：valid 只下发 aster-api ApiKeySnapshot 认的字段，
// 不带 teamId / subscriptionStatus；invalid 只带 reason，吊销时附 revokedAtEpochMs
describe('toApiKeySnapshotBody', () => {
  it('个人 key：改前字段 + quotaOwnerId=userId，revokedAtEpochMs:null；无业务角色时不含 businessRoles 键', async () => {
    const { toApiKeySnapshotBody } = await import('@/lib/api-key-identity');
    const body = toApiKeySnapshotBody({
      valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', teamId: null, quotaOwnerId: 'u1',
      role: 'owner', businessRoles: [], plan: 'pro', subscriptionStatus: 'active',
    });
    expect(body).not.toHaveProperty('businessRoles');
    expect(body).toEqual({
      valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', quotaOwnerId: 'u1', role: 'owner', plan: 'pro', revokedAtEpochMs: null,
    });
  });
  it('团队 key：tenantId=teamId、成员角色、quotaOwnerId=owner、套餐取 owner；非空业务角色原样下发', async () => {
    const { toApiKeySnapshotBody } = await import('@/lib/api-key-identity');
    expect(toApiKeySnapshotBody({
      valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', teamId: 't1', quotaOwnerId: 'owner',
      role: 'member', businessRoles: ['DPO', 'CISO'], plan: 'team', subscriptionStatus: null,
    })).toEqual({
      valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', quotaOwnerId: 'owner', role: 'member',
      businessRoles: ['DPO', 'CISO'], plan: 'team', revokedAtEpochMs: null,
    });
  });
  it('无效：revoked 附 revokedAtEpochMs；expired / not_found / membership_revoked 只带 reason', async () => {
    const { toApiKeySnapshotBody } = await import('@/lib/api-key-identity');
    const revokedAt = new Date('2026-04-01T00:00:00Z');
    expect(toApiKeySnapshotBody({ valid: false, reason: 'revoked', revokedAt }))
      .toEqual({ valid: false, reason: 'revoked', revokedAtEpochMs: revokedAt.getTime() });
    expect(toApiKeySnapshotBody({ valid: false, reason: 'expired', expiredAt: new Date('2020-01-01T00:00:00Z') }))
      .toEqual({ valid: false, reason: 'expired' });
    expect(toApiKeySnapshotBody({ valid: false, reason: 'not_found' })).toEqual({ valid: false, reason: 'not_found' });
    expect(toApiKeySnapshotBody({ valid: false, reason: 'membership_revoked' })).toEqual({ valid: false, reason: 'membership_revoked' });
  });
});
