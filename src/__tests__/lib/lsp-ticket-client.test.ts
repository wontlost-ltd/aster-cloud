// #657：客户端每次连接前取 ticket；取不到时不带凭据（由网关决定放行与否）。
import { describe, it, expect, vi } from 'vitest';
import { lspAuthQuery } from '@/lib/lsp-ticket-client';

function fetchReturning(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('lspAuthQuery', () => {
  it('取到 ticket：带 ticket 参数并 URL 编码', async () => {
    const f = fetchReturning(200, { ticket: 'p.s', expiresAt: 1 });
    expect(await lspAuthQuery({ fetchImpl: f })).toBe('&ticket=p.s');
    expect(f).toHaveBeenCalledWith('/api/lsp/ticket', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    expect(await lspAuthQuery({ fetchImpl: fetchReturning(200, { ticket: 'a b' }) })).toBe('&ticket=a%20b');
  });

  it('端点 503 / 404 / 网络错误 / 响应缺 ticket：空串，不回落到任何共享 token', async () => {
    expect(await lspAuthQuery({ fetchImpl: fetchReturning(503, {}) })).toBe('');
    expect(await lspAuthQuery({ fetchImpl: fetchReturning(404, {}) })).toBe('');
    expect(await lspAuthQuery({ fetchImpl: vi.fn().mockRejectedValue(new Error('net')) })).toBe('');
    expect(await lspAuthQuery({ fetchImpl: fetchReturning(200, {}) })).toBe('');
  });
});
