// 导出为 Cedar 路由（ADR 0047 §6）：POST /api/policies/[id]/export/cedar。
// 仅策略所有者可导出；导出 secure-execute 会执行的版本（无则 409），走源码模式并附 claimedRef；
// 上游忙 503 原样透传，其余上游错误 502。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  findFirst: vi.fn(),
  findExecutable: vi.fn(),
  exportCedar: vi.fn(),
  createClient: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: () => h.getSession() }));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policies: { findFirst: (...a: unknown[]) => h.findFirst(...a) },
    },
  },
  policies: { id: { name: 'policies.id' }, userId: { name: 'policies.userId' }, deletedAt: { name: 'policies.deletedAt' } },
}));
vi.mock('@/services/security/secure-executor', () => ({
  findDefaultExecutableVersion: (...a: unknown[]) => h.findExecutable(...a),
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

const { findFirst, findExecutable, exportCedar, getSession } = h;
const owned = (over: Record<string, unknown> = {}) => ({ id: 'p1', userId: 'u1', teamId: null, ...over });
const executable = (over: Record<string, unknown> = {}) =>
  ({ version: 1, source: 'Module m.', content: 'Module m.', aliasSet: null, ...over });
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
    expect(where).toContain(JSON.stringify({ isNull: 'policies.deletedAt' }));
  });

  it('409 when no version is executable (drafts are never exported)', async () => {
    findFirst.mockResolvedValue(owned());
    findExecutable.mockResolvedValue(null);
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no executable version' });
    expect(findExecutable).toHaveBeenCalledWith('p1');
    expect(exportCedar).not.toHaveBeenCalled();
  });

  it('exports the executable version: its source, aliasSet, detected locale and version in claimedRef', async () => {
    findFirst.mockResolvedValue(owned());
    findExecutable.mockResolvedValue(executable({
      version: 3, source: 'Module approved.\n…', content: 'stale', aliasSet: JSON.stringify({ IF: ['when'] }) }));
    exportCedar.mockResolvedValue({ exportable: true, policies: 'permit…', schema: {}, probes: { count: 4, agreed: 4 }, diagnostics: [] });
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(200);
    expect(exportCedar).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Module approved.\n…', aliasSet: { IF: ['when'] }, claimedRef: { cloudPolicyId: 'p1', version: '3' } }));
    expect(exportCedar.mock.calls[0][0].locale).toBe('en-US');
    expect(h.createClient).toHaveBeenCalledWith('u1', 'u1');
    expect(await res.json()).toEqual({ exportable: true, policies: 'permit…', schema: {}, probes: { count: 4, agreed: 4 }, diagnostics: [] });
  });

  it('falls back to content when the executable version has no source column', async () => {
    findFirst.mockResolvedValue(owned());
    findExecutable.mockResolvedValue(executable({ version: 2, source: null, content: 'Module legacy.' }));
    exportCedar.mockResolvedValue({ exportable: false, diagnostics: [] });
    await POST(req(), ctx('p1'));
    expect(exportCedar.mock.calls[0][0]).toMatchObject({ source: 'Module legacy.', claimedRef: { version: '2' } });
  });

  it('detects zh locale from source; team policy signs as the team tenant', async () => {
    findFirst.mockResolvedValue(owned({ teamId: 't9' }));
    findExecutable.mockResolvedValue(executable({ source: '模块 m。' }));
    exportCedar.mockResolvedValue({ exportable: false, policies: null, schema: null, diagnostics: [] });
    await POST(req(), ctx('p1'));
    expect(exportCedar.mock.calls[0][0]).toMatchObject({ locale: 'zh-CN', aliasSet: null });
    expect(h.createClient).toHaveBeenCalledWith('t9', 'u1');
  });

  it('malformed stored aliasSet degrades to null', async () => {
    findFirst.mockResolvedValue(owned());
    findExecutable.mockResolvedValue(executable({ aliasSet: '{not json' }));
    exportCedar.mockResolvedValue({ exportable: false, diagnostics: [] });
    expect((await POST(req(), ctx('p1'))).status).toBe(200);
    expect(exportCedar.mock.calls[0][0].aliasSet).toBeNull();
  });

  it('omits claimedRef when the id falls outside the allowed charset', async () => {
    const odd = 'p 1#';
    findFirst.mockResolvedValue(owned({ id: odd }));
    findExecutable.mockResolvedValue(executable({ version: 2 }));
    exportCedar.mockResolvedValue({ exportable: false, diagnostics: [] });
    expect((await POST(req(), ctx(odd))).status).toBe(200);
    expect(exportCedar.mock.calls[0][0]).not.toHaveProperty('claimedRef');
  });

  it('502 on upstream error', async () => {
    findFirst.mockResolvedValue(owned());
    findExecutable.mockResolvedValue(executable());
    exportCedar.mockRejectedValue(new PolicyApiError('upstream down', 503));
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: 'upstream down' });
  });

  it('502 when upstream rejects our identity (401/403 is a server misconfiguration)', async () => {
    findFirst.mockResolvedValue(owned());
    findExecutable.mockResolvedValue(executable());
    exportCedar.mockRejectedValue(new PolicyApiError('unauthenticated', 401));
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, error: 'unauthenticated' });
  });

  it('503 cedar_export_busy passes through with body and Retry-After', async () => {
    findFirst.mockResolvedValue(owned());
    findExecutable.mockResolvedValue(executable());
    const body = { error: 'cedar_export_busy', message: 'Cedar export is busy', concurrencyLimit: 2 };
    exportCedar.mockRejectedValue(new PolicyApiError(body.message, 503, body.error, undefined, body, '1'));
    const res = await POST(req(), ctx('p1'));
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(await res.json()).toEqual(body);
  });
});
