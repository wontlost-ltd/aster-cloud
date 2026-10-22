import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), role: vi.fn() }));
vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/effective-role', () => ({ getEffectiveRole: mocks.role }));

// 工作台仅 SaaS 开放；on-prem project 下路由对已登录且 next 合法的请求恒为 404
const IS_SAAS_BUILD = (process.env.DEPLOYMENT_MODE ?? '') === 'saas';

async function privateKey() {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
}
const req = (qs: string) => new NextRequest(`https://aster-lang.cloud/api/ai-workspace/handoff${qs}`);

describe('GET /api/ai-workspace/handoff', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_AI_WORKSPACE_URL', 'https://ai.aster-lang.cloud');
    vi.stubEnv('AI_WORKSPACE_ENABLED_FOR', 'all');
    vi.stubEnv('AI_WORKSPACE_HANDOFF_PRIVATE_KEY', await privateKey());
    mocks.auth.mockResolvedValue({ user: { id: 'u1', name: 'Ann', email: 'a@x.io' } });
    mocks.role.mockResolvedValue('owner');
  });

  it.runIf(IS_SAAS_BUILD)('已登录：302 到工作台 /handoff，带令牌与 next', async () => {
    const { GET } = await import('@/app/api/ai-workspace/handoff/route');
    const res = await GET(req('?next=%2Fpanel%3FpolicyId%3Dp-1&locale=zh'));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://ai.aster-lang.cloud/handoff');
    expect(loc.searchParams.get('next')).toBe('/panel?policyId=p-1');
    expect(loc.searchParams.get('token')).toMatch(/^[\w-]+\.[\w-]+$/);
  });
  it.runIf(IS_SAAS_BUILD)('★theme=dark|light 原样转交给工作台 /handoff（F29）', async () => {
    const { GET } = await import('@/app/api/ai-workspace/handoff/route');
    for (const theme of ['dark', 'light']) {
      const res = await GET(req(`?next=%2Fpanel&locale=zh&theme=${theme}`));
      expect(new URL(res.headers.get('location')!).searchParams.get('theme')).toBe(theme);
    }
  });
  it.runIf(IS_SAAS_BUILD)('theme 缺失、system 或非法值：不转交 theme', async () => {
    const { GET } = await import('@/app/api/ai-workspace/handoff/route');
    for (const qs of ['', '&theme=system', '&theme=%3Cscript%3E']) {
      const res = await GET(req(`?next=%2Fpanel&locale=zh${qs}`));
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location')!).searchParams.has('theme')).toBe(false);
    }
  });
  it.runIf(!IS_SAAS_BUILD)('非 SaaS 部署：已登录也是 404', async () => {
    const { GET } = await import('@/app/api/ai-workspace/handoff/route');
    expect((await GET(req('?next=%2F'))).status).toBe(404);
  });
  it('未登录：302 到登录页并带回调', async () => {
    mocks.auth.mockResolvedValue(null);
    const { GET } = await import('@/app/api/ai-workspace/handoff/route');
    const res = await GET(req('?next=%2F&locale=de'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/aster-lang\.cloud\/de\/login\?callbackUrl=/);
  });
  it('非法 next：400', async () => {
    const { GET } = await import('@/app/api/ai-workspace/handoff/route');
    expect((await GET(req('?next=%2F%2Fevil.com'))).status).toBe(400);
  });
  it('不在灰度名单：404', async () => {
    vi.stubEnv('AI_WORKSPACE_ENABLED_FOR', 'someone-else');
    const { GET } = await import('@/app/api/ai-workspace/handoff/route');
    expect((await GET(req('?next=%2F'))).status).toBe(404);
  });
  it.runIf(IS_SAAS_BUILD)('私钥缺失：503，并记一行 console.warn（不含用户信息）', async () => {
    vi.stubEnv('AI_WORKSPACE_HANDOFF_PRIVATE_KEY', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { GET } = await import('@/app/api/ai-workspace/handoff/route');
    expect((await GET(req('?next=%2F'))).status).toBe(503);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0].map(String).join(' ');
    expect(line).toContain('AI_WORKSPACE_HANDOFF_PRIVATE_KEY');
    for (const s of ['u1', 'Ann', 'a@x.io']) expect(line).not.toContain(s);
    warn.mockRestore();
  });
});
