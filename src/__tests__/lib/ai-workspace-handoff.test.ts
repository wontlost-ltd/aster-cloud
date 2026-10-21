import { describe, expect, it } from 'vitest';
import { signHandoffToken } from '@/lib/ai-workspace-handoff';

async function keyPair() {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  return { kp, pkcs8 };
}
const b64urlToBytes = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

describe('signHandoffToken', () => {
  it('签出 payload.signature，可用公钥验证，exp = iat + 60', async () => {
    const { kp, pkcs8 } = await keyPair();
    const token = await signHandoffToken({ sub: 'u1', name: 'Ann', email: 'a@x.io', locale: 'zh', role: 'owner' }, pkcs8, 1_800_000_000);
    const [payload, sig] = token.split('.');
    const claims = JSON.parse(b64urlToBytes(payload).toString('utf8'));
    expect(claims).toMatchObject({ v: 1, aud: 'ai-workspace', sub: 'u1', locale: 'zh', role: 'owner', iat: 1_800_000_000, exp: 1_800_000_060 });
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, kp.publicKey, b64urlToBytes(sig), new TextEncoder().encode(payload));
    expect(ok).toBe(true);
  });
  it('私钥非法时抛错（不返回半成品令牌）', async () => {
    await expect(signHandoffToken({ sub: 'u1', name: null, email: null, locale: 'en', role: 'owner' }, 'bm90LWEta2V5')).rejects.toThrow();
  });
});
