// @vitest-environment node
// 执行结果 → guard 决策登记（ADR 0042 §5.1）：成功记决策/审批 id、失败记错误码、无证据不调 api、动作映射。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { notifyApprovalRequested, isPolicyTenantMember, loadBusinessRoles, dbUpdate, dbSet, dbWhere } = vi.hoisted(() => {
  const dbWhere = vi.fn();
  const dbSet = vi.fn(() => ({ where: dbWhere }));
  return {
    notifyApprovalRequested: vi.fn(), isPolicyTenantMember: vi.fn(), loadBusinessRoles: vi.fn(),
    dbUpdate: vi.fn(() => ({ set: dbSet })), dbSet, dbWhere,
  };
});
vi.mock('@/lib/guard-notifications', () => ({ notifyApprovalRequested }));
vi.mock('@/lib/business-roles', () => ({ isPolicyTenantMember, loadBusinessRoles }));
vi.mock('@/lib/prisma', () => ({ db: { update: dbUpdate }, executions: { id: { name: 'id' } } }));
vi.mock('drizzle-orm', () => ({ eq: (col: { name: string }, v: unknown) => ({ eq: [col.name, v] }) }));

import {
  needsGuardDecision,
  registerGuardAfterInsert,
  registerGuardDecision,
  registerGuardDecisionWith,
  toGuardAction,
} from '@/lib/guard-register';
import { PolicyApiError, type PolicyApiClient } from '@/services/policy/policy-api';
import type { PolicyExecutionResult } from '@/services/policy/cnl-executor';
import { resetFactSigningKeyCacheForTests } from '@/services/guard/fact-signing-key';

const guardFromEvidence = vi.fn();
const listFactIssuers = vi.fn();
const client = { guardFromEvidence, listFactIssuers } as unknown as PolicyApiClient;
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
    await vi.waitFor(() => expect(notifyApprovalRequested).toHaveBeenCalled());
    expect(notifyApprovalRequested).toHaveBeenCalledWith('owner-1', {
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
    await vi.waitFor(() => expect(notifyApprovalRequested).toHaveBeenCalled());
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
  beforeEach(() => {
    guardFromEvidence.mockReset();
    notifyApprovalRequested.mockReset();
    isPolicyTenantMember.mockReset();
    isPolicyTenantMember.mockResolvedValue(true);
  });

  it('执行人属于策略租户 → 装配客户端并登记', async () => {
    guardFromEvidence.mockResolvedValue({ decisionId: 'd1' });
    const { client: _c, ...rest } = args();
    await expect(registerGuardDecisionWith(async () => client, rest)).resolves.toEqual({ guardDecisionId: 'd1' });
    expect(isPolicyTenantMember).toHaveBeenCalledWith('user-1', policy);
  });

  it('共享/公开策略的租户外执行人 → { guardError: not_tenant_member }，不装配客户端、不开决策、不通知', async () => {
    isPolicyTenantMember.mockResolvedValue(false);
    const create = vi.fn();
    const { client: _c, ...rest } = args({ requesterUserId: 'outsider-1' });

    await expect(registerGuardDecisionWith(create, rest)).resolves.toEqual({ guardError: 'not_tenant_member' });
    expect(isPolicyTenantMember).toHaveBeenCalledWith('outsider-1', policy);
    expect(create).not.toHaveBeenCalled();
    expect(guardFromEvidence).not.toHaveBeenCalled();
    expect(notifyApprovalRequested).not.toHaveBeenCalled();
  });

  it('成员校验查询失败 → client_error，不抛', async () => {
    isPolicyTenantMember.mockRejectedValue(new Error('db down'));
    const { client: _c, ...rest } = args();
    await expect(registerGuardDecisionWith(vi.fn(), rest)).resolves.toEqual({ guardError: 'client_error' });
  });

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

describe('registerGuardAfterInsert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('先等执行行落库，再登记，再按执行 id 回写 metadata', async () => {
    const order: string[] = [];
    let insertDone!: () => void;
    const insert = new Promise<void>((resolve) => { insertDone = resolve; }).then(() => { order.push('insert'); });
    const register = vi.fn(async () => {
      order.push('register');
      return { guardDecisionId: 'd1' };
    });
    dbWhere.mockImplementation(async () => { order.push('update'); });

    const pending = registerGuardAfterInsert(insert, 'exec-1', register);
    await Promise.resolve();
    expect(register).not.toHaveBeenCalled();
    insertDone();

    await expect(pending).resolves.toEqual({ guardDecisionId: 'd1' });
    expect(order).toEqual(['insert', 'register', 'update']);
    expect(dbSet).toHaveBeenCalledWith({ metadata: { guardDecisionId: 'd1' } });
    expect(dbWhere).toHaveBeenCalledWith({ eq: ['id', 'exec-1'] });
  });

  it('执行行插入失败 → 不登记、不回写，返回 null 且不抛', async () => {
    const register = vi.fn();
    await expect(registerGuardAfterInsert(Promise.reject(new Error('insert failed')), 'exec-1', register))
      .resolves.toBeNull();
    expect(register).not.toHaveBeenCalled();
    expect(dbUpdate).not.toHaveBeenCalled();
  });

  it('metadata 回写失败只记日志，仍返回登记结果', async () => {
    dbWhere.mockRejectedValueOnce(new Error('db down'));
    await expect(registerGuardAfterInsert(Promise.resolve(), 'exec-1', async () => ({ guardError: 'http_503' })))
      .resolves.toEqual({ guardError: 'http_503' });
  });
});

describe('needsGuardDecision', () => {
  it('require_approval 与 escalate 需要开决策，其余不需要', () => {
    expect(needsGuardDecision('require_approval')).toBe(true);
    expect(needsGuardDecision('escalate')).toBe(true);
    for (const d of ['approved', 'denied', 'indeterminate', 'error', null, undefined]) {
      expect(needsGuardDecision(d)).toBe(false);
    }
  });
});

describe('toGuardAction', () => {
  it('约定键映射，principal.id 恒为发起人（输入的 principal_id 只留在 context），agent 剥离 source', () => {
    const input = {
      principal_id: 'cust-9', principal_type: 'service', principal_roles: ['ops', 7],
      action: 'customer.delete', resource_type: 'customer', resource_id: 'c-42', extra: true,
    };
    const agent = { provider: 'acme', model: 'm1', version: '2', source: 'declared' as const };

    expect(toGuardAction(input, 'deleteCustomer', agent, 'user-1')).toEqual({
      principal: { id: 'user-1', type: 'service', roles: ['ops'] },
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

/**
 * from-evidence 首次请求即附签名事实（ADR 0046 §11.6 第 11 条；§11.7 裁定 6）：未配置密钥 / 本租户未启用 cloud 签发方时
 * 请求体与今天逐字节相同；附事实失败（invalid_fact）不去掉事实重试——翻转后那会用一次 DENY 消耗证据。
 */
describe('registerGuardDecision — 签名事实', () => {
  let secret: string;
  let publicKey: string;

  beforeEach(async () => {
    guardFromEvidence.mockReset();
    listFactIssuers.mockReset();
    notifyApprovalRequested.mockReset();
    isPolicyTenantMember.mockReset();
    isPolicyTenantMember.mockResolvedValue(true);
    resetFactSigningKeyCacheForTests();
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
    publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    secret = JSON.stringify({ issuer: 'aster-cloud', kid: 'k-test', privateKey, publicKey });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const enabledIssuer = () => ({
    issuers: [{ alg: 'Ed25519', createdAt: '2026-11-01T00:00:00Z', createdBy: 'owner-1', enabled: true,
      issuer: 'aster-cloud', kid: 'k-test', publicKey }],
  });

  it('noFactsWhenSigningKeyMissing：请求体与未引入签发前相同，action 不含 facts 键', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', '');
    guardFromEvidence.mockResolvedValue({ decisionId: 'd1' });

    await registerGuardDecision(args());

    const req = guardFromEvidence.mock.calls[0][0];
    expect(req).toEqual({ correlationId: 'c-1', action: toGuardAction({ a: 1 }, 'deleteCustomer', null, 'user-1') });
    expect(req.action).not.toHaveProperty('facts');
    expect(listFactIssuers).not.toHaveBeenCalled();
  });

  it('noFactsWhenCloudIssuerNotEnabled：签发方已吊销 → 照常登记、不附事实', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', secret);
    listFactIssuers.mockResolvedValue({ issuers: [{ ...enabledIssuer().issuers[0], enabled: false }] });
    guardFromEvidence.mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'PENDING' } });

    await expect(registerGuardDecision(args())).resolves.toEqual({ guardDecisionId: 'd1', guardApprovalId: 'a1' });
    expect(guardFromEvidence.mock.calls[0][0].action).not.toHaveProperty('facts');
  });

  it('attachesOneFactWithPrincipalId：audience 为策略租户，claim 为发起人', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', secret);
    listFactIssuers.mockResolvedValue(enabledIssuer());
    guardFromEvidence.mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'PENDING' } });

    await registerGuardDecision(args());

    const { action } = guardFromEvidence.mock.calls[0][0];
    expect(action.facts).toHaveLength(1);
    expect(action.facts[0].audience).toBe('team-1');
    expect(action.facts[0].claims['principal.id']).toBe('user-1');
    expect(action.facts[0].sources['principal.id']).toBe('hmac.userId');
  });

  it('reRegisterRouteAlsoAttachesFacts：经 registerGuardDecisionWith（重新登记路由的入口）同样附事实', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', secret);
    listFactIssuers.mockResolvedValue(enabledIssuer());
    guardFromEvidence.mockResolvedValue({ decisionId: 'd1' });
    const { client: _c, ...rest } = args();

    await registerGuardDecisionWith(async () => client, rest);

    expect(listFactIssuers).toHaveBeenCalledTimes(1);
    expect(guardFromEvidence.mock.calls[0][0].action.facts).toHaveLength(1);
  });

  it('invalidFactIsNotRetriedWithoutFacts', async () => {
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', secret);
    listFactIssuers.mockResolvedValue(enabledIssuer());
    guardFromEvidence.mockRejectedValue(new PolicyApiError('bad fact', 400, 'invalid_fact'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(registerGuardDecision(args())).resolves.toEqual({ guardError: 'invalid_fact' });
    expect(guardFromEvidence).toHaveBeenCalledTimes(1);
    expect(guardFromEvidence.mock.calls[0][0].action.facts).toHaveLength(1);
    err.mockRestore();
  });
});
