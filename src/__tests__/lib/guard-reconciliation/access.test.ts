// @vitest-environment node
// 对账访问判定与客户端工厂（ADR 0061 §3.1 / §3.2）：看 = 个人租户本人或团队 ≥ member；确认 = 个人租户本人或
// 团队 ≥ admin；签名角色 = 现查的团队角色（个人租户 owner）；工厂只返回窄接口。角色矩阵用真实实现。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  roles: new Map<string, string>(),
  getTeamMemberRole: vi.fn(),
  membersFind: vi.fn(),
  createClient: vi.fn(),
  client: {
    getGuardReconciliation: vi.fn(),
    listGuardOrphans: vi.fn(),
    ackGuardOrphan: vi.fn(),
    getGuardDecision: vi.fn(),
    listFactIssuers: vi.fn(),
  },
}));

vi.mock('@/lib/team-permissions', async () => {
  const matrix = await vi.importActual<typeof import('@/lib/team-permission-matrix')>('@/lib/team-permission-matrix');
  return {
    getRoleLevel: matrix.getRoleLevel,
    ROLE_HIERARCHY: matrix.ROLE_HIERARCHY,
    SOLO_TENANT_ROLE: 'owner',
    getTeamMemberRole: (userId: string, teamId: string) => h.getTeamMemberRole(userId, teamId),
  };
});
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (...args: unknown[]) => h.createClient(...args),
}));
vi.mock('@/db/fresh-read', () => ({ freshDb: { query: { teamMembers: { findMany: h.membersFind } } } }));
vi.mock('@/lib/prisma', () => ({ teamMembers: { userId: { name: 'userId' } } }));
vi.mock('drizzle-orm', () => ({ eq: (col: { name: string }, v: unknown) => ({ eq: [col.name, v] }) }));

const { createReconciliationClient, listReconciliationTenants, reconciliationAccess } = await import(
  '@/lib/guard-reconciliation/access'
);

describe('reconciliationAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.roles.clear();
    h.getTeamMemberRole.mockImplementation(async (u: string, t: string) => h.roles.get(`${u}:${t}`) ?? null);
    h.createClient.mockResolvedValue(h.client);
  });

  it('个人租户 → owner，可看可确认，不查成员表', async () => {
    expect(await reconciliationAccess('u1', 'u1')).toEqual({ role: 'owner', canView: true, canAck: true });
    expect(h.getTeamMemberRole).not.toHaveBeenCalled();
  });

  it.each([
    ['viewer', false, false],
    ['member', true, false],
    ['admin', true, true],
    ['owner', true, true],
  ])('团队 %s → canView=%s canAck=%s', async (role, canView, canAck) => {
    h.roles.set('u1:team1', role);
    expect(await reconciliationAccess('u1', 'team1')).toEqual({ role, canView, canAck });
    expect(h.getTeamMemberRole).toHaveBeenCalledWith('u1', 'team1');
  });

  it('非成员（含他人的个人租户）与库里的未知角色 → null', async () => {
    expect(await reconciliationAccess('u1', 'team9')).toBeNull();
    expect(await reconciliationAccess('u1', 'u2')).toBeNull();
    h.roles.set('u1:team1', 'superuser');
    expect(await reconciliationAccess('u1', 'team1')).toBeNull();
  });
});

describe('createReconciliationClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.roles.clear();
    h.getTeamMemberRole.mockImplementation(async (u: string, t: string) => h.roles.get(`${u}:${t}`) ?? null);
    h.createClient.mockResolvedValue(h.client);
  });

  it('viewer / 非成员 → null，且不构造客户端', async () => {
    h.roles.set('u1:team1', 'viewer');
    expect(await createReconciliationClient('team1', 'u1')).toBeNull();
    expect(await createReconciliationClient('team9', 'u1')).toBeNull();
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it.each([
    ['team1', 'member', 'member'],
    ['team1', 'admin', 'admin'],
    ['team1', 'owner', 'owner'],
    ['u1', undefined, 'owner'],
  ])('租户 %s（团队角色 %s）→ 以 %s 作第三参数构造客户端', async (tenantId, role, signed) => {
    if (role) h.roles.set(`u1:${tenantId}`, role);
    const rec = await createReconciliationClient(tenantId, 'u1');
    expect(rec).not.toBeNull();
    expect(h.createClient).toHaveBeenCalledTimes(1);
    expect(h.createClient).toHaveBeenCalledWith(tenantId, 'u1', signed);
    expect(rec!.access.role).toBe(signed);
  });

  it('返回值键集恰为 api / access；api 恰为四个方法且冻结，转发到对应客户端方法', async () => {
    h.roles.set('u1:team1', 'admin');
    const rec = (await createReconciliationClient('team1', 'u1'))!;
    expect(Object.keys(rec).sort()).toEqual(['access', 'api']);
    expect(Object.keys(rec.api).sort()).toEqual(['ackOrphan', 'getDecision', 'listOrphans', 'summary']);
    expect(Object.isFrozen(rec.api)).toBe(true);
    expect(rec.api).not.toHaveProperty('listFactIssuers');

    const q = { status: 'OPEN' as const, severities: [], limit: 50 };
    await rec.api.summary();
    await rec.api.listOrphans(q);
    await rec.api.ackOrphan(7, 'ok');
    await rec.api.getDecision('d-1');
    expect(h.client.getGuardReconciliation).toHaveBeenCalledTimes(1);
    expect(h.client.listGuardOrphans).toHaveBeenCalledWith(q);
    expect(h.client.ackGuardOrphan).toHaveBeenCalledWith(7, 'ok');
    expect(h.client.getGuardDecision).toHaveBeenCalledWith('d-1');
  });

  it('每次调用都现查角色（不缓存）：两次调用之间降级即按新角色签名', async () => {
    h.roles.set('u1:team1', 'admin');
    expect((await createReconciliationClient('team1', 'u1'))!.access.canAck).toBe(true);
    h.roles.set('u1:team1', 'member');
    const second = (await createReconciliationClient('team1', 'u1'))!;
    expect(second.access).toEqual({ role: 'member', canView: true, canAck: false });
    expect(h.getTeamMemberRole).toHaveBeenCalledTimes(2);
    expect(h.createClient.mock.calls.map((c) => c[2])).toEqual(['admin', 'member']);
  });
});

describe('listReconciliationTenants', () => {
  beforeEach(() => vi.clearAllMocks());

  it('个人租户在前；只列 ≥ member 的团队；成员关系走 freshDb', async () => {
    h.membersFind.mockResolvedValue([
      { teamId: 'team-a', role: 'admin', team: { name: 'Alpha' } },
      { teamId: 'team-v', role: 'viewer', team: { name: 'Viewers' } },
      { teamId: 'team-m', role: 'member', team: null },
    ]);
    const tenants = await listReconciliationTenants('u1');
    expect(tenants).toEqual([
      { id: 'u1', name: '', access: { role: 'owner', canView: true, canAck: true } },
      { id: 'team-a', name: 'Alpha', access: { role: 'admin', canView: true, canAck: true } },
      { id: 'team-m', name: 'team-m', access: { role: 'member', canView: true, canAck: false } },
    ]);
    expect(h.membersFind).toHaveBeenCalledWith(expect.objectContaining({ where: { eq: ['userId', 'u1'] } }));
  });
});
