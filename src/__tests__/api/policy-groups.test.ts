import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted so variables can be referenced in vi.mock factories
const {
  mockReturningInsert,
  mockValuesInsert,
  mockInsert,
  mockReturningUpdate,
  mockWhereUpdate,
  mockSetUpdate,
  mockUpdate,
  mockWhereDelete: _mockWhereDelete,
  mockDelete,
  mockSelect,
  mockTransactionFn,
  __realTables,
} = vi.hoisted(() => {
  // ★真实 drizzle 列定义（见下方 vi.mock('@/lib/prisma') 处的说明）：
  //   只有真列才能让 where 谓词里的列名在测试中可断言。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pgTable, text, integer, boolean, timestamp } = require('drizzle-orm/pg-core');
  const __realTables = {
    policyGroups: pgTable('PolicyGroup', {
      id: text('id'), userId: text('userId'), parentId: text('parentId'),
      teamId: text('teamId'), sortOrder: integer('sortOrder'), name: text('name'),
      isSystem: boolean('isSystem'),
    }),
    teamMembers: pgTable('TeamMember', {
      userId: text('userId'), teamId: text('teamId'), role: text('role'),
    }),
    policies: pgTable('Policy', {
      id: text('id'), groupId: text('groupId'), userId: text('userId'),
      teamId: text('teamId'), deletedAt: timestamp('deletedAt'),
      updatedAt: timestamp('updatedAt'), name: text('name'),
      description: text('description'),
    }),
  };
  const mockReturningInsert = vi.fn();
  const mockValuesInsert = vi.fn().mockReturnValue({ returning: mockReturningInsert });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValuesInsert });

  const mockReturningUpdate = vi.fn();
  const mockWhereUpdate = vi.fn().mockReturnValue({ returning: mockReturningUpdate });
  const mockSetUpdate = vi.fn().mockReturnValue({ where: mockWhereUpdate });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSetUpdate });

  const mockWhereDelete = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn().mockReturnValue({ where: mockWhereDelete });

  const mockSelect = vi.fn();
  const mockTransactionFn = vi.fn();

  return {
    mockReturningInsert,
    mockValuesInsert,
    mockInsert,
    mockReturningUpdate,
    mockWhereUpdate,
    mockSetUpdate,
    mockUpdate,
    mockWhereDelete,
    mockDelete,
    mockSelect,
    mockTransactionFn,
    __realTables,
  };
});

/**
 * 从 drizzle 的 SQL 谓词对象中递归提取参与的列名。
 * 用于断言「where 里到底有没有归属列」——这是 mock 层唯一能真实验证
 * 租户隔离的方式（`{}` 占位列做不到，故此前漏洞可长期全绿）。
 */
function predicateColumns(node: unknown, depth = 0): string[] {
  const out = new Set<string>();
  const walk = (n: unknown, d: number): void => {
    if (!n || d > 12) return;
    if (Array.isArray(n)) { n.forEach((x) => walk(x, d + 1)); return; }
    if (typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    if (typeof o.name === 'string' && o.columnType !== undefined) out.add(o.name);
    if (o.queryChunks) walk(o.queryChunks, d + 1);
  };
  walk((node as { queryChunks?: unknown })?.queryChunks ?? node, depth);
  return [...out];
}

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policyGroups: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      teamMembers: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      policies: {
        findMany: vi.fn(),
      },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    select: mockSelect,
    transaction: mockTransactionFn,
  },
  // ★列对象必须是**真实的 drizzle 列**而非 `{}` 占位。
  //   用 `{}` 时，eq()/and() 构造出的 SQL 对象里不保留可识别的列信息，
  //   于是「谓词里到底有没有 userId」在测试中根本无法断言——
  //   这正是「少一个 owner 谓词」的跨租户漏洞能在 5826 条用例下全绿的原因。
  //   换成 pgTable 定义的真列后，可以从 queryChunks 中提取列名做真实断言。
  policyGroups: __realTables.policyGroups,
  teamMembers: __realTables.teamMembers,
  policies: __realTables.policies,
}));

import { GET, POST } from '@/app/api/policy-groups/route';
import { GET as GET_ID, PUT, DELETE } from '@/app/api/policy-groups/[id]/route';
import { getSession } from '@/lib/auth';
import { db } from '@/lib/prisma';

const mockGetSession = vi.mocked(getSession);

const DEFAULT_SESSION = { user: { id: 'user-1' } } as Awaited<ReturnType<typeof getSession>>;

function makeRequest(url: string, method = 'GET', body?: Record<string, unknown>): Request {
  return new Request(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'content-type': 'application/json' } : undefined,
  });
}

// Helper to setup a count select chain returning a given count.
// The GET handler now uses one GROUP BY query over the full set of
// group ids — so the chain is select().from().where().groupBy() and
// resolves to an array of { groupId, count } rows. The POST handler
// kept its per-call shape (select().from().where() → [{count}]). We
// model both: the .where() result is awaited as the single-row
// shape, and .where().groupBy() returns the grouped-rows shape (in
// these tests both default to "no policies", so the grouped result
// is an empty array — the route then falls back to count: 0).
function setupCountSelect(count: number) {
  const where = vi.fn(() => {
    const thenable = Promise.resolve([{ count }]) as unknown as Promise<
      { count: number }[]
    > & {
      groupBy: () => Promise<Array<{ groupId: string; count: number }>>;
    };
    thenable.groupBy = vi
      .fn()
      .mockResolvedValue([] as Array<{ groupId: string; count: number }>);
    return thenable;
  });
  const from = vi.fn().mockReturnValue({ where });
  mockSelect.mockReturnValue({ from });
}

function mockPolicyGroup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'g1',
    name: 'Test Group',
    description: null,
    icon: null,
    sortOrder: 0,
    parentId: null,
    userId: 'user-1',
    teamId: null,
    isSystem: false,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

// Helper to setup max+count selects (used in POST)
function setupMaxThenCountSelect(maxValue: number, countValue: number) {
  let callIdx = 0;
  mockSelect.mockImplementation(() => {
    callIdx++;
    if (callIdx === 1) {
      const where = vi.fn().mockResolvedValue([{ max: maxValue }]);
      const from = vi.fn().mockReturnValue({ where });
      return { from };
    }
    const where = vi.fn().mockResolvedValue([{ count: countValue }]);
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });
}

describe('Policy Groups API - Drizzle Migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(DEFAULT_SESSION);
    // Default: no team memberships
    vi.mocked(db.query.teamMembers.findMany).mockResolvedValue([]);
    vi.mocked(db.query.teamMembers.findFirst).mockResolvedValue(undefined);
    // Default policy count = 0 for all groups
    setupCountSelect(0);
  });

  describe('GET /api/policy-groups', () => {
    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return groups tree and flat list', async () => {
      const mockGroups = [
        mockPolicyGroup({ id: 'g1', name: 'Root Group' }),
        mockPolicyGroup({ id: 'g2', name: 'Child Group', parentId: 'g1' }),
      ];
      // findMany called for: userGroups, systemGroups
      vi.mocked(db.query.policyGroups.findMany)
        .mockResolvedValueOnce(mockGroups)    // userGroups
        .mockResolvedValueOnce([]);           // systemGroups

      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.groups).toBeDefined();
      expect(body.flatGroups).toBeDefined();
    });

    it('should build correct tree structure with children', async () => {
      const mockGroups = [
        mockPolicyGroup({ id: 'g1', name: 'Root' }),
        mockPolicyGroup({ id: 'g2', name: 'Child', parentId: 'g1' }),
      ];
      vi.mocked(db.query.policyGroups.findMany)
        .mockResolvedValueOnce(mockGroups)
        .mockResolvedValueOnce([]);

      const response = await GET();
      const body = await response.json();

      // Root group should have child in tree
      const root = body.groups.find((g: { id: string }) => g.id === 'g1');
      expect(root).toBeDefined();
      expect(root.children).toHaveLength(1);
      expect(root.children[0].id).toBe('g2');
    });

    it('should return 500 on internal error', async () => {
      vi.mocked(db.query.policyGroups.findMany).mockRejectedValue(new Error('DB error'));

      const response = await GET();
      const body = await response.json();

      // P1-5 envelope: { error: { code, message, requestId } }.
      // Raw exception text no longer leaks into the response — the
      // operator-actionable detail lives on the requestId, which
      // matches the x-request-id header for log correlation.
      expect(response.status).toBe(500);
      expect(body.error).toMatchObject({
        code: 'service_unavailable',
        message: expect.stringContaining('Could not load policy groups'),
        requestId: expect.any(String),
      });
      expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    });
  });

  describe('POST /api/policy-groups', () => {
    const validBody = { name: 'New Group' };

    beforeEach(() => {
      const newGroup = { id: 'g-new', name: 'New Group', parentId: null, userId: 'user-1' };
      mockReturningInsert.mockResolvedValue([newGroup]);
      mockValuesInsert.mockReturnValue({ returning: mockReturningInsert });
      mockInsert.mockReturnValue({ values: mockValuesInsert });
      // max sort order = 0, policy count = 0
      setupMaxThenCountSelect(0, 0);
    });

    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await POST(makeRequest('http://localhost/api/policy-groups', 'POST', validBody));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 400 when name is missing', async () => {
      const response = await POST(makeRequest('http://localhost/api/policy-groups', 'POST', {}));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Name is required');
    });

    it('should return 404 when parentId group is not found', async () => {
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.teamMembers.findMany).mockResolvedValue([]);

      const response = await POST(
        makeRequest('http://localhost/api/policy-groups', 'POST', {
          name: 'Child Group',
          parentId: 'nonexistent-parent',
        })
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Parent group not found');
    });

    it('should return 403 when teamId specified but user is not a member', async () => {
      vi.mocked(db.query.teamMembers.findFirst).mockResolvedValue(undefined);

      const response = await POST(
        makeRequest('http://localhost/api/policy-groups', 'POST', {
          name: 'Team Group',
          teamId: 'team-1',
        })
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Not a team member');
    });

    it('should return 201 on successful group creation', async () => {
      const response = await POST(makeRequest('http://localhost/api/policy-groups', 'POST', validBody));

      expect(response.status).toBe(201);
    });
  });

  describe('GET /api/policy-groups/[id]', () => {
    const mockParams = { params: Promise.resolve({ id: 'g1' }) };

    beforeEach(() => {
      // Multiple count queries
      let _callCount = 0;
      mockSelect.mockImplementation(() => {
        _callCount++;
        const count = 0;
        const where = vi.fn().mockResolvedValue([{ count }]);
        const from = vi.fn().mockReturnValue({ where });
        return { from };
      });
    });

    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await GET_ID(makeRequest('http://localhost/api/policy-groups/g1'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 404 when group is not found', async () => {
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.teamMembers.findMany).mockResolvedValue([]);

      const response = await GET_ID(makeRequest('http://localhost/api/policy-groups/g1'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Group not found');
    });

    it('should return group with children and policies', async () => {
      const mockGroup = mockPolicyGroup();
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(mockGroup);
      vi.mocked(db.query.policyGroups.findMany).mockResolvedValue([]); // no children
      vi.mocked(db.query.policies.findMany).mockResolvedValue([]); // no policies

      const response = await GET_ID(makeRequest('http://localhost/api/policy-groups/g1'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe('g1');
      expect(body.children).toBeDefined();
      expect(body.policies).toBeDefined();
      expect(body._count).toBeDefined();
    });
  });

  describe('PUT /api/policy-groups/[id]', () => {
    const mockParams = { params: Promise.resolve({ id: 'g1' }) };
    const updateBody = { name: 'Updated Group' };

    beforeEach(() => {
      const existingGroup = mockPolicyGroup({ name: 'Old Name' });
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(existingGroup);
      mockReturningUpdate.mockResolvedValue([{ ...existingGroup, name: 'Updated Group' }]);
      mockWhereUpdate.mockReturnValue({ returning: mockReturningUpdate });
      mockSetUpdate.mockReturnValue({ where: mockWhereUpdate });
      mockUpdate.mockReturnValue({ set: mockSetUpdate });
      setupCountSelect(0);
    });

    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await PUT(
        makeRequest('http://localhost/api/policy-groups/g1', 'PUT', updateBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 404 when group is not found', async () => {
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.teamMembers.findMany).mockResolvedValue([]);

      const response = await PUT(
        makeRequest('http://localhost/api/policy-groups/g1', 'PUT', updateBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Group not found');
    });

    it('should return 403 when trying to modify system group', async () => {
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(
        mockPolicyGroup({ name: 'System Group', isSystem: true })
      );

      const response = await PUT(
        makeRequest('http://localhost/api/policy-groups/g1', 'PUT', updateBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Cannot modify system group');
    });

    it('should return 400 when group is set as its own parent', async () => {
      const response = await PUT(
        makeRequest('http://localhost/api/policy-groups/g1', 'PUT', { parentId: 'g1' }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Group cannot be its own parent');
    });

    it('should update group successfully', async () => {
      const response = await PUT(
        makeRequest('http://localhost/api/policy-groups/g1', 'PUT', updateBody),
        mockParams
      );

      expect(response.status).toBe(200);
    });
  });

  describe('DELETE /api/policy-groups/[id]', () => {
    const mockParams = { params: Promise.resolve({ id: 'g1' }) };

    beforeEach(() => {
      const existingGroup = mockPolicyGroup();
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(existingGroup);
      // Policy count and children count both 0
      let _selectCallCount = 0;
      mockSelect.mockImplementation(() => {
        _selectCallCount++;
        const where = vi.fn().mockResolvedValue([{ count: 0 }]);
        const from = vi.fn().mockReturnValue({ where });
        return { from };
      });
      // transaction
      mockTransactionFn.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        const txMock = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
          }),
          delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        };
        await fn(txMock);
      });
    });

    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await DELETE(
        makeRequest('http://localhost/api/policy-groups/g1', 'DELETE'),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 404 when group is not found', async () => {
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(undefined);
      vi.mocked(db.query.teamMembers.findMany).mockResolvedValue([]);

      const response = await DELETE(
        makeRequest('http://localhost/api/policy-groups/g1', 'DELETE'),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Group not found');
    });

    it('should return 403 when trying to delete system group', async () => {
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(
        mockPolicyGroup({ name: 'System Group', isSystem: true })
      );

      const response = await DELETE(
        makeRequest('http://localhost/api/policy-groups/g1', 'DELETE'),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Cannot delete system group');
    });

    it('should delete group and return success message', async () => {
      const response = await DELETE(
        makeRequest('http://localhost/api/policy-groups/g1', 'DELETE'),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toContain('deleted');
    });

    it('should use transaction when deleting group with policies or children', async () => {
      let selectCallCount = 0;
      mockSelect.mockImplementation(() => {
        selectCallCount++;
        const count = selectCallCount === 1 ? 2 : 1; // 2 policies, 1 child
        const where = vi.fn().mockResolvedValue([{ count }]);
        const from = vi.fn().mockReturnValue({ where });
        return { from };
      });

      await DELETE(
        makeRequest('http://localhost/api/policy-groups/g1', 'DELETE'),
        mockParams
      );

      expect(mockTransactionFn).toHaveBeenCalled();
    });
  });

  // ============================================================
  // ★安全审计回归（2026-08-17）
  //
  // 这两个洞在既有 488 个测试文件、5826 条用例下**全绿**——mock 层
  // 只断言「调用了 db.update」，从不检查 where 谓词里有什么，
  // 于是「少一个 owner 谓词」这类缺陷结构上无法被现有测试发现。
  // 下面的用例直接断言**传给 drizzle 的谓词对象**，锁住归属过滤。
  // ============================================================
  describe('跨租户隔离回归', () => {
    const mockParams = { params: Promise.resolve({ id: 'sys-1' }) };

    it('GET 系统分组时，策略查询必须带归属谓词（否则读到全平台策略）', async () => {
      mockGetSession.mockResolvedValue(DEFAULT_SESSION);
      // 系统分组：全局共享行，userId 为空 —— 任何登录用户都能通过第一道门
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(
        mockPolicyGroup({ id: 'sys-1', isSystem: true, userId: null, teamId: null })
      );
      vi.mocked(db.query.policyGroups.findMany).mockResolvedValue([]);
      const findManyPolicies = vi.mocked(db.query.policies.findMany);
      findManyPolicies.mockResolvedValue([]);
      mockSelect.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 0 }]) }),
      }));

      await GET_ID(makeRequest('http://localhost/api/policy-groups/sys-1'), mockParams);

      expect(findManyPolicies).toHaveBeenCalled();
      const whereArg = findManyPolicies.mock.calls[0][0]?.where;
      const cols = predicateColumns(whereArg);
      // 核心安全断言：谓词里必须出现归属列。
      // 去掉 policyScope 后 cols 只剩 ['groupId','deletedAt'] → 此断言失败。
      expect(
        cols,
        '系统分组是全局行；策略查询缺 userId 归属谓词即跨租户读全平台策略'
      ).toContain('userId');
      expect(cols).toContain('groupId');
    });

    it('DELETE 级联必须先按归属迁移、再无条件解引用，不得跨租户投放', async () => {
      mockGetSession.mockResolvedValue(DEFAULT_SESSION);
      // 有父分组的团队分组：迁移分支会被触发
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(
        mockPolicyGroup({ id: 'g1', parentId: 'parent-1', teamId: 'team-1', userId: 'user-1' })
      );
      mockSelect.mockImplementation(() => ({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ count: 5 }]) }),
      }));

      const updateCalls: Array<{ set: unknown; where: unknown }> = [];
      mockTransactionFn.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
        const txMock = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockImplementation((setArg: unknown) => ({
              where: vi.fn().mockImplementation((whereArg: unknown) => {
                updateCalls.push({ set: setArg, where: whereArg });
                return Promise.resolve(undefined);
              }),
            })),
          }),
          delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        };
        await fn(txMock);
      });

      await DELETE(
        makeRequest('http://localhost/api/policy-groups/g1', 'DELETE'),
        { params: Promise.resolve({ id: 'g1' }) }
      );

      // 迁移(→parent-1) 与 解引用(→null) 必须都发生：
      // 只迁移 → 他人行留下悬挂 groupId；只解引用 → 我的策略被错误地掉出父组。
      const movedToParent = updateCalls.filter(
        (c) => (c.set as { groupId?: unknown })?.groupId === 'parent-1'
      );
      const dereferenced = updateCalls.filter(
        (c) => (c.set as { groupId?: unknown })?.groupId === null
      );
      expect(movedToParent.length, '必须有按归属迁移到父分组的 UPDATE').toBeGreaterThan(0);
      expect(dereferenced.length, '必须有无条件解引用的 UPDATE，杜绝悬挂 groupId').toBeGreaterThan(0);

      // 关键安全断言：把行**投放到父分组**的那条 UPDATE 必须携带归属谓词。
      // 若退化成只按 groupId 过滤（历史漏洞形态），cols 里就没有 userId/teamId，
      // 此断言失败。这是本用例真正的杀伤点。
      const moveCols = predicateColumns(movedToParent[0].where);
      expect(
        moveCols,
        '迁移 UPDATE 必须带 owner 谓词，否则会把他人的策略投放到我指定的父分组（跨租户写）'
      ).toEqual(expect.arrayContaining(['groupId']));
      expect(
        moveCols.some((c) => c === 'userId' || c === 'teamId'),
        `迁移 UPDATE 的 where 只有 [${moveCols.join(',')}]——缺归属列即跨租户写`
      ).toBe(true);
    });
  });
});
