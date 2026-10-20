import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { signedWorkspaceRequest, TEST_AI_WORKSPACE_KEY } from '@/__tests__/helpers/ai-workspace-signing';

/**
 * /api/llm/complete AI 配额前置门控回归。
 *
 * 缺陷背景：LLM 代理路径此前【完全不检查 AI 配额】——checkAiQuota 是死代码（无人调
 * /api/internal/ai/quota），任何登录用户都能无限烧平台 LLM 预算。本测试锁定门控：
 * quota 拒绝 → 直接返回对应 HTTP 状态，绝不 fetch 上游 aster-api（不烧 token）；
 * quota 放行 → 才转发。
 */

const { mockAuth, mockCheckAiQuota, mockRecordAiUsage, mockSign, mockResolveByok, mockInjectByok, mockClaimNonce } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockClaimNonce: vi.fn(),
  mockCheckAiQuota: vi.fn(),
  mockRecordAiUsage: vi.fn(),
  mockSign: vi.fn(),
  mockResolveByok: vi.fn(),
  mockInjectByok: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/ai-quota', () => ({
  checkAiQuota: mockCheckAiQuota,
  recordAiUsage: mockRecordAiUsage,
}));
// 出站签名用 mock；入站验签（AI 工作台服务签名）用真实实现。
vi.mock('@/lib/api-signing', async (orig) => ({
  ...(await orig<typeof import('@/lib/api-signing')>()),
  signInternalCallerHeaders: mockSign,
}));
vi.mock('@/services/security/nonce-service', () => ({ claimNonce: mockClaimNonce }));
vi.mock('@/lib/byok-envelope', () => ({
  resolveByokEnvelope: mockResolveByok,
  injectByokEnvelope: mockInjectByok,
}));

function post(body: unknown = { prompt: 'x' }): Request {
  return new Request('http://cloud.test/api/llm/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/llm/complete — AI 配额门控', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    mockAuth.mockReset();
    mockCheckAiQuota.mockReset();
    mockRecordAiUsage.mockReset().mockResolvedValue(undefined);
    mockSign.mockReset().mockResolvedValue({ 'X-Internal-Caller': 'cloud-bff' });
    // 默认无 BYOK（平台路径）；inject 默认原样返回 body
    mockResolveByok.mockReset().mockResolvedValue(null);
    mockInjectByok.mockReset().mockImplementation((raw: string) => ({ body: raw, injected: false }));
    mockClaimNonce.mockReset().mockResolvedValue(true);
    vi.stubEnv('AI_WORKSPACE_HMAC_KEY', TEST_AI_WORKSPACE_KEY);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"result":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('未登录 → 401，不检查配额也不转发', async () => {
    mockAuth.mockResolvedValue(null);
    const { POST } = await import('@/app/api/llm/complete/route');
    const res = await POST(post() as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(mockCheckAiQuota).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('配额用尽 → 402，不转发上游（不烧 token）', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({
      allowed: false,
      reason: 'ai_quota_exhausted',
      message: '本月 AI 配额已用尽',
    });
    const { POST } = await import('@/app/api/llm/complete/route');
    const res = await POST(post() as never);
    expect(res.status).toBe(402);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled(); // 拒绝不记账
    const body = await res.json();
    expect(body.error).toBe('ai_quota_exhausted');
  });

  it('速率超限 → 429 + Retry-After，不转发', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({
      allowed: false,
      reason: 'ai_rate_limited',
      message: '请求太频繁',
      retryAfterSec: 60,
    });
    const { POST } = await import('@/app/api/llm/complete/route');
    const res = await POST(post() as never);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('风险封禁 → 403，不转发', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({
      allowed: false,
      reason: 'ai_banned',
      message: 'AI 功能被禁用',
    });
    const { POST } = await import('@/app/api/llm/complete/route');
    const res = await POST(post() as never);
    expect(res.status).toBe(403);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('配额放行 → 转发上游、透传结果，并记一笔 success（驱动配额计数）', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    const { POST } = await import('@/app/api/llm/complete/route');
    const res = await POST(post() as never);
    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    // 止血闭环：2xx 后记账，让月配额/速率计数真正递增
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({
      userId: 'user-1',
      callKind: 'complete',
      status: 'success',
      usedByok: false,
    });
    const body = await res.json();
    expect(body.result).toBe('ok');
  });

  describe('★请求是否到达第三方 AI 决定是否计费（#518）', () => {
    const cases: Array<[string, string, boolean]> = [
      ['未配置 key / 连不上 provider：upstreamReached=false → 不计费',
        '{"completion":"","model":"m","upstreamReached":false}', false],
      ['provider 报错后的空补全：upstreamReached=true → 计费',
        '{"completion":"","model":"m","upstreamReached":true}', true],
      ['正常补全 → 计费', '{"completion":"Return 1.","model":"m","upstreamReached":true}', true],
      ['旧版 aster-api（无该字段）→ 保持原口径计费', '{"completion":"","model":"m"}', true],
      ['非 JSON 的 2xx → 保持原口径计费', 'ok', true],
    ];
    for (const [name, upstreamBody, billed] of cases) {
      it(name, async () => {
        mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
        mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
        globalThis.fetch = vi.fn().mockResolvedValue(
          new Response(upstreamBody, { status: 200, headers: { 'content-type': 'application/json' } }),
        );
        const { POST } = await import('@/app/api/llm/complete/route');
        const res = await POST(post() as never);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(upstreamBody); // 响应原样透传
        expect(mockRecordAiUsage).toHaveBeenCalledTimes(billed ? 1 : 0);
      });
    }
  });

  it('★400 provider_rejected_model（已到达 provider）→ 透传 400，记一笔 api_error，model 为 BYOK 指定的模型', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockResolveByok.mockResolvedValue({ provider: 'openai', apiKey: 'sk-x', baseUrl: null, bindingId: 'b1', model: 'gpt-9' });
    mockInjectByok.mockImplementation((raw: string) => ({ body: raw, injected: true }));
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: -1, limit: -1, usedByok: true });
    const upstreamBody = '{"error":"provider_rejected_model","message":"provider 拒绝了所选模型: gpt-9"}';
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(upstreamBody, { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    const { POST } = await import('@/app/api/llm/complete/route');
    const res = await POST(post() as never);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(upstreamBody);
    expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({
      callKind: 'complete', status: 'api_error', model: 'gpt-9', usedByok: true, aiKeyBindingId: 'b1',
    });
  });

  // 生产事故原文：Anthropic key 未绑定 workspace → 新版 aster-api 回 400 provider_bad_request。
  const WORKSPACE_MSG = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.';
  for (const code of ['provider_auth_failed', 'provider_rejected_model', 'provider_bad_request']) {
    it(`★400 ${code}（已到达 provider）→ 原样透传 body，记 api_error`, async () => {
      mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
      mockResolveByok.mockResolvedValue({ provider: 'anthropic', apiKey: 'sk-ant-x', baseUrl: null, bindingId: 'b1', model: 'claude-x' });
      mockInjectByok.mockImplementation((raw: string) => ({ body: raw, injected: true }));
      mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: -1, limit: -1, usedByok: true });
      const upstreamBody = JSON.stringify({ error: code, message: WORKSPACE_MSG, providerErrorType: 'invalid_request_error' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(upstreamBody, { status: 400, headers: { 'content-type': 'application/json' } }),
      );
      const { POST } = await import('@/app/api/llm/complete/route');
      const res = await POST(post() as never);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe(upstreamBody);
      expect(mockRecordAiUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ status: 'api_error', model: 'claude-x', usedByok: true });
    });
  }

  it('其他 400（如 invalid_byok，未到达 provider）→ 不记账', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":"invalid_byok","message":"x"}', { status: 400, headers: { 'content-type': 'application/json' } }),
    );
    const { POST } = await import('@/app/api/llm/complete/route');
    expect((await POST(post() as never)).status).toBe(400);
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it('上游返回非 2xx → 透传错误，不记 success', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":"upstream"}', { status: 500, headers: { 'content-type': 'application/json' } })
    );
    const { POST } = await import('@/app/api/llm/complete/route');
    const res = await POST(post() as never);
    expect(res.status).toBe(500);
    expect(mockRecordAiUsage).not.toHaveBeenCalled(); // 上游失败不记 success
  });

  it('BYOK 用户 → 注入 _byok、checkAiQuota 收 usedByok=true、记账 usedByok=true', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockResolveByok.mockResolvedValue({ provider: 'openai', apiKey: 'sk-user', bindingId: 'b1' });
    mockInjectByok.mockImplementation((raw: string) => ({
      body: JSON.stringify({ ...JSON.parse(raw), _byok: { provider: 'openai', apiKey: 'sk-user' } }),
      injected: true,
    }));
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: -1, limit: -1, usedByok: true });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"completion":"x","model":"gpt-4o","upstreamReached":true}', {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );

    const { POST } = await import('@/app/api/llm/complete/route');
    const res = await POST(post() as never);
    expect(res.status).toBe(200);

    // checkAiQuota 收到 usedByok=true（跳过平台月配额）
    expect(mockCheckAiQuota).toHaveBeenCalledWith('user-1', { usedByok: true });
    // 转发上游的 body 含注入的 _byok
    const forwardedBody = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(JSON.parse(forwardedBody)._byok).toEqual({ provider: 'openai', apiKey: 'sk-user' });
    // 记账 usedByok=true
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ usedByok: true, model: 'gpt-4o' });
  });

  it('aster-api 响应无 model 字段（旧版）→ 仍记账，model 为 unknown', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"completion":"x","upstreamReached":true}', {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    const { POST } = await import('@/app/api/llm/complete/route');
    await POST(post() as never);
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ model: 'unknown' });
  });
  it('AI 工作台服务签名正确 → 以 u1 身份转发并按 u1 记账，不读会话', async () => {
    mockCheckAiQuota.mockResolvedValue({ allowed: true, remaining: 5, limit: 20, usedByok: false });
    const body = JSON.stringify({ prompt: 'x' });
    const { POST } = await import('@/app/api/llm/complete/route');
    const res = await POST((await signedWorkspaceRequest('http://cloud.test/api/llm/complete', body)) as never);
    expect(res.status).toBe(200);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockCheckAiQuota).toHaveBeenCalledWith('u1', { usedByok: false });
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers['X-Tenant-Id']).toBe('u1');
    expect(mockRecordAiUsage.mock.calls[0][0]).toMatchObject({ userId: 'u1', callKind: 'complete' });
  });

  it('★AI 工作台签名错误 → 401，不回落会话、不转发', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const { POST } = await import('@/app/api/llm/complete/route');
    const bad = await signedWorkspaceRequest('http://cloud.test/api/llm/complete', '{}', { over: { 'X-Aster-User-Id': 'u2' } });
    const res = await POST(bad as never);
    expect(res.status).toBe(401);
    expect(mockAuth).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
