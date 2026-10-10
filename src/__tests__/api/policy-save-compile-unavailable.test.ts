import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 保存入口在编译检查不可用时的端到端响应（POST /api/teams/{teamId}/policies）。
 *
 * 其余路由测试整体 mock version-manager，只能用鸭子类型构造带 retryAfterSeconds 的错误。
 * 此处保留真实的 version-manager、编译校验器与响应映射，只 mock 上游 HTTP 客户端，
 * 确认真实的 PolicyCompileUnavailableError 能穿过 instanceof 判别变成 503。
 */
const { mockCompile, mockValuesInsert } = vi.hoisted(() => {
  const mockReturningInsert = vi.fn().mockResolvedValue([
    { id: 'p-new', name: 'n', description: null, teamId: 't1', createdAt: new Date() },
  ]);
  return {
    mockCompile: vi.fn(),
    mockValuesInsert: vi.fn().mockReturnValue({ returning: mockReturningInsert }),
  };
});

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn().mockResolvedValue({ user: { id: 'user-1' } }),
}));
vi.mock('@/lib/prisma', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/prisma')>()),
  db: { insert: vi.fn(() => ({ values: mockValuesInsert })) },
}));
vi.mock('@/lib/team-permissions', () => ({
  checkTeamPermission: vi.fn().mockResolvedValue({ allowed: true }),
  TeamPermission: { CREATE_POLICY: 'CREATE_POLICY', VIEW_POLICIES: 'VIEW_POLICIES' },
}));
vi.mock('@/services/policy/policy-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/policy/policy-api')>()),
  createPolicyApiClient: vi.fn(() => ({ compile: mockCompile })),
}));

const { POST } = await import('@/app/api/teams/[teamId]/policies/route');
const { PolicyApiError } = await import('@/services/policy/policy-api');

function save(content: string) {
  const req = new Request('http://localhost/api/teams/t1/policies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'loan', content }),
  });
  return POST(req, { params: Promise.resolve({ teamId: 't1' }) } as never);
}

const PLAIN = 'Module m.\n\nRule r given x as Int, produce Bool:\n  Return x at least 1.\n';
const PROFILED = 'Module m.\nProfile "governed".\n\nRule r given x as Int, produce Bool:\n  Return x at least 1.\n';

describe('保存入口：编译检查不可用（真实错误类）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('上游 429 → 真实 PolicyCompileUnavailableError → 503 compile_unavailable + Retry-After，不落库', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('rate limited', 429, 'RATE_LIMITED', undefined, { retryAfter: 7 }));
    const res = await save(PLAIN);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('7');
    expect(body.error).toBe('compile_unavailable');
    expect(mockValuesInsert).not.toHaveBeenCalled();
  });

  it('声明档案 + 上游 408 超时 → 503 compile_unavailable，不落库', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('Request timeout', 408, 'TIMEOUT'));
    const res = await save(PROFILED);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).not.toBeNull();
    expect((await res.json()).error).toBe('compile_unavailable');
    expect(mockValuesInsert).not.toHaveBeenCalled();
  });

  it('未声明档案 + 上游 408 超时 → 照旧放行保存', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('Request timeout', 408, 'TIMEOUT'));
    const res = await save(PLAIN);
    expect(res.status).toBe(201);
    expect(mockValuesInsert).toHaveBeenCalled();
  });

  it('声明档案 + 上游 5xx → 503 compile_unavailable，不落库', async () => {
    mockCompile.mockRejectedValue(new PolicyApiError('upstream down', 502));
    const res = await save(PROFILED);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('compile_unavailable');
    expect(mockValuesInsert).not.toHaveBeenCalled();
  });
});

// 与 aster-api PolicyCompileResourceCatchAllTest 成对：api 编译端点兜底失败时的响应原样，
// 诊断码 COMPILE_INTERNAL_ERROR 表示「编译没做成」，不是源码错误。
const API_INTERNAL_FAILURE = {
  success: false,
  diagnostics: [
    {
      severity: 'error',
      message: '编译服务内部错误，未能完成编译，请稍后重试',
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
      code: 'COMPILE_INTERNAL_ERROR',
      featureId: null,
      blocking: false,
    },
  ],
  error: '编译失败: boom',
};

describe('保存入口：api 编译端点内部故障（COMPILE_INTERNAL_ERROR）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('声明档案 → 503 compile_unavailable + Retry-After，不落库', async () => {
    mockCompile.mockResolvedValue(API_INTERNAL_FAILURE);
    const res = await save(PROFILED);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).not.toBeNull();
    expect((await res.json()).error).toBe('compile_unavailable');
    expect(mockValuesInsert).not.toHaveBeenCalled();
  });

  it('未声明档案 → 照旧放行保存', async () => {
    mockCompile.mockResolvedValue(API_INTERNAL_FAILURE);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await save(PLAIN);
    expect(res.status).toBe(201);
    expect(mockValuesInsert).toHaveBeenCalled();
  });

  it('普通编译错误（无码 error 诊断）→ 仍为 400 compile_error，不落库', async () => {
    mockCompile.mockResolvedValue({
      success: false,
      diagnostics: [{ severity: 'error', message: 'Unexpected token', startLine: 4, startColumn: 12, endLine: 4, endColumn: 12, code: null }],
    });
    const res = await save(PROFILED);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('compile_error');
    expect(mockValuesInsert).not.toHaveBeenCalled();
  });
});

