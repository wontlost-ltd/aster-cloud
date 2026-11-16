// ADR 0058 §4.10：平台管理员的能力授权接口（授予 / 撤销 / 额度），只测路由层：鉴权、写闸、载荷校验、错误映射。
// 写服务 grants.ts 整体 mock；真实 SQL 由 capability-grants.integration.test.ts 覆盖。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn() }));
vi.mock('@/lib/capabilities/grants', () => ({
  grantToSubject: vi.fn(),
  revokeGrant: vi.fn(),
  setTeamAllotment: vi.fn(),
  countActiveSeats: vi.fn(),
}));
vi.mock('@/lib/capabilities/resolve', () => ({ listGrantSources: vi.fn() }));
vi.mock('@/db/fresh-read', () => ({ freshDb: {} }));

import { DELETE, GET, POST } from '@/app/api/admin/capabilities/[capability]/grants/route';
import { PUT } from '@/app/api/admin/capabilities/[capability]/teams/[teamId]/allotment/route';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { grantToSubject, revokeGrant, setTeamAllotment } from '@/lib/capabilities/grants';
import { CapabilityError } from '@/lib/capabilities/errors';

const CAP = 'structured_authoring';
const BASE = `http://localhost/api/admin/capabilities/${CAP}/grants`;

function req(method: string, body?: unknown, url = BASE) {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const grantParams = (capability = CAP) => ({ params: Promise.resolve({ capability }) });
const allotParams = (capability = CAP) => ({ params: Promise.resolve({ capability, teamId: 'team-1' }) });
const GRANT = { id: 'g-1', capability: CAP, userId: 'u-1', teamId: null };

describe('/api/admin/capabilities/[capability]/grants 与 allotment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ userId: 'admin-1' });
    vi.mocked(requireLicenseWriteOk).mockResolvedValue(null);
  });

  it('非管理员：GET / POST / DELETE / PUT 均 403，不调用写服务', async () => {
    const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    vi.mocked(requireAdmin).mockImplementation(async () => forbidden());
    expect((await GET(req('GET'), grantParams())).status).toBe(403);
    expect((await POST(req('POST', { subjectType: 'user', subjectId: 'u-1' }), grantParams())).status).toBe(403);
    expect((await DELETE(req('DELETE', { grantId: 'g-1' }), grantParams())).status).toBe(403);
    expect((await PUT(req('PUT', { seatCap: 1, ownerGrantingEnabled: true }), allotParams())).status).toBe(403);
    expect(grantToSubject).not.toHaveBeenCalled();
    expect(revokeGrant).not.toHaveBeenCalled();
    expect(setTeamAllotment).not.toHaveBeenCalled();
  });

  it('requireLicenseWriteOk 返回响应时 POST / DELETE / PUT 原样返回它', async () => {
    const gate = NextResponse.json({ error: 'read_only' }, { status: 423 });
    vi.mocked(requireLicenseWriteOk).mockResolvedValue(gate);
    expect(await POST(req('POST', { subjectType: 'user', subjectId: 'u-1' }), grantParams())).toBe(gate);
    expect(await DELETE(req('DELETE', { grantId: 'g-1' }), grantParams())).toBe(gate);
    expect(await PUT(req('PUT', { seatCap: 1, ownerGrantingEnabled: true }), allotParams())).toBe(gate);
    expect(grantToSubject).not.toHaveBeenCalled();
    expect(revokeGrant).not.toHaveBeenCalled();
    expect(setTeamAllotment).not.toHaveBeenCalled();
  });

  it('未注册能力 → 404 unknown_capability（四个方法）', async () => {
    const responses = [
      await GET(req('GET'), grantParams('unknown')),
      await POST(req('POST', { subjectType: 'user', subjectId: 'u-1' }), grantParams('unknown')),
      await DELETE(req('DELETE', { grantId: 'g-1' }), grantParams('unknown')),
      await PUT(req('PUT', { seatCap: 1, ownerGrantingEnabled: true }), allotParams('unknown')),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'unknown_capability', code: 'unknown_capability' });
    }
  });

  it.each([
    ['subjectType 为 org', { subjectType: 'org', subjectId: 'u-1' }],
    ['subjectId 为空', { subjectType: 'user', subjectId: '' }],
    ['note 501 字符', { subjectType: 'user', subjectId: 'u-1', note: 'x'.repeat(501) }],
    ['note 非字符串', { subjectType: 'team', subjectId: 't-1', note: 5 }],
  ])('POST %s → 400 invalid_payload', async (_label, body) => {
    const res = await POST(req('POST', body), grantParams());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_payload');
    expect(grantToSubject).not.toHaveBeenCalled();
  });

  it('POST 非 JSON 正文 → 400 invalid_payload', async () => {
    const bad = new Request(BASE, { method: 'POST', body: '{not json' });
    const res = await POST(bad, grantParams());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_payload');
  });

  it('POST 新建 → 201，已存在 → 200；note 500 字符可通过', async () => {
    vi.mocked(grantToSubject).mockResolvedValueOnce({ grant: GRANT, created: true } as never);
    const note = 'x'.repeat(500);
    const created = await POST(req('POST', { subjectType: 'user', subjectId: 'u-1', note }), grantParams());
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ grant: GRANT });
    expect(grantToSubject).toHaveBeenCalledWith({
      capability: CAP,
      subject: { type: 'user', id: 'u-1' },
      grantedBy: 'admin-1',
      note,
    });

    vi.mocked(grantToSubject).mockResolvedValueOnce({ grant: GRANT, created: false } as never);
    const existing = await POST(req('POST', { subjectType: 'team', subjectId: 't-1' }), grantParams());
    expect(existing.status).toBe(200);
    expect(vi.mocked(grantToSubject).mock.calls[1][0]).toEqual({
      capability: CAP,
      subject: { type: 'team', id: 't-1' },
      grantedBy: 'admin-1',
    });
  });

  it('DELETE 校验 grantId，成功时以 manual 原因撤销并返回 200 { grant }', async () => {
    const bad = await DELETE(req('DELETE', { grantId: 42 }), grantParams());
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('invalid_payload');

    vi.mocked(revokeGrant).mockResolvedValueOnce(GRANT as never);
    const res = await DELETE(req('DELETE', { grantId: 'g-1' }), grantParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grant: GRANT });
    expect(revokeGrant).toHaveBeenCalledWith({
      grantId: 'g-1',
      revokedBy: 'admin-1',
      reason: 'manual',
      expectCapability: CAP,
    });
  });

  it.each([
    ['seatCap 1.5', { seatCap: 1.5, ownerGrantingEnabled: true }],
    ['seatCap -1', { seatCap: -1, ownerGrantingEnabled: true }],
    ['seatCap 10001', { seatCap: 10001, ownerGrantingEnabled: true }],
    ['seatCap 字符串', { seatCap: '3', ownerGrantingEnabled: true }],
    ['ownerGrantingEnabled 缺失', { seatCap: 3 }],
  ])('PUT %s → 400 invalid_payload', async (_label, body) => {
    const res = await PUT(req('PUT', body), allotParams());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_payload');
    expect(setTeamAllotment).not.toHaveBeenCalled();
  });

  it('PUT 合法载荷 → 200 { allotment }', async () => {
    const allotment = { capability: CAP, teamId: 'team-1', seatCap: 10000, ownerGrantingEnabled: false };
    vi.mocked(setTeamAllotment).mockResolvedValueOnce(allotment as never);
    const res = await PUT(req('PUT', { seatCap: 10000, ownerGrantingEnabled: false }), allotParams());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allotment });
    expect(setTeamAllotment).toHaveBeenCalledWith({
      capability: CAP,
      teamId: 'team-1',
      seatCap: 10000,
      ownerGrantingEnabled: false,
      updatedBy: 'admin-1',
    });
  });

  it('CapabilityError 按 status / code 转成 JSON 响应', async () => {
    vi.mocked(grantToSubject).mockRejectedValueOnce(new CapabilityError('subject_not_found'));
    const notFound = await POST(req('POST', { subjectType: 'user', subjectId: 'gone' }), grantParams());
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: 'subject_not_found', code: 'subject_not_found' });

    vi.mocked(revokeGrant).mockRejectedValueOnce(new CapabilityError('grant_not_found'));
    const missing = await DELETE(req('DELETE', { grantId: 'g-x' }), grantParams());
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('grant_not_found');

    vi.mocked(setTeamAllotment).mockRejectedValueOnce(
      new CapabilityError('seat_cap_below_active', undefined, 'seatCap 1 is below 3 active delegated seats'),
    );
    const below = await PUT(req('PUT', { seatCap: 1, ownerGrantingEnabled: true }), allotParams());
    expect(below.status).toBe(409);
    expect(await below.json()).toEqual({
      error: 'seatCap 1 is below 3 active delegated seats',
      code: 'seat_cap_below_active',
    });

    vi.mocked(setTeamAllotment).mockRejectedValueOnce(new CapabilityError('delegation_not_supported'));
    const unsupported = await PUT(req('PUT', { seatCap: 1, ownerGrantingEnabled: true }), allotParams());
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).code).toBe('delegation_not_supported');
  });

  it('非 CapabilityError 不被吞成 4xx', async () => {
    vi.mocked(grantToSubject).mockRejectedValueOnce(new Error('db down'));
    await expect(POST(req('POST', { subjectType: 'user', subjectId: 'u-1' }), grantParams())).rejects.toThrow('db down');
  });

  it.each([
    ['subject=org', `${BASE}?subject=org`],
  ])('GET %s → 400 invalid_payload', async (_label, url) => {
    const res = await GET(req('GET', undefined, url), grantParams());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_payload');
  });
});
