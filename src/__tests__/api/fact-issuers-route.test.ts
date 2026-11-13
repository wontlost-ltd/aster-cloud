// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 签发方管理代理（ADR 0040 §11 D3）：读 = 个人租户本人或团队 TEAM_VIEW；写 / 吊销 = 个人租户本人或团队
 * MEMBER_UPDATE_ROLE。权限判定用真实的角色矩阵（只替换成员关系查询），客户端用真实 PolicyApiClient 的
 * 校验与错误类型，只替换装配出的 api 调用。
 */

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  memberships: new Map<string, string>(),
  createClient: vi.fn(),
  listFactIssuers: vi.fn(),
  putFactIssuer: vi.fn(),
  deleteFactIssuer: vi.fn(),
  loadFactSigningKey: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: () => h.getSession() }));
vi.mock('@/lib/team-permissions', async () => {
  const matrix = await vi.importActual<typeof import('@/lib/team-permission-matrix')>('@/lib/team-permission-matrix');
  return {
    TeamPermission: matrix.TeamPermission,
    checkTeamPermission: async (userId: string, teamId: string, permission: string) => {
      const role = h.memberships.get(`${userId}:${teamId}`);
      if (!role) return { allowed: false, error: 'not a member', code: 'not_team_member', status: 403 };
      return matrix.hasPermission(role as never, permission as never)
        ? { allowed: true }
        : { allowed: false, error: 'insufficient', code: 'insufficient_team_role', status: 403 };
    },
  };
});
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (tenantId: string, userId: string) => h.createClient(tenantId, userId),
}));
vi.mock('@/services/guard/fact-signing-key', () => ({ loadFactSigningKey: () => h.loadFactSigningKey() }));

const { PolicyApiError } = await import('@/services/policy/policy-api');
const { GET } = await import('@/app/api/fact-issuers/[tenantId]/route');
const { PUT, DELETE } = await import('@/app/api/fact-issuers/[tenantId]/[issuer]/[kid]/route');

const PUBLIC_KEY = 'q'.repeat(43);
const ROW = {
  alg: 'Ed25519', createdAt: '2026-11-13T00:00:00Z', createdBy: 'u-admin', enabled: true,
  issuer: 'idp.example.com', kid: '2026-11', publicKey: PUBLIC_KEY,
};

function list(tenantId: string) {
  return GET(new Request(`https://x.test/api/fact-issuers/${tenantId}`), { params: Promise.resolve({ tenantId }) });
}

function put(tenantId: string, issuer: string, kid: string, body: unknown = { publicKey: PUBLIC_KEY }) {
  const req = new Request(`https://x.test/api/fact-issuers/${tenantId}/${issuer}/${kid}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return PUT(req, { params: Promise.resolve({ tenantId, issuer, kid }) });
}

function del(tenantId: string, issuer: string, kid: string) {
  const req = new Request(`https://x.test/api/fact-issuers/${tenantId}/${issuer}/${kid}`, { method: 'DELETE' });
  return DELETE(req, { params: Promise.resolve({ tenantId, issuer, kid }) });
}

function asUser(id: string) {
  h.getSession.mockResolvedValue({ user: { id } });
}

describe('/api/fact-issuers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.memberships.clear();
    h.memberships.set('u-viewer:team1', 'viewer');
    h.memberships.set('u-member:team1', 'member');
    h.memberships.set('u-admin:team1', 'admin');
    h.memberships.set('u-owner:team1', 'owner');
    h.createClient.mockResolvedValue({
      listFactIssuers: h.listFactIssuers,
      putFactIssuer: h.putFactIssuer,
      deleteFactIssuer: h.deleteFactIssuer,
    });
    h.listFactIssuers.mockResolvedValue({ issuers: [ROW] });
    h.putFactIssuer.mockResolvedValue(ROW);
    h.deleteFactIssuer.mockResolvedValue(undefined);
    h.loadFactSigningKey.mockResolvedValue({
      issuer: 'aster-cloud', kid: 'k-2026-11', publicKey: 'c'.repeat(43), privateKey: {} as CryptoKey,
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('未登录 → 401，不调 api', async () => {
    h.getSession.mockResolvedValue(null);
    expect((await list('team1')).status).toBe(401);
    expect((await put('team1', 'idp', 'k1')).status).toBe(401);
    expect((await del('team1', 'idp', 'k1')).status).toBe(401);
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it('viewerCanListButNotPut：团队 viewer GET 200（canManage=false），PUT / DELETE 403', async () => {
    asUser('u-viewer');
    const res = await list('team1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      issuers: [ROW],
      cloudIssuer: { issuer: 'aster-cloud', kid: 'k-2026-11', publicKey: 'c'.repeat(43) },
      canManage: false,
    });
    expect(h.createClient).toHaveBeenCalledWith('team1', 'u-viewer');

    const denied = await put('team1', 'idp.example.com', '2026-11');
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe('forbidden');
    expect((await del('team1', 'idp.example.com', '2026-11')).status).toBe(403);
    expect(h.putFactIssuer).not.toHaveBeenCalled();
    expect(h.deleteFactIssuer).not.toHaveBeenCalled();
  });

  it('团队 member 只读：MEMBER_UPDATE_ROLE 只属 admin / owner', async () => {
    asUser('u-member');
    expect((await (await list('team1')).json()).canManage).toBe(false);
    expect((await put('team1', 'idp', 'k1')).status).toBe(403);
  });

  it('adminCanPutAndDelete：admin / owner PUT 200 返回签发方视图，DELETE 204 无体', async () => {
    for (const user of ['u-admin', 'u-owner']) {
      asUser(user);
      expect((await (await list('team1')).json()).canManage).toBe(true);

      const res = await put('team1', 'idp.example.com', '2026-11', {
        publicKey: PUBLIC_KEY, notAfter: '2027-01-01T00:00:00Z', enabled: true,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(ROW);
      expect(h.putFactIssuer).toHaveBeenLastCalledWith('idp.example.com', '2026-11', {
        publicKey: PUBLIC_KEY, notAfter: '2027-01-01T00:00:00Z', enabled: true,
      });

      const gone = await del('team1', 'idp.example.com', '2026-11');
      expect(gone.status).toBe(204);
      expect(await gone.text()).toBe('');
      expect(h.deleteFactIssuer).toHaveBeenLastCalledWith('idp.example.com', '2026-11');
    }
  });

  it('PUT 只转发已知字段', async () => {
    asUser('u-admin');
    await put('team1', 'idp', 'k1', { publicKey: PUBLIC_KEY, alg: 'Ed25519', createdBy: 'someone-else' });
    expect(h.putFactIssuer).toHaveBeenCalledWith('idp', 'k1', { publicKey: PUBLIC_KEY });
  });

  it('personalTenantOwnerCanManage：tenantId = 本人 userId 时可读可写，不查团队成员关系', async () => {
    asUser('u-solo');
    const res = await list('u-solo');
    expect(res.status).toBe(200);
    expect((await res.json()).canManage).toBe(true);
    expect((await put('u-solo', 'aster-cloud', 'k-2026-11')).status).toBe(200);
    expect((await del('u-solo', 'aster-cloud', 'k-2026-11')).status).toBe(204);
    expect(h.createClient).toHaveBeenCalledWith('u-solo', 'u-solo');
  });

  it('otherUsersPersonalTenantIs403：他人的个人租户与非成员团队 → 403，不调 api', async () => {
    asUser('u-solo');
    for (const tenant of ['u-other', 'team1']) {
      const res = await list(tenant);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('forbidden');
      expect((await put(tenant, 'idp', 'k1')).status).toBe(403);
      expect((await del(tenant, 'idp', 'k1')).status).toBe(403);
    }
    expect(h.createClient).not.toHaveBeenCalled();
  });

  it('invalidIssuerNameIs400WithoutUpstreamCall：非法 issuer / kid → 400 invalid_issuer_name，不调 api', async () => {
    asUser('u-admin');
    for (const [issuer, kid] of [['..', 'k1'], ['a b', 'k1'], ['a%2f', 'k1'], ['idp', 'k#1'], ['idp', 'x'.repeat(65)], ['x'.repeat(256), 'k1']]) {
      for (const res of [await put('team1', issuer, kid), await del('team1', issuer, kid)]) {
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe('invalid_issuer_name');
      }
    }
    expect(h.putFactIssuer).not.toHaveBeenCalled();
    expect(h.deleteFactIssuer).not.toHaveBeenCalled();
  });

  it('PUT 请求体不合法 → 400 invalid_issuer，不调 api', async () => {
    asUser('u-admin');
    const bad: unknown[] = [
      '{not json', [], null, {}, { publicKey: 7 }, { publicKey: 'short' }, { publicKey: `${PUBLIC_KEY}==` },
      { publicKey: 'q'.repeat(42) + '+' }, { publicKey: PUBLIC_KEY, enabled: 'yes' }, { publicKey: PUBLIC_KEY, notAfter: 5 },
      { publicKey: PUBLIC_KEY, notAfter: 'tomorrow' },
    ];
    for (const body of bad) {
      const res = await put('team1', 'idp', 'k1', body === null ? 'null' : body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_issuer');
    }
    expect(h.putFactIssuer).not.toHaveBeenCalled();
    // 带填充的 43 字符公钥 api 容忍，cloud 同样放行
    expect((await put('team1', 'idp', 'k1', { publicKey: `${PUBLIC_KEY}=` })).status).toBe(200);
  });

  it('上游 409 issuer_key_conflict / issuer_revoked 与 400 invalid_issuer 按原状态码透传，中文 message 换成英文', async () => {
    asUser('u-admin');
    const cases: Array<[number, string]> = [[409, 'issuer_key_conflict'], [409, 'issuer_revoked'], [400, 'invalid_issuer']];
    for (const [status, code] of cases) {
      h.putFactIssuer.mockRejectedValueOnce(new PolicyApiError('该 kid 已登记不同的公钥', status, code));
      const res = await put('team1', 'idp', 'k1');
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.error).toBe(code);
      expect(body.message).not.toMatch(/[一-鿿]/);
    }
  });

  it('上游 DELETE 404（空体）→ 404', async () => {
    asUser('u-admin');
    h.deleteFactIssuer.mockRejectedValueOnce(new PolicyApiError('HTTP 404: Not Found', 404));
    const res = await del('team1', 'idp', 'k1');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('issuer_not_found');
  });

  it('deleteReceiptUnavailableIs503Retryable：上游 503 receipt_unavailable → 503 原码', async () => {
    asUser('u-admin');
    h.deleteFactIssuer.mockRejectedValueOnce(new PolicyApiError('审计链不可用', 503, 'receipt_unavailable'));
    const res = await del('team1', 'idp', 'k1');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('receipt_unavailable');
    expect(body.message).toBe(
      'The issuer is disabled, but updating the approvals that depend on it did not finish. Retry to complete it.',
    );
    expect(body.retryable).toBe(true);
  });

  it('upstreamTimeoutIs502WithRequestId：408 / 5xx / 网络错误 → 502 upstream_unavailable 带 requestId', async () => {
    asUser('u-admin');
    const failures = [
      new PolicyApiError('Request timeout', 408, 'TIMEOUT'),
      new PolicyApiError('boom', 500, 'UNKNOWN'),
      new PolicyApiError('bad gateway', 503),
    ];
    for (const failure of failures) {
      h.listFactIssuers.mockRejectedValueOnce(failure);
      const res = await list('team1');
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe('upstream_unavailable');
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.headers.get('x-request-id')).toBe(body.requestId);
    }
    h.putFactIssuer.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await put('team1', 'idp', 'k1')).status).toBe(502);
  });

  it('cloudIssuerNullWithoutSigningKey：未配置或自检失败的平台密钥 → cloudIssuer null，列表照常', async () => {
    asUser('u-admin');
    h.loadFactSigningKey.mockResolvedValue(null);
    const res = await list('team1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuers: [ROW], cloudIssuer: null, canManage: true });
  });
});
