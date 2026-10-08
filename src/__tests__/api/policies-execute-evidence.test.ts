// dashboard 执行路由（/api/policies/[id]/execute）证据列落库测试（ADR 0041 §4）。
//
// 钉两件事：
//   1. 执行端收到固定 dashboard agent（aster-cloud/dashboard），落库 agent 加 source:'declared'；
//   2. Execution 行写入 outcome/decision 五态/ruleId/controls/evidenceCorrelationId。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockValuesInsert, mockInsert, mockDbExecute, mockGetSession, mockExecute } = vi.hoisted(() => {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValuesInsert = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  return {
    mockValuesInsert,
    mockInsert: vi.fn().mockReturnValue({ values: mockValuesInsert }),
    mockDbExecute: vi.fn(),
    mockGetSession: vi.fn(),
    mockExecute: vi.fn(),
  };
});

vi.mock('@/lib/auth', () => ({ getSession: () => mockGetSession() }));

vi.mock('@/lib/cache', () => ({
  getCachedPolicyMeta: vi.fn().mockResolvedValue(null),
  cachePolicyMeta: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/team-permissions', () => ({
  checkTeamPermission: vi.fn().mockResolvedValue({ allowed: true }),
  TeamPermission: { POLICY_EXECUTE: 'policy.execute' },
}));

vi.mock('@/services/policy/runner-parity-from-execution', () => ({
  maybeRunParityForExecution: vi.fn().mockResolvedValue(null),
  RUNNER_LAUNCHER_HMAC_ROLE: 'runner-launcher',
}));

vi.mock('@/services/policy/cnl-executor', () => ({
  executePolicyUnified: (o: unknown) => mockExecute(o),
  getPrimaryError: vi.fn(() => undefined),
  detectCNLLocale: vi.fn(() => 'en-US'),
  deriveExecutionDecision: vi.fn((r: { metadata?: { outcome?: string } }) =>
    r?.metadata?.outcome === 'REQUIRE_APPROVAL' ? 'require_approval' : 'approved'),
  deriveExecutionOutcome: vi.fn((r: { metadata?: { outcome?: string } }) => r?.metadata?.outcome ?? 'ALLOW'),
}));

// guard 登记（ADR 0042 §5.1）不在本文件断言范围：装配客户端与通知均替身，开决策走成功路径。
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: vi.fn().mockResolvedValue({
    guardFromEvidence: vi.fn().mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'PENDING' } }),
  }),
}));
vi.mock('@/lib/guard-notifications', () => ({ notifyApprovalRequested: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn().mockRejectedValue(new Error('Not cloudflare')),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
      policies: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
    },
    insert: mockInsert,
    execute: mockDbExecute,
  },
  policies: { id: {}, userId: {}, updatedAt: {} },
  executions: { id: {} },
  users: { id: {} },
  usageRecords: { userId: {}, type: {}, period: {}, count: {} },
}));

import { POST } from '@/app/api/policies/[id]/execute/route';
import { executions } from '@/lib/prisma';

function execResult(metadata: Record<string, unknown>) {
  return {
    allowed: false,
    approved: false,
    matchedRules: [],
    deniedReasons: [],
    metadata: {
      evaluatedAt: '2026-10-08T00:00:00Z', policyId: 'p1', policyName: 'P',
      ruleCount: 1, matchedRuleCount: 0, denyCount: 0, engine: 'aster-cnl', ...metadata,
    },
  };
}

function request(body: unknown): Request {
  return new Request('http://localhost/api/policies/p1/execute', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const params = { params: Promise.resolve({ id: 'p1' }) };

describe('POST /api/policies/[id]/execute — ADR 0041 证据列', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValuesInsert });
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    mockDbExecute.mockResolvedValue([{
      policy_id: 'p1', policy_name: 'P', policy_content: 'Module X. Rule r given x: Return true.',
      policy_alias_set: null, policy_user_id: 'user-1', policy_team_id: null, policy_is_public: false,
      policy_version_row_id: 'pv-1', policy_version: 1, policy_source_toolchain_id: null, policy_vocab_snapshot_ids: null,
      user_plan: 'pro', user_trial_ends_at: null, usage_count: 0, is_team_member: false,
    }]);
  });

  it('REQUIRE_APPROVAL：落库五态 decision + outcome/ruleId/controls/evidenceCorrelationId + dashboard agent', async () => {
    mockExecute.mockResolvedValue(execResult({
      outcome: 'REQUIRE_APPROVAL', ruleId: 'CUST-DEL-001', controls: ['GDPR:ART17'], evidenceCorrelationId: 'c-1',
    }));

    const res = await POST(request({ input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      agent: { provider: 'aster-cloud', model: 'dashboard' },
    }));
    expect(mockInsert).toHaveBeenCalledWith(executions);
    expect(mockValuesInsert).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'REQUIRE_APPROVAL',
      decision: 'require_approval',
      ruleId: 'CUST-DEL-001',
      controls: ['GDPR:ART17'],
      agent: { provider: 'aster-cloud', model: 'dashboard', source: 'declared' },
      evidenceCorrelationId: 'c-1',
      source: 'dashboard',
    }));
  });

  it('响应无证据字段：证据列写 null，outcome 仍按派生值写', async () => {
    mockExecute.mockResolvedValue(execResult({}));

    const res = await POST(request({ input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(mockValuesInsert).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'ALLOW',
      ruleId: null,
      controls: null,
      evidenceCorrelationId: null,
      agent: { provider: 'aster-cloud', model: 'dashboard', source: 'declared' },
    }));
  });
});
