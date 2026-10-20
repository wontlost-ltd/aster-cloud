// /api/llm/* 调用方解析测试（ADR 0049 Part B）：浏览器会话 vs AI 工作台服务签名。
//
// 钉住：①无服务头 → 走会话（未登录时 401 体与旧实现一致）②服务签名正确 → 服务身份且不读会话
// ③带服务头但验签失败（签名错 / body 篡改 / 超窗 / 重放）→ 401，绝不回落 cookie 会话
// ④密钥未配置 → 503 ⑤跨语言共享向量（Java 侧钉同一值）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), claimNonce: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/services/security/nonce-service', () => ({ claimNonce: mocks.claimNonce }));

const KEY = 'k'.repeat(64);
async function hmacHex(data: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))).toString('hex');
}
async function sha(s: string) {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))).toString('hex');
}
async function signed(body: string, over: Partial<Record<string, string>> = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = 'a'.repeat(32);
  const canonical = ['POST', '/api/llm/suggest', ts, nonce, await sha(body), 'u1'].join('\n');
  const headers: Record<string, string> = {
    'x-internal-caller': 'ai-workspace', 'x-aster-timestamp': ts, 'x-aster-nonce': nonce,
    'x-aster-user-id': 'u1', 'x-internal-signature': await hmacHex(canonical), ...over,
  };
  return new Request('https://aster-lang.cloud/api/llm/suggest', { method: 'POST', headers, body });
}

describe('resolveLlmCaller', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('AI_WORKSPACE_HMAC_KEY', KEY);
    mocks.auth.mockReset();
    mocks.claimNonce.mockReset().mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('无服务头：走会话', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u9' } });
    const { resolveLlmCaller } = await import('@/lib/llm-caller');
    const r = await resolveLlmCaller(new Request('https://aster-lang.cloud/api/llm/suggest', { method: 'POST', body: '{}' }), '{}');
    expect(r).toEqual({ userId: 'u9', via: 'session' });
  });
  it('无服务头且未登录：401，错误体与旧实现一致（Unauthorized）', async () => {
    mocks.auth.mockResolvedValue(null);
    const { resolveLlmCaller } = await import('@/lib/llm-caller');
    const r = await resolveLlmCaller(new Request('https://aster-lang.cloud/api/llm/suggest', { method: 'POST', body: '{}' }), '{}');
    expect(r).toEqual({ error: 'Unauthorized', status: 401 });
  });
  it('服务签名正确：返回服务身份且不读会话，nonce 被认领', async () => {
    const { resolveLlmCaller } = await import('@/lib/llm-caller');
    const r = await resolveLlmCaller(await signed('{"source":"x"}'), '{"source":"x"}');
    expect(r).toEqual({ userId: 'u1', via: 'ai-workspace' });
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.claimNonce).toHaveBeenCalledWith('a'.repeat(32), expect.any(Date));
  });
  it('签名错误：401，且绝不回落到 cookie 会话，也不认领 nonce', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'u9' } });
    const { resolveLlmCaller } = await import('@/lib/llm-caller');
    const r = await resolveLlmCaller(await signed('{}', { 'x-internal-signature': '00'.repeat(32) }), '{}');
    expect(r).toMatchObject({ status: 401 });
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.claimNonce).not.toHaveBeenCalled();
  });
  it('body 被篡改：401', async () => {
    const { resolveLlmCaller } = await import('@/lib/llm-caller');
    expect(await resolveLlmCaller(await signed('{"a":1}'), '{"a":2}')).toMatchObject({ status: 401 });
  });
  it('userId 被替换：401', async () => {
    const { resolveLlmCaller } = await import('@/lib/llm-caller');
    expect(await resolveLlmCaller(await signed('{}', { 'x-aster-user-id': 'u2' }), '{}')).toMatchObject({ status: 401 });
  });
  it('时间戳超窗：401', async () => {
    const { resolveLlmCaller } = await import('@/lib/llm-caller');
    expect(await resolveLlmCaller(await signed('{}', { 'x-aster-timestamp': '1000' }), '{}')).toMatchObject({ status: 401 });
  });
  it('nonce 格式非法：401', async () => {
    const { resolveLlmCaller } = await import('@/lib/llm-caller');
    expect(await resolveLlmCaller(await signed('{}', { 'x-aster-nonce': 'zz' }), '{}')).toMatchObject({ status: 401 });
  });
  it('nonce 重放：401', async () => {
    mocks.claimNonce.mockResolvedValue(false);
    const { resolveLlmCaller } = await import('@/lib/llm-caller');
    expect(await resolveLlmCaller(await signed('{}'), '{}')).toMatchObject({ status: 401 });
  });
  it('密钥未配置：503', async () => {
    vi.stubEnv('AI_WORKSPACE_HMAC_KEY', '');
    const { resolveLlmCaller } = await import('@/lib/llm-caller');
    expect(await resolveLlmCaller(await signed('{}'), '{}')).toMatchObject({ status: 503 });
  });
});

describe('canonicalAiWorkspace — 跨语言共享 HMAC 向量（Java 侧钉同一值）', () => {
  const CANONICAL =
    'POST\n/api/llm/suggest\n1800000000\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nee7bd4c48c9c43b1068696c254751f09083b15f0381f55e453051c40cb5a549c\nu1';
  const SIGNATURE = '82a00757510ea78239d0835a4f5343ba6e4b1fb02a5cfd563aeb686ec824aa0e';

  it('canonical 串与签名固定', async () => {
    const { canonicalAiWorkspace } = await import('@/lib/llm-caller');
    const canonical = canonicalAiWorkspace('post', '/api/llm/suggest', '1800000000', 'a'.repeat(32), await sha('{"source":"x"}'), 'u1');
    expect(canonical).toBe(CANONICAL);
    expect(await hmacHex(canonical)).toBe(SIGNATURE);
  });
});
