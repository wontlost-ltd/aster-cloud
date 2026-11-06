// #657：客户端每次连接前取 ticket；取不到（旧部署 / 未配置）时回落到共享 token。
import { describe, it, expect, vi } from 'vitest';
import { lspAuthQuery } from '@/lib/lsp-ticket-client';

function fetchReturning(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('lspAuthQuery', () => {
  it('取到 ticket：只带 ticket，不带共享 token', async () => {
    const f = fetchReturning(200, { ticket: 'p.s', expiresAt: 1 });
    expect(await lspAuthQuery({ fetchImpl: f, legacyToken: 'legacy' })).toBe('&ticket=p.s');
    expect(f).toHaveBeenCalledWith('/api/lsp/ticket', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
  });

  it('端点 503 / 404 / 网络错误：回落到共享 token', async () => {
    expect(await lspAuthQuery({ fetchImpl: fetchReturning(503, {}), legacyToken: 'a b' })).toBe('&token=a%20b');
    expect(await lspAuthQuery({ fetchImpl: fetchReturning(404, {}), legacyToken: 'x' })).toBe('&token=x');
    expect(await lspAuthQuery({ fetchImpl: vi.fn().mockRejectedValue(new Error('net')), legacyToken: 'x' })).toBe('&token=x');
  });

  it('既无 ticket 也无共享 token：空串', async () => {
    expect(await lspAuthQuery({ fetchImpl: fetchReturning(503, {}), legacyToken: undefined })).toBe('');
  });
});
