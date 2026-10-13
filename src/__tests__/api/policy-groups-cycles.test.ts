/**
 * 策略分组父子关系成环（#478）：reorder 防环、PUT 遇到库里已有环不死循环、列表遇环仍可序列化。
 *
 * 库用一张「分组 → parentId」表模拟；所有分组都属于当前用户。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state, mockTransaction, mockUpdate } = vi.hoisted(() => ({
  state: { parents: {} as Record<string, string | null> },
  mockTransaction: vi.fn(),
  mockUpdate: vi.fn(),
}));

const idFromWhere = (where: unknown): string | undefined => {
  const flat = JSON.stringify(where ?? {});
  return Object.keys(state.parents).find((id) => flat.includes(`"${id}"`));
};
const row = (id: string) => ({ id, name: id, isSystem: false, userId: 'u1', teamId: null, parentId: state.parents[id], sortOrder: 0 });

vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: 'u1' } })) }));
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  inArray: (col: unknown, val: unknown) => ({ op: 'inArray', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  asc: (col: unknown) => col,
  desc: (col: unknown) => col,
  sql: () => ({ op: 'sql' }),
}));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policyGroups: {
        // 归属查询（userId = u1）与 parentId 查询都走这里
        findFirst: vi.fn(async (args: { where?: unknown }) => {
          const id = idFromWhere(args?.where);
          return id ? row(id) : undefined;
        }),
        findMany: vi.fn(async (args: { where?: unknown }) => {
          const flat = JSON.stringify(args?.where ?? {});
          if (flat.includes('isSystem')) return [];
          if (flat.includes('"pg.userId"') && !flat.includes('inArray')) return Object.keys(state.parents).map(row);
          return Object.keys(state.parents).filter((id) => flat.includes(`"${id}"`)).map(row);
        }),
      },
      teamMembers: { findMany: vi.fn(async () => []) },
    },
    transaction: mockTransaction,
    update: mockUpdate,
    select: () => ({ from: () => ({ where: () => ({ groupBy: async () => [] }) }) }),
  },
  policyGroups: { id: 'pg.id', userId: 'pg.userId', teamId: 'pg.teamId', parentId: 'pg.parentId', isSystem: 'pg.isSystem', sortOrder: 'pg.sortOrder', name: 'pg.name' },
  policies: { groupId: 'p.groupId', userId: 'p.userId', teamId: 'p.teamId', deletedAt: 'p.deletedAt' },
  teamMembers: { userId: 'tm.userId', role: 'tm.role', teamId: 'tm.teamId' },
}));

const jsonReq = (body: unknown) => ({ json: async () => body }) as unknown as Request;

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ update: () => ({ set: () => ({ where: async () => undefined }) }) }));
  mockUpdate.mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [row('A')] }) }) });
});

describe('POST /api/policy-groups/reorder — 防环', () => {
  it('★一次请求 A→B、B→A：400，且不写入', async () => {
    state.parents = { A: null, B: null };
    const { POST } = await import('@/app/api/policy-groups/reorder/route');
    const res = await POST(jsonReq({ orders: [{ id: 'A', sortOrder: 0, parentId: 'B' }, { id: 'B', sortOrder: 1, parentId: 'A' }] }));
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('★把 A 挂到它的孙子 C 下（库里 C→B→A）：400', async () => {
    state.parents = { A: null, B: 'A', C: 'B' };
    const { POST } = await import('@/app/api/policy-groups/reorder/route');
    const res = await POST(jsonReq({ orders: [{ id: 'A', sortOrder: 0, parentId: 'C' }] }));
    expect(res.status).toBe(400);
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('正常调整顺序与层级：200 并写入', async () => {
    state.parents = { A: null, B: 'A', C: null };
    const { POST } = await import('@/app/api/policy-groups/reorder/route');
    const res = await POST(jsonReq({ orders: [{ id: 'B', sortOrder: 0, parentId: 'C' }, { id: 'A', sortOrder: 1 }] }));
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /api/policy-groups/[id] — 库里已有环', () => {
  it('★把 A 挂到环 X↔Y 上：400（曾无限递归）', async () => {
    state.parents = { A: null, X: 'Y', Y: 'X' };
    const { PUT } = await import('@/app/api/policy-groups/[id]/route');
    const res = await PUT(jsonReq({ parentId: 'X' }), { params: Promise.resolve({ id: 'A' }) });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('★把 A 挂到自己的子孙下：400', async () => {
    state.parents = { A: null, B: 'A' };
    const { PUT } = await import('@/app/api/policy-groups/[id]/route');
    const res = await PUT(jsonReq({ parentId: 'B' }), { params: Promise.resolve({ id: 'A' }) });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/policy-groups — 列表遇环', () => {
  it('★库里有环 X↔Y：200，环上分组按顶层返回，JSON 可序列化', async () => {
    state.parents = { root: null, child: 'root', X: 'Y', Y: 'X' };
    const { GET } = await import('@/app/api/policy-groups/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const rootIds = body.groups.map((g: { id: string }) => g.id).sort();
    expect(rootIds).toEqual(['X', 'Y', 'root']);
    expect(body.groups.find((g: { id: string }) => g.id === 'root').children.map((c: { id: string }) => c.id)).toEqual(['child']);
  });
});
