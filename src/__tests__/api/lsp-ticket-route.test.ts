// #657：POST /api/lsp/ticket 为登录用户签发一次性短时 ticket。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const auth = vi.hoisted(() => vi.fn());
vi.mock('@/auth', () => ({ auth }));

import { POST } from '@/app/api/lsp/ticket/route';
import { verifyLspTicket, createNonceCache } from '../../../lsp-server.mjs';

describe('POST /api/lsp/ticket', () => {
  beforeEach(() => auth.mockReset());
  afterEach(() => vi.unstubAllEnvs());

  it('未登录 401', async () => {
    vi.stubEnv('LSP_TICKET_SECRET', 's');
    auth.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it('未配置密钥 503 lsp_ticket_unconfigured', async () => {
    vi.stubEnv('LSP_TICKET_SECRET', '');
    auth.mockResolvedValue({ user: { id: 'u1' } });
    const res = await POST();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('lsp_ticket_unconfigured');
  });

  it('登录用户拿到可被网关验证、不可缓存的 ticket', async () => {
    vi.stubEnv('LSP_TICKET_SECRET', 'route-secret');
    auth.mockResolvedValue({ user: { id: 'u1' } });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();
    expect(typeof body.expiresAt).toBe('number');
    expect(verifyLspTicket(body.ticket, { secret: 'route-secret', now: Date.now(), nonces: createNonceCache() }))
      .toEqual({ ok: true, sub: 'u1' });
  });
});
