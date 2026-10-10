// 源码编译代理（POST /api/policies/compile）：aliasSet 透传给 aster-api，档案徽标用独立限流桶（ADR 0046 §6）。
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

function call(body: unknown) {
  return POST(new Request('http://localhost/api/policies/compile', { method: 'POST', body: JSON.stringify(body) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue({ user: { id: 'u-1' } } as never);
  checkRateLimit.mockReturnValue({ allowed: true, remaining: 1, resetAt: Date.now() + 1000 });
  compile.mockResolvedValue({ success: true, profile: 'governed' });
});

describe('POST /api/policies/compile', () => {
  it('aliasSet 透传给 client.compile，响应原样返回 profile', async () => {
    const aliasSet = { TIMES: ['multiplied by'] };
    const r = await call({ source: 'Module X.', locale: 'en-US', aliasSet });
    expect(r.status).toBe(200);
    expect(compile).toHaveBeenCalledWith({ source: 'Module X.', locale: 'en-US', aliasSet });
    expect((await r.json()).profile).toBe('governed');
  });

  it('未带 aliasSet → 以 null 调用', async () => {
    await call({ source: 'Module X.' });
    expect(compile).toHaveBeenCalledWith({ source: 'Module X.', locale: 'en-US', aliasSet: null });
  });

  it('aliasSet 形状非法 → 400，不调上游', async () => {
    const r = await call({ source: 'Module X.', aliasSet: { TIMES: 'x' } });
    expect(r.status).toBe(400);
    expect(compile).not.toHaveBeenCalled();
  });

  it('编辑器请求用 policy-compile 桶；purpose=profile 用 policy-profile 桶，限额相同', async () => {
    await call({ source: 'Module X.' });
    await call({ source: 'Module X.', purpose: 'profile' });
    expect(checkRateLimit.mock.calls.map((c) => c[0])).toEqual(['policy-compile:u-1', 'policy-profile:u-1']);
    expect(checkRateLimit.mock.calls.every((c) => c[1] === RateLimitPresets.EVALUATE_SOURCE)).toBe(true);
  });
});
