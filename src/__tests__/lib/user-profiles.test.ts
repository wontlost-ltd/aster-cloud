// @vitest-environment node
// 用户 id → 展示信息的批量查询（自 version-approvals-inbox 的 loadDisplayNames 抽出，供签发方列表共用）：
// 去重后一次 inArray 查询，空集合不查库，查不到的 id 不出现在结果里。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({ usersFindMany: vi.fn(), membersFindMany: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  db: { query: { users: { findMany: h.usersFindMany } } },
  users: { id: { name: 'users.id' } },
  teamMembers: { teamId: { name: 'teamMembers.teamId' }, userId: { name: 'teamMembers.userId' } },
}));
// 成员关系走 freshDb（离队后立即不再展示资料）
vi.mock('@/db/fresh-read', () => ({ freshDb: { query: { teamMembers: { findMany: h.membersFindMany } } } }));
vi.mock('drizzle-orm', () => ({
  inArray: (col: { name: string }, values: unknown[]) => ({ inArray: [col.name, values] }),
  eq: (col: { name: string }, value: unknown) => ({ eq: [col.name, value] }),
  and: (...c: unknown[]) => ({ and: c }),
}));

const { loadUserProfiles, loadTenantMemberProfiles } = await import('@/lib/user-profiles');

describe('loadUserProfiles', () => {
  beforeEach(() => {
    h.usersFindMany.mockReset();
    h.membersFindMany.mockReset();
  });

  it('空集合不查库', async () => {
    expect((await loadUserProfiles([])).size).toBe(0);
    expect(h.usersFindMany).not.toHaveBeenCalled();
  });

  it('去重后一次批量查询，只取展示列；查不到的 id 不在结果里', async () => {
    h.usersFindMany.mockResolvedValue([
      { id: 'u1', name: 'Ann', email: 'ann@x.test', image: null },
      { id: 'u2', name: null, email: 'bob@x.test', image: 'https://img/b.png' },
    ]);
    const map = await loadUserProfiles(['u1', 'u2', 'u1', 'gone']);

    expect(h.usersFindMany).toHaveBeenCalledTimes(1);
    expect(h.usersFindMany).toHaveBeenCalledWith({
      where: { inArray: ['users.id', ['u1', 'u2', 'gone']] },
      columns: { id: true, name: true, email: true, image: true },
    });
    expect(map.get('u1')).toEqual({ name: 'Ann', email: 'ann@x.test', image: null });
    expect(map.get('u2')).toEqual({ name: null, email: 'bob@x.test', image: 'https://img/b.png' });
    expect(map.has('gone')).toBe(false);
  });

  it('loadTenantMemberProfiles 团队租户：只查当前成员（离队成员与非成员不返回资料）', async () => {
    h.membersFindMany.mockResolvedValue([{ userId: 'u1' }]);
    h.usersFindMany.mockResolvedValue([{ id: 'u1', name: 'Ann', email: 'ann@x.test', image: null }]);
    const map = await loadTenantMemberProfiles('team1', ['u1', 'former', 'u1', 'anonymous']);

    expect(h.membersFindMany).toHaveBeenCalledWith({
      where: { and: [{ eq: ['teamMembers.teamId', 'team1'] }, { inArray: ['teamMembers.userId', ['u1', 'former', 'anonymous']] }] },
      columns: { userId: true },
    });
    expect(h.usersFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { inArray: ['users.id', ['u1']] } }));
    expect([...map.keys()]).toEqual(['u1']);
  });

  it('loadTenantMemberProfiles 个人租户：只解析租户本人，不查成员表', async () => {
    h.usersFindMany.mockResolvedValue([{ id: 'solo', name: 'Sam', email: 's@x.test', image: null }]);
    const map = await loadTenantMemberProfiles('solo', ['solo', 'someone-else'], 'solo');
    expect(h.membersFindMany).not.toHaveBeenCalled();
    expect(h.usersFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { inArray: ['users.id', ['solo']] } }));
    expect([...map.keys()]).toEqual(['solo']);
  });

  it('loadTenantMemberProfiles 无 id 时不查库', async () => {
    expect((await loadTenantMemberProfiles('team1', [])).size).toBe(0);
    expect(h.membersFindMany).not.toHaveBeenCalled();
    expect(h.usersFindMany).not.toHaveBeenCalled();
  });
});
