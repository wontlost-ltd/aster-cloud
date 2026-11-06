/**
 * #657：网关校验 cloud 签发的短时 ticket（lsp-server.mjs verifyLspTicket / evaluateUpgrade）。
 * 签发端（src/lib/lsp-ticket.ts，WebCrypto）与验签端（node:crypto）必须互通。
 */
import { describe, it, expect } from 'vitest';
import { createNonceCache, evaluateUpgrade, verifyLspTicket } from '../../../lsp-server.mjs';
import { issueLspTicket, LSP_TICKET_TTL_MS } from '@/lib/lsp-ticket';

const SECRET = 'ticket-secret-for-tests';
const T0 = 1_800_000_000_000;

describe('verifyLspTicket', () => {
  it('合法 ticket 通过并返回 sub', async () => {
    const ticket = await issueLspTicket({ secret: SECRET, sub: 'user-1', now: T0 });
    expect(verifyLspTicket(ticket, { secret: SECRET, now: T0 + 1000, nonces: createNonceCache() }))
      .toEqual({ ok: true, sub: 'user-1' });
  });

  it('过期 ticket 被拒', async () => {
    const ticket = await issueLspTicket({ secret: SECRET, sub: 'user-1', now: T0 });
    const r = verifyLspTicket(ticket, { secret: SECRET, now: T0 + LSP_TICKET_TTL_MS + 1, nonces: createNonceCache() });
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('同一 ticket 第二次使用被拒（nonce 重放）', async () => {
    const ticket = await issueLspTicket({ secret: SECRET, sub: 'user-1', now: T0 });
    const nonces = createNonceCache();
    expect(verifyLspTicket(ticket, { secret: SECRET, now: T0, nonces }).ok).toBe(true);
    expect(verifyLspTicket(ticket, { secret: SECRET, now: T0 + 10, nonces })).toEqual({ ok: false, reason: 'replayed' });
  });

  it('签名错误 / 密钥不同 / 篡改 payload 被拒', async () => {
    const ticket = await issueLspTicket({ secret: SECRET, sub: 'user-1', now: T0 });
    const nonces = createNonceCache();
    expect(verifyLspTicket(ticket, { secret: 'other', now: T0, nonces })).toEqual({ ok: false, reason: 'bad_signature' });
    const [, sig] = ticket.split('.');
    const forged = `${Buffer.from(JSON.stringify({ v: 1, sub: 'admin', exp: T0 + 60_000, nonce: 'x' })).toString('base64url')}.${sig}`;
    expect(verifyLspTicket(forged, { secret: SECRET, now: T0, nonces })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('格式错误被拒', () => {
    const nonces = createNonceCache();
    for (const bad of ['', 'abc', 'a.b.c', '.']) {
      expect(verifyLspTicket(bad, { secret: SECRET, now: T0, nonces }).ok).toBe(false);
    }
  });

  it('nonce 缓存过期后清理，不无限增长', () => {
    const nonces = createNonceCache();
    nonces.claim('n1', T0 + 100, T0);
    expect(nonces.size()).toBe(1);
    nonces.claim('n2', T0 + 10_000, T0 + 200);
    expect(nonces.size()).toBe(1);
  });
});

const ORIGIN = 'https://aster-lang.cloud';
function cfg(overrides: Record<string, unknown> = {}) {
  return {
    allowedOrigins: [ORIGIN],
    maxConnections: 5,
    authToken: 'legacy',
    authDisabled: false,
    isProduction: true,
    ticketSecret: SECRET,
    ticketRequired: false,
    nonces: createNonceCache(),
    now: T0,
    ...overrides,
  };
}

describe('evaluateUpgrade — ticket', () => {
  it('合法 ticket 放行并带回 sub', async () => {
    const ticket = await issueLspTicket({ secret: SECRET, sub: 'user-9', now: T0 });
    expect(evaluateUpgrade({ origin: ORIGIN, queryTicket: ticket, activeCount: 0 }, cfg()))
      .toEqual({ ok: true, sub: 'user-9' });
  });

  it('带了无效 ticket 时不回落到共享 token', () => {
    const r = evaluateUpgrade({ origin: ORIGIN, queryTicket: 'bad', queryToken: 'legacy', activeCount: 0 }, cfg());
    expect(r).toMatchObject({ ok: false, code: 401 });
  });

  it('过渡期：未带 ticket 时旧 token 仍可用', () => {
    expect(evaluateUpgrade({ origin: ORIGIN, queryToken: 'legacy', activeCount: 0 }, cfg())).toEqual({ ok: true });
  });

  it('LSP_TICKET_REQUIRED 后：旧 token 被拒、不带 ticket 被拒', () => {
    const c = cfg({ ticketRequired: true });
    expect(evaluateUpgrade({ origin: ORIGIN, queryToken: 'legacy', activeCount: 0 }, c)).toMatchObject({ ok: false, code: 401 });
    expect(evaluateUpgrade({ origin: ORIGIN, activeCount: 0 }, c)).toMatchObject({ ok: false, code: 401 });
  });

  it('网关未配置 ticket 密钥时带 ticket 被拒（不静默放行）', async () => {
    const ticket = await issueLspTicket({ secret: SECRET, sub: 'u', now: T0 });
    const r = evaluateUpgrade({ origin: ORIGIN, queryTicket: ticket, activeCount: 0 }, cfg({ ticketSecret: '' }));
    expect(r).toMatchObject({ ok: false, code: 401 });
  });

  it('Origin 不合法时 ticket 也不放行', async () => {
    const ticket = await issueLspTicket({ secret: SECRET, sub: 'u', now: T0 });
    expect(evaluateUpgrade({ origin: 'https://evil.example', queryTicket: ticket, activeCount: 0 }, cfg()))
      .toMatchObject({ ok: false, code: 403 });
  });
});
