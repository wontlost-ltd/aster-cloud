// 重新登记路由（ADR 0042 §5.1 第 3 条）：POST /api/policies/[id]/executions/[execId]/guard-register。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  return {
    getSession: vi.fn(),
    policyFind: vi.fn(),
    execFind: vi.fn(),
    update: vi.fn().mockReturnValue({ set }),
    set,
    where,
    createClient: vi.fn(),
    guardFromEvidence: vi.fn(),
    notify: vi.fn(),
    isMember: vi.fn(),
  };
});

vi.mock('@/lib/auth', () => ({ getSession: () => h.getSession() }));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: { policies: { findFirst: h.policyFind }, executions: { findFirst: h.execFind } },
    update: h.update,
  },
  policies: { id: { name: 'policies.id' }, userId: { name: 'policies.userId' }, deletedAt: { name: 'policies.deletedAt' } },
  executions: { id: { name: 'executions.id' }, policyId: { name: 'executions.policyId' }, userId: { name: 'executions.userId' } },
}));
// where 条件以可检查的结构表达，供归属（owner-only）断言
vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, v: unknown) => ({ eq: [col.name, v] }),
  and: (...c: unknown[]) => ({ and: c }),
  isNull: (col: { name: string }) => ({ isNull: col.name }),
}));
vi.mock('@/lib/policy-access', async () =>
  (await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule());
vi.mock('@/lib/business-roles', () => ({
  isPolicyTenantMember: (...a: unknown[]) => h.isMember(...a),
}));
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (...a: unknown[]) => h.createClient(...a),
}));
vi.mock('@/lib/guard-notifications', () => ({ notifyApprovalRequested: (...a: unknown[]) => h.notify(...a) }));

import { POST } from '@/app/api/policies/[id]/executions/[execId]/guard-register/route';
import { executions } from '@/lib/prisma';
import { policyAccessState } from '@/__tests__/helpers/policy-access-mock';

const params = { params: Promise.resolve({ id: 'p1', execId: 'e1' }) };
const call = () => POST(new Request('http://localhost/x', { method: 'POST' }), params);

function execRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1', input: { action: 'customer.delete' }, decision: 'require_approval', functionName: 'deleteCustomer',
    agent: { provider: 'aster-cloud', model: 'dashboard', source: 'declared' },
    evidenceCorrelationId: 'c-1', metadata: { guardError: 'client_error' },
    output: { allowed: false, metadata: { outcome: 'REQUIRE_APPROVAL' } },
    ...overrides,
  };
}

describe('POST guard-register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.update.mockReturnValue({ set: h.set });
    h.set.mockReturnValue({ where: h.where });
    h.getSession.mockResolvedValue({ user: { id: 'user-1' } });
    policyAccessState.policy = { id: 'p1', name: 'Delete customer', teamId: 'team-1', userId: 'user-1' };
    policyAccessState.teamRole = 'member';
    h.createClient.mockResolvedValue({ guardFromEvidence: h.guardFromEvidence });
    h.isMember.mockResolvedValue(true);
  });

  it('未登录 → 401', async () => {
    h.getSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(h.execFind).not.toHaveBeenCalled();
  });

  it('guardError 行重试成功 → 回写 metadata（清掉旧 guardError）', async () => {
    h.execFind.mockResolvedValue(execRow());
    h.guardFromEvidence.mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'PENDING' } });

    const res = await call();

    expect(res.status).toBe(200);
    expect(h.createClient).toHaveBeenCalledWith('team-1', 'user-1');
    expect(h.guardFromEvidence).toHaveBeenCalledWith(expect.objectContaining({
      correlationId: 'c-1',
      action: expect.objectContaining({ action: { name: 'customer.delete' } }),
    }));
    expect(h.update).toHaveBeenCalledWith(executions);
    expect(h.set).toHaveBeenCalledWith({ metadata: { guardDecisionId: 'd1', guardApprovalId: 'a1' } });
    expect(await res.json()).toEqual({ metadata: { guardDecisionId: 'd1', guardApprovalId: 'a1' } });
    expect(h.notify).toHaveBeenCalled();
  });

  it('重试仍失败 → 回写新 guardError，返回 502', async () => {
    h.execFind.mockResolvedValue(execRow());
    h.guardFromEvidence.mockRejectedValue(new TypeError('fetch failed'));

    const res = await call();

    expect(res.status).toBe(502);
    expect(h.set).toHaveBeenCalledWith({ metadata: { guardError: 'client_error' } });
  });

  it('已登记 → 幂等返回，不再调 api、不回写', async () => {
    h.execFind.mockResolvedValue(execRow({ metadata: { guardDecisionId: 'd0' } }));

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ metadata: { guardDecisionId: 'd0' } });
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('非待审批行 → 409；策略或执行不存在 → 404', async () => {
    h.execFind.mockResolvedValue(execRow({ decision: 'approved' }));
    expect((await call()).status).toBe(409);

    h.execFind.mockResolvedValue(undefined);
    expect((await call()).status).toBe(404);

    policyAccessState.policy = null;
    expect((await call()).status).toBe(404);
  });

  it('他人的个人策略 → 404，不读执行行', async () => {
    policyAccessState.policy = { id: 'p1', name: 'Delete customer', teamId: null, userId: 'owner-9' };

    const res = await call();

    expect(res.status).toBe(404);
    expect(h.execFind).not.toHaveBeenCalled();
  });

  it('团队策略按当前角色：viewer 403、已被移除的创建者 404，均不读执行行（#670）', async () => {
    policyAccessState.teamRole = 'viewer';
    expect((await call()).status).toBe(403);
    policyAccessState.teamRole = null;
    expect((await call()).status).toBe(404);
    expect(h.execFind).not.toHaveBeenCalled();
  });

  it('执行行与回写均约束 (execId, policyId, 会话用户)', async () => {
    h.execFind.mockResolvedValue(execRow());
    h.guardFromEvidence.mockResolvedValue({ decisionId: 'd1' });

    await call();

    const expected = { and: [
      { eq: ['executions.id', 'e1'] }, { eq: ['executions.policyId', 'p1'] }, { eq: ['executions.userId', 'user-1'] },
    ] };
    expect(h.execFind.mock.calls[0][0].where).toEqual(expected);
    expect(h.where).toHaveBeenCalledWith(expected);
  });

  it('无证据锚（no_evidence）→ 409 短路，不调 api、不回写', async () => {
    h.execFind.mockResolvedValue(execRow({ evidenceCorrelationId: null, metadata: { guardError: 'no_evidence' } }));

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_evidence');
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it('所有者已不在策略团队 → not_tenant_member，不调 api', async () => {
    h.execFind.mockResolvedValue(execRow());
    h.isMember.mockResolvedValue(false);

    const res = await call();

    expect(res.status).toBe(502);
    expect(h.set).toHaveBeenCalledWith({ metadata: { guardError: 'not_tenant_member' } });
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });
});
