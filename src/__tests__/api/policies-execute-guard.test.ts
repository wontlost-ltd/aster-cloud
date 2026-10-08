// 执行路由开 guard 决策（ADR 0042 §5.1/§5.3）：dashboard 与 v1 两条路由。
//
// 钉三件事：
//   1. outcome REQUIRE_APPROVAL → 以执行者身份调 from-evidence，执行行 metadata 记决策/审批 id，并发待审批通知；
//   2. outcome ALLOW → 不调 guard，metadata 不含 guard 键；
//   3. guard 失败 → 执行照常 200 落库，metadata 只记 guardError。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValuesInsert = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  return {
    mockValuesInsert,
    mockInsert: vi.fn().mockReturnValue({ values: mockValuesInsert }),
    mockDbExecute: vi.fn(),
    mockGetSession: vi.fn(),
    mockAuthApi: vi.fn(),
    mockExecute: vi.fn(),
    guardFromEvidence: vi.fn(),
    createClient: vi.fn(),
    notifyApprovalRequested: vi.fn(),
  };
});

vi.mock('@/lib/auth', () => ({ getSession: () => h.mockGetSession() }));
vi.mock('@/lib/api-keys', () => ({ authenticateApiRequest: (r: Request) => h.mockAuthApi(r) }));
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
  executePolicyUnified: (o: unknown) => h.mockExecute(o),
  getPrimaryError: vi.fn(() => undefined),
  detectCNLLocale: vi.fn(() => 'en-US'),
  deriveExecutionDecision: vi.fn((r: { metadata?: { outcome?: string } }) =>
    r?.metadata?.outcome === 'REQUIRE_APPROVAL' ? 'require_approval' : 'approved'),
  deriveExecutionOutcome: vi.fn((r: { metadata?: { outcome?: string } }) => r?.metadata?.outcome ?? 'ALLOW'),
}));
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (...a: unknown[]) => h.createClient(...a),
}));
vi.mock('@/lib/guard-notifications', () => ({
  notifyApprovalRequested: (...a: unknown[]) => h.notifyApprovalRequested(...a),
}));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn().mockRejectedValue(new Error('Not cloudflare')),
}));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn().mockResolvedValue({ plan: 'pro', trialEndsAt: null }) },
      policies: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
    },
    insert: h.mockInsert,
    execute: h.mockDbExecute,
  },
  policies: { id: {}, userId: {}, updatedAt: {} },
  executions: { id: {} },
  users: { id: {} },
  usageRecords: { userId: {}, type: {}, period: {}, count: {} },
}));

import { POST as dashboardPost } from '@/app/api/policies/[id]/execute/route';
import { POST as v1Post } from '@/app/api/v1/policies/[id]/execute/route';
import { PolicyApiError } from '@/services/policy/policy-api';

function execResult(metadata: Record<string, unknown>) {
  return {
    allowed: false, approved: false, matchedRules: [], deniedReasons: [], executedFunction: 'deleteCustomer',
    metadata: {
      evaluatedAt: '2026-10-09T00:00:00Z', policyId: 'p1', policyName: 'P',
      ruleCount: 1, matchedRuleCount: 0, denyCount: 0, engine: 'aster-cnl', ...metadata,
    },
  };
}

function request(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

const params = { params: Promise.resolve({ id: 'p1' }) };
const routes = [
  { name: 'dashboard', post: dashboardPost, path: '/api/policies/p1/execute' },
  { name: 'v1', post: v1Post, path: '/api/v1/policies/p1/execute' },
] as const;

function insertedValues(): Record<string, unknown> {
  return h.mockValuesInsert.mock.calls[0][0] as Record<string, unknown>;
}

describe.each(routes)('POST $name execute — ADR 0042 guard 登记', ({ post, path }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.mockInsert.mockReturnValue({ values: h.mockValuesInsert });
    h.mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    h.mockAuthApi.mockResolvedValue({ success: true, userId: 'user-1', apiKeyId: 'k1' });
    h.createClient.mockResolvedValue({ guardFromEvidence: h.guardFromEvidence });
    h.mockDbExecute.mockResolvedValue([{
      policy_id: 'p1', policy_name: 'Delete customer', policy_content: 'Module X. Rule r given x: Return true.',
      policy_alias_set: null, policy_user_id: 'user-1', policy_team_id: 'team-1', policy_is_public: false,
      policy_version_row_id: 'pv-1', policy_version: 1, policy_source_toolchain_id: null, policy_vocab_snapshot_ids: null,
      user_plan: 'pro', user_trial_ends_at: null, usage_count: 0, api_usage_count: 0, exec_usage_count: 0,
      is_team_member: true,
    }]);
  });

  it('REQUIRE_APPROVAL：以执行者在策略租户的身份开决策，metadata 记 id，并发待审批通知', async () => {
    h.mockExecute.mockResolvedValue(execResult({ outcome: 'REQUIRE_APPROVAL', evidenceCorrelationId: 'c-1' }));
    h.guardFromEvidence.mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'PENDING', requiredRole: 'DPO' } });

    const res = await post(request(path, { input: { action: 'customer.delete' } }), params);

    expect(res.status).toBe(200);
    expect(h.createClient).toHaveBeenCalledWith('team-1', 'user-1');
    expect(h.guardFromEvidence).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: 'c-1',
      action: expect.objectContaining({ action: { name: 'customer.delete' }, principal: expect.objectContaining({ id: 'user-1' }) }),
    }));
    expect(insertedValues()).toEqual(expect.objectContaining({
      decision: 'require_approval',
      metadata: { guardDecisionId: 'd1', guardApprovalId: 'a1' },
    }));
    expect(h.notifyApprovalRequested).toHaveBeenCalledWith('team-1', expect.objectContaining({
      decisionId: 'd1', approvalId: 'a1', policyId: 'p1', policyName: 'Delete customer', requiredRole: 'DPO',
    }));
  });

  it('ALLOW：不调 guard，metadata 不含 guard 键', async () => {
    h.mockExecute.mockResolvedValue({ ...execResult({ evidenceCorrelationId: 'c-2' }), allowed: true, approved: true });

    const res = await post(request(path, { input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.guardFromEvidence).not.toHaveBeenCalled();
    expect(insertedValues().metadata).toBeNull();
    expect(h.notifyApprovalRequested).not.toHaveBeenCalled();
  });

  it('guard 409：执行照常 200 落库，metadata 记 guardError', async () => {
    h.mockExecute.mockResolvedValue(execResult({ outcome: 'REQUIRE_APPROVAL', evidenceCorrelationId: 'c-1' }));
    h.guardFromEvidence.mockRejectedValue(new PolicyApiError('conflict', 409, 'evidence_not_approvable'));

    const res = await post(request(path, { input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(insertedValues().metadata).toEqual({ guardError: 'evidence_not_approvable' });
    expect(h.notifyApprovalRequested).not.toHaveBeenCalled();
  });

  it('无证据关联 id：不装配客户端，metadata 记 no_evidence', async () => {
    h.mockExecute.mockResolvedValue(execResult({ outcome: 'REQUIRE_APPROVAL' }));

    const res = await post(request(path, { input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(insertedValues().metadata).toEqual({ guardError: 'no_evidence' });
  });
});
