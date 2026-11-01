// /api/pilot-applications —— 落地页试点申请
//
// 不变量：仅 SaaS；蜜罐字段非空静默丢弃（同形 200，不落库不记事件）；按 IP 限流；
// 合法提交落库 + 记 pilot_application_submitted（不含邮箱）；非法字段 400 并指出字段名。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  insert: vi.fn(),
  record: vi.fn(),
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
vi.mock('@/lib/product-events/server', () => ({ recordProductEventAfterResponse: mocks.record }));
vi.mock('@/lib/pilot-applications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pilot-applications')>('@/lib/pilot-applications');
  return { ...actual, insertPilotApplication: mocks.insert };
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
});
