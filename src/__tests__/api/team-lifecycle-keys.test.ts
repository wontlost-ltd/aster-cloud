import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSession } from '@/lib/auth';
import {
  checkTeamAccess,
  checkTeamPermission,
  canChangeRole,
  canRemoveMember,
} from '@/lib/team-permissions';
import { revokeTeamKeys, refreshTeamKeySnapshots } from '@/lib/api-keys';
import { invalidatePlanCache } from '@/lib/plan-gate-client';

// 团队生命周期钩子（ADR 0015 §5）：成员移出 / 角色变更 / 转让 / 删除团队 必须吊销或重推团队 key
const { mockFindFirst, mockUpdate, mockDelete, mockTransaction, txStub } = vi.hoisted(() => {
  const chainUpdate = () => ({ set: () => ({ where: vi.fn() }) });
  const chainDelete = () => ({ where: vi.fn() });
  return {
    mockFindFirst: vi.fn(),
    mockUpdate: vi.fn(chainUpdate),
    mockDelete: vi.fn(chainDelete),
    mockTransaction: vi.fn(),
    txStub: { update: chainUpdate, delete: chainDelete },
  };
});

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/team-permissions', () => ({
  TeamPermission: {
    TEAM_DELETE: 'team.delete',
    TEAM_TRANSFER: 'team.transfer',
    MEMBER_REMOVE: 'member.remove',
    MEMBER_UPDATE_ROLE: 'member.updateRole',
  },
  checkTeamAccess: vi.fn(),
  checkTeamPermission: vi.fn(),
  canChangeRole: vi.fn(),
  canRemoveMember: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: { teamMembers: { findFirst: mockFindFirst } },
    update: mockUpdate,
    delete: mockDelete,
    transaction: mockTransaction,
  },
  teams: { id: {}, ownerId: {} },
  teamMembers: { id: {}, teamId: {}, userId: {} },
  teamInvitations: { teamId: {} },
  policies: { teamId: {} },
  policyGroups: { teamId: {} },
}));

vi.mock('@/lib/api-keys', () => ({
  revokeTeamKeys: vi.fn(),
  refreshTeamKeySnapshots: vi.fn(),
}));

vi.mock('@/lib/plan-gate-client', () => ({
  invalidatePlanCache: vi.fn(),
}));

const mockRevokeTeamKeys = vi.mocked(revokeTeamKeys);
const mockRefreshTeamKeySnapshots = vi.mocked(refreshTeamKeySnapshots);
const mockInvalidatePlanCache = vi.mocked(invalidatePlanCache);

const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) }) as never;
const json = (method: string, body: unknown) =>
  new Request('http://cloud.test/x', {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('团队生命周期 → 团队 key 钩子（ADR 0015 §5）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue({
      user: { id: 'u-admin' },
    } as unknown as Awaited<ReturnType<typeof getSession>>);
    vi.mocked(checkTeamAccess).mockResolvedValue({ allowed: true, role: 'owner', teamId: 't1' });
    vi.mocked(checkTeamPermission).mockResolvedValue({ allowed: true });
    vi.mocked(canChangeRole).mockReturnValue({ allowed: true });
    vi.mocked(canRemoveMember).mockReturnValue({ allowed: true });
    mockFindFirst.mockResolvedValue({ id: 'm1', teamId: 't1', userId: 'u2', role: 'member' });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => fn(txStub));
    mockRevokeTeamKeys.mockResolvedValue(0);
    mockRefreshTeamKeySnapshots.mockResolvedValue(0);
    mockInvalidatePlanCache.mockResolvedValue(undefined);
  });

  it('DELETE 成员 → revokeTeamKeys("t1","u2")（用 targetMember.userId，不是 memberId）', async () => {
    const { DELETE } = await import('@/app/api/teams/[teamId]/members/[memberId]/route');
    const res = await DELETE(new Request('http://cloud.test/x', { method: 'DELETE' }), params({ teamId: 't1', memberId: 'm1' }));
    expect(res.status).toBe(200);
    expect(mockRevokeTeamKeys).toHaveBeenCalledWith('t1', 'u2');
  });

  it('PUT 角色 → refreshTeamKeySnapshots("t1","u2")', async () => {
    const { PUT } = await import('@/app/api/teams/[teamId]/members/[memberId]/route');
    const res = await PUT(json('PUT', { role: 'admin' }), params({ teamId: 't1', memberId: 'm1' }));
    expect(res.status).toBe(200);
    expect(mockRefreshTeamKeySnapshots).toHaveBeenCalledWith('t1', 'u2');
  });

  it('POST transfer → refreshTeamKeySnapshots("t1") 且 invalidatePlanCache("t1")', async () => {
    const { POST } = await import('@/app/api/teams/[teamId]/transfer/route');
    const res = await POST(json('POST', { newOwnerId: 'u2' }), params({ teamId: 't1' }));
    expect(res.status).toBe(200);
    expect(mockRefreshTeamKeySnapshots).toHaveBeenCalledWith('t1');
    expect(mockInvalidatePlanCache).toHaveBeenCalledWith('t1');
  });

  // ApiKey.teamId 无外键、删团队事务不碰 ApiKey，删后仍可按 teamId 吊销；放在事务之后，事务失败就不会留下
  // “团队还在、成员 key 全被吊销”的残局。revoke mock 先让出一个宏任务再记录：单个微任务会在路由返回前跑完、
  // 钉不住 await；宏任务下路由若不 await 它，响应返回时 order 里还没有 revoke
  it('DELETE 团队 → 事务提交之后再 await revokeTeamKeys("t1")', async () => {
    const order: string[] = [];
    mockRevokeTeamKeys.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 0));
      order.push('revoke');
      return 0;
    });
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => { await fn(txStub); order.push('tx'); });
    const { DELETE } = await import('@/app/api/teams/[teamId]/route');
    const res = await DELETE(new Request('http://cloud.test/x', { method: 'DELETE' }), params({ teamId: 't1' }));
    expect(res.status).toBe(200);
    expect(mockRevokeTeamKeys).toHaveBeenCalledWith('t1');
    expect(order).toEqual(['tx', 'revoke']);
  });

  it('DELETE 团队事务失败 → 不吊销任何 key（团队仍在，成员 key 照常可用），500', async () => {
    mockTransaction.mockRejectedValue(new Error('tx failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { DELETE } = await import('@/app/api/teams/[teamId]/route');
    const res = await DELETE(new Request('http://cloud.test/x', { method: 'DELETE' }), params({ teamId: 't1' }));
    expect(res.status).toBe(500);
    expect(mockRevokeTeamKeys).not.toHaveBeenCalled();
  });

  // 钩子的数据库步骤可能抛错；业务写入已经（或将要）成功，不能被钩子失败改写成 500
  it('钩子抛错不影响业务结果：成员移出仍 200', async () => {
    mockRevokeTeamKeys.mockRejectedValue(new Error('db down'));
    const { DELETE } = await import('@/app/api/teams/[teamId]/members/[memberId]/route');
    const res = await DELETE(new Request('http://cloud.test/x', { method: 'DELETE' }), params({ teamId: 't1', memberId: 'm1' }));
    expect(res.status).toBe(200);
    expect(mockDelete).toHaveBeenCalled();
  });

  it('钩子抛错不影响业务结果：角色变更与转让仍 200', async () => {
    mockRefreshTeamKeySnapshots.mockRejectedValue(new Error('db down'));
    const { PUT } = await import('@/app/api/teams/[teamId]/members/[memberId]/route');
    const { POST } = await import('@/app/api/teams/[teamId]/transfer/route');
    const putRes = await PUT(json('PUT', { role: 'admin' }), params({ teamId: 't1', memberId: 'm1' }));
    const postRes = await POST(json('POST', { newOwnerId: 'u2' }), params({ teamId: 't1' }));
    expect(putRes.status).toBe(200);
    expect(postRes.status).toBe(200);
    expect(mockInvalidatePlanCache).toHaveBeenCalledWith('t1');
  });

  it('transfer 的 invalidatePlanCache 抛错不影响业务结果：仍 200，且已重推全队快照', async () => {
    mockInvalidatePlanCache.mockRejectedValue(new Error('aster-api down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { POST } = await import('@/app/api/teams/[teamId]/transfer/route');
    const res = await POST(json('POST', { newOwnerId: 'u2' }), params({ teamId: 't1' }));
    expect(res.status).toBe(200);
    expect(mockRefreshTeamKeySnapshots).toHaveBeenCalledWith('t1');
  });

  it('钩子抛错不影响业务结果：团队删除事务照常执行', async () => {
    mockRevokeTeamKeys.mockRejectedValue(new Error('db down'));
    const { DELETE } = await import('@/app/api/teams/[teamId]/route');
    const res = await DELETE(new Request('http://cloud.test/x', { method: 'DELETE' }), params({ teamId: 't1' }));
    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('权限不足时不触发钩子', async () => {
    vi.mocked(checkTeamPermission).mockResolvedValue({ allowed: false, error: 'forbidden', status: 403 });
    const { DELETE } = await import('@/app/api/teams/[teamId]/route');
    const { POST } = await import('@/app/api/teams/[teamId]/transfer/route');
    const delRes = await DELETE(new Request('http://cloud.test/x', { method: 'DELETE' }), params({ teamId: 't1' }));
    const postRes = await POST(json('POST', { newOwnerId: 'u2' }), params({ teamId: 't1' }));
    expect(delRes.status).toBe(403);
    expect(postRes.status).toBe(403);
    expect(mockRevokeTeamKeys).not.toHaveBeenCalled();
    expect(mockRefreshTeamKeySnapshots).not.toHaveBeenCalled();
    expect(mockInvalidatePlanCache).not.toHaveBeenCalled();
  });
});
