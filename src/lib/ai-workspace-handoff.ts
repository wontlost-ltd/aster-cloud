/**
 * 交接令牌（ADR 0049 §2.6）：cloud 用 Ed25519 私钥签名，AI 工作台用公钥验证。
 * 用 WebCrypto 实现（Workers 与 Node 24 均支持 Ed25519），不引入 JWT 依赖。
 */
export interface HandoffClaims {
  v: 1;
  aud: 'ai-workspace';
  sub: string;
  name: string | null;
  email: string | null;
  locale: string;
  role: string;
  iat: number;
  exp: number;
  jti: string;
}

const TTL_SECONDS = 60;

const toB64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** 签发一次性短期令牌；私钥非法时直接抛错，不返回半成品。 */
export async function signHandoffToken(
  claims: Omit<HandoffClaims, 'v' | 'aud' | 'iat' | 'exp' | 'jti'>,
  privateKeyB64: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await crypto.subtle.importKey('pkcs8', fromB64(privateKeyB64), { name: 'Ed25519' }, false, ['sign']);
  const full: HandoffClaims = { v: 1, aud: 'ai-workspace', ...claims, iat: now, exp: now + TTL_SECONDS, jti: crypto.randomUUID() };
  const payload = toB64url(new TextEncoder().encode(JSON.stringify(full)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(payload)));
  return `${payload}.${toB64url(sig)}`;
}
