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
      { id: 'u1', plan: 'pro', subscriptionStatus: 'active' },
      { id: 'u2', plan: 'free', subscriptionStatus: null },
      { id: 'owner', plan: 'team', subscriptionStatus: 'active' },
    ]);
    m.teamsFindMany.mockResolvedValue([{ id: 't1', ownerId: 'owner' }]);
    m.teamMembersFindMany.mockResolvedValue([{ teamId: 't1', userId: 'u2', role: 'member' }]);
  });

  it('个人 key：tenantId=userId、role=owner、quotaOwnerId=userId、plan 取本人', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    const r = (await resolveApiKeyIdentities([personal], NOW)).get('k1');
    expect(r).toEqual({ valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', teamId: null, quotaOwnerId: 'u1', role: 'owner', plan: 'pro', subscriptionStatus: 'active' });
  });
  it('团队 key：tenantId=teamId、role=成员角色、quotaOwnerId=owner、plan 取 owner', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    const r = (await resolveApiKeyIdentities([teamKey], NOW)).get('k2');
    expect(r).toEqual({ valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', teamId: 't1', quotaOwnerId: 'owner', role: 'member', plan: 'team', subscriptionStatus: 'active' });
  });
  it('已吊销 / 已过期 优先于一切查询', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    const revoked = { ...teamKey, id: 'k3', revokedAt: new Date('2026-01-01T00:00:00Z') };
    const expired = { ...teamKey, id: 'k4', expiresAt: new Date('2026-01-01T00:00:00Z') };
    const r = await resolveApiKeyIdentities([revoked, expired], NOW);
    expect(r.get('k3')).toEqual({ valid: false, reason: 'revoked', revokedAt: revoked.revokedAt });
    expect(r.get('k4')).toEqual({ valid: false, reason: 'expired', expiredAt: expired.expiresAt });
  });
  it('团队不存在 → team_not_found；无 membership → membership_revoked', async () => {
    const { resolveApiKeyIdentities } = await import('@/lib/api-key-identity');
    m.teamsFindMany.mockResolvedValue([]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'team_not_found' });
    m.teamsFindMany.mockResolvedValue([{ id: 't1', ownerId: 'owner' }]);
    m.teamMembersFindMany.mockResolvedValue([]);
    expect((await resolveApiKeyIdentities([teamKey], NOW)).get('k2')).toEqual({ valid: false, reason: 'membership_revoked' });
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
});

describe('resolveApiKeyIdentity', () => {
  it('按 hash 找不到 key → not_found；找到则委托批量解析', async () => {
    const { resolveApiKeyIdentity } = await import('@/lib/api-key-identity');
    m.apiKeysFindFirst.mockResolvedValue(undefined);
    expect(await resolveApiKeyIdentity('a'.repeat(64), NOW)).toEqual({ valid: false, reason: 'not_found' });
    m.apiKeysFindFirst.mockResolvedValue(personal);
    m.usersFindMany.mockResolvedValue([{ id: 'u1', plan: 'pro', subscriptionStatus: 'active' }]);
    m.teamsFindMany.mockResolvedValue([]);
    m.teamMembersFindMany.mockResolvedValue([]);
    expect((await resolveApiKeyIdentity('a'.repeat(64), NOW)).valid).toBe(true);
  });
});
