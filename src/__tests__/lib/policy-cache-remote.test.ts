import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkInternalSignature } from '@/lib/api-signing';
import { invalidatePolicyCacheRemote } from '@/lib/policy-cache-remote';

/** #649：迁移 Job 经 cloud 内部端点失效 Workers KV；请求必须能通过入站 v2 验签。 */
describe('invalidatePolicyCacheRemote', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(status: number) {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(status === 200 ? '{"invalidated":true}' : '{"error":"x"}', { status });
    }));
    return requests;
  }

  it('POST 到内部端点，签名可被入站校验接受', async () => {
    const requests = stubFetch(200);
    await invalidatePolicyCacheRemote('pol/1', { baseUrl: 'https://cloud.internal/', secret: 'k' });

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(new URL(req.url).pathname).toBe('/api/internal/policies/pol%2F1/invalidate-cache');
    await expect(checkInternalSignature(req, '', 'k')).resolves.toMatchObject({ ok: true, usedLegacyCanonical: false });
    await expect(checkInternalSignature(req, '', 'other')).resolves.toMatchObject({ ok: false });
  });

  it('非 2xx → 抛错（调用方只告警）', async () => {
    stubFetch(401);
    await expect(
      invalidatePolicyCacheRemote('pol-1', { baseUrl: 'https://cloud.internal', secret: 'k' }),
    ).rejects.toThrow(/401/);
  });
});
