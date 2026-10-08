// @vitest-environment node
// 执行结果 → guard 决策登记（ADR 0042 §5.1）：成功记决策/审批 id、失败记错误码、无证据不调 api、动作映射。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { notifyApprovalRequested } = vi.hoisted(() => ({ notifyApprovalRequested: vi.fn() }));
vi.mock('@/lib/guard-notifications', () => ({ notifyApprovalRequested }));

import { registerGuardDecision, registerGuardDecisionWith, toGuardAction } from '@/lib/guard-register';
import { PolicyApiError, type PolicyApiClient } from '@/services/policy/policy-api';
import type { PolicyExecutionResult } from '@/services/policy/cnl-executor';

const guardFromEvidence = vi.fn();
const client = { guardFromEvidence } as unknown as PolicyApiClient;
const policy = { id: 'p1', name: 'Delete customer', teamId: 'team-1', userId: 'owner-1' };

function result(evidenceCorrelationId?: string): PolicyExecutionResult {
  return {
    allowed: false, approved: false, matchedRules: [], deniedReasons: [],
    metadata: {
      evaluatedAt: '2026-10-09T00:00:00Z', policyId: 'p1', policyName: 'P', ruleCount: 1,
      matchedRuleCount: 0, denyCount: 0, engine: 'aster-cnl', outcome: 'REQUIRE_APPROVAL',
      ...(evidenceCorrelationId ? { evidenceCorrelationId } : {}),
    },
  };
}

function args(overrides: Partial<Parameters<typeof registerGuardDecision>[0]> = {}) {
  return {
    client, policy, functionName: 'deleteCustomer', input: { a: 1 }, agent: null,
    result: result('c-1'), requesterUserId: 'user-1', ...overrides,
  };
}

describe('registerGuardDecision', () => {
  beforeEach(() => {
    guardFromEvidence.mockReset();
    notifyApprovalRequested.mockReset();
  });

  it('成功 → { guardDecisionId, guardApprovalId }，并按团队租户发待审批通知', async () => {
    guardFromEvidence.mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'PENDING', requiredRole: 'DPO' } });

    await expect(registerGuardDecision(args())).resolves.toEqual({ guardDecisionId: 'd1', guardApprovalId: 'a1' });
    expect(notifyApprovalRequested).toHaveBeenCalledWith('team-1', {
      tenantId: 'team-1', decisionId: 'd1', approvalId: 'a1', policyId: 'p1',
      policyName: 'Delete customer', requiredRole: 'DPO',
    });
  });

  it('请求只含 correlationId 与 action（不传模块名）', async () => {
    guardFromEvidence.mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'PENDING' } });

    await registerGuardDecision(args());

    const req = guardFromEvidence.mock.calls[0][0];
    expect(Object.keys(req).sort()).toEqual(['action', 'correlationId']);
    expect(req.correlationId).toBe('c-1');
    // ESCALATE（无 requiredRole）→ 通知 requiredRole=null
    expect(notifyApprovalRequested.mock.calls[0][1].requiredRole).toBeNull();
  });

  it('api 409 evidence_not_approvable → { guardError: 码 }，不抛、不通知', async () => {
    guardFromEvidence.mockRejectedValue(new PolicyApiError('conflict', 409, 'evidence_not_approvable'));

    await expect(registerGuardDecision(args())).resolves.toEqual({ guardError: 'evidence_not_approvable' });
    expect(notifyApprovalRequested).not.toHaveBeenCalled();
  });

  it('api 错误无 code → http_<status>；非 api 错误 → client_error', async () => {
    guardFromEvidence.mockRejectedValueOnce(new PolicyApiError('boom', 503));
    await expect(registerGuardDecision(args())).resolves.toEqual({ guardError: 'http_503' });

    guardFromEvidence.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(registerGuardDecision(args())).resolves.toEqual({ guardError: 'client_error' });
  });

  it('缺 evidenceCorrelationId → { guardError: no_evidence } 且不调用 client', async () => {
    await expect(registerGuardDecision(args({ result: result() }))).resolves.toEqual({ guardError: 'no_evidence' });
    expect(guardFromEvidence).not.toHaveBeenCalled();
  });

  it('决策无 approval → 只记 guardDecisionId，不通知', async () => {
    guardFromEvidence.mockResolvedValue({ decisionId: 'd2' });

    await expect(registerGuardDecision(args())).resolves.toEqual({ guardDecisionId: 'd2' });
    expect(notifyApprovalRequested).not.toHaveBeenCalled();
  });
});

describe('registerGuardDecisionWith', () => {
  beforeEach(() => guardFromEvidence.mockReset());

  it('客户端装配失败 → { guardError: client_error }，不抛', async () => {
    const { client: _c, ...rest } = args();
    await expect(registerGuardDecisionWith(() => Promise.reject(new Error('db down')), rest))
      .resolves.toEqual({ guardError: 'client_error' });
  });

  it('无证据时不装配客户端', async () => {
    const create = vi.fn();
    const { client: _c, ...rest } = args({ result: result() });
    await expect(registerGuardDecisionWith(create, rest)).resolves.toEqual({ guardError: 'no_evidence' });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('toGuardAction', () => {
  it('约定键优先映射，context 为整个输入，agent 剥离 source', () => {
    const input = {
      principal_id: 'cust-9', principal_type: 'service', principal_roles: ['ops', 7],
      action: 'customer.delete', resource_type: 'customer', resource_id: 'c-42', extra: true,
    };
    const agent = { provider: 'acme', model: 'm1', version: '2', source: 'declared' as const };

    expect(toGuardAction(input, 'deleteCustomer', agent, 'user-1')).toEqual({
      principal: { id: 'cust-9', type: 'service', roles: ['ops'] },
      action: { name: 'customer.delete' },
      resource: { type: 'customer', id: 'c-42' },
      context: input,
      agent: { provider: 'acme', model: 'm1', version: '2', session: undefined },
    });
  });

  it('缺省回退：principal=发起人/user/[]，action=函数名，resource 空串，无 agent', () => {
    expect(toGuardAction({ amount: 5 }, 'deleteCustomer', null, 'user-1')).toEqual({
      principal: { id: 'user-1', type: 'user', roles: [] },
      action: { name: 'deleteCustomer' },
      resource: { type: '', id: '' },
      context: { amount: 5 },
    });
  });
});
