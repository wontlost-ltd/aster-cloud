import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockUser } from '@/__tests__/helpers/mock-user';

// Use vi.hoisted so variables can be referenced in vi.mock factories
const {
  mockOnConflictDoUpdate,
  mockValuesInsert,
  mockInsert,
  mockDbExecute,
  mockDbSelect,
} = vi.hoisted(() => {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValuesInsert = vi.fn().mockReturnValue({
    onConflictDoUpdate: mockOnConflictDoUpdate,
    returning: vi.fn().mockResolvedValue([]),
  });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValuesInsert });
  const mockDbExecute = vi.fn();
  const mockDbSelect = vi.fn();

  return {
    mockOnConflictDoUpdate,
    mockValuesInsert,
    mockInsert,
    mockDbExecute,
    mockDbSelect,
  };
});

const { mockLoadExecutionVocabulary, mockLoadLiveVocabulary } = vi.hoisted(() => ({
  mockLoadExecutionVocabulary: vi.fn(async (): Promise<Record<string, unknown> | undefined> => undefined),
  mockLoadLiveVocabulary: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
}));
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  loadExecutionVocabulary: mockLoadExecutionVocabulary,
  loadLiveVocabularyForPolicy: mockLoadLiveVocabulary,
}));

vi.mock('@/lib/api-keys', () => ({
  authenticateApiRequest: vi.fn(),
}));

const { mockCountOwnerPoolUsage, mockRecordApiCallRecord } = vi.hoisted(() => ({
  mockCountOwnerPoolUsage: vi.fn(async (_owner: string, _period: string) => 0),
  mockRecordApiCallRecord: vi.fn(async (_r: unknown) => undefined),
}));
vi.mock('@/lib/api-quota-pool', () => ({
  countOwnerPoolUsage: mockCountOwnerPoolUsage,
  recordApiCallRecord: mockRecordApiCallRecord,
  currentPeriodMonth: () => '2026-10',
}));

vi.mock('@/lib/policy-freeze', () => ({
  getPolicyFreezeStatus: vi.fn(),
  getBatchPolicyFreezeStatus: vi.fn(),
  isPolicyFrozen: vi.fn(),
}));

vi.mock('@/lib/usage', () => ({
  checkUsageLimit: vi.fn(),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/team-permissions', () => ({
  checkTeamPermission: vi.fn(),
  TeamPermission: {
    POLICY_EXECUTE: 'policy.execute',
  },
}));

vi.mock('@/services/policy/cnl-executor', () => ({
  executePolicyUnified: vi.fn(),
  getPrimaryError: vi.fn(),
  // 回放地基（ADR 0030）：execute route 用 detectCNLLocale(policy.content) 填 Execution.locale。
  // mock 返回默认 locale（测试不断言 locale 值，只需 mock 提供该导出避免 mocker 抛缺失）。
  detectCNLLocale: vi.fn(() => 'en-US'),
  // 审计决策派生（execute route 写 executions.decision 用）。测试里从执行结果派生。
  deriveExecutionDecision: vi.fn((r: {
    allowed?: boolean;
    metadata?: { engineError?: boolean; decision?: string; outcome?: string };
  }) =>
    r?.metadata?.engineError
      ? 'error'
      : r?.metadata?.decision === 'indeterminate'
        ? 'indeterminate'
        : r?.metadata?.outcome === 'REQUIRE_APPROVAL'
          ? 'require_approval'
          : r?.allowed
            ? 'approved'
            : 'denied'),
  // 证据 outcome 派生（ADR 0041 §4）：测试里直接取 metadata.outcome，缺省按 allowed。
  deriveExecutionOutcome: vi.fn((r: { allowed?: boolean; metadata?: { outcome?: string } }) =>
    r?.metadata?.outcome ?? (r?.allowed ? 'ALLOW' : 'DENY')),
}));

// guard 登记（ADR 0042 §5.1）由 policies-execute-guard.test.ts 覆盖；此处只替身其依赖。
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: vi.fn().mockResolvedValue({
    guardFromEvidence: vi.fn().mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'PENDING' } }),
  }),
}));
vi.mock('@/lib/guard-notifications', () => ({ notifyApprovalRequested: vi.fn().mockResolvedValue(undefined) }));

// Mock opennextjs cloudflare to avoid dynamic import issues
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn().mockRejectedValue(new Error('Not cloudflare')),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policyVersions: { findMany: vi.fn().mockResolvedValue([]) },
      policies: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
      users: {
        findFirst: vi.fn(),
      },
      teamMembers: {
        findMany: vi.fn(),
      },
    },
    insert: mockInsert,
    execute: mockDbExecute,
    select: mockDbSelect,
  },
  policies: { id: {}, userId: {}, deletedAt: {}, updatedAt: {} },
  policyVersions: { policyId: {} },
  executions: { policyId: {}, userId: {} },
  users: { id: {}, plan: {}, trialEndsAt: {} },
  teamMembers: { userId: {}, teamId: {} },
  usageRecords: { userId: {}, type: {}, period: {}, count: {} },
}));

import { GET } from '@/app/api/v1/policies/route';
import { POST } from '@/app/api/v1/policies/[id]/execute/route';
import { authenticateApiRequest } from '@/lib/api-keys';
import { db } from '@/lib/prisma';
import { getPolicyFreezeStatus, getBatchPolicyFreezeStatus } from '@/lib/policy-freeze';
import { checkUsageLimit } from '@/lib/usage';
import { executePolicyUnified, getPrimaryError } from '@/services/policy/cnl-executor';
import { checkTeamPermission } from '@/lib/team-permissions';
import { computeSourceEnvelope } from '@/lib/policy-alias';

const mockAuthenticateApiRequest = vi.mocked(authenticateApiRequest);
const mockGetPolicyFreezeStatus = vi.mocked(getPolicyFreezeStatus);
const mockGetBatchPolicyFreezeStatus = vi.mocked(getBatchPolicyFreezeStatus);
const mockCheckUsageLimit = vi.mocked(checkUsageLimit);
const mockExecutePolicyUnified = vi.mocked(executePolicyUnified);
const mockGetPrimaryError = vi.mocked(getPrimaryError);
const mockCheckTeamPermission = vi.mocked(checkTeamPermission);

/** 构建完整的 Policy mock 对象，所有字段均有合理默认值 */
function mockPolicy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: 'user-1',
    teamId: null,
    groupId: null,
    name: 'Test Policy',
    description: null,
    content: 'Module X. Rule greet given name: has name.',
    version: 1,
    isPublic: false,
    shareSlug: null,
    piiFields: null,
    deletedAt: null,
    deletedBy: null,
    deleteReason: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-02'),
    ...overrides,
  };
}

/** 构建完整的 PolicyExecutionResult mock 对象 */
function mockExecutionResult(overrides: Partial<{
  allowed: boolean;
  approved: boolean;
  matchedRules: string[];
  deniedReasons: string[];
  metadata: Record<string, unknown>;
}> = {}) {
  const allowed = overrides.allowed ?? true;
  return {
    allowed,
    approved: overrides.approved ?? allowed,
    matchedRules: overrides.matchedRules ?? [],
    deniedReasons: overrides.deniedReasons ?? [],
    metadata: {
      evaluatedAt: new Date().toISOString(),
      policyId: 'p1',
      policyName: 'Test Policy',
      ruleCount: 1,
      matchedRuleCount: 0,
      denyCount: 0,
      engine: 'aster-cnl' as const,
      ...(overrides.metadata ?? {}),
    },
  };
}

const VALID_AUTH = { success: true as const, userId: 'user-1', apiKeyId: 'key-1', teamId: null, quotaOwnerId: 'user-1' };

function makeRequest(url: string, method = 'GET', body?: unknown): Request {
  return new Request(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'content-type': 'application/json' } : undefined,
  });
}

// Setup db.select for execution count queries
function setupSelectCount(count: number) {
  const where = vi.fn().mockResolvedValue([{ count }]);
  const from = vi.fn().mockReturnValue({ where });
  mockDbSelect.mockReturnValue({ from });
}

describe('V1 Policies API - Drizzle Migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticateApiRequest.mockResolvedValue(VALID_AUTH);
    mockCheckUsageLimit.mockResolvedValue({ allowed: true, limit: 5000, remaining: 4999 });
    mockGetPolicyFreezeStatus.mockResolvedValue({
      limit: 25,
      totalPolicies: 1,
      frozenCount: 0,
      frozenPolicyIds: new Set(),
    });
    mockGetBatchPolicyFreezeStatus.mockResolvedValue(new Map());
    // Default: no team memberships
    vi.mocked(db.query.teamMembers.findMany).mockResolvedValue([]);
    // Default: empty execution count
    setupSelectCount(0);
  });

  describe('GET /api/v1/policies', () => {
    it('should return 401 when API key authentication fails', async () => {
      mockAuthenticateApiRequest.mockResolvedValue({
        success: false as const,
        error: 'Invalid API key',
        status: 401,
      });

      const response = await GET(makeRequest('http://localhost/api/v1/policies'));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid API key');
    });

    it('should return 429 with upgrade contract when API call limit is exceeded', async () => {
      mockCheckUsageLimit.mockResolvedValue({
        allowed: false,
        limit: 1000,
        remaining: 0,
        message: "You've reached your monthly limit of 1000 api_calls.",
      });

      const response = await GET(makeRequest('http://localhost/api/v1/policies'));
      const body = await response.json();

      // F3 v1.1：保留 429 状态码（与现有客户端行为一致），body 改用 upgradeResponse 统一格式
      expect(response.status).toBe(429);
      expect(body.upgrade).toBe(true);
      expect(body.reason).toBe('evaluations');
      expect(body.recommendedPlan).toBe('pro');
      expect(typeof body.message).toBe('string');
    });

    it('should return own policies list with freeze status', async () => {
      const mockPolicies = [
        mockPolicy({ name: 'My Policy' }),
      ];
      vi.mocked(db.query.policies.findMany).mockResolvedValue(mockPolicies);

      const response = await GET(makeRequest('http://localhost/api/v1/policies'));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.policies).toHaveLength(1);
      expect(body.policies[0].id).toBe('p1');
      expect(body.policies[0].source).toBe('own');
      expect(body.meta.total).toBe(1);
    });

    it('should include frozen policies marked as isFrozen=true', async () => {
      const mockPolicies = [
        mockPolicy({ id: 'p1', name: 'Active Policy' }),
        mockPolicy({ id: 'p2', name: 'Frozen Policy' }),
      ];
      vi.mocked(db.query.policies.findMany).mockResolvedValue(mockPolicies);
      mockGetPolicyFreezeStatus.mockResolvedValue({
        limit: 1,
        totalPolicies: 2,
        frozenCount: 1,
        frozenPolicyIds: new Set(['p2']),
      });

      const response = await GET(makeRequest('http://localhost/api/v1/policies'));
      const body = await response.json();

      const p1 = body.policies.find((p: { id: string }) => p.id === 'p1');
      const p2 = body.policies.find((p: { id: string }) => p.id === 'p2');
      expect(p1.isFrozen).toBe(false);
      expect(p2.isFrozen).toBe(true);
    });

    it('should return 500 on internal error', async () => {
      vi.mocked(db.query.policies.findMany).mockRejectedValue(new Error('DB error'));

      const response = await GET(makeRequest('http://localhost/api/v1/policies'));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });

    it('should include meta with total and freeze info', async () => {
      vi.mocked(db.query.policies.findMany).mockResolvedValue([]);
      mockGetPolicyFreezeStatus.mockResolvedValue({
        limit: 25,
        totalPolicies: 0,
        frozenCount: 0,
        frozenPolicyIds: new Set(),
      });

      const response = await GET(makeRequest('http://localhost/api/v1/policies'));
      const body = await response.json();

      expect(body.meta.total).toBe(0);
      expect(body.meta.limit).toBe(25);
      expect(body.meta.frozenCount).toBe(0);
      expect(body.meta.timestamp).toBeDefined();
    });
  });

  describe('POST /api/v1/policies/:id/execute', () => {
    const mockParams = { params: Promise.resolve({ id: 'p1' }) };
    const validBody = { input: { name: 'Alice', age: 30 } };

    // Mock unified SQL execute result
    function setupExecuteRow(overrides: Record<string, unknown> = {}) {
      const defaultRow = {
        policy_id: 'p1',
        policy_name: 'Test Policy',
        policy_content: 'Module X. Rule greet given name: has name.',
        policy_user_id: 'user-1',
        policy_team_id: null,
        policy_is_public: false,
        user_plan: 'pro',
        user_trial_ends_at: null,
        api_usage_count: 0,
        exec_usage_count: 0,
        is_team_member: false,
        ...overrides,
      };
      mockDbExecute.mockResolvedValue([defaultRow]);
    }

    beforeEach(() => {
      setupExecuteRow();
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult());
      mockGetPrimaryError.mockReturnValue(undefined);
      // Default successful insert chain
      mockOnConflictDoUpdate.mockResolvedValue(undefined);
      mockValuesInsert.mockReturnValue({
        onConflictDoUpdate: mockOnConflictDoUpdate,
        returning: vi.fn().mockResolvedValue([{}]),
      });
      mockInsert.mockReturnValue({ values: mockValuesInsert });
    });

    it('should return 401 when API key is invalid', async () => {
      mockAuthenticateApiRequest.mockResolvedValue({
        success: false as const,
        error: 'Invalid API key',
        status: 401,
      });

      const response = await POST(makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody), mockParams);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Invalid API key');
    });

    it('should return 400 when input is missing or not an object', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', { notInput: true }),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Input');
    });

    it('should return 404 when policy is not found', async () => {
      mockDbExecute.mockResolvedValue([]); // no rows

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Policy not found');
    });

    it('should return 404 when user has no access to private policy', async () => {
      setupExecuteRow({
        policy_user_id: 'other-user',
        policy_is_public: false,
        is_team_member: false,
      });

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const _body = await response.json();

      expect(response.status).toBe(404);
    });

    it('should return 429 with upgrade contract when API call limit is exceeded', async () => {
      // pro plan apiCalls=5000：按 owner 池（apiCallRecords）计，已到上限
      mockCountOwnerPoolUsage.mockResolvedValueOnce(5000);

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      // F3 v1.1：upgradeResponse('evaluations') 统一格式
      expect(response.status).toBe(429);
      expect(body.upgrade).toBe(true);
      expect(body.reason).toBe('evaluations');
      expect(body.recommendedPlan).toBe('pro');
      expect(body.usage).toBeGreaterThanOrEqual(5000);
      expect(body.limit).toBe(5000);
    });

    it('API 配额按 key 的配额 owner 池计数，cloud REST 与直连 aster-api 共用一个池', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );

      expect(response.status).toBe(200);
      expect(mockCountOwnerPoolUsage).toHaveBeenCalledWith('user-1', '2026-10');
    });

    it('团队 key：按团队 owner 的套餐与池判定，owner 池已满即 429', async () => {
      mockAuthenticateApiRequest.mockResolvedValue({ ...VALID_AUTH, teamId: 'team-1', quotaOwnerId: 'owner-1' });
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ plan: 'pro', trialEndsAt: null } as never);
      vi.mocked(db.query.policies.findMany).mockResolvedValue([{ id: 'p1' }] as never);
      setupExecuteRow({ user_plan: 'free' }); // 成员本人是 free，不影响团队 key 的 API 配额
      mockCountOwnerPoolUsage.mockResolvedValueOnce(5000);

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(mockCountOwnerPoolUsage).toHaveBeenCalledWith('owner-1', '2026-10');
      expect(response.status).toBe(429);
      expect(body.limit).toBe(5000);
      expect(mockExecutePolicyUnified).not.toHaveBeenCalled();
    });

    it('成功执行写一行 apiCallRecords（带 quotaOwnerId），使计费页与告警看到 cloud REST 调用', async () => {
      mockAuthenticateApiRequest.mockResolvedValue({ ...VALID_AUTH, teamId: 'team-1', quotaOwnerId: 'owner-1' });
      vi.mocked(db.query.users.findFirst).mockResolvedValue({ plan: 'pro', trialEndsAt: null } as never);
      vi.mocked(db.query.policies.findMany).mockResolvedValue([{ id: 'p1' }] as never);

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      await new Promise((r) => setTimeout(r, 0));

      expect(response.status).toBe(200);
      expect(mockRecordApiCallRecord).toHaveBeenCalledTimes(1);
      expect(mockRecordApiCallRecord).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        apiKeyId: 'key-1',
        quotaOwnerId: 'owner-1',
        endpointPath: '/api/v1/policies/{id}/execute',
        status: 'success',
      }), expect.any(Date));
    });

    it('引擎失败记 api_error（不计入配额池的 success 计数）', async () => {
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult({
        allowed: false,
        metadata: { engineError: true },
      }));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await POST(makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody), mockParams);
      await new Promise((r) => setTimeout(r, 0));

      expect(mockRecordApiCallRecord).toHaveBeenCalledWith(expect.objectContaining({ status: 'api_error' }), expect.any(Date));
    });

    it('API 配额已满时不执行也不记 apiCallRecords', async () => {
      mockCountOwnerPoolUsage.mockResolvedValueOnce(5000);
      await POST(makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody), mockParams);
      expect(mockRecordApiCallRecord).not.toHaveBeenCalled();
    });

    it('should return 429 with upgrade contract when execution limit is exceeded', async () => {
      // PM v1.1: pro plan evaluations=50_000
      setupExecuteRow({ exec_usage_count: 50000 });

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.upgrade).toBe(true);
      expect(body.reason).toBe('evaluations');
      expect(body.recommendedPlan).toBe('pro');
      expect(body.usage).toBeGreaterThanOrEqual(50000);
      expect(body.limit).toBe(50000);
    });

    it('should return execution result on success', async () => {
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult({ allowed: true }));
      mockGetPrimaryError.mockReturnValue(undefined);

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.decision).toBe('approved');
      expect(body.data).toBeDefined();
      expect(body.meta.policyId).toBe('p1');
      expect(body.meta.policyName).toBe('Test Policy');
      expect(body.meta.durationMs).toBeTypeOf('number');
    });

    it('#609：引擎失败原文（Java 异常）不出现在 API 响应中，带 execution_failed 码', async () => {
      const raw = 'CNL 动态执行失败: Polyglot 执行失败: java.lang.RuntimeException: 无法访问成员：alter';
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockExecutePolicyUnified.mockResolvedValue({
        ...mockExecutionResult({ allowed: false, deniedReasons: [raw], metadata: { engineError: true } }),
        diagnostics: [{ code: 'RUNTIME', message: 'java.lang.IllegalStateException: boom' }],
      } as never);
      mockGetPrimaryError.mockImplementation((r) => r.deniedReasons[0]);

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(body.errorCode).toBe('execution_failed');
      expect(JSON.stringify(body)).not.toMatch(/java\.lang|Polyglot|无法访问/);
      log.mockRestore();
    });

    it('输入缺少规则读取的字段：400 + missing_input_field + 字段路径，不记执行与 API 调用', async () => {
      mockExecutePolicyUnified.mockResolvedValue({
        ...mockExecutionResult({ allowed: false, deniedReasons: ['Input is missing field "applicant.creditScore".'] }),
        inputError: { code: 'missing_input_field', field: 'applicant.creditScore' },
      } as never);

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', { input: { applicant: { id: 'A1' } } }),
        mockParams
      );
      const body = await response.json();
      await new Promise((r) => setTimeout(r, 0));

      expect(response.status).toBe(400);
      expect(body.code).toBe('missing_input_field');
      expect(body.field).toBe('applicant.creditScore');
      expect(body.error).toContain('applicant.creditScore');
      expect(JSON.stringify(body)).not.toMatch(/execution_failed|java\.lang|Polyglot/);
      expect(mockInsert).not.toHaveBeenCalled();
      expect(mockRecordApiCallRecord).not.toHaveBeenCalled();
    });

    it('passes an optional Rule name from functionName to the policy executor', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', {
          ...validBody,
          functionName: 'evaluateLoanEligibility',
        }),
        mockParams
      );

      expect(response.status).toBe(200);
      expect(mockExecutePolicyUnified).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'evaluateLoanEligibility' }),
      );
    });

    it('rejects a malformed optional functionName before execution', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', {
          ...validBody,
          functionName: '   ',
        }),
        mockParams
      );

      expect(response.status).toBe(400);
      expect(mockExecutePolicyUnified).not.toHaveBeenCalled();
    });

    it('ADR 0041：落库 outcome/decision/ruleId/controls/evidenceCorrelationId，agent 透传并标 declared', async () => {
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult({
        allowed: false,
        metadata: { outcome: 'REQUIRE_APPROVAL', ruleId: 'CUST-DEL-001', controls: ['GDPR:ART17'], evidenceCorrelationId: 'c-1' },
      }));

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', {
          ...validBody,
          agent: { provider: 'anthropic', model: 'claude' },
        }),
        mockParams,
      );

      expect(response.status).toBe(200);
      expect(mockExecutePolicyUnified).toHaveBeenCalledWith(
        expect.objectContaining({ agent: { provider: 'anthropic', model: 'claude' } }),
      );
      expect(mockValuesInsert).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'REQUIRE_APPROVAL',
        decision: 'require_approval',
        ruleId: 'CUST-DEL-001',
        controls: ['GDPR:ART17'],
        agent: { provider: 'anthropic', model: 'claude', source: 'declared' },
        evidenceCorrelationId: 'c-1',
      }));
    });

    it('ADR 0041：未带 agent 时 agent 列写 null，执行端不收 agent', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams,
      );

      expect(response.status).toBe(200);
      expect(mockExecutePolicyUnified.mock.calls[0][0].agent).toBeUndefined();
      expect(mockValuesInsert).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'ALLOW',
        agent: null,
        ruleId: null,
        controls: null,
        evidenceCorrelationId: null,
      }));
    });

    it('ADR 0041：agent:null 视为未声明 → 200，agent 列写 null，执行端不收 agent', async () => {
      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', { ...validBody, agent: null }),
        mockParams,
      );

      expect(response.status).toBe(200);
      expect(mockExecutePolicyUnified.mock.calls[0][0].agent).toBeUndefined();
      expect(mockValuesInsert).toHaveBeenCalledWith(expect.objectContaining({ agent: null }));
    });

    it.each([
      ['非对象', 'x'],
      ['缺 model', { provider: 'anthropic' }],
      ['空 provider', { provider: '', model: 'claude' }],
      ['version 非字符串', { provider: 'anthropic', model: 'claude', version: 1 }],
      ['超长 session', { provider: 'anthropic', model: 'claude', session: 's'.repeat(256) }],
      ['数组', [{ provider: 'anthropic', model: 'claude' }]],
    ])('ADR 0041：非法 agent（%s）→ 400 Invalid agent，且零执行', async (_label, agent) => {
      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', { ...validBody, agent }),
        mockParams,
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Invalid agent' });
      expect(mockExecutePolicyUnified).not.toHaveBeenCalled();
    });

    it('C1(v1)：把活跃版本冻结的 aliasSet 透传给执行端', async () => {
      // 修复前 v1 执行入口只取 p.content 不 JOIN PolicyVersion.aliasSet → 别名策略在 v1
      // API key 路径按无别名解析，编译失败/结果错。现应 JOIN 冻结值并解析后透传。
      setupExecuteRow({
        policy_alias_set: JSON.stringify({ TIMES: ['multiplied by'] }),
      });
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult({ allowed: true }));

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams,
      );

      expect(response.status).toBe(200);
      expect(mockExecutePolicyUnified).toHaveBeenCalledWith(
        expect.objectContaining({ aliasSet: { TIMES: ['multiplied by'] } }),
      );
    });

    it('#602(v1)：按版本冻结快照加载作用域内词汇并透传给执行端', async () => {
      const refs = [{ snapshotId: 's-de', domain: 'e2e1026', locale: 'de' }];
      const vocabulary = { id: 'e2e1026', locale: 'de-DE', fields: [{ canonical: 'age', localized: 'alter' }] };
      // 带词汇执行前要按同一 locale 提取类型（#638），源码须是该 locale 下可解析的德语。
      const source = 'Modul x.\n\nDefiniere Fahrer hat alter als Ganzzahl.\n';
      setupExecuteRow({ policy_vocab_snapshot_ids: refs, policy_version: 1, policy_content: source });
      // 已审批版本走冻结快照（草稿走作者现行词汇，见 #626 用例）。
      vi.mocked(db.query.policyVersions.findMany).mockResolvedValueOnce([
        { id: 'pv-1', version: 1, status: 'APPROVED', isDefault: false, createdBy: 'user-1' },
      ] as never);
      mockLoadExecutionVocabulary.mockResolvedValueOnce(vocabulary);
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult({ allowed: true }));

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams,
      );

      expect(response.status).toBe(200);
      // locale 与 dashboard execute 同一解析器：无 envelope 时取冻结快照引用的唯一 locale。
      expect(mockLoadExecutionVocabulary).toHaveBeenCalledWith(refs, { source, locale: 'de' });
      expect(mockExecutePolicyUnified).toHaveBeenCalledWith(expect.objectContaining({ vocabulary }));
    });

    describe('#626 策略语言输入（v1 / SDK）', () => {
      const DE_SOURCE = `Modul e2e1027.vocab.

Definiere Fahrer hat alter als Ganzzahl.

Regel bewerten gegeben person als Fahrer liefert Ganzzahl:
  wenn person.alter mindestens 18:
    gib zurück 42.
  gib zurück 0.
`;
      const deVocab = {
        id: 'e2e1027', locale: 'de-DE', name: 'e2e1027', version: '1',
        structs: [{ canonical: 'Driver', localized: 'Fahrer', kind: 'struct' }],
        fields: [{ canonical: 'age', localized: 'alter', kind: 'field', parent: 'Driver' }],
        functions: [],
      };
      const approved = [{ id: 'pv-1', version: 1, status: 'APPROVED', isDefault: false, createdBy: 'author-1' }];
      const draft = [{ id: 'pv-1', version: 1, status: 'DRAFT', isDefault: false, createdBy: 'author-1' }];

      function run(input: unknown) {
        return POST(makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', { input }), mockParams);
      }

      beforeEach(() => {
        setupExecuteRow({ policy_content: DE_SOURCE, policy_version: 1, policy_vocab_snapshot_ids: [{ snapshotId: 's', domain: 'e2e1027', locale: 'de' }] });
      });

      it('本地化输入映射为规范名后交给引擎，执行记录存规范输入', async () => {
        vi.mocked(db.query.policyVersions.findMany).mockResolvedValueOnce(approved as never);
        mockLoadExecutionVocabulary.mockResolvedValueOnce(deVocab);

        const response = await run({ person: { alter: 21 } });

        expect(response.status).toBe(200);
        expect(mockExecutePolicyUnified).toHaveBeenCalledWith(expect.objectContaining({ input: { person: { age: 21 } } }));
        expect(mockValuesInsert.mock.calls[0]![0]).toMatchObject({ input: { person: { age: 21 } } });
      });

      it('规范输入仍然接受', async () => {
        vi.mocked(db.query.policyVersions.findMany).mockResolvedValueOnce(approved as never);
        mockLoadExecutionVocabulary.mockResolvedValueOnce(deVocab);

        const response = await run({ person: { age: 21 } });

        expect(response.status).toBe(200);
        expect(mockExecutePolicyUnified).toHaveBeenCalledWith(expect.objectContaining({ input: { person: { age: 21 } } }));
      });

      it('本地化键与规范键并存 → 400 ambiguous_input_field', async () => {
        vi.mocked(db.query.policyVersions.findMany).mockResolvedValueOnce(approved as never);
        mockLoadExecutionVocabulary.mockResolvedValueOnce(deVocab);

        const response = await run({ person: { alter: 21, age: 22 } });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ code: 'ambiguous_input_field', field: 'person.age' });
        expect(mockExecutePolicyUnified).not.toHaveBeenCalled();
      });

      it('locale 与 dashboard execute 同一解析器：版本记录的编译 locale 优先于源码识别', async () => {
        const envelope = computeSourceEnvelope(DE_SOURCE, null, 'en-US', 'tc-1', '');
        setupExecuteRow({
          policy_content: DE_SOURCE, policy_version: 1, policy_source_toolchain_id: 'tc-1',
          policy_vocab_snapshot_ids: [{ snapshotId: 's', domain: 'e2e1027', locale: 'de' }],
        });
        vi.mocked(db.query.policyVersions.findMany).mockResolvedValueOnce(
          [{ ...approved[0], sourceEnvelopeSha256: envelope, sourceScopesJson: '' }] as never,
        );

        await run({ person: { alter: 21 } });

        expect(mockLoadExecutionVocabulary).toHaveBeenCalledWith(expect.anything(), { source: DE_SOURCE, locale: 'en-US' });
        expect(mockExecutePolicyUnified).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en-US' }));
      });

      it('草稿用作者现行词汇映射并透传', async () => {
        vi.mocked(db.query.policyVersions.findMany).mockResolvedValueOnce(draft as never);
        mockLoadLiveVocabulary.mockResolvedValueOnce(deVocab);

        const response = await run({ person: { alter: 21 } });

        expect(response.status).toBe(200);
        // 本文件桩掉了 cnl-executor（含 locale 识别），这里只钉住「按版本作者 + 源码」取现行词汇。
        expect(mockLoadLiveVocabulary).toHaveBeenCalledWith('author-1', expect.objectContaining({ source: DE_SOURCE }));
        expect(mockLoadExecutionVocabulary).not.toHaveBeenCalled();
        expect(mockExecutePolicyUnified).toHaveBeenCalledWith(
          expect.objectContaining({ input: { person: { age: 21 } }, vocabulary: deVocab }),
        );
      });
    });

    it('C1(v1)：无别名（policy_alias_set=null）时 aliasSet 传 null', async () => {
      setupExecuteRow({ policy_alias_set: null });
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult({ allowed: true }));

      await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams,
      );

      expect(mockExecutePolicyUnified).toHaveBeenCalledWith(
        expect.objectContaining({ aliasSet: null }),
      );
    });

    it('C1(v1)：损坏的 aliasSet JSON 视为无别名，不阻塞执行', async () => {
      setupExecuteRow({ policy_alias_set: '{not valid json' });
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult({ allowed: true }));

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams,
      );

      expect(response.status).toBe(200);
      expect(mockExecutePolicyUnified).toHaveBeenCalledWith(
        expect.objectContaining({ aliasSet: null }),
      );
    });

    it('should return allowed=false with error for failed execution', async () => {
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult({ allowed: false, approved: false, deniedReasons: ['Rule failed'] }));
      mockGetPrimaryError.mockReturnValue('Rule failed');

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Rule failed');
    });

    it('should allow execution of public policy by non-owner', async () => {
      setupExecuteRow({
        policy_user_id: 'other-user',
        policy_is_public: true,
        is_team_member: false,
        policy_team_id: null,
      });
      // For non-owner check, need owner data
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'pro' }));
      vi.mocked(db.query.policies.findMany).mockResolvedValue([mockPolicy()]);
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult());
      mockGetPrimaryError.mockReturnValue(undefined);

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
    });

    it('should return 403 when team member lacks execute permission', async () => {
      setupExecuteRow({
        policy_user_id: 'other-user',
        policy_is_public: false,
        policy_team_id: 'team-1',
        is_team_member: true,
      });
      mockCheckTeamPermission.mockResolvedValue({
        allowed: false,
        error: 'Insufficient permissions',
        code: 'insufficient_team_role',
        status: 403,
      });

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Insufficient permissions');
    });

    it('should return 403 when policy is frozen (owner plan exceeded)', async () => {
      setupExecuteRow({
        policy_user_id: 'other-user',
        policy_is_public: true,
        policy_team_id: null,
        is_team_member: false,
      });
      // Owner has free plan but target policy not in active set
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'free' }));
      vi.mocked(db.query.policies.findMany).mockResolvedValue([
        mockPolicy({ id: 'p-active-1' }), mockPolicy({ id: 'p-active-2' }), mockPolicy({ id: 'p-active-3' }),
        // 'p1' is NOT in this list → frozen
      ]);

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.frozen).toBe(true);
    });

    // 回归测试：所有者执行自己的冻结策略也必须被拦截。
    // 旧实现把冻结检查放在 if(!isOwner) 内，所有者越权执行自己的冻结策略。
    it('should return 403 when OWNER executes their own frozen policy', async () => {
      // caller === owner (user-1)，所有者套餐降级到 free 后该策略超限被冻结
      setupExecuteRow({
        policy_user_id: 'user-1',
        policy_is_public: false,
        policy_team_id: null,
        is_team_member: false,
        user_plan: 'free',
      });
      vi.mocked(db.query.users.findFirst).mockResolvedValue(mockUser({ plan: 'free' }));
      vi.mocked(db.query.policies.findMany).mockResolvedValue([
        mockPolicy({ id: 'p-active-1' }), mockPolicy({ id: 'p-active-2' }), mockPolicy({ id: 'p-active-3' }),
        // 'p1' 不在活跃列表 → 冻结
      ]);
      mockExecutePolicyUnified.mockResolvedValue(mockExecutionResult());

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.frozen).toBe(true);
      // 冻结策略必须零执行：门拦截发生在调用后端执行之前
      expect(mockExecutePolicyUnified).not.toHaveBeenCalled();
    });

    it('should return 500 on internal error', async () => {
      mockDbExecute.mockRejectedValue(new Error('DB connection failed'));

      const response = await POST(
        makeRequest('http://localhost/api/v1/policies/p1/execute', 'POST', validBody),
        mockParams
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });
  });
});
