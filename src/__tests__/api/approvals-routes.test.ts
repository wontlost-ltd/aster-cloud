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
  getGuardApprovalInput: vi.fn(),
  revealGuardApprovalInput: vi.fn(),
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
const { GET: GET_INPUT } = await import('@/app/api/approvals/[tenantId]/[approvalId]/input/route');
const { POST: POST_REVEAL } = await import('@/app/api/approvals/[tenantId]/[approvalId]/input/reveal/route');

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
    expect(h.approveGuard).toHaveBeenCalledWith('a1', 'ok', undefined);
  });

  it('api 403 role_mismatch → 原样 403 并带 verifiedRoles；中文 message 换成英文（审查 L1）', async () => {
    h.approveGuard.mockRejectedValue(
      new FakePolicyApiError('该审批需要业务角色: DPO', 403, 'role_mismatch', undefined, { error: 'role_mismatch', verifiedRoles: ['CISO'] }),
    );
    const res = await post('team1', 'approve');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'role_mismatch',
      message: 'This approval requires a business role that is not among your verified roles.',
      verifiedRoles: ['CISO'],
    });
    expect(h.notifyApprovalDecided).not.toHaveBeenCalled();
  });

  it('api 403 segregation_of_duties → 原样 403，不带 verifiedRoles；中文 message 换成英文（#680）', async () => {
    h.approveGuard.mockRejectedValue(new FakePolicyApiError('动作的发起主体或提交方不能审批该动作', 403, 'segregation_of_duties'));
    const res = await post('team1', 'approve');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'segregation_of_duties',
      message: 'The requester or submitter of an action cannot approve it.',
    });
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
    expect(h.rejectGuard).toHaveBeenCalledWith('a1', 'no', undefined);
    expect(h.notifyApprovalDecided).toHaveBeenCalledWith({
      tenantId: 'team1', decisionId: 'd1', approvalId: 'a1', requiredRole: null, outcome: 'REJECTED',
    });
  });

  it('approve 成功 → 通知 outcome=APPROVED 并带 requiredRole', async () => {
    await post('team1', 'approve');
    expect(h.notifyApprovalDecided).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'APPROVED', requiredRole: 'DPO' }));
  });

  it('团队租户：以 (团队, 会话用户) 装配客户端', async () => {
    const res = await post('team1', 'approve', { comment: 'ok' });
    expect(res.status).toBe(200);
    expect(h.checkTeamAccess).toHaveBeenCalledWith('u1', 'team1');
    expect(h.createClient).toHaveBeenCalledWith('team1', 'u1');
  });

  it('上游不可用（408 超时 / 5xx / 客户端网络错误）→ 502 upstream_unavailable，不通知', async () => {
    for (const err of [
      new FakePolicyApiError('Request timeout', 408, 'TIMEOUT'),
      new FakePolicyApiError('fetch failed', 500, 'UNKNOWN'),
      new FakePolicyApiError('bad gateway', 503),
    ]) {
      h.approveGuard.mockRejectedValueOnce(err);
      const res = await post('team1', 'approve');
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe('upstream_unavailable');
    }
    expect(h.notifyApprovalDecided).not.toHaveBeenCalled();
  });

  it('其余 4xx 原样透传（409 approval_not_pending / 本地 400 invalid_id）', async () => {
    h.approveGuard.mockRejectedValueOnce(new FakePolicyApiError('not pending', 409, 'approval_not_pending'));
    const conflict = await post('team1', 'approve');
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe('approval_not_pending');

    h.approveGuard.mockRejectedValueOnce(new FakePolicyApiError('Invalid guard id', 400, 'invalid_id'));
    const bad = await post('team1', 'approve');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_id');
  });

  // #711：上游不可用的原文（可能含内部主机 / IP / 端口）只进服务端日志，响应给稳定 code + 英文文案 + requestId
  it('上游不可用：不回传原文，带 requestId（响应体与 x-request-id 一致）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.approveGuard.mockRejectedValueOnce(new FakePolicyApiError('connect ECONNREFUSED 10.43.0.12:8080', 500, 'UNKNOWN'));
    const res = await post('team1', 'approve');
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body).toMatchObject({ error: 'upstream_unavailable', code: 'upstream_unavailable' });
    expect(body.message).toBe('The approval service is temporarily unavailable. Please try again later.');
    expect(JSON.stringify(body)).not.toContain('10.43.0.12');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('x-request-id')).toBe(body.requestId);
    expect(JSON.stringify(spy.mock.calls)).toContain(body.requestId);
    spy.mockRestore();
  });

  it('未登记错误码的 4xx：保留 code 与状态码，文案换成英文通用句，不回传上游原文', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.approveGuard.mockRejectedValueOnce(new FakePolicyApiError('审批记录已被锁定 io.aster.Foo', 409, 'approval_locked'));
    const res = await post('team1', 'approve');
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toBe('approval_locked');
    expect(body.message).toBe('The approval action could not be completed.');
    expect(JSON.stringify(body)).not.toMatch(/锁定|io\.aster/);
    spy.mockRestore();
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


describe('审批输入代理（ADR 0042 §12 D10）', () => {
  const VIEW = {
    approvalId: 'a1', decisionId: 'd1', status: 'available', revealed: false, revealedByMe: false,
    inputSnapshotHash: 'b'.repeat(64), input: { context: { email: { $pii: { level: 'L2', category: 'email' } } } },
  };
  const params = (tenantId: string) => ({ params: Promise.resolve({ tenantId, approvalId: 'a1' }) });
  const getInput = (tenantId = 'team1') => GET_INPUT(new Request('https://x.test/i'), params(tenantId));
  const reveal = (tenantId = 'team1') => POST_REVEAL(new Request('https://x.test/r', { method: 'POST' }), params(tenantId));

  beforeEach(() => {
    vi.clearAllMocks();
    h.getSession.mockResolvedValue({ user: { id: 'u1' } });
    h.checkTeamAccess.mockResolvedValue({ allowed: true, role: 'member', teamId: 'team1' });
    h.createClient.mockResolvedValue({
      approveGuard: h.approveGuard, rejectGuard: h.rejectGuard,
      getGuardApprovalInput: h.getGuardApprovalInput, revealGuardApprovalInput: h.revealGuardApprovalInput,
    });
    h.getGuardApprovalInput.mockResolvedValue(VIEW);
    h.revealGuardApprovalInput.mockResolvedValue({ ...VIEW, revealed: true, revealedByMe: true });
    h.approveGuard.mockResolvedValue({ decisionId: 'd1', approval: { id: 'a1', status: 'APPROVED' } });
  });

  it('GET 以当前用户身份转发（团队租户 + 会话用户装配客户端），视图原样返回且不缓存', async () => {
    const res = await getInput();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VIEW);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(h.createClient).toHaveBeenCalledWith('team1', 'u1');
    expect(h.getGuardApprovalInput).toHaveBeenCalledWith('a1');
  });

  it('未登录 401、非成员 403，均不调 api', async () => {
    h.getSession.mockResolvedValueOnce(null);
    expect((await getInput()).status).toBe(401);
    h.checkTeamAccess.mockResolvedValueOnce({ allowed: false });
    expect((await reveal()).status).toBe(403);
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it('上游 403 reveal_not_permitted / 409 input_snapshot_mismatch·input_not_available / 503 receipt_unavailable 原样映射', async () => {
    const cases: Array<[number, string]> = [
      [403, 'reveal_not_permitted'], [409, 'input_not_available'], [503, 'receipt_unavailable'],
    ];
    for (const [status, code] of cases) {
      h.revealGuardApprovalInput.mockRejectedValueOnce(new FakePolicyApiError('上游中文', status, code, undefined,
        status === 403 ? { verifiedRoles: ['Analyst'] } : undefined));
      const res = await reveal();
      const body = await res.json();
      expect(res.status).toBe(status);
      expect(body.error).toBe(code);
      expect(body.message).not.toContain('上游中文');
      if (status === 403) expect(body.verifiedRoles).toEqual(['Analyst']);
    }
    h.approveGuard.mockRejectedValueOnce(new FakePolicyApiError('changed', 409, 'input_snapshot_mismatch'));
    const mismatch = await post('team1', 'approve', { inputSnapshotHash: 'c'.repeat(64) });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).error).toBe('input_snapshot_mismatch');
  });

  it('旧 api（无输入端点）404 → 200 { status: unavailable }；新 api 的 404 approval_not_found 原样透传', async () => {
    h.getGuardApprovalInput.mockRejectedValueOnce(new FakePolicyApiError('Not Found', 404));
    const legacy = await getInput();
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({ status: 'unavailable', approvalId: 'a1' });

    h.getGuardApprovalInput.mockRejectedValueOnce(new FakePolicyApiError('审批不存在', 404, 'approval_not_found'));
    const missing = await getInput();
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('approval_not_found');
  });

  it('上游 408 / 5xx / 超时 → 502 upstream_unavailable', async () => {
    for (const err of [new FakePolicyApiError('timeout', 408, 'TIMEOUT'), new FakePolicyApiError('boom', 500)]) {
      h.getGuardApprovalInput.mockRejectedValueOnce(err);
      const res = await getInput();
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe('upstream_unavailable');
    }
  });

  it('approve / reject 透传合法 inputSnapshotHash；非法格式 400 invalid_approval，不调 api', async () => {
    const hash = 'd'.repeat(64);
    expect((await post('team1', 'approve', { inputSnapshotHash: hash })).status).toBe(200);
    expect(h.approveGuard).toHaveBeenCalledWith('a1', undefined, hash);
    await post('team1', 'reject', { comment: 'no', inputSnapshotHash: hash });
    expect(h.rejectGuard).toHaveBeenCalledWith('a1', 'no', hash);

    h.approveGuard.mockClear();
    for (const bad of ['D'.repeat(64), 'x', 42, 'a'.repeat(63)]) {
      const res = await post('team1', 'approve', { inputSnapshotHash: bad });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_approval');
    }
    expect(h.approveGuard).not.toHaveBeenCalled();
    // 不带哈希（旧客户端 / 输入不可用）照常
    expect((await post('team1', 'approve', {})).status).toBe(200);
    expect(h.approveGuard).toHaveBeenCalledWith('a1', undefined, undefined);
  });
});
