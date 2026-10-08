// 执行路由开 guard 决策（ADR 0042 §5.1/§5.3）：dashboard 与 v1 两条路由。
//
// 钉这几件事：
//   1. outcome REQUIRE_APPROVAL/ESCALATE → 执行行先以 metadata=null 落库，再以执行者身份调 from-evidence，
//      然后按执行 id 回写 metadata（决策/审批 id），并发待审批通知；
//   2. outcome ALLOW → 不调 guard，不回写 metadata；
//   3. guard 失败 → 执行照常 200 落库，回写的 metadata 只记 guardError；
//   4. 执行人不属于策略租户（公开/共享策略的外部执行人）→ not_tenant_member，不调 api、不通知。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockValuesInsert = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  return {
    mockValuesInsert,
    mockInsert: vi.fn().mockReturnValue({ values: mockValuesInsert }),
    mockUpdateSet,
    mockUpdateWhere,
    mockUpdate: vi.fn().mockReturnValue({ set: mockUpdateSet }),
    teamMemberFind: vi.fn(),
    sharingEnabled: vi.fn(),
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
  deriveExecutionDecision: vi.fn((r: { metadata?: { outcome?: string } }) => {
    if (r?.metadata?.outcome === 'REQUIRE_APPROVAL') return 'require_approval';
    return r?.metadata?.outcome === 'ESCALATE' ? 'escalate' : 'approved';
  }),
  deriveExecutionOutcome: vi.fn((r: { metadata?: { outcome?: string } }) => r?.metadata?.outcome ?? 'ALLOW'),
}));
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (...a: unknown[]) => h.createClient(...a),
}));
vi.mock('@/lib/guard-notifications', () => ({
  notifyApprovalRequested: (...a: unknown[]) => h.notifyApprovalRequested(...a),
}));
vi.mock('@/lib/platform-settings', () => ({ isPolicySharingEnabled: () => h.sharingEnabled() }));
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: vi.fn().mockRejectedValue(new Error('Not cloudflare')),
}));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn().mockResolvedValue({ plan: 'pro', trialEndsAt: null }) },
      policies: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
      teamMembers: { findFirst: (...a: unknown[]) => h.teamMemberFind(...a) },
    },
    insert: h.mockInsert,
    update: h.mockUpdate,
    execute: h.mockDbExecute,
  },
  policies: { id: {}, userId: {}, updatedAt: {} },
  executions: { id: {} },
  teamMembers: { teamId: {}, userId: {} },
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

/** 登记后回写的 metadata（未回写 → undefined）。 */
function updatedMetadata(): unknown {
  return (h.mockUpdateSet.mock.calls[0]?.[0] as { metadata?: unknown } | undefined)?.metadata;
}

const policyRow = {
  policy_id: 'p1', policy_name: 'Delete customer', policy_content: 'Module X. Rule r given x: Return true.',
  policy_alias_set: null, policy_user_id: 'user-1', policy_team_id: 'team-1', policy_is_public: false,
  policy_version_row_id: 'pv-1', policy_version: 1, policy_source_toolchain_id: null, policy_vocab_snapshot_ids: null,
  user_plan: 'pro', user_trial_ends_at: null, usage_count: 0, api_usage_count: 0, exec_usage_count: 0,
  is_team_member: true,
};

describe.each(routes)('POST $name execute — ADR 0042 guard 登记', ({ post, path }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.mockInsert.mockReturnValue({ values: h.mockValuesInsert });
    h.mockUpdate.mockReturnValue({ set: h.mockUpdateSet });
    h.mockUpdateSet.mockReturnValue({ where: h.mockUpdateWhere });
    h.mockUpdateWhere.mockResolvedValue(undefined);
    h.teamMemberFind.mockResolvedValue({ id: 'tm-1' });
    h.sharingEnabled.mockResolvedValue(true);
    h.mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    h.mockAuthApi.mockResolvedValue({ success: true, userId: 'user-1', apiKeyId: 'k1' });
    h.createClient.mockResolvedValue({ guardFromEvidence: h.guardFromEvidence });
    h.mockDbExecute.mockResolvedValue([policyRow]);
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
    // 执行行先以 metadata=null 落库，登记结果按执行 id 回写
    expect(insertedValues()).toEqual(expect.objectContaining({ decision: 'require_approval', metadata: null }));
    expect(h.mockInsert.mock.invocationCallOrder[0]).toBeLessThan(h.guardFromEvidence.mock.invocationCallOrder[0]);
    expect(h.guardFromEvidence.mock.invocationCallOrder[0]).toBeLessThan(h.mockUpdate.mock.invocationCallOrder[0]);
    expect(updatedMetadata()).toEqual({ guardDecisionId: 'd1', guardApprovalId: 'a1' });
    expect(h.mockUpdateWhere).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.notifyApprovalRequested).toHaveBeenCalled());
    expect(h.notifyApprovalRequested).toHaveBeenCalledWith('user-1', expect.objectContaining({
      tenantId: 'team-1', decisionId: 'd1', approvalId: 'a1', policyId: 'p1', policyName: 'Delete customer',
      requiredRole: 'DPO',
    }));
  });

  it('ALLOW：不调 guard，metadata 不含 guard 键', async () => {
    h.mockExecute.mockResolvedValue({ ...execResult({ evidenceCorrelationId: 'c-2' }), allowed: true, approved: true });

    const res = await post(request(path, { input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.guardFromEvidence).not.toHaveBeenCalled();
    expect(insertedValues().metadata).toBeNull();
    expect(h.mockUpdate).not.toHaveBeenCalled();
    expect(h.notifyApprovalRequested).not.toHaveBeenCalled();
  });

  it('guard 409：执行照常 200 落库，metadata 记 guardError', async () => {
    h.mockExecute.mockResolvedValue(execResult({ outcome: 'REQUIRE_APPROVAL', evidenceCorrelationId: 'c-1' }));
    h.guardFromEvidence.mockRejectedValue(new PolicyApiError('conflict', 409, 'evidence_not_approvable'));

    const res = await post(request(path, { input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(insertedValues().metadata).toBeNull();
    expect(updatedMetadata()).toEqual({ guardError: 'evidence_not_approvable' });
    expect(h.notifyApprovalRequested).not.toHaveBeenCalled();
  });

  it('无证据关联 id：不装配客户端，metadata 记 no_evidence', async () => {
    h.mockExecute.mockResolvedValue(execResult({ outcome: 'REQUIRE_APPROVAL' }));

    const res = await post(request(path, { input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(h.createClient).not.toHaveBeenCalled();
    expect(updatedMetadata()).toEqual({ guardError: 'no_evidence' });
  });

  it('ESCALATE：同样开决策（requiredRole=null 时通知全员由通知模块处理）', async () => {
    h.mockExecute.mockResolvedValue(execResult({ outcome: 'ESCALATE', evidenceCorrelationId: 'c-3' }));
    h.guardFromEvidence.mockResolvedValue({ decisionId: 'd3', approval: { id: 'a3', status: 'PENDING' } });

    const res = await post(request(path, { input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(insertedValues().decision).toBe('escalate');
    expect(h.guardFromEvidence).toHaveBeenCalledWith(expect.objectContaining({ correlationId: 'c-3' }));
    expect(updatedMetadata()).toEqual({ guardDecisionId: 'd3', guardApprovalId: 'a3' });
    await vi.waitFor(() => expect(h.notifyApprovalRequested).toHaveBeenCalled());
    expect(h.notifyApprovalRequested.mock.calls[0][1].requiredRole).toBeNull();
  });

  it('公开个人策略的外部执行人 → not_tenant_member：执行照常落库，不调 api、不通知', async () => {
    h.mockDbExecute.mockResolvedValue([{
      ...policyRow, policy_user_id: 'owner-1', policy_team_id: null, policy_is_public: true, is_team_member: false,
    }]);
    h.mockExecute.mockResolvedValue(execResult({ outcome: 'REQUIRE_APPROVAL', evidenceCorrelationId: 'c-1' }));

    const res = await post(request(path, { input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(insertedValues().metadata).toBeNull();
    expect(updatedMetadata()).toEqual({ guardError: 'not_tenant_member' });
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.guardFromEvidence).not.toHaveBeenCalled();
    expect(h.notifyApprovalRequested).not.toHaveBeenCalled();
  });

  it('执行行插入失败 → 不登记 guard，响应仍 200', async () => {
    h.mockValuesInsert.mockReturnValueOnce(Promise.reject(new Error('insert failed')));
    h.mockExecute.mockResolvedValue(execResult({ outcome: 'REQUIRE_APPROVAL', evidenceCorrelationId: 'c-1' }));

    const res = await post(request(path, { input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(h.guardFromEvidence).not.toHaveBeenCalled();
    expect(h.mockUpdate).not.toHaveBeenCalled();
  });
});

describe('POST dashboard execute — 共享策略的租户外执行人', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.mockInsert.mockReturnValue({ values: h.mockValuesInsert });
    h.mockUpdate.mockReturnValue({ set: h.mockUpdateSet });
    h.mockUpdateSet.mockReturnValue({ where: h.mockUpdateWhere });
    h.mockGetSession.mockResolvedValue({ user: { id: 'user-1' } });
    h.sharingEnabled.mockResolvedValue(true);
    h.createClient.mockResolvedValue({ guardFromEvidence: h.guardFromEvidence });
  });

  it('个人策略经 PolicyShare 共享给执行人所在团队 → 可执行，但不在所有者租户开审批', async () => {
    h.mockDbExecute
      .mockResolvedValueOnce([{
        ...policyRow, policy_user_id: 'owner-1', policy_team_id: null, policy_is_public: false, is_team_member: false,
      }])
      .mockResolvedValueOnce([{ permission: 'execute' }]);
    h.mockExecute.mockResolvedValue(execResult({ outcome: 'REQUIRE_APPROVAL', evidenceCorrelationId: 'c-1' }));

    const res = await dashboardPost(request('/api/policies/p1/execute', { input: { a: 1 } }), params);

    expect(res.status).toBe(200);
    expect(h.mockDbExecute).toHaveBeenCalledTimes(2);
    expect(updatedMetadata()).toEqual({ guardError: 'not_tenant_member' });
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.guardFromEvidence).not.toHaveBeenCalled();
    expect(h.notifyApprovalRequested).not.toHaveBeenCalled();
  });
});

describe('POST v1 execute — 策略所有者 ≠ key 持有者', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.mockInsert.mockReturnValue({ values: h.mockValuesInsert });
    h.mockUpdate.mockReturnValue({ set: h.mockUpdateSet });
    h.mockUpdateSet.mockReturnValue({ where: h.mockUpdateWhere });
    h.mockAuthApi.mockResolvedValue({ success: true, userId: 'user-1', apiKeyId: 'k1' });
    h.teamMemberFind.mockResolvedValue({ id: 'tm-1' });
    h.createClient.mockResolvedValue({ guardFromEvidence: h.guardFromEvidence });
    h.mockDbExecute.mockResolvedValue([{ ...policyRow, policy_user_id: 'owner-1', policy_team_id: 'team-1' }]);
  });

  it('以 key 持有者（非策略所有者）为请求人与 principal', async () => {
    h.mockExecute.mockResolvedValue(execResult({ outcome: 'REQUIRE_APPROVAL', evidenceCorrelationId: 'c-1' }));
    h.guardFromEvidence.mockResolvedValue({ decisionId: 'd1' });

    const res = await v1Post(request('/api/v1/policies/p1/execute', { input: { principal_id: 'owner-1' } }), params);

    expect(res.status).toBe(200);
    expect(h.createClient).toHaveBeenCalledWith('team-1', 'user-1');
    const action = h.guardFromEvidence.mock.calls[0][0].action;
    expect(action.principal.id).toBe('user-1');
    expect(action.context).toEqual({ principal_id: 'owner-1' });
    expect(updatedMetadata()).toEqual({ guardDecisionId: 'd1' });
  });
});
