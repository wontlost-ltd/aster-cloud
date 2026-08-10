import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 团队建策略入口的编译门禁（`POST /api/teams/{teamId}/policies`）。
 *
 * <h2>被修复的缺口</h2>
 *
 * <p>此入口此前**没有**编译门禁：`/api/policies` 与
 * `/api/v1/policies/{id}/versions` 都在落库前调 `assertCompilable`，
 * 唯独这条不调，于是不可解析的源码能直接进库，直到**执行时**才报语法错。
 *
 * <p>实测事故：AI 生成的 `is < 18`（`is` 后接符号——CNL 只允许 `is` 接
 * 文字比较词）由此入口存入，用户在执行页才看到
 * 「行 15 第 25 列」的语法错误，而保存时一路绿灯。
 */
const {
  mockInsert, mockValuesInsert,
  mockAssertCompilable, mockPolicyCompileError, mockCheckTeamPermission,
} = vi.hoisted(() => {
  const mockReturningInsert = vi.fn().mockResolvedValue([
    { id: 'p-new', name: 'n', description: null, teamId: 't1', createdAt: new Date() },
  ]);
  const mockValuesInsert = vi.fn().mockReturnValue({ returning: mockReturningInsert });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValuesInsert });
  class MockPolicyCompileError extends Error {
    constructor(message = '策略存在解析错误，无法保存，请先修复后再试。') {
      super(message);
      this.name = 'PolicyCompileError';
    }
  }
  return {
    mockInsert, mockValuesInsert, mockReturningInsert,
    mockAssertCompilable: vi.fn().mockResolvedValue(undefined),
    mockPolicyCompileError: MockPolicyCompileError,
    mockCheckTeamPermission: vi.fn().mockResolvedValue({ allowed: true }),
  };
});

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}));
vi.mock('@/lib/prisma', () => ({
  db: { insert: mockInsert, query: { policies: { findFirst: vi.fn() } } },
  policies: {}, executions: {},
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(), desc: vi.fn(), sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));
vi.mock('@/lib/team-permissions', () => ({
  checkTeamPermission: mockCheckTeamPermission,
  TeamPermission: { CREATE_POLICY: 'CREATE_POLICY', VIEW_POLICIES: 'VIEW_POLICIES' },
}));
vi.mock('@/services/policy/version-manager', () => ({
  assertCompilable: mockAssertCompilable,
  PolicyCompileError: mockPolicyCompileError,
}));
vi.mock('@/lib/policy-compile-validator', () => ({
  makeCompileValidator: vi.fn().mockReturnValue(vi.fn()),
}));

const { POST } = await import('@/app/api/teams/[teamId]/policies/route');

function req(body: unknown) {
  return new Request('http://localhost/api/teams/t1/policies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const ctx = { params: Promise.resolve({ teamId: 't1' }) };
const VALID = { name: 'loan', content: 'Module M.\n\nRule r given x as Int, produce Bool:\n  Return x is at least 1.\n' };

describe('POST /api/teams/{teamId}/policies 编译门禁', () => {
  beforeEach(() => vi.clearAllMocks());

  it('★保存前必须调 assertCompilable——此入口此前完全没有门禁', async () => {
    await POST(req(VALID), ctx as never);
    expect(mockAssertCompilable).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ source: VALID.content }),
    );
  });

  it('★不可解析的源码必须 400 compile_error 且**不落库**', async () => {
    // 例如 `is < 18`：CNL 的 `is` 只能接文字比较词，接符号是语法错误。
    mockAssertCompilable.mockRejectedValueOnce(new mockPolicyCompileError());
    const res = await POST(req({ ...VALID, content: 'Module M.\n  If age is < 18\n' }), ctx as never);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe('compile_error');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('门禁必须在插入**之前**——否则坏源码已经落库了', async () => {
    mockAssertCompilable.mockRejectedValueOnce(new mockPolicyCompileError());
    await POST(req(VALID), ctx as never);
    expect(mockValuesInsert).not.toHaveBeenCalled();
  });
});
