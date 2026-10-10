// 源码编译代理（POST /api/policies/compile）：编辑器在浏览器端编译，此路由只为 IDE 风格诊断服务；
// 先限流再解析请求体，非法请求体也计入额度并带限流头。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { compile, checkRateLimit } = vi.hoisted(() => ({
  compile: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/services/policy/policy-api', () => ({ createPolicyApiClient: () => ({ compile }) }));
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: (...a: unknown[]) => checkRateLimit(...a),
}));

import { POST } from '@/app/api/policies/compile/route';
import { getSession } from '@/lib/auth';
import { RateLimitPresets } from '@/lib/rate-limit';

function call(body: string) {
  return POST(new Request('http://localhost/api/policies/compile', { method: 'POST', body }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ user: { id: 'u-1' } } as never);
  checkRateLimit.mockReturnValue({ allowed: true, remaining: 1, resetAt: Date.now() + 1000 });
  compile.mockResolvedValue({ success: true, diagnostics: [] });
});

describe('POST /api/policies/compile', () => {
  it('以 source + locale 调上游，响应原样返回', async () => {
    const r = await call(JSON.stringify({ source: 'Module X.', locale: 'de-DE' }));
    expect(r.status).toBe(200);
    expect(compile).toHaveBeenCalledWith({ source: 'Module X.', locale: 'de-DE' });
  });

  it('所有请求共用 policy-compile 桶（EVALUATE_SOURCE 限额）', async () => {
    await call(JSON.stringify({ source: 'Module X.', purpose: 'profile' }));
    expect(checkRateLimit).toHaveBeenCalledWith('policy-compile:u-1', RateLimitPresets.EVALUATE_SOURCE);
  });

  it('先限流再解析：非法 JSON 也计入额度，400 带限流头', async () => {
    const r = await call('{not json');
    expect(r.status).toBe(400);
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(r.headers.get('X-RateLimit-Limit')).not.toBeNull();
    expect(compile).not.toHaveBeenCalled();
  });

  it('超出额度 → 429，不解析请求体也不调上游', async () => {
    checkRateLimit.mockReturnValue({ allowed: false, remaining: 0, resetAt: Date.now() + 1000, retryAfterSeconds: 3 });
    const r = await call('{not json');
    expect(r.status).toBe(429);
    expect(compile).not.toHaveBeenCalled();
  });
});
