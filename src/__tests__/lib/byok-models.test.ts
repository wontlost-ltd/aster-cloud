import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-signing', () => ({
  signInternalCallerHeaders: vi.fn().mockResolvedValue({ 'X-Internal-Signature': 'sig', 'X-Aster-Timestamp': '1', 'X-Aster-Nonce': 'n', 'X-Internal-Caller': 'cloud-bff' }),
}));

import { fetchByokModels, unverifiedReason } from '@/lib/byok-models';
import { signInternalCallerHeaders } from '@/lib/api-signing';

const creds = { provider: 'openai', apiKey: 'sk-x', baseUrl: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});

describe('fetchByokModels（经 aster-api POST /api/v1/ai/models）', () => {
  it('签名覆盖含 _byok 的 body，并以 userId 作 tenant', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ provider: 'openai', models: ['gpt-4o'], defaultModel: 'gpt-4o-mini', fetchedAt: 'now' }), { status: 200 }));
    const res = await fetchByokModels('u1', creds);
    expect(res).toEqual({ ok: true, models: ['gpt-4o'], defaultModel: 'gpt-4o-mini' });
    const [, path, body, tenant] = vi.mocked(signInternalCallerHeaders).mock.calls[0];
    expect(path).toBe('/api/v1/ai/models');
    expect(JSON.parse(body as string)._byok).toEqual({ provider: 'openai', apiKey: 'sk-x' });
    expect(tenant).toBe('u1');
  });

  it('baseUrl 非空时注入 _byok.baseUrl', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ models: null, defaultModel: 'x' }), { status: 200 }));
    await fetchByokModels('u1', { ...creds, baseUrl: 'https://gw.example.com/v1' });
    expect(JSON.parse(vi.mocked(signInternalCallerHeaders).mock.calls[0][2] as string)._byok.baseUrl).toBe('https://gw.example.com/v1');
  });

  it('★网关不支持列表 → ok:true models:null（不是错误）', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ models: null, defaultModel: 'x' }), { status: 200 }));
    expect(await fetchByokModels('u1', creds)).toEqual({ ok: true, models: null, defaultModel: 'x' });
  });

  it('上游 502 / 网络异常 → ok:false', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ error: 'models_unavailable' }), { status: 502 }));
    expect(await fetchByokModels('u1', creds)).toEqual({ ok: false, error: 'models_unavailable' });
    vi.mocked(fetch).mockRejectedValue(new Error('boom'));
    expect((await fetchByokModels('u1', creds)).ok).toBe(false);
  });

  it('HMAC 密钥缺失 → ok:false cloud_misconfigured', async () => {
    vi.mocked(signInternalCallerHeaders).mockRejectedValueOnce(new Error('ASTER_PLAN_GATE_HMAC_KEY not configured'));
    expect(await fetchByokModels('u1', creds)).toEqual({ ok: false, error: 'cloud_misconfigured' });
  });

  it('★超时（AbortSignal.timeout → TimeoutError）→ ok:false error=timeout', async () => {
    vi.mocked(fetch).mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await fetchByokModels('u1', creds)).toEqual({ ok: false, error: 'timeout' });
  });
});

describe('unverifiedReason（把 fetchByokModels 的 error 收敛成稳定原因码）', () => {
  it.each([
    ['cloud_misconfigured', 'cloud_misconfigured'],
    ['models_unavailable', 'provider_unavailable'],
    ['invalid_byok', 'endpoint_rejected'],
    ['timeout', 'timeout'],
    ['http_500', 'unknown'],
    ['fetch failed', 'unknown'],
  ])('%s → %s', (error, reason) => {
    expect(unverifiedReason(error)).toBe(reason);
  });
});
