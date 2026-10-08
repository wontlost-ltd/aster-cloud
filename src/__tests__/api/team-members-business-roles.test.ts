import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PUT /api/teams/[teamId]/members/[memberId] 的业务角色授予（ADR 0042 §2.1）。
 *
 * 权限判断走真实的 team-permissions（只 mock 数据库），钉住三件事：
 *   1. 权限沿用 MEMBER_UPDATE_ROLE：owner/admin 可授予，member 403 且不写库
 *   2. 只改业务角色时只写 businessRoles，不碰成员角色（也不受 canChangeRole 的 owner 行限制）
 *   3. 词表不合法整体 400 invalid_business_role；写入后重推该成员的团队 key 快照
 */

const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth', () => ({ getSession: () => getSession() }));

const m = vi.hoisted(() => {
  const where = vi.fn();
  const set = vi.fn((_patch: unknown) => ({ where }));
  return { findFirst: vi.fn(), update: vi.fn(() => ({ set })), set, where, refresh: vi.fn() };
});
vi.mock('@/lib/prisma', () => ({
  db: { query: { teamMembers: { findFirst: m.findFirst } }, update: m.update, delete: vi.fn() },
  teamMembers: { id: 'tm.id', teamId: 'tm.teamId', userId: 'tm.userId' },
}));
vi.mock('@/lib/api-keys', () => ({ refreshTeamKeySnapshots: m.refresh, revokeTeamKeys: vi.fn() }));
// where 条件以可检查的结构表达，供租户隔离断言（team-permissions 只把条件原样交给 findFirst）
vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ eq: [col, val] }),
  and: (...c: unknown[]) => ({ and: c }),
}));

import { PUT } from '@/app/api/teams/[teamId]/members/[memberId]/route';

const params = { params: Promise.resolve({ teamId: 't1', memberId: 'm2' }) } as never;
const put = (body: unknown) =>
  new Request('http://cloud.test/x', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

type Row = { id: string; teamId: string; userId: string; role: string; businessRoles: string[] };

/** 按查询形状分派：columns.role → 操作者成员行；with → 更新后回读；其余 → 目标成员。 */
function seed(actorRole: string, target: Row) {
  let current = target;
  m.set.mockImplementation((patch: unknown) => {
    current = { ...current, ...(patch as Partial<Row>) };
    return { where: m.where };
  });
  m.findFirst.mockImplementation(async (args: { columns?: { role?: boolean }; with?: unknown }) => {
    if (args.columns?.role) return { role: actorRole };
    if (args.with) return { ...current, user: { id: current.userId, name: 'N', email: 'n@x' } };
    return target;
  });
}

describe('PUT 成员业务角色（ADR 0042 §2.1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ user: { id: 'u-actor' } });
    m.refresh.mockResolvedValue(1);
  });

  it('admin 授予 → 200，只写 businessRoles、不改 role，并重推该成员快照', async () => {
    seed('admin', { id: 'm2', teamId: 't1', userId: 'u2', role: 'member', businessRoles: [] });
    const res = await PUT(put({ businessRoles: [' DPO ', 'DPO'] }), params);
    expect(res.status).toBe(200);
    expect(m.set).toHaveBeenCalledWith({ businessRoles: ['DPO'] });
    expect(await res.json()).toMatchObject({ id: 'm2', role: 'member', businessRoles: ['DPO'] });
    expect(m.refresh).toHaveBeenCalledWith('t1', 'u2');
  });

  it('owner 给 owner 行授予业务角色 → 200（canChangeRole 只约束成员角色）', async () => {
    seed('owner', { id: 'm2', teamId: 't1', userId: 'u-actor', role: 'owner', businessRoles: [] });
    const res = await PUT(put({ businessRoles: ['Data Protection Officer'] }), params);
    expect(res.status).toBe(200);
    expect(m.set).toHaveBeenCalledWith({ businessRoles: ['Data Protection Officer'] });
  });

  it('member 调用 → 403，不写库、不推快照', async () => {
    seed('member', { id: 'm2', teamId: 't1', userId: 'u2', role: 'member', businessRoles: [] });
    const res = await PUT(put({ businessRoles: ['DPO'] }), params);
    expect(res.status).toBe(403);
    expect(m.update).not.toHaveBeenCalled();
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it('非法角色 → 400 invalid_business_role，不写库', async () => {
    seed('admin', { id: 'm2', teamId: 't1', userId: 'u2', role: 'member', businessRoles: [] });
    const res = await PUT(put({ businessRoles: ['数据保护官'] }), params);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_business_role' });
    expect(m.update).not.toHaveBeenCalled();
  });

  it('role 与 businessRoles 都缺 → 400；同时给出 → 一次写入两者', async () => {
    seed('owner', { id: 'm2', teamId: 't1', userId: 'u2', role: 'member', businessRoles: [] });
    expect((await PUT(put({}), params)).status).toBe(400);
    expect(m.update).not.toHaveBeenCalled();
    const res = await PUT(put({ role: 'admin', businessRoles: ['CISO'] }), params);
    expect(res.status).toBe(200);
    expect(m.set).toHaveBeenCalledWith({ role: 'admin', businessRoles: ['CISO'] });
  });

  it('只改 role 时仍走 canChangeRole：admin 改 admin → 403', async () => {
    seed('admin', { id: 'm2', teamId: 't1', userId: 'u2', role: 'admin', businessRoles: [] });
    const res = await PUT(put({ role: 'member' }), params);
    expect(res.status).toBe(403);
    expect(m.update).not.toHaveBeenCalled();
  });

  it('写入与回读的 where 同时绑定 memberId 与 teamId', async () => {
    seed('admin', { id: 'm2', teamId: 't1', userId: 'u2', role: 'member', businessRoles: [] });
    const res = await PUT(put({ businessRoles: ['DPO'] }), params);
    expect(res.status).toBe(200);
    const inTeam = { and: [{ eq: ['tm.id', 'm2'] }, { eq: ['tm.teamId', 't1'] }] };
    expect(m.where).toHaveBeenCalledWith(inTeam);
    const readBack = m.findFirst.mock.calls.find(([args]) => (args as { with?: unknown }).with)?.[0];
    expect(readBack).toEqual(expect.objectContaining({ where: inTeam }));
  });

  it('memberId 属于其他团队 → 404，不写库、不推快照', async () => {
    seed('admin', { id: 'm2', teamId: 't-other', userId: 'u2', role: 'member', businessRoles: [] });
    // 模拟数据库：目标查询按 (id, teamId) 过滤，m2 不在 t1 → 查不到
    const base = m.findFirst.getMockImplementation()!;
    m.findFirst.mockImplementation(async (args: { columns?: { role?: boolean }; with?: unknown; where?: unknown }) => {
      if (args.columns?.role || args.with) return base(args);
      const where = JSON.stringify(args.where);
      return where.includes(JSON.stringify({ eq: ['tm.teamId', 't1'] })) ? undefined : base(args);
    });

    const res = await PUT(put({ businessRoles: ['DPO'] }), params);

    expect(res.status).toBe(404);
    const targetQuery = m.findFirst.mock.calls.map(([a]) => a as { where?: unknown; columns?: unknown; with?: unknown })
      .find((a) => !a.columns && !a.with);
    expect(targetQuery?.where).toEqual({ and: [{ eq: ['tm.id', 'm2'] }, { eq: ['tm.teamId', 't1'] }] });
    expect(m.update).not.toHaveBeenCalled();
    expect(m.refresh).not.toHaveBeenCalled();
  });
});
