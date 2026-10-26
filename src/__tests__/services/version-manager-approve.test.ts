// @vitest-environment node
// approveVersion 的审批权限（用户裁决）：团队策略由团队 owner/admin 审批且作者不能自审；
// 普通成员与非成员按「策略不存在」拒绝；个人策略所有者可自审，审计事件带 selfApproved: true，
// 且作者首个批准版本触发 AHA 里程碑。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  policiesFindFirst: vi.fn(),
  versionsFindFirst: vi.fn(),
  insertValues: vi.fn(),
  updateSet: vi.fn(),
  getTeamMemberRole: vi.fn(),
  logSecurityEvent: vi.fn(),
  recordAha: vi.fn(),
  snapshot: vi.fn(),
  invalidateCache: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policies: { findFirst: h.policiesFindFirst },
      policyVersions: { findFirst: h.versionsFindFirst },
    },
    insert: () => ({ values: h.insertValues }),
    update: () => ({ set: (v: unknown) => { h.updateSet(v); return { where: async () => undefined }; } }),
  },
  policies: { id: {}, deletedAt: {}, userId: {} },
  policyVersions: { id: {}, policyId: {}, version: {}, status: {} },
  policyApprovals: {},
}));
vi.mock('@/lib/team-permissions', () => ({ getTeamMemberRole: h.getTeamMemberRole }));
vi.mock('@/services/security/security-event-service', () => ({ logSecurityEvent: h.logSecurityEvent }));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: h.recordAha }));
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({ snapshotOnPolicyApprove: h.snapshot }));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: h.invalidateCache }));

import {
  approveVersion,
  PolicyAccessDeniedError,
  SegregationOfDutiesError,
} from '@/services/policy/version-manager';

function setup(policy: { userId: string; teamId: string | null }, author: string, role: string | null = null) {
  h.policiesFindFirst.mockResolvedValue(policy);
  h.getTeamMemberRole.mockResolvedValue(role);
  h.versionsFindFirst.mockResolvedValue({
    id: 'v1', policyId: 'p1', version: 2, createdBy: author, status: 'PENDING_APPROVAL',
    content: GERMAN_SOURCE, source: null,
  });
}

const GERMAN_SOURCE = 'Modul x.\n\nDefiniere Fahrer hat alter als Ganzzahl.\n';

function decisionEvent() {
  return h.logSecurityEvent.mock.calls.map((c) => c[0]).find((e) => e.eventType === 'APPROVAL_DECISION');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.recordAha.mockResolvedValue(true);
  h.insertValues.mockResolvedValue(undefined);
  h.snapshot.mockResolvedValue([]);
  h.invalidateCache.mockResolvedValue(undefined);
});

describe('approveVersion — 团队策略', () => {
  it('团队 admin（非作者）可批准，审计事件不带自审标记', async () => {
    setup({ userId: 'author', teamId: 'team1' }, 'author', 'admin');

    await approveVersion({ policyId: 'p1', version: 2, approverId: 'admin1', decision: 'APPROVED' });

    expect(h.getTeamMemberRole).toHaveBeenCalledWith('admin1', 'team1');
    expect(h.updateSet).toHaveBeenCalledWith({ status: 'APPROVED' });
    expect(decisionEvent().details).toEqual({ version: 2, decision: 'APPROVED', comment: undefined });
  });

  it('团队 admin 可驳回', async () => {
    setup({ userId: 'author', teamId: 'team1' }, 'author', 'owner');

    await approveVersion({ policyId: 'p1', version: 2, approverId: 'boss', decision: 'REJECTED', comment: 'no' });

    expect(h.updateSet).toHaveBeenCalledWith({ status: 'REJECTED' });
  });

  it('作者（即使是 admin）不能审批自己的版本：四眼原则，记录自审尝试', async () => {
    setup({ userId: 'author', teamId: 'team1' }, 'author', 'admin');

    await expect(approveVersion({ policyId: 'p1', version: 2, approverId: 'author', decision: 'APPROVED' }))
      .rejects.toBeInstanceOf(SegregationOfDutiesError);
    expect(h.updateSet).not.toHaveBeenCalled();
    expect(h.logSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'SELF_APPROVAL_ATTEMPT' }));
  });

  it('普通成员不能审批，按策略不存在处理且不读版本', async () => {
    setup({ userId: 'author', teamId: 'team1' }, 'author', 'member');

    await expect(approveVersion({ policyId: 'p1', version: 2, approverId: 'm1', decision: 'APPROVED' }))
      .rejects.toBeInstanceOf(PolicyAccessDeniedError);
    expect(h.versionsFindFirst).not.toHaveBeenCalled();
    expect(h.updateSet).not.toHaveBeenCalled();
  });

  it('非团队成员不能审批', async () => {
    setup({ userId: 'author', teamId: 'team1' }, 'author', null);

    await expect(approveVersion({ policyId: 'p1', version: 2, approverId: 'stranger', decision: 'REJECTED', comment: 'x' }))
      .rejects.toBeInstanceOf(PolicyAccessDeniedError);
  });
});

describe('approveVersion — 个人策略', () => {
  it('所有者可批准自己提交的版本：审计事件标记 selfApproved，并触发作者的 AHA 里程碑', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');

    await approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'APPROVED', comment: 'ok' });

    expect(h.getTeamMemberRole).not.toHaveBeenCalled();
    expect(h.updateSet).toHaveBeenCalledWith({ status: 'APPROVED' });
    expect(decisionEvent().details).toEqual({ version: 2, decision: 'APPROVED', comment: 'ok', selfApproved: true });
    expect(h.recordAha).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', policyVersionId: 'v1' }));
  });

  it('非所有者不能审批个人策略', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');

    await expect(approveVersion({ policyId: 'p1', version: 2, approverId: 'other', decision: 'APPROVED' }))
      .rejects.toBeInstanceOf(PolicyAccessDeniedError);
  });

  it('策略不存在或已删除：按策略不存在处理', async () => {
    h.policiesFindFirst.mockResolvedValue(undefined);

    await expect(approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'APPROVED' }))
      .rejects.toBeInstanceOf(PolicyAccessDeniedError);
  });
});

describe('approveVersion — 词汇快照（#610）', () => {
  it('只按被审批版本的源码与语言冻结词汇，且在缓存失效前完成', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');
    const order: string[] = [];
    h.snapshot.mockImplementation(async () => { order.push('snapshot'); return []; });
    h.invalidateCache.mockImplementation(async () => { order.push('invalidate'); });

    await approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'APPROVED' });

    expect(h.snapshot).toHaveBeenCalledWith({
      policyVersionId: 'v1',
      policyAuthorId: 'owner',
      policy: { source: GERMAN_SOURCE, locale: 'de-DE' },
    });
    expect(order.indexOf('snapshot')).toBeLessThan(order.indexOf('invalidate'));
  });

  it('驳回不冻结词汇', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');

    await approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'REJECTED' });

    expect(h.snapshot).not.toHaveBeenCalled();
  });
});
