import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockUser } from '@/__tests__/helpers/mock-user';

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
  mockSelectExec,
  mockCreateVersion,
  mockGetStructuralAliasGrant,
  mockBuildAliasReservedForUser,
  mockCompile,
  mockPolicyCompileError,
  mockAssertCompilable,
} = vi.hoisted(() => {
  const mockReturningInsert = vi.fn();
  const mockValuesInsert = vi.fn().mockReturnValue({ returning: mockReturningInsert });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValuesInsert });

  const mockReturningUpdate = vi.fn();
  const mockWhereUpdate = vi.fn().mockReturnValue({ returning: mockReturningUpdate });
  const mockSetUpdate = vi.fn().mockReturnValue({ where: mockWhereUpdate });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockSetUpdate });

  const mockWhereDelete = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn().mockReturnValue({ where: mockWhereDelete });

  const mockSelectExec = vi.fn();
  const mockCreateVersion = vi.fn().mockResolvedValue({
    id: 'v1',
    version: 1,
    sourceHash: 'hash',
    sourceEnvelopeSha256: 'envelope',
  });
  const mockGetStructuralAliasGrant = vi.fn().mockResolvedValue(false);
  const mockBuildAliasReservedForUser = vi.fn().mockResolvedValue({
    canonicalKeywordsLower: new Set<string>(),
    baseAliasesLower: new Set<string>(),
    vocabularyTermsLower: new Set<string>(),
  });
  const mockCompile = vi.fn().mockResolvedValue({ success: true, diagnostics: [] });
  // 与 version-manager 的 PolicyCompileError 同构，供 mock 导出 + 测试 instanceof。
  class MockPolicyCompileError extends Error {
    constructor(message = '策略存在解析错误，无法保存，请先修复后再试。') {
      super(message);
      this.name = 'PolicyCompileError';
    }
  }
  // assertCompilable 默认放行（no-op）；门禁真实逻辑在 policy-version-compile-gate.test.ts。
  const mockAssertCompilable = vi.fn().mockResolvedValue(undefined);

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
    mockSelectExec,
    mockCreateVersion,
    mockGetStructuralAliasGrant,
    mockBuildAliasReservedForUser,
    mockCompile,
    mockPolicyCompileError: MockPolicyCompileError,
    mockAssertCompilable,
  };
});

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/policy-lifecycle', () => ({
  softDeletePolicy: vi.fn(),
}));

vi.mock('@/lib/cache', () => ({
  invalidatePolicyCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/policy-freeze', () => ({
  getPolicyFreezeStatus: vi.fn(),
  isPolicyFrozen: vi.fn(),
}));

vi.mock('@/services/pii/detector', () => ({
  detectPII: vi.fn().mockReturnValue({ detectedTypes: [] }),
}));

vi.mock('@/services/policy/version-manager', () => ({
  createVersion: mockCreateVersion,
  PolicyCompileError: mockPolicyCompileError,
  // 默认 no-op（放行）；单个测试可覆写以模拟 compile 门禁抛 PolicyCompileError。
  assertCompilable: mockAssertCompilable,
}));

vi.mock('@/services/policy/policy-api', () => ({
  createPolicyApiClient: vi.fn(() => ({ compile: mockCompile })),
}));

vi.mock('@/lib/structural-alias-grants', () => ({
  getStructuralAliasGrant: mockGetStructuralAliasGrant,
  buildAliasReservedForUser: mockBuildAliasReservedForUser,
}));

vi.mock('@/lib/usage', () => ({
  checkUsageLimit: vi.fn().mockResolvedValue({ allowed: true }),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policies: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      policyVersions: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      policyGroups: {
        findFirst: vi.fn(),
      },
      users: {
        findFirst: vi.fn(),
      },
      structuralAliasGrants: {
        findFirst: vi.fn(),
      },
    },
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
    select: mockSelectExec,
    transaction: vi.fn(async (fn) => fn({
      query: {
        policyVersions: { findFirst: vi.fn().mockResolvedValue(null) },
      },
      insert: mockInsert,
      // C2：PUT 编辑路径现在事务内也 update（回填 Policy.version）+ createVersion。
      update: mockUpdate,
    })),
    execute: vi.fn().mockResolvedValue([{ test: 1 }]),
  },
  policies: { id: {}, userId: {}, deletedAt: {}, isPublic: {}, groupId: {} },
  policyVersions: { policyId: {}, version: {} },
  policyGroups: { id: {}, userId: {} },
  executions: { policyId: {} },
  users: { id: {}, plan: {}, trialEndsAt: {} },
  structuralAliasGrants: { userId: {}, revokedAt: {} },
}));

import { GET, POST } from '@/app/api/policies/route';
import { GET as GET_ID, PUT, DELETE } from '@/app/api/policies/[id]/route';
import { getSession } from '@/lib/auth';
import { db } from '@/lib/prisma';
import { getPolicyFreezeStatus, isPolicyFrozen } from '@/lib/policy-freeze';
import { softDeletePolicy } from '@/lib/policy-lifecycle';
import { invalidatePolicyCache } from '@/lib/cache';
import { detectPII } from '@/services/pii/detector';
import type { PIIDetectionResult } from '@/services/pii/detector';

const mockGetSession = vi.mocked(getSession);
const mockGetPolicyFreezeStatus = vi.mocked(getPolicyFreezeStatus);
const mockIsPolicyFrozen = vi.mocked(isPolicyFrozen);
const mockSoftDeletePolicy = vi.mocked(softDeletePolicy);
const mockDetectPII = vi.mocked(detectPII);

const DEFAULT_SESSION = { user: { id: 'user-1' } } as Awaited<ReturnType<typeof getSession>>;

function makeRequest(
  url: string,
  method = 'GET',
  body?: Record<string, unknown>
): Request {
  return new Request(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'content-type': 'application/json' } : undefined,
  });
}

// Setup a select chain that returns grouped execution counts
function setupGroupBySelect(rows: { policyId: string; count: number }[] = []) {
  const groupBy = vi.fn().mockResolvedValue(rows);
  const whereCount = vi.fn().mockReturnValue({ groupBy });
  const fromCount = vi.fn().mockReturnValue({ where: whereCount });
  mockSelectExec.mockReturnValue({ from: fromCount });
}

// Setup a select chain that returns a single count row
function setupCountSelect(count: number) {
  const whereCount = vi.fn().mockResolvedValue([{ count }]);
  const fromCount = vi.fn().mockReturnValue({ where: whereCount });
  mockSelectExec.mockReturnValue({ from: fromCount });
}

// 部分策略对象，仅包含测试需要的字段
function mockPolicy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: 'user-1',
    name: 'Test Policy',
    content: 'Module X.',
    description: null,
    teamId: null,
    groupId: null,
    version: 1,
    isPublic: false,
    shareSlug: null,
    piiFields: null,
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// 部分策略版本对象
function mockPolicyVersion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    policyId: 'p1',
    version: 1,
    content: 'Module X.',
    source: null,
    sourceHash: null,
    prevHash: null,
    comment: null,
    status: 'DRAFT' as const,
    createdBy: null,
    isDefault: false,
    releaseNote: null,
    deprecatedAt: null,
    deprecatedBy: null,
    archivedAt: null,
    archivedBy: null,
    vocabularySnapshotIds: [],
    aliasSet: null,
    sourceEnvelopeSha256: null,
    sourceToolchainId: null,
    profile: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('Policies API - Drizzle Migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(DEFAULT_SESSION);
    // Default freeze status: no freezes
    mockGetPolicyFreezeStatus.mockResolvedValue({
      limit: 25,
      totalPolicies: 1,
      frozenCount: 0,
      frozenPolicyIds: new Set(),
    });
    mockIsPolicyFrozen.mockResolvedValue({
      isFrozen: false,
      activePoliciesLimit: 25,
      totalPolicies: 1,
      frozenCount: 0,
    });
    vi.mocked(db.query.structuralAliasGrants.findFirst).mockResolvedValue(undefined);
    mockGetStructuralAliasGrant.mockResolvedValue(false);
    mockBuildAliasReservedForUser.mockResolvedValue({
      canonicalKeywordsLower: new Set<string>(),
      baseAliasesLower: new Set<string>(),
      vocabularyTermsLower: new Set<string>(),
    });
    mockCreateVersion.mockResolvedValue({
      id: 'v1',
      version: 1,
      sourceHash: 'hash',
      sourceEnvelopeSha256: 'envelope',
    });
    // 编译门禁默认放行（clearAllMocks 后重置实现）。
    mockAssertCompilable.mockResolvedValue(undefined);
    mockCompile.mockResolvedValue({ success: true, diagnostics: [] });
    // Default select: returns empty execution counts
    setupGroupBySelect([]);
  });

  describe('GET /api/policies', () => {
    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return policies list with freeze info', async () => {
      const policies = [
        mockPolicy({ group: null }),
      ];
      vi.mocked(db.query.policies.findMany).mockResolvedValue(policies);
      setupGroupBySelect([{ policyId: 'p1', count: 5 }]);

      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.policies).toHaveLength(1);
      expect(body.policies[0].id).toBe('p1');
      expect(body.freezeInfo).toBeDefined();
      expect(body.freezeInfo.limit).toBe(25);
    });

    it('should mark frozen policies in list', async () => {
      const policies = [
        mockPolicy({ id: 'p1', name: 'Active Policy', group: null }),
        mockPolicy({ id: 'p2', name: 'Frozen Policy', group: null }),
      ];
      vi.mocked(db.query.policies.findMany).mockResolvedValue(policies);
      mockGetPolicyFreezeStatus.mockResolvedValue({
        limit: 1,
        totalPolicies: 2,
        frozenCount: 1,
        frozenPolicyIds: new Set(['p2']),
      });

      const response = await GET();
      const body = await response.json();

      const p1 = body.policies.find((p: { id: string }) => p.id === 'p1');
      const p2 = body.policies.find((p: { id: string }) => p.id === 'p2');
      expect(p1.isFrozen).toBe(false);
      expect(p2.isFrozen).toBe(true);
    });

    it('should return 500 on internal error', async () => {
      vi.mocked(db.query.policies.findMany).mockRejectedValue(new Error('DB failure'));

      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });
  });

  describe('POST /api/policies', () => {
    const validBody = { name: 'My Policy', content: 'Module X.' };

    beforeEach(() => {
      // Setup user check (within policy limit)
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'pro' }));
      // Setup policy count select (current count = 1, limit = 25)
      setupCountSelect(1);
      // Setup successful insert
      const policy = mockPolicy({ id: 'new-p1', name: 'My Policy' });
      mockReturningInsert.mockResolvedValue([policy]);
      mockValuesInsert.mockReturnValue({ returning: mockReturningInsert });
      mockInsert.mockReturnValue({ values: mockValuesInsert });
    });

    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await POST(makeRequest('http://localhost/api/policies', 'POST', validBody));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 400 when name is missing', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/policies', 'POST', { content: 'Module X.' })
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('required');
    });

    it('should return 400 when content is missing', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/policies', 'POST', { name: 'Test' })
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('required');
    });

    it('should return 402 with upgrade contract when policy limit is reached for free user', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'free' }));
      // PM v1.1 free plan limit = 5, current count = 5
      setupCountSelect(5);

      const response = await POST(makeRequest('http://localhost/api/policies', 'POST', validBody));
      const body = await response.json();

      // F3 v1.1：统一 upgrade JSON 格式（详见 src/lib/plan-quota.ts）
      expect(response.status).toBe(402);
      expect(body.upgrade).toBe(true);
      expect(body.reason).toBe('published_rules');
      expect(body.recommendedPlan).toBe('pro');
      expect(body.usage).toBeGreaterThanOrEqual(5);
      expect(body.limit).toBe(5);
      expect(typeof body.message).toBe('string');
    });

    it('should return 404 when specified groupId does not belong to user', async () => {
      vi.mocked(db.query.policyGroups.findFirst).mockResolvedValue(undefined);

      const response = await POST(
        makeRequest('http://localhost/api/policies', 'POST', {
          ...validBody,
          groupId: 'group-nonexistent',
        })
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Group not found');
    });

    it('should detect PII and include in policy creation', async () => {
      mockDetectPII.mockReturnValue({
        hasPII: true,
        detectedTypes: ['email', 'phone'],
        locations: [],
        riskLevel: 'medium',
      } satisfies PIIDetectionResult);
      const policy = mockPolicy({ id: 'new-p1', name: 'PII Policy', piiFields: ['email', 'phone'] });
      mockReturningInsert.mockResolvedValue([policy]);

      const response = await POST(makeRequest('http://localhost/api/policies', 'POST', validBody));

      expect(mockDetectPII).toHaveBeenCalledWith('Module X.');
      expect(response.status).toBe(201);
    });

    it('should create policy with status 201', async () => {
      const response = await POST(makeRequest('http://localhost/api/policies', 'POST', validBody));

      expect(response.status).toBe(201);
    });

    it('编译门禁抛 PolicyCompileError → 路由返回 400 compile_error（事务外 preflight）', async () => {
      // 门禁在事务外 assertCompilable preflight（门禁逻辑单测见
      // policy-version-compile-gate.test.ts）；此处验证路由把 PolicyCompileError
      // 映射为 400 而非 500，且未落库（createVersion 不被调用）。
      mockAssertCompilable.mockRejectedValueOnce(new mockPolicyCompileError());
      const response = await POST(
        makeRequest('http://localhost/api/policies', 'POST', validBody),
      );
      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.error).toBe('compile_error');
      expect(mockCreateVersion).not.toHaveBeenCalled();
    });

    it('编译检查不可用（带 retryAfterSeconds）→ 503 compile_unavailable + Retry-After，不落库', async () => {
      class Unavailable extends mockPolicyCompileError {
        readonly retryAfterSeconds = 42;
        constructor() {
          super('策略编译检查暂时不可用');
        }
      }
      mockAssertCompilable.mockRejectedValueOnce(new Unavailable());
      const response = await POST(
        makeRequest('http://localhost/api/policies', 'POST', validBody),
      );
      const body = await response.json();
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('42');
      expect(body.error).toBe('compile_unavailable');
      expect(mockCreateVersion).not.toHaveBeenCalled();
    });

    it('保存前调 assertCompilable 门禁（已接线）', async () => {
      await POST(makeRequest('http://localhost/api/policies', 'POST', validBody));
      expect(mockAssertCompilable).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ source: validBody.content }),
      );
    });

    it('提交后缓存失效抛错不影响建策略结果（仍 201）', async () => {
      vi.mocked(invalidatePolicyCache).mockRejectedValueOnce(new Error('kv down'));
      const response = await POST(makeRequest('http://localhost/api/policies', 'POST', validBody));
      expect(response.status).toBe(201);
    });

    it('门禁编译得到的 profile 随版本落库（ADR 0046 §6）', async () => {
      mockAssertCompilable.mockResolvedValueOnce('eu-ai-act-high-risk');
      const response = await POST(makeRequest('http://localhost/api/policies', 'POST', validBody));
      expect(response.status).toBe(201);
      expect(mockCreateVersion).toHaveBeenCalledWith(
        expect.objectContaining({ profile: 'eu-ai-act-high-risk' }),
      );
    });

    it('should pass aliasSet into createVersion with server-built reserved sets', async () => {
      const aliasSet = { TIMES: ['multiplied by'] };
      const response = await POST(makeRequest('http://localhost/api/policies', 'POST', {
        ...validBody,
        aliasSet,
        locale: 'en-US',
      }));

      expect(response.status).toBe(201);
      expect(mockBuildAliasReservedForUser).toHaveBeenCalledWith('user-1', 'en-US');
      expect(mockCreateVersion).toHaveBeenCalledWith(expect.objectContaining({
        aliasSet,
        aliasReserved: expect.any(Object),
        allowStructuralAliases: false,
      }));
    });

    it('should use the server structural grant for createVersion', async () => {
      mockGetStructuralAliasGrant.mockResolvedValue(true);
      const aliasSet = { RETURN: ['the answer is'] };
      const response = await POST(makeRequest('http://localhost/api/policies', 'POST', {
        ...validBody,
        aliasSet,
        allowStructural: false,
      }));

      expect(response.status).toBe(201);
      expect(mockCreateVersion).toHaveBeenCalledWith(expect.objectContaining({
        aliasSet,
        allowStructuralAliases: true,
      }));
    });

    it('H2：500 不泄露 stack / DB schema 细节，仅回 requestId', async () => {
      // 构造一个带 postgres 泄露字段的错误——修复前这些会原样回给客户端。
      const leaky = Object.assign(new Error('duplicate key value violates unique constraint'), {
        stack: 'Error: at /app/src/services/policy/version-manager.ts:123:45\n  secret path',
        code: '23505',
        detail: 'Key (userId, name)=(user-1, X) already exists.',
        constraint: 'PolicyVersion_pkey',
        table: 'PolicyVersion',
        column: 'sourceEnvelopeSha256',
        hint: 'internal hint leak',
      });
      mockCreateVersion.mockRejectedValueOnce(leaky);

      const response = await POST(
        makeRequest('http://localhost/api/policies', 'POST', validBody),
      );
      const body = await response.json();
      const raw = JSON.stringify(body);

      expect(response.status).toBe(500);
      // 统一 envelope 契约：{ error: { code, message, requestId } } + x-request-id 头
      expect(body.error.code).toBe('internal_error');
      expect(typeof body.error.requestId).toBe('string');
      expect(body.error.requestId.length).toBeGreaterThan(0);
      expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
      // ★不泄露：stack / 约束 / 表 / 列 / detail / hint / pg code 一律不得出现在响应体
      expect(body.debug).toBeUndefined();
      expect(raw).not.toContain('version-manager.ts');
      expect(raw).not.toContain('PolicyVersion_pkey');
      expect(raw).not.toContain('PolicyVersion');
      expect(raw).not.toContain('sourceEnvelopeSha256');
      expect(raw).not.toContain('23505');
      expect(raw).not.toContain('already exists');
      expect(raw).not.toContain('internal hint leak');
    });
  });

  describe('GET /api/policies/[id]', () => {
    const mockParams = { params: Promise.resolve({ id: 'p1' }) };

    beforeEach(() => {
      vi.mocked(db.query.policyVersions.findMany).mockResolvedValue([]);
      setupCountSelect(3);
    });

    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await GET_ID(makeRequest('http://localhost/api/policies/p1'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 404 when policy is not found', async () => {
      vi.mocked(db.query.policies.findFirst).mockResolvedValue(undefined);

      const response = await GET_ID(makeRequest('http://localhost/api/policies/p1'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Policy not found');
    });

    it('should return policy with versions and execution count', async () => {
      vi.mocked(db.query.policies.findFirst).mockResolvedValue(
        mockPolicy({ team: null })
      );
      vi.mocked(db.query.policyVersions.findMany).mockResolvedValue([
        mockPolicyVersion(),
      ]);

      const response = await GET_ID(makeRequest('http://localhost/api/policies/p1'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.id).toBe('p1');
      expect(body.versions).toHaveLength(1);
      expect(body._count.executions).toBe(3);
    });

    it('返回活跃版本冻结的 activeAliasSet（供执行页 schema 提取合并 lexicon）', async () => {
      vi.mocked(db.query.policies.findFirst).mockResolvedValue(mockPolicy({ team: null }));
      vi.mocked(db.query.policyVersions.findMany).mockResolvedValue([mockPolicyVersion()]);
      // 活跃版本精确查（version===Policy.version）返回冻结别名。
      vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(
        { aliasSet: JSON.stringify({ PLUS: ['followed by'] }) } as never,
      );

      const response = await GET_ID(makeRequest('http://localhost/api/policies/p1'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.activeAliasSet).toBe(JSON.stringify({ PLUS: ['followed by'] }));
    });

    it('should include freeze info for own policies', async () => {
      vi.mocked(db.query.policies.findFirst).mockResolvedValue(mockPolicy());
      mockIsPolicyFrozen.mockResolvedValue({
        isFrozen: true,
        reason: 'Plan limit exceeded',
        activePoliciesLimit: 3,
        totalPolicies: 5,
        frozenCount: 2,
      });

      const response = await GET_ID(makeRequest('http://localhost/api/policies/p1'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.isFrozen).toBe(true);
      expect(body.freezeInfo.reason).toBe('Plan limit exceeded');
    });
  });

  describe('PUT /api/policies/[id]', () => {
    const mockParams = { params: Promise.resolve({ id: 'p1' }) };
    const updateBody = { name: 'Updated Policy', content: 'Module Updated.' };

    beforeEach(() => {
      const existingPolicy = mockPolicy();
      vi.mocked(db.query.policies.findFirst).mockResolvedValue(existingPolicy);
      mockReturningUpdate.mockResolvedValue([mockPolicy({ name: 'Updated Policy', version: 2 })]);
      mockWhereUpdate.mockReturnValue({ returning: mockReturningUpdate });
      mockSetUpdate.mockReturnValue({ where: mockWhereUpdate });
      mockUpdate.mockReturnValue({ set: mockSetUpdate });
      mockReturningInsert.mockResolvedValue([{ id: 'v2' }]);
      mockValuesInsert.mockReturnValue({ returning: mockReturningInsert });
      mockInsert.mockReturnValue({ values: mockValuesInsert });
    });

    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await PUT(
        makeRequest('http://localhost/api/policies/p1', 'PUT', updateBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 404 when policy is not found', async () => {
      vi.mocked(db.query.policies.findFirst).mockResolvedValue(undefined);

      const response = await PUT(
        makeRequest('http://localhost/api/policies/p1', 'PUT', updateBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Policy not found');
    });

    it('should return 403 when policy is frozen', async () => {
      mockIsPolicyFrozen.mockResolvedValue({
        isFrozen: true,
        reason: 'Plan allows 3 policies but you have 5.',
        activePoliciesLimit: 3,
        totalPolicies: 5,
        frozenCount: 2,
      });

      const response = await PUT(
        makeRequest('http://localhost/api/policies/p1', 'PUT', updateBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.frozen).toBe(true);
      expect(body.error).toBe('Policy is frozen');
    });

    it('should return updated policy on success', async () => {
      const response = await PUT(
        makeRequest('http://localhost/api/policies/p1', 'PUT', updateBody),
        mockParams
      );

      expect(response.status).toBe(200);
    });

    it('新版本带上门禁编译得到的 profile（ADR 0046 §6）', async () => {
      mockAssertCompilable.mockResolvedValueOnce('governed');
      const response = await PUT(
        makeRequest('http://localhost/api/policies/p1', 'PUT', updateBody),
        mockParams,
      );
      expect(response.status).toBe(200);
      expect(mockCreateVersion).toHaveBeenCalledWith(
        expect.objectContaining({ profile: 'governed' }),
      );
    });

    it('审计 High：仅改 aliasSet（content 不变）也创建新版本走 createVersion', async () => {
      // 修复前 newVersion 只看 content 变化 → 别名单独变会被静默丢弃（无 envelope/审计）。
      // 现应：活跃版本无别名(null) vs 提交非空别名 → aliasChanged=true → createVersion。
      vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue({ aliasSet: null } as never);

      const response = await PUT(
        makeRequest('http://localhost/api/policies/p1', 'PUT', {
          content: 'Module X.', // 与 existingPolicy.content 相同（内容不变）
          aliasSet: { TIMES: ['multiplied by'] },
        }),
        mockParams,
      );

      expect(response.status).toBe(200);
      // 关键：content 未变但 aliasSet 变 → 仍调 createVersion，source 沿用现有 content。
      expect(mockCreateVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'Module X.',
          aliasSet: { TIMES: ['multiplied by'] },
        }),
      );
    });

    it('审计 High：改 content 但省略 aliasSet 字段 → 保留活跃版本已有别名（不清空）', async () => {
      // 修复前：aliasSet 字段缺省 → aliasSetInput=null → 新版本 aliasSet 被写 null，
      // 静默清空已有别名。现应：字段缺省=保留，新版本沿用活跃版本冻结的别名。
      vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(
        { aliasSet: JSON.stringify({ TIMES: ['multiplied by'] }) } as never,
      );

      const response = await PUT(
        makeRequest('http://localhost/api/policies/p1', 'PUT', {
          content: 'Module Changed.', // content 变，但不带 aliasSet 字段
        }),
        mockParams,
      );

      expect(response.status).toBe(200);
      // 关键：createVersion 收到保留的现有别名，而非 null。
      expect(mockCreateVersion).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'Module Changed.',
          aliasSet: { TIMES: ['multiplied by'] },
        }),
      );
    });

    it('审计 High：显式传 aliasSet: null → 清空别名（与省略字段区分）', async () => {
      // 显式 null/{}=清空（三态语义：undefined 保留 / null 清空 / 非空对象采用）。
      vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(
        { aliasSet: JSON.stringify({ TIMES: ['multiplied by'] }) } as never,
      );

      const response = await PUT(
        makeRequest('http://localhost/api/policies/p1', 'PUT', {
          content: 'Module X.', // content 不变
          aliasSet: null, // 显式清空
        }),
        mockParams,
      );

      expect(response.status).toBe(200);
      // 别名从非空变 null → aliasChanged=true → 建版本，aliasSet 传 null（清空）。
      expect(mockCreateVersion).toHaveBeenCalledWith(
        expect.objectContaining({ aliasSet: null }),
      );
    });

    it('审计 High：content 与 aliasSet 都不变时不创建新版本', async () => {
      // 活跃版本已冻结相同别名（canonical JSON）→ 提交相同别名 → aliasChanged=false，
      // content 也不变 → 不建版本（避免每次保存刷版本）。
      vi.mocked(db.query.policyVersions.findFirst).mockResolvedValue(
        { aliasSet: JSON.stringify({ TIMES: ['multiplied by'] }) } as never,
      );

      const response = await PUT(
        makeRequest('http://localhost/api/policies/p1', 'PUT', {
          name: 'Renamed only',
          content: 'Module X.',
          aliasSet: { TIMES: ['multiplied by'] },
        }),
        mockParams,
      );

      expect(response.status).toBe(200);
      expect(mockCreateVersion).not.toHaveBeenCalled();
    });

    it('should return 500 on database error', async () => {
      mockUpdate.mockImplementation(() => { throw new Error('DB error'); });

      const response = await PUT(
        makeRequest('http://localhost/api/policies/p1', 'PUT', updateBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });
  });

  describe('DELETE /api/policies/[id]', () => {
    const mockParams = { params: Promise.resolve({ id: 'p1' }) };

    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await DELETE(makeRequest('http://localhost/api/policies/p1', 'DELETE'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 404 when policy is not found', async () => {
      mockSoftDeletePolicy.mockResolvedValue({
        success: false,
        policyId: 'p1',
        error: 'Policy not found or already deleted',
      });

      const response = await DELETE(makeRequest('http://localhost/api/policies/p1', 'DELETE'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Policy not found or already deleted');
    });

    it('should return success message on soft delete', async () => {
      mockSoftDeletePolicy.mockResolvedValue({ success: true, policyId: 'p1' });

      const response = await DELETE(makeRequest('http://localhost/api/policies/p1', 'DELETE'), mockParams);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toContain('trash');
    });

    it('should pass deletion reason to softDeletePolicy when provided', async () => {
      mockSoftDeletePolicy.mockResolvedValue({ success: true, policyId: 'p1' });

      await DELETE(
        makeRequest('http://localhost/api/policies/p1', 'DELETE', { reason: 'No longer needed' }),
        mockParams
      );

      expect(mockSoftDeletePolicy).toHaveBeenCalledWith('p1', 'user-1', 'No longer needed');
    });
  });
});
