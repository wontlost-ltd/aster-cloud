import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 回归：`PUT /api/policy-groups/[id]` 的 **parentId 归属校验**。
 *
 * 缺陷：该路由严格校验了被改分组 `id` 的归属（本人分组，或本人为 owner/admin
 * 的团队分组，否则 404），对新 `parentId` 却**只查循环引用**
 * （`parentId === id` 与 `checkIsDescendant`），从不校验它属于谁 ——
 * 攻击者可用自己的分组作为 `id`（能过 owner 谓词），把受害者的分组 ID 塞进
 * `parentId`，把自己的分组挂到对方的分组树下。
 *
 * ★ 三个兄弟端点里 PUT 是唯一遗漏者：
 *   - `POST /api/policy-groups`            —— 有归属校验（本人或所在团队，否则 404）
 *   - `POST /api/policy-groups/reorder`    —— 有归属校验（见同目录 reorder 用例）
 *   - `PUT  /api/policy-groups/[id]`       —— 本次修复前无
 *
 * ★ 危害不止"挂错位置"（与 reorder 用例同源）：
 *   1. `policyGroups.parentId` 是裸 text 列，**无 FK、无约束**，DB 不兜底；
 *   2. `DELETE /api/policy-groups/[id]` 的级联按 `parentId` 改写且**无 owner 谓词**。
 *
 * 本用例钉死：**parentId 必须与 id 一同参与归属校验，且拒绝发生在写入之前**。
 */

const { mockGroupFindFirst, mockTeamFindMany, mockUpdate, mockSelect } = vi.hoisted(() => ({
  mockGroupFindFirst: vi.fn(),
  mockTeamFindMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(async () => ({ user: { id: 'user-attacker' } })),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policyGroups: { findFirst: mockGroupFindFirst },
      teamMembers: { findMany: mockTeamFindMany },
    },
    update: mockUpdate,
    select: mockSelect,
  },
  policyGroups: {
    id: 'pg.id',
    userId: 'pg.userId',
    teamId: 'pg.teamId',
    parentId: 'pg.parentId',
  },
  policies: {
    groupId: 'p.groupId',
    userId: 'p.userId',
    teamId: 'p.teamId',
    deletedAt: 'p.deletedAt',
  },
  teamMembers: { userId: 'tm.userId', role: 'tm.role', teamId: 'tm.teamId' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  inArray: (col: unknown, val: unknown) => ({ op: 'inArray', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  sql: Object.assign(() => ({ op: 'sql' }), { raw: () => ({ op: 'sql' }) }),
  desc: (col: unknown) => ({ op: 'desc', col }),
}));

const ATTACKER_GROUP = 'group-owned-by-attacker';
const VICTIM_GROUP = 'group-owned-by-victim';

function makeRequest(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('PUT /api/policy-groups/[id] — parentId 归属校验', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamFindMany.mockResolvedValue([]); // 攻击者不属于任何团队

    // 只有攻击者自己的分组能被查到；受害者的分组一律查不到
    mockGroupFindFirst.mockImplementation(async (args: { where?: unknown }) => {
      const flat = JSON.stringify(args?.where ?? {});
      if (flat.includes(ATTACKER_GROUP)) {
        return { id: ATTACKER_GROUP, isSystem: false, parentId: null, teamId: null };
      }
      return undefined;
    });

    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => ({
          returning: async () => [{ id: ATTACKER_GROUP, teamId: null }],
        }),
      }),
    });
    mockSelect.mockReturnValue({
      from: () => ({ where: async () => [{ count: 0 }] }),
    });
  });

  it('把受害者分组塞进 parentId 时必须被拒（404），且不执行任何写入', async () => {
    const { PUT } = await import('@/app/api/policy-groups/[id]/route');

    const res = await PUT(
      makeRequest({ parentId: VICTIM_GROUP }),
      makeParams(ATTACKER_GROUP)
    );

    expect(res.status).toBe(404);
    // ★关键断言：拒绝必须发生在写入之前
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('parentId 被纳入归属查询（不是只查被改分组的 id）', async () => {
    const { PUT } = await import('@/app/api/policy-groups/[id]/route');

    await PUT(
      makeRequest({ parentId: VICTIM_GROUP }),
      makeParams(ATTACKER_GROUP)
    ).catch(() => undefined);

    const queried = JSON.stringify(mockGroupFindFirst.mock.calls.map((c) => c[0]));
    expect(queried).toContain(VICTIM_GROUP);
  });

  it('挂到自己的分组下仍然放行', async () => {
    const { PUT } = await import('@/app/api/policy-groups/[id]/route');

    // 被改分组与目标父分组都是攻击者自己的（用同一 ID 会触发自环校验，
    // 故这里让 findFirst 对两个"自己的"分组 ID 都返回命中）
    const OWN_PARENT = `${ATTACKER_GROUP}-parent`;
    mockGroupFindFirst.mockImplementation(async (args: { where?: unknown }) => {
      const flat = JSON.stringify(args?.where ?? {});
      if (flat.includes(OWN_PARENT)) {
        return { id: OWN_PARENT, isSystem: false, parentId: null, teamId: null };
      }
      if (flat.includes(ATTACKER_GROUP)) {
        return { id: ATTACKER_GROUP, isSystem: false, parentId: null, teamId: null };
      }
      return undefined;
    });

    const res = await PUT(
      makeRequest({ name: 'renamed' }),
      makeParams(ATTACKER_GROUP)
    );

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });
});
