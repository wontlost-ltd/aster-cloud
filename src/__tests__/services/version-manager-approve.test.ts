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
  lockPolicy: vi.fn(),
  /** 事务内 FOR UPDATE 复核时读到的版本状态（模拟并发审批已改掉状态）。 */
  lockedVersionStatus: { value: 'PENDING_APPROVAL' },
  audit: vi.fn(),
  invalidateCache: vi.fn(),
  /** 已提交的事务写入（模拟回滚：事务回调抛错时其写入不进入此列表）。 */
  committed: [] as string[],
}));

/**
 * 事务替身：写入先暂存在 tx.staged，回调成功才「提交」到 h.committed；回调抛错即丢弃，
 * 模拟数据库回滚。
 */
async function fakeTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  const staged: string[] = [];
  const tx = {
    staged,
    select: () => ({
      from: () => ({ where: () => ({ for: async () => [{ status: h.lockedVersionStatus.value }] }) }),
    }),
    insert: () => ({ values: async (v: unknown) => { await h.insertValues(v); staged.push('approval'); } }),
    update: () => ({
      set: (v: unknown) => {
        h.updateSet(v);
        return { where: async () => { staged.push('status'); } };
      },
    }),
  };
  const result = await fn(tx);
  h.committed.push(...staged);
  return result;
}

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policies: { findFirst: h.policiesFindFirst },
      policyVersions: { findFirst: h.versionsFindFirst },
    },
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fakeTransaction(fn),
  },
  policies: { id: {}, deletedAt: {}, userId: {} },
  policyVersions: { id: {}, policyId: {}, version: {}, status: {} },
  policyApprovals: {},
}));
vi.mock('@/lib/team-permissions', () => ({ getTeamMemberRole: h.getTeamMemberRole }));
vi.mock('@/services/security/security-event-service', () => ({ logSecurityEvent: h.logSecurityEvent }));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: h.recordAha }));
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  freezeVocabularyForApproval: h.snapshot,
  auditVocabularyFreeze: h.audit,
  lockPolicyForSnapshotRefs: h.lockPolicy,
  // envelope 反推编译 locale 用的按 locale 词汇来源（本测试的 envelope 词汇段均为空）
  loadFrozenVocabularyForSource: async () => () => null,
  loadLiveVocabularyForSource: async () => () => null,
}));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: h.invalidateCache }));

import {
  approveVersion,
  PolicyAccessDeniedError,
  SegregationOfDutiesError,
  VocabularyFreezeError,
} from '@/services/policy/version-manager';

function setup(policy: { userId: string; teamId: string | null }, author: string, role: string | null = null) {
  h.policiesFindFirst.mockResolvedValue(policy);
  h.getTeamMemberRole.mockResolvedValue(role);
  h.versionsFindFirst.mockResolvedValue({
    id: 'v1', policyId: 'p1', version: 2, createdBy: author, status: 'PENDING_APPROVAL',
    content: GERMAN_SOURCE, source: null,
    aliasSet: null, sourceEnvelopeSha256: null, sourceToolchainId: null,
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
  h.lockPolicy.mockResolvedValue(true);
  h.lockedVersionStatus.value = 'PENDING_APPROVAL';
  h.audit.mockResolvedValue(undefined);
  h.committed.length = 0;
  h.invalidateCache.mockResolvedValue(undefined);
});

describe('approveVersion — 团队策略', () => {
  it('团队 admin（非作者）可批准，审计事件不带自审标记', async () => {
    setup({ userId: 'author', teamId: 'team1' }, 'author', 'admin');

    await approveVersion({ policyId: 'p1', version: 2, approverId: 'admin1', decision: 'APPROVED' });

    expect(h.getTeamMemberRole).toHaveBeenCalledWith('admin1', 'team1');
    expect(h.updateSet).toHaveBeenCalledWith({ status: 'APPROVED', vocabularySnapshotIds: [] });
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
    expect(h.updateSet).toHaveBeenCalledWith({ status: 'APPROVED', vocabularySnapshotIds: [] });
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
  it('按被审批版本的源码与语言冻结词汇，引用随状态一并写入', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');
    const refs = [{ snapshotId: 's1', domain: 'e2e1026', locale: 'de' }];
    h.snapshot.mockResolvedValue(refs);

    await approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'APPROVED' });

    expect(h.snapshot).toHaveBeenCalledWith(
      { policyAuthorId: 'owner', policy: { source: GERMAN_SOURCE, locale: 'de-DE' } },
      expect.objectContaining({ staged: expect.any(Array) }),
    );
    expect(h.audit).toHaveBeenCalledWith({ policyAuthorId: 'owner', policyVersionId: 'v1', refs });
    expect(h.updateSet).toHaveBeenCalledWith({ status: 'APPROVED', vocabularySnapshotIds: refs });
  });

  it('冻结失败 → 审批整体失败：不写审批记录、不改状态、不失效缓存', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');
    h.snapshot.mockRejectedValue(new Error('db down'));

    await expect(approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'APPROVED' }))
      .rejects.toBeInstanceOf(VocabularyFreezeError);
    expect(h.insertValues).not.toHaveBeenCalled();
    expect(h.updateSet).not.toHaveBeenCalled();
    expect(h.invalidateCache).not.toHaveBeenCalled();
  });

  it('冻结后审批写入失败 → 冻结的 refCount 递增随事务回滚，审计不记录', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');
    // 冻结在审批事务内递增 refCount（写入经由同一个 tx）。
    h.snapshot.mockImplementation(async (_params: unknown, tx: { staged: string[] }) => {
      tx.staged.push('refCount+1');
      return [{ snapshotId: 's1', domain: 'e2e1026', locale: 'de' }];
    });
    h.insertValues.mockRejectedValueOnce(new Error('approval insert failed'));

    await expect(approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'APPROVED' }))
      .rejects.toThrow('approval insert failed');
    expect(h.committed).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.invalidateCache).not.toHaveBeenCalled();
  });

  it('成功时冻结、审批记录、状态更新一并提交', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');
    h.snapshot.mockImplementation(async (_params: unknown, tx: { staged: string[] }) => {
      tx.staged.push('refCount+1');
      return [];
    });

    await approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'APPROVED' });

    expect(h.committed).toEqual(['refCount+1', 'approval', 'status']);
  });

  it('审批事务先锁策略行，且锁在冻结（refCount 递增）之前（#628）', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');
    const order: string[] = [];
    h.lockPolicy.mockImplementation(async (tx: { staged: string[] }, policyId: string) => {
      order.push(`lock:${policyId}:${Array.isArray(tx.staged)}`);
      return true;
    });
    h.snapshot.mockImplementation(async () => {
      order.push('freeze');
      return [];
    });

    await approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'APPROVED' });

    expect(order).toEqual(['lock:p1:true', 'freeze']);
  });

  it('锁住时策略已被删除/软删：拒绝审批，不冻结、不写入（#628）', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');
    h.lockPolicy.mockResolvedValue(false);

    await expect(approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'APPROVED' }))
      .rejects.toBeInstanceOf(PolicyAccessDeniedError);
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.committed).toEqual([]);
    expect(h.invalidateCache).not.toHaveBeenCalled();
  });

  it('同一版本被并发审批：锁住版本行后发现已不在待审批 → 后到者失败，不冻结、不写入', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');
    h.lockedVersionStatus.value = 'APPROVED';

    await expect(approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'APPROVED' }))
      .rejects.toThrow('不在待审批状态');
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.committed).toEqual([]);
  });

  it('驳回不冻结词汇，也不改写快照引用', async () => {
    setup({ userId: 'owner', teamId: null }, 'owner');

    await approveVersion({ policyId: 'p1', version: 2, approverId: 'owner', decision: 'REJECTED' });

    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.updateSet).toHaveBeenCalledWith({ status: 'REJECTED' });
  });
});
