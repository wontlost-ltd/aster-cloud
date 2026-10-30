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
  mockInsert, mockValuesInsert, mockCreateVersion, mockTransaction,
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
  const mockTransaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn({ insert: mockInsert }));
  return {
    mockInsert, mockValuesInsert, mockReturningInsert, mockTransaction,
    mockCreateVersion: vi.fn().mockResolvedValue({ id: 'v1', version: 1 }),
    mockAssertCompilable: vi.fn().mockResolvedValue(undefined),
    mockPolicyCompileError: MockPolicyCompileError,
    mockCheckTeamPermission: vi.fn().mockResolvedValue({ allowed: true }),
  };
});

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}));
vi.mock('@/lib/prisma', () => ({
  db: { insert: mockInsert, transaction: mockTransaction, query: { policies: { findFirst: vi.fn() } } },
  policies: {}, executions: {},
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(), desc: vi.fn(), sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));
vi.mock('@/lib/team-permissions', () => ({
  checkTeamPermission: mockCheckTeamPermission,
  TeamPermission: { CREATE_POLICY: 'CREATE_POLICY', VIEW_POLICIES: 'VIEW_POLICIES' },
}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/services/policy/version-manager', () => ({
  createVersion: mockCreateVersion,
  assertCompilable: mockAssertCompilable,
  PolicyCompileError: mockPolicyCompileError,
}));
vi.mock('@/lib/policy-compile-validator', () => ({
  loadSaveVocabulary: vi.fn(async () => ({ vocabulary: null, scopesJson: '' })),
  makeCompileValidator: vi.fn().mockReturnValue(vi.fn()),
}));

const { POST } = await import('@/app/api/teams/[teamId]/policies/route');
const { loadSaveVocabulary } = await import('@/lib/policy-compile-validator');
const { VocabularyScopeError } = await import('@aster-cloud/aster-lang-ts/browser');

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

  it('★新建团队策略在同一事务里生成 v1 版本（#681：此前没有版本行，提交审批 400）', async () => {
    mockAssertCompilable.mockResolvedValueOnce('governed');
    const res = await POST(req(VALID), ctx as never);
    expect(res.status).toBe(201);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockCreateVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: 'p-new',
        source: VALID.content,
        createdBy: 'user-1',
        locale: 'en-US',
        profile: 'governed',
        dbClient: expect.anything(),
      }),
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

  it('编译检查不可用（上游限流）→ 503 + Retry-After，不落库', async () => {
    const err = Object.assign(new mockPolicyCompileError('策略编译检查暂时不可用'), {
      retryAfterSeconds: 9,
    });
    mockAssertCompilable.mockRejectedValueOnce(err);
    const res = await POST(req(VALID), ctx as never);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('9');
    expect(body.error).toBe('compile_unavailable');
    expect(mockValuesInsert).not.toHaveBeenCalled();
  });

  // ADR 0051：作者词汇非法 / 加载失败两条拒绝路径（#650）
  it('作者词汇非法（字段缺 parent）→ 400 vocabulary_scope_invalid，不编译不落库', async () => {
    vi.mocked(loadSaveVocabulary).mockRejectedValueOnce(
      new VocabularyScopeError('field_parent_required', '字段 "alter" 缺少 parent'),
    );
    const res = await POST(req(VALID), ctx as never);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ code: 'vocabulary_scope_invalid', reason: 'field_parent_required', term: 'alter' });
    expect(mockAssertCompilable).not.toHaveBeenCalled();
    expect(mockValuesInsert).not.toHaveBeenCalled();
  });

  it('作者词汇加载失败 → 503 vocabulary_unavailable + Retry-After，不落库', async () => {
    vi.mocked(loadSaveVocabulary).mockRejectedValueOnce(Object.assign(
      new mockPolicyCompileError('Domain vocabulary could not be loaded. Try again later.'),
      { retryAfterSeconds: 30, unavailableCode: 'vocabulary_unavailable' },
    ));
    const res = await POST(req(VALID), ctx as never);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect((await res.json()).code).toBe('vocabulary_unavailable');
    expect(mockAssertCompilable).not.toHaveBeenCalled();
    expect(mockValuesInsert).not.toHaveBeenCalled();
  });
});
