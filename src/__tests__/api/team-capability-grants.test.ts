// ADR 0058 §4.6 / §4.10：团队 owner 委派接口，只测路由层：会话、owner 判定、写闸、载荷校验、错误映射。
// 写服务 grants.ts 整体 mock；真实 SQL 由 capability-delegation.integration.test.ts 覆盖。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn() }));
vi.mock('@/lib/capabilities/grants', () => ({
  delegateToMember: vi.fn(),
  revokeGrant: vi.fn(),
  listTeamDelegations: vi.fn(),
  isTeamDelegationOpen: vi.fn(),
}));
const teamLookup = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('@/db/fresh-read', () => ({ freshDb: { query: { teams: teamLookup } } }));

import { DELETE, GET, POST } from '@/app/api/teams/[teamId]/capabilities/[capability]/grants/route';
import { getSession } from '@/lib/auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { delegateToMember, isTeamDelegationOpen, listTeamDelegations, revokeGrant } from '@/lib/capabilities/grants';
import { CapabilityError } from '@/lib/capabilities/errors';

const CAP = 'structured_authoring';
const TEAM = 'team-1';
const OWNER = 'owner-1';
const BASE = `http://localhost/api/teams/${TEAM}/capabilities/${CAP}/grants`;

function req(method: string, body?: unknown) {
  return new Request(BASE, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (capability = CAP) => ({ params: Promise.resolve({ teamId: TEAM, capability }) });
const GRANT = { id: 'g-1', capability: CAP, userId: 'u-1', delegatingTeamId: TEAM };

const signIn = (userId: string | null) =>
  vi.mocked(getSession).mockResolvedValue((userId ? { user: { id: userId } } : null) as never);

describe('/api/teams/[teamId]/capabilities/[capability]/grants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn(OWNER);
    vi.mocked(requireLicenseWriteOk).mockResolvedValue(null);
    teamLookup.findFirst.mockResolvedValue({ ownerId: OWNER });
  });

  it('未登录 → 401，不调用写服务', async () => {
    signIn(null);
    expect((await GET(req('GET'), params())).status).toBe(401);
    expect((await POST(req('POST', { userId: 'u-1' }), params())).status).toBe(401);
    expect((await DELETE(req('DELETE', { grantId: 'g-1' }), params())).status).toBe(401);
    expect(delegateToMember).not.toHaveBeenCalled();
  });

  it.each([
    ['团队 admin（非 ownerId）', { ownerId: 'someone-else' }],
    ['团队不存在', undefined],
  ])('%s：GET / POST / DELETE 一律 403 not_team_owner', async (_label, team) => {
    signIn('admin-1');
    teamLookup.findFirst.mockResolvedValue(team);
    const responses = [
      await GET(req('GET'), params()),
      await POST(req('POST', { userId: 'u-1' }), params()),
      await DELETE(req('DELETE', { grantId: 'g-1' }), params()),
    ];
    for (const res of responses) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_team_owner', code: 'not_team_owner' });
    }
    expect(listTeamDelegations).not.toHaveBeenCalled();
    expect(delegateToMember).not.toHaveBeenCalled();
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it('写闸返回响应时 POST / DELETE 原样返回它；GET 不受写闸影响', async () => {
    const gate = NextResponse.json({ error: 'license-read-only-mode' }, { status: 503 });
    vi.mocked(requireLicenseWriteOk).mockResolvedValue(gate);
    vi.mocked(listTeamDelegations).mockResolvedValue({ allotment: null, seatsUsed: 0, delegations: [] });
    expect(await POST(req('POST', { userId: 'u-1' }), params())).toBe(gate);
    expect(await DELETE(req('DELETE', { grantId: 'g-1' }), params())).toBe(gate);
    expect((await GET(req('GET'), params())).status).toBe(200);
    expect(delegateToMember).not.toHaveBeenCalled();
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it('未注册能力 → 404 unknown_capability', async () => {
    for (const res of [
      await GET(req('GET'), params('unknown')),
      await POST(req('POST', { userId: 'u-1' }), params('unknown')),
      await DELETE(req('DELETE', { grantId: 'g-1' }), params('unknown')),
    ]) {
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('unknown_capability');
    }
  });

  it('GET：owner 拿到额度、已用座位与委派名单', async () => {
    const body = {
      allotment: { seatCap: 3, ownerGrantingEnabled: true },
      seatsUsed: 1,
      delegations: [
        { grantId: 'g-1', userId: 'u-1', email: 'a@x.io', name: 'A', role: 'member', grantedAt: '2026-11-17T00:00:00.000Z' },
      ],
    };
    vi.mocked(listTeamDelegations).mockResolvedValue(body as never);
    vi.mocked(isTeamDelegationOpen).mockResolvedValue(true);
    const res = await GET(req('GET'), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...body, delegationOpen: true });
    expect(listTeamDelegations).toHaveBeenCalledWith(CAP, TEAM);
    expect(isTeamDelegationOpen).toHaveBeenCalledWith(CAP, TEAM);
  });

  it('GET：委派不可行（全局开关关或额度未开放）→ delegationOpen=false', async () => {
    vi.mocked(listTeamDelegations).mockResolvedValue({ allotment: null, seatsUsed: 0, delegations: [] });
    vi.mocked(isTeamDelegationOpen).mockResolvedValue(false);
    expect((await (await GET(req('GET'), params())).json()).delegationOpen).toBe(false);
  });

  it.each([
    ['userId 缺失', {}],
    ['userId 为空', { userId: ' ' }],
    ['userId 非字符串', { userId: 5 }],
  ])('POST %s → 400 invalid_payload', async (_label, body) => {
    const res = await POST(req('POST', body), params());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_payload');
    expect(delegateToMember).not.toHaveBeenCalled();
  });

  it('POST 新建 → 201，已存在 → 200；以会话用户为 ownerId 调用写服务', async () => {
    vi.mocked(delegateToMember).mockResolvedValueOnce({ grant: GRANT, created: true } as never);
    const created = await POST(req('POST', { userId: 'u-1' }), params());
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ grant: GRANT });
    expect(delegateToMember).toHaveBeenCalledWith({ capability: CAP, teamId: TEAM, userId: 'u-1', ownerId: OWNER });

    vi.mocked(delegateToMember).mockResolvedValueOnce({ grant: GRANT, created: false } as never);
    expect((await POST(req('POST', { userId: 'u-1' }), params())).status).toBe(200);
  });

  it.each([
    ['seat_cap_reached', 409],
    ['team_delegation_disabled', 403],
    ['delegation_not_supported', 400],
    ['not_team_member', 400],
    ['viewer_not_eligible', 400],
    ['not_team_owner', 403],
  ] as const)('POST 写服务抛 %s → %d', async (code, status) => {
    vi.mocked(delegateToMember).mockRejectedValueOnce(new CapabilityError(code));
    const res = await POST(req('POST', { userId: 'u-1' }), params());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code, code });
  });

  it('DELETE：只撤本团队的委派行（expectDelegatingTeamId = 团队），reason = manual', async () => {
    vi.mocked(revokeGrant).mockResolvedValueOnce(GRANT as never);
    const res = await DELETE(req('DELETE', { grantId: 'g-1' }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grant: GRANT });
    expect(revokeGrant).toHaveBeenCalledWith({
      grantId: 'g-1',
      revokedBy: OWNER,
      reason: 'manual',
      expectCapability: CAP,
      expectDelegatingTeamId: TEAM,
    });
  });

  it('DELETE：别的团队的行 → 404 grant_not_found；grantId 缺失 → 400', async () => {
    vi.mocked(revokeGrant).mockRejectedValueOnce(new CapabilityError('grant_not_found'));
    const res = await DELETE(req('DELETE', { grantId: 'other-team-grant' }), params());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('grant_not_found');

    const bad = await DELETE(req('DELETE', {}), params());
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_payload');
  });
});
