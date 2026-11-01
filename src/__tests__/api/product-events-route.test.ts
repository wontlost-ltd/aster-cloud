// /api/product-events —— 浏览器侧产品事件上报
//
// 不变量：
//   - 只接受客户端白名单内的事件（服务端事件不能被伪造）
//   - actor 只来自会话，客户端传来的 userId 被忽略
//   - 属性交给服务端白名单过滤（由 recordProductEvent 负责，这里只验透传）
//   - 超限 429、坏 JSON 400、超大 body 413
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rate: vi.fn(),
  record: vi.fn(),
  isSaas: true,
}));

vi.mock('@/lib/deployment-mode', async () => {
  const actual = await vi.importActual<typeof import('@/lib/deployment-mode')>('@/lib/deployment-mode');
  return { ...actual, get IS_SAAS() { return mocks.isSaas; } };
});

vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/rate-limit-distributed', () => ({ checkRateLimitDistributed: mocks.rate }));
vi.mock('@/lib/product-events/server', () => ({ recordProductEventAfterResponse: mocks.record }));

import { POST } from '@/app/api/product-events/route';

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://aster-lang.cloud/api/product-events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.9',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rate.mockResolvedValue({ allowed: true, remaining: 100, resetAt: Date.now() + 60_000 });
  mocks.auth.mockResolvedValue(null);
  mocks.isSaas = true;
});

describe('POST /api/product-events', () => {
  it('匿名落地页访问：202，actor 为空', async () => {
    const res = await POST(req({ name: 'landing_viewed', properties: { page: 'insurance-rating' } }));
    expect(res.status).toBe(202);
    expect(mocks.record).toHaveBeenCalledWith('landing_viewed', {
      userId: null,
      properties: { page: 'insurance-rating' },
    });
    expect(mocks.rate).toHaveBeenCalledWith('product-events:203.0.113.9', expect.any(Object));
  });

  it('登录用户的事件 actor 取自会话，忽略 body 里的 userId', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'session-user' } });
    await POST(req({ name: 'template_selected', userId: 'forged', properties: { templateId: 'loan-evaluation' } }));
    expect(mocks.record).toHaveBeenCalledWith('template_selected', {
      userId: 'session-user',
      properties: { templateId: 'loan-evaluation' },
    });
  });

  it('拒绝服务端事件与未知事件', async () => {
    for (const name of ['signup_completed', 'policy_first_executed', 'evidence_exported', 'nope']) {
      const res = await POST(req({ name }));
      expect(res.status).toBe(400);
    }
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('坏 JSON → 400', async () => {
    const res = await POST(req('{not json'));
    expect(res.status).toBe(400);
  });

  it('超大 body → 413', async () => {
    const res = await POST(req({ name: 'landing_viewed', properties: { pad: 'x'.repeat(9_000) } }));
    expect(res.status).toBe(413);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('超限 → 429 且不记录', async () => {
    mocks.rate.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 1000, retryAfterSeconds: 1 });
    const res = await POST(req({ name: 'landing_viewed' }));
    expect(res.status).toBe(429);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('会话读取失败时按匿名记录', async () => {
    mocks.auth.mockRejectedValue(new Error('decoder'));
    const res = await POST(req({ name: 'approvals_inbox_viewed' }));
    expect(res.status).toBe(202);
    expect(mocks.record).toHaveBeenCalledWith('approvals_inbox_viewed', { userId: null, properties: undefined });
  });

  it('爬虫 UA → 同形 202 但不记录', async () => {
    const res = await POST(req({ name: 'landing_viewed' }, { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }));
    expect(res.status).toBe(202);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('on-prem → 404', async () => {
    mocks.isSaas = false;
    const res = await POST(req({ name: 'landing_viewed' }));
    expect(res.status).toBe(404);
    expect(mocks.rate).not.toHaveBeenCalled();
  });
});
