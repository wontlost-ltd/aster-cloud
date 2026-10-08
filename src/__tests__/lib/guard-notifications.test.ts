// @vitest-environment node
// guard 待审批通知收件人（ADR 0042 §5.3）：角色持有者 / ESCALATE 全员 / 个人租户本人；失败不抛。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  teamFind: vi.fn(), membersFind: vi.fn(), createNotification: vi.fn(), execFind: vi.fn(), policyFind: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      teams: { findFirst: h.teamFind },
      teamMembers: { findMany: h.membersFind },
      executions: { findFirst: h.execFind },
      policies: { findFirst: h.policyFind },
    },
  },
  teams: { id: { name: 'id' } },
  teamMembers: { teamId: { name: 'teamId' }, businessRoles: { name: 'businessRoles' } },
  executions: { metadata: { name: 'metadata' } },
  policies: { id: { name: 'id' } },
}));
vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, v: unknown) => ({ eq: [col.name, v] }),
  and: (...c: unknown[]) => ({ and: c }),
  arrayContains: (col: { name: string }, v: unknown) => ({ arrayContains: [col.name, v] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
}));
vi.mock('@/lib/notifications', () => ({ createNotification: (p: unknown) => h.createNotification(p) }));

import { notifyApprovalDecided, notifyApprovalRequested } from '@/lib/guard-notifications';

const payload = {
  tenantId: 'team-1', decisionId: 'd1', approvalId: 'a1', policyId: 'p1', policyName: 'P', requiredRole: 'DPO',
};

describe('notifyApprovalRequested', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.createNotification.mockResolvedValue('n1');
  });

  it('团队租户：只查持有 requiredRole 的成员并逐个通知', async () => {
    h.membersFind.mockResolvedValue([{ userId: 'u-dpo' }, { userId: 'u-dpo2' }]);

    await notifyApprovalRequested('owner-1', payload);

    expect(h.membersFind).toHaveBeenCalledWith(expect.objectContaining({
      where: { and: [{ eq: ['teamId', 'team-1'] }, { arrayContains: ['businessRoles', ['DPO']] }] },
    }));
    expect(h.createNotification.mock.calls.map((c) => c[0])).toEqual([
      { userId: 'u-dpo', kind: 'guard.approval_requested', data: payload },
      { userId: 'u-dpo2', kind: 'guard.approval_requested', data: payload },
    ]);
  });

  it('ESCALATE（requiredRole=null）：团队全员', async () => {
    h.membersFind.mockResolvedValue([{ userId: 'u1' }]);

    await notifyApprovalRequested('owner-1', { ...payload, requiredRole: null });

    expect(h.membersFind).toHaveBeenCalledWith(expect.objectContaining({ where: { eq: ['teamId', 'team-1'] } }));
    expect(h.createNotification).toHaveBeenCalledTimes(1);
  });

  it('个人租户（tenantId = 所有者 id，与业务角色同一判定）：只通知所有者，不查团队与成员', async () => {
    await notifyApprovalRequested('user-1', { ...payload, tenantId: 'user-1' });

    expect(h.teamFind).not.toHaveBeenCalled();
    expect(h.membersFind).not.toHaveBeenCalled();
    expect(h.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1' }));
  });

  it('查询失败不抛', async () => {
    h.membersFind.mockRejectedValue(new Error('db down'));
    await expect(notifyApprovalRequested('owner-1', payload)).resolves.toBeUndefined();
  });
});

describe('notifyApprovalDecided', () => {
  const decided = { tenantId: 'team-1', decisionId: 'd1', approvalId: 'a1', requiredRole: 'DPO', outcome: 'APPROVED' as const };

  beforeEach(() => {
    vi.clearAllMocks();
    h.createNotification.mockResolvedValue('n1');
  });

  it('按 metadata.guardDecisionId 反查发起执行，通知其 userId 并带策略名', async () => {
    h.execFind.mockResolvedValue({ userId: 'u-req', policyId: 'p1' });
    h.policyFind.mockResolvedValue({ name: 'Refunds', teamId: 'team-1', userId: 'owner-1' });

    await notifyApprovalDecided(decided);

    const where = h.execFind.mock.calls[0][0].where as { sql: string; values: unknown[] };
    expect(where.sql).toContain("->>'guardDecisionId' = ");
    expect(where.values).toEqual([{ name: 'metadata' }, 'd1']);
    expect(h.createNotification).toHaveBeenCalledWith({
      userId: 'u-req',
      kind: 'guard.approval_decided',
      data: { ...decided, policyId: 'p1', policyName: 'Refunds' },
    });
  });

  it('策略不属于审批所在租户 → 视为查不到，不通知', async () => {
    h.execFind.mockResolvedValue({ userId: 'u-req', policyId: 'p1' });
    h.policyFind.mockResolvedValue({ name: 'Refunds', teamId: 'team-other', userId: 'owner-1' });
    await notifyApprovalDecided(decided);
    expect(h.createNotification).not.toHaveBeenCalled();

    // 个人策略：租户 = 所有者 id，与 team-1 不符
    h.policyFind.mockResolvedValue({ name: 'Refunds', teamId: null, userId: 'owner-1' });
    await notifyApprovalDecided(decided);
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it('个人策略且审批租户 = 所有者 id → 通知', async () => {
    h.execFind.mockResolvedValue({ userId: 'owner-1', policyId: 'p1' });
    h.policyFind.mockResolvedValue({ name: 'Mine', teamId: null, userId: 'owner-1' });
    await notifyApprovalDecided({ ...decided, tenantId: 'owner-1' });
    expect(h.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1' }));
  });

  it('查不到发起执行 → 不通知', async () => {
    h.execFind.mockResolvedValue(undefined);
    await notifyApprovalDecided(decided);
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  it('查询失败不抛', async () => {
    h.execFind.mockRejectedValue(new Error('db down'));
    await expect(notifyApprovalDecided(decided)).resolves.toBeUndefined();
  });
});
