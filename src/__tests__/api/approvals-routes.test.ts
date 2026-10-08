// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 审批收件箱路由（ADR 0042 §5.2）：cloud 只做登录、租户归属与驳回理由的本地校验；
 * 角色匹配/四眼由 aster-api 判定，其错误码与状态码原样透传（role_mismatch 附 verifiedRoles）。
 */

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  checkTeamAccess: vi.fn(),
  approveGuard: vi.fn(),
  rejectGuard: vi.fn(),
  createClient: vi.fn(),
  notifyApprovalDecided: vi.fn(),
  listUserApprovals: vi.fn(),
}));

class FakePolicyApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly diagnostics?: unknown,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

vi.mock('@/lib/auth', () => ({ getSession: () => h.getSession() }));
vi.mock('@/lib/team-permissions', () => ({
  checkTeamAccess: (userId: string, teamId: string) => h.checkTeamAccess(userId, teamId),
}));
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (tenantId: string, userId: string) => h.createClient(tenantId, userId),
}));
vi.mock('@/lib/guard-notifications', () => ({ notifyApprovalDecided: (p: unknown) => h.notifyApprovalDecided(p) }));
vi.mock('@/services/policy/policy-api', () => ({ PolicyApiError: FakePolicyApiError }));
vi.mock('@/lib/approvals-inbox', () => ({
  isGuardApprovalStatus: (v: unknown) => ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'].includes(v as string),
  listUserApprovals: (userId: string, status: string) => h.listUserApprovals(userId, status),
}));

const { POST } = await import('@/app/api/approvals/[tenantId]/[approvalId]/[verb]/route');
const { GET } = await import('@/app/api/approvals/route');

function post(tenantId: string, verb: string, body: unknown = {}) {
  const req = new Request(`https://x.test/api/approvals/${tenantId}/a1/${verb}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ tenantId, approvalId: 'a1', verb }) });
}

describe('POST /api/approvals/:tenantId/:approvalId/:verb', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSession.mockResolvedValue({ user: { id: 'u1' } });
    h.checkTeamAccess.mockResolvedValue({ allowed: true, role: 'member', teamId: 'team1' });
    h.createClient.mockResolvedValue({ approveGuard: h.approveGuard, rejectGuard: h.rejectGuard });
    h.approveGuard.mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'APPROVED', requiredRole: 'DPO' } });
    h.rejectGuard.mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'REJECTED' } });
  });

  it('未登录 → 401，不调 api', async () => {
    h.getSession.mockResolvedValue(null);
    const res = await post('team1', 'approve');
    expect(res.status).toBe(401);
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it('不属于该团队租户 → 403，不调 api', async () => {
    h.checkTeamAccess.mockResolvedValue({ allowed: false, error: 'x', status: 403 });
    const res = await post('team9', 'approve');
    expect(res.status).toBe(403);
    expect(h.checkTeamAccess).toHaveBeenCalledWith('u1', 'team9');
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it('个人租户（tenantId = userId）不查团队成员关系', async () => {
    const res = await post('u1', 'approve', { comment: 'ok' });
    expect(res.status).toBe(200);
    expect(h.checkTeamAccess).not.toHaveBeenCalled();
    expect(h.createClient).toHaveBeenCalledWith('u1', 'u1');
    expect(h.approveGuard).toHaveBeenCalledWith('a1', 'ok');
  });

  it('api 403 role_mismatch → 原样 403 并带 verifiedRoles', async () => {
    h.approveGuard.mockRejectedValue(
      new FakePolicyApiError('role mismatch', 403, 'role_mismatch', undefined, { error: 'role_mismatch', verifiedRoles: ['CISO'] }),
    );
    const res = await post('team1', 'approve');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'role_mismatch', message: 'role mismatch', verifiedRoles: ['CISO'] });
    expect(h.notifyApprovalDecided).not.toHaveBeenCalled();
  });

  it('api 403 segregation_of_duties → 原样 403，不带 verifiedRoles', async () => {
    h.approveGuard.mockRejectedValue(new FakePolicyApiError('same user', 403, 'segregation_of_duties'));
    const res = await post('team1', 'approve');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'segregation_of_duties', message: 'same user' });
  });

  it('reject 无 comment（或全空白）→ 400 comment_required，不调 api', async () => {
    for (const body of [{}, { comment: '   ' }]) {
      const res = await post('team1', 'reject', body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('comment_required');
    }
    expect(h.rejectGuard).not.toHaveBeenCalled();
  });

  it('reject 成功 → 200，通知发起人 outcome=REJECTED', async () => {
    const res = await post('team1', 'reject', { comment: 'no' });
    expect(res.status).toBe(200);
    expect(h.rejectGuard).toHaveBeenCalledWith('a1', 'no');
    expect(h.notifyApprovalDecided).toHaveBeenCalledWith({
      tenantId: 'team1', decisionId: 'd1', approvalId: 'a1', requiredRole: null, outcome: 'REJECTED',
    });
  });

  it('approve 成功 → 通知 outcome=APPROVED 并带 requiredRole', async () => {
    await post('team1', 'approve');
    expect(h.notifyApprovalDecided).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'APPROVED', requiredRole: 'DPO' }));
  });

  it('未知动词 → 404', async () => {
    const res = await post('team1', 'delete');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/approvals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getSession.mockResolvedValue({ user: { id: 'u1' } });
    h.listUserApprovals.mockResolvedValue({ items: [], unavailableTenants: [] });
  });

  it('未登录 → 401', async () => {
    h.getSession.mockResolvedValue(null);
    const res = await GET(new Request('https://x.test/api/approvals'));
    expect(res.status).toBe(401);
  });

  it('缺省 status=PENDING', async () => {
    const res = await GET(new Request('https://x.test/api/approvals'));
    expect(res.status).toBe(200);
    expect(h.listUserApprovals).toHaveBeenCalledWith('u1', 'PENDING');
  });

  it('非法 status → 400', async () => {
    const res = await GET(new Request('https://x.test/api/approvals?status=BOGUS'));
    expect(res.status).toBe(400);
    expect(h.listUserApprovals).not.toHaveBeenCalled();
  });
});
