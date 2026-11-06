/**
 * LSP 网关短时 ticket 的签发端（#657）。
 *
 * 格式：`base64url(JSON payload).base64url(HMAC-SHA256(secret, payload 段))`，
 * payload = `{ v: 1, sub: userId, exp: 毫秒时间戳, nonce }`。
 * 验签端在 lsp-server.mjs（verifyLspTicket，node:crypto），两端格式必须一致。
 * 用 WebCrypto 实现，Workers 与 Node 都能运行。密钥 LSP_TICKET_SECRET 只在服务端，不进前端 bundle。
 */

/** ticket 有效期：只够浏览器拿到后立刻握手；过期后客户端重连会重新取票 */
export const LSP_TICKET_TTL_MS = 60_000;

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function issueLspTicket(opts: { secret: string; sub: string; now?: number }): Promise<string> {
  const exp = (opts.now ?? Date.now()) + LSP_TICKET_TTL_MS;
  const payload = { v: 1, sub: opts.sub, exp, nonce: crypto.randomUUID() };
  const encoder = new TextEncoder();
  const payloadPart = base64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(opts.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payloadPart)));
  return `${payloadPart}.${base64url(sig)}`;
}
