// 导出为 Cedar 路由（ADR 0047 §6）：POST /api/policies/[id]/export/cedar。
// 仅策略所有者可导出；走源码模式并附 claimedRef；上游忙 503 原样透传，其余上游错误 502。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  findFirst: vi.fn(),
  versionFindFirst: vi.fn(),
  exportCedar: vi.fn(),
  createClient: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: () => h.getSession() }));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policies: { findFirst: (...a: unknown[]) => h.findFirst(...a) },
      policyVersions: { findFirst: (...a: unknown[]) => h.versionFindFirst(...a) },
    },
  },
  policies: { id: { name: 'policies.id' }, userId: { name: 'policies.userId' }, deletedAt: { name: 'policies.deletedAt' } },
  policyVersions: { policyId: { name: 'pv.policyId' }, version: { name: 'pv.version' } },
}));
// where 条件以可检查的结构表达，供归属（owner-only）断言
vi.mock('drizzle-orm', () => ({
  eq: (col: { name: string }, v: unknown) => ({ eq: [col.name, v] }),
  and: (...c: unknown[]) => ({ and: c }),
  isNull: (col: { name: string }) => ({ isNull: col.name }),
}));
vi.mock('@/lib/policy-api-identity', () => ({
  createPolicyApiClientForUser: (...a: unknown[]) => h.createClient(...a),
}));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: (...a: unknown[]) => h.checkRateLimit(...a),
}));

import { POST } from '@/app/api/policies/[id]/export/cedar/route';
import { PolicyApiError } from '@/services/policy/policy-api';
import { RateLimitPresets } from '@/lib/rate-limit';

const { findFirst, versionFindFirst, exportCedar, getSession } = h;
const req = () => new Request('http://localhost/api/policies/p1/export/cedar', { method: 'POST' });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { id: 'u1' } });
  h.checkRateLimit.mockReturnValue({ allowed: true, remaining: 19, resetAt: Date.now() + 60_000 });
  h.createClient.mockResolvedValue({ exportCedar });
});

describe('POST /api/policies/[id]/export/cedar', () => {
  it('401 without session', async () => {
    getSession.mockResolvedValue(null);
    expect((await POST(req(), ctx('p1'))).status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('429 when rate limited, keyed per user on EVALUATE_SOURCE', async () => {
    h.checkRateLimit.mockReturnValue({ allowed: false, remaining: 0, resetAt: Date.now() + 1000, retryAfterSeconds: 3 });
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(429);
    expect(res.headers.get('X-RateLimit-Limit')).not.toBeNull();
    expect(h.checkRateLimit).toHaveBeenCalledWith('policy-cedar-export:u1', RateLimitPresets.EVALUATE_SOURCE);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('404 when policy not owned', async () => {
    findFirst.mockResolvedValue(undefined);
    expect((await POST(req(), ctx('p1'))).status).toBe(404);
    expect(exportCedar).not.toHaveBeenCalled();
  });

  it('ownership query constrains id and owner userId', async () => {
    findFirst.mockResolvedValue(undefined);
    await POST(req(), ctx('p1'));
    const where = JSON.stringify(findFirst.mock.calls[0][0].where);
    expect(where).toContain(JSON.stringify({ eq: ['policies.id', 'p1'] }));
    expect(where).toContain(JSON.stringify({ eq: ['policies.userId', 'u1'] }));
  });

  it('forwards source, detected locale, aliasSet and claimedRef', async () => {
    findFirst.mockResolvedValue({ id: 'p1', userId: 'u1', teamId: null, content: 'Module m.\n…', version: 3 });
    versionFindFirst.mockResolvedValue({ aliasSet: JSON.stringify({ IF: ['when'] }) });
    exportCedar.mockResolvedValue({ exportable: true, policies: 'permit…', schema: {}, probes: { count: 4, agreed: 4 }, diagnostics: [] });
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(200);
    expect(exportCedar).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Module m.\n…', aliasSet: { IF: ['when'] }, claimedRef: { cloudPolicyId: 'p1', version: '3' } }));
    expect(exportCedar.mock.calls[0][0].locale).toBe('en-US');
    expect(h.createClient).toHaveBeenCalledWith('u1', 'u1');
    expect(await res.json()).toEqual({ exportable: true, policies: 'permit…', schema: {}, probes: { count: 4, agreed: 4 }, diagnostics: [] });
  });

  it('detects zh locale from content; team policy signs as the team tenant', async () => {
    findFirst.mockResolvedValue({ id: 'p1', userId: 'u1', teamId: 't9', content: '模块 m。', version: 1 });
    versionFindFirst.mockResolvedValue(undefined);
    exportCedar.mockResolvedValue({ exportable: false, policies: null, schema: null, diagnostics: [] });
    await POST(req(), ctx('p1'));
    expect(exportCedar.mock.calls[0][0]).toMatchObject({ locale: 'zh-CN', aliasSet: null });
    expect(h.createClient).toHaveBeenCalledWith('t9', 'u1');
  });

  it('malformed stored aliasSet degrades to null', async () => {
    findFirst.mockResolvedValue({ id: 'p1', userId: 'u1', teamId: null, content: 'Module m.', version: 1 });
    versionFindFirst.mockResolvedValue({ aliasSet: '{not json' });
    exportCedar.mockResolvedValue({ exportable: false, diagnostics: [] });
    expect((await POST(req(), ctx('p1'))).status).toBe(200);
    expect(exportCedar.mock.calls[0][0].aliasSet).toBeNull();
  });

  it('omits claimedRef when the id falls outside the allowed charset', async () => {
    const odd = 'p 1#';
    findFirst.mockResolvedValue({ id: odd, userId: 'u1', teamId: null, content: 'Module m.', version: 2 });
    versionFindFirst.mockResolvedValue(undefined);
    exportCedar.mockResolvedValue({ exportable: false, diagnostics: [] });
    expect((await POST(req(), ctx(odd))).status).toBe(200);
    expect(exportCedar.mock.calls[0][0]).not.toHaveProperty('claimedRef');
  });

  it('502 on upstream error', async () => {
    findFirst.mockResolvedValue({ id: 'p1', userId: 'u1', content: 'Module m.', version: 1 });
    versionFindFirst.mockResolvedValue({ aliasSet: null });
    exportCedar.mockRejectedValue(new PolicyApiError('upstream down', 503));
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: 'upstream down' });
  });

  it('502 when upstream rejects our identity (401/403 is a server misconfiguration)', async () => {
    findFirst.mockResolvedValue({ id: 'p1', userId: 'u1', content: 'Module m.', version: 1 });
    versionFindFirst.mockResolvedValue(undefined);
    exportCedar.mockRejectedValue(new PolicyApiError('unauthenticated', 401));
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: 'unauthenticated' });
  });

  it('503 cedar_export_busy passes through with body and Retry-After', async () => {
    findFirst.mockResolvedValue({ id: 'p1', userId: 'u1', content: 'Module m.', version: 1 });
    versionFindFirst.mockResolvedValue(undefined);
    const body = { error: 'cedar_export_busy', message: 'Cedar export is busy', concurrencyLimit: 2 };
    exportCedar.mockRejectedValue(new PolicyApiError(body.message, 503, body.error, undefined, body, '1'));
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(await res.json()).toEqual(body);
  });
});
