// /api/pilot-applications —— 落地页试点申请
//
// 不变量：仅 SaaS；蜜罐字段非空静默丢弃（同形 200，不落库不记事件）；按 IP 限流；
// 合法提交落库 + 记 pilot_application_submitted（不含邮箱）；非法字段 400 并指出字段名。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  insert: vi.fn(),
  recent: vi.fn(),
  record: vi.fn(),
  notify: vi.fn(),
  isSaas: true,
}));

vi.mock('@/lib/deployment-mode', async () => {
  const actual = await vi.importActual<typeof import('@/lib/deployment-mode')>('@/lib/deployment-mode');
  return {
    ...actual,
    get IS_SAAS() {
      return mocks.isSaas;
    },
  };
});
vi.mock('@/lib/rate-limit-distributed', () => ({ checkRateLimitDistributed: mocks.rate }));
vi.mock('@/lib/email/pilot-application-notification', () => ({ notifyPilotApplication: mocks.notify }));
vi.mock('@/lib/product-events/server', () => ({ recordProductEventAfterResponse: mocks.record }));
vi.mock('@/lib/pilot-applications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pilot-applications')>('@/lib/pilot-applications');
  return { ...actual, insertPilotApplication: mocks.insert, hasRecentPilotApplication: mocks.recent };
});

import { POST } from '@/app/api/pilot-applications/route';

const valid = {
  email: 'jane@insurer.example',
  company: 'Example Mutual',
  role: 'actuarial_pricing',
  useCases: ['insurance_rating'],
  consent: true,
  page: 'insurance-rating',
  locale: 'en',
  attribution: { utmSource: 'linkedin', referrerHost: 'www.linkedin.com' },
  website: '',
};

function req(body: unknown) {
  return new Request('https://aster-lang.cloud/api/pilot-applications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.4' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSaas = true;
  mocks.rate.mockResolvedValue({ allowed: true, remaining: 4, resetAt: Date.now() + 3_600_000 });
  mocks.insert.mockResolvedValue('app-1');
  mocks.recent.mockResolvedValue(false);
  mocks.notify.mockResolvedValue(undefined);
});

describe('POST /api/pilot-applications', () => {
  it('合法提交 → 201，落库并记事件（事件不含邮箱与公司）', async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(201);
    expect(mocks.rate).toHaveBeenCalledWith('pilot-application:198.51.100.4', { windowMs: 3_600_000, maxRequests: 5 });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
      email: 'jane@insurer.example', emailDomain: 'insurer.example', freeMailDomain: false,
      landingPage: 'insurance-rating', utmSource: 'linkedin', referrerHost: 'www.linkedin.com',
    }));
    expect(mocks.record).toHaveBeenCalledWith('pilot_application_submitted', {
      properties: {
        page: 'insurance-rating', locale: 'en', freeMailDomain: false,
        utmSource: 'linkedin', referrerHost: 'www.linkedin.com',
      },
    });
    const eventJson = JSON.stringify(mocks.record.mock.calls);
    expect(eventJson).not.toContain('jane');
    expect(eventJson).not.toContain('Example Mutual');
  });

  it('蜜罐字段被填 → 同形 200，不落库不记事件', async () => {
    const res = await POST(req({ ...valid, website: 'http://spam.example' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('非法字段 → 400 + 字段名', async () => {
    const res = await POST(req({ ...valid, consent: false }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_field', field: 'consent' });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('坏 JSON → 400；超大 body → 413', async () => {
    expect((await POST(req('{oops'))).status).toBe(400);
    expect((await POST(req({ ...valid, painPoint: 'x'.repeat(20_000) }))).status).toBe(413);
  });

  it('超限 → 429 + Retry-After', async () => {
    mocks.rate.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 1000, retryAfterSeconds: 60 });
    const res = await POST(req(valid));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('on-prem → 404', async () => {
    mocks.isSaas = false;
    const res = await POST(req(valid));
    expect(res.status).toBe(404);
    expect(mocks.rate).not.toHaveBeenCalled();
  });

  it('落库失败 → 500，不记事件', async () => {
    mocks.insert.mockRejectedValue(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await POST(req(valid));
    expect(res.status).toBe(500);
    expect(mocks.record).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('同一邮箱 24 小时内重复提交 → 201 但不落新行、不记事件', async () => {
    mocks.recent.mockResolvedValue(true);
    const res = await POST(req(valid));
    expect(res.status).toBe(201);
    expect(mocks.recent).toHaveBeenCalledWith('jane@insurer.example');
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('落库成功 → 响应之后发一次内部通知（带完整规范化申请）', async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({
      email: 'jane@insurer.example', company: 'Example Mutual', landingPage: 'insurance-rating',
    }));
  });

  it('重复提交 / 蜜罐 / 非法字段 / 限流 / 落库失败 / on-prem → 都不通知', async () => {
    mocks.recent.mockResolvedValueOnce(true);
    await POST(req(valid));
    await POST(req({ ...valid, website: 'http://spam.example' }));
    await POST(req({ ...valid, consent: false }));
    mocks.rate.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: Date.now() + 1000 });
    await POST(req(valid));
    mocks.insert.mockRejectedValueOnce(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await POST(req(valid));
    err.mockRestore();
    mocks.isSaas = false;
    await POST(req(valid));
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it('通知失败（同步抛错或拒绝）不影响 201', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.notify.mockRejectedValueOnce(new Error('resend down'));
    expect((await POST(req(valid))).status).toBe(201);
    mocks.notify.mockImplementationOnce(() => { throw new Error('boom'); });
    expect((await POST(req(valid))).status).toBe(201);
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(2));
    err.mockRestore();
  });
});
