// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * cloud 平台签发方密钥（ADR 0046 §11.7 裁定 4）：ASTER_FACT_SIGNING_KEY 是 JSON
 * `{ issuer, kid, privateKey: <pkcs8 base64>, publicKey: <base64url 原始 32 字节> }`。
 * 解析、名字段、公钥长度、私钥导入与「私钥签 / 公钥验」自检任一失败都返回 null，只告警一次且不打印密钥。
 */

import { loadFactSigningKey, resetFactSigningKeyCacheForTests } from '@/services/guard/fact-signing-key';

const toB64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

async function keyPair() {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
  const publicKey = toB64url(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  return { kp, privateKey, publicKey };
}

function secret(over: Record<string, unknown>): string {
  return JSON.stringify({ issuer: 'aster-cloud', kid: 'k-2026-11', ...over });
}

describe('loadFactSigningKey', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetFactSigningKeyCacheForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('validKeyLoads：返回 issuer / kid / publicKey 与可签名的私钥，签名可用公钥验证', async () => {
    const { kp, privateKey, publicKey } = await keyPair();
    const key = await loadFactSigningKey(secret({ privateKey, publicKey }));

    expect(key).not.toBeNull();
    expect(key).toMatchObject({ issuer: 'aster-cloud', kid: 'k-2026-11', publicKey });
    const msg = new TextEncoder().encode('payload');
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key!.privateKey, msg);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, kp.publicKey, sig, msg)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('缺省读取 ASTER_FACT_SIGNING_KEY；未配置 → null', async () => {
    const { privateKey, publicKey } = await keyPair();
    vi.stubEnv('ASTER_FACT_SIGNING_KEY', secret({ privateKey, publicKey }));
    await expect(loadFactSigningKey()).resolves.toMatchObject({ publicKey });

    vi.stubEnv('ASTER_FACT_SIGNING_KEY', '');
    await expect(loadFactSigningKey()).resolves.toBeNull();
    await expect(loadFactSigningKey(undefined)).resolves.toBeNull();
  });

  it('malformedJsonIsNull：非 JSON、非对象、缺字段、字段非字符串 → null，同一值只告警一次', async () => {
    const { privateKey, publicKey } = await keyPair();
    for (const raw of ['{not json', '"str"', '[]', 'null', secret({ privateKey }), secret({ publicKey, privateKey: 7 })]) {
      await expect(loadFactSigningKey(raw)).resolves.toBeNull();
    }
    const calls = warn.mock.calls.length;
    await expect(loadFactSigningKey('{not json')).resolves.toBeNull();
    expect(warn.mock.calls.length).toBe(calls);
  });

  it('publicKeyMismatchIsNull：私钥与公钥不配对 → 自检失败 null，告警不含密钥', async () => {
    const a = await keyPair();
    const b = await keyPair();
    await expect(loadFactSigningKey(secret({ privateKey: a.privateKey, publicKey: b.publicKey }))).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain(a.privateKey);
    expect(logged).not.toContain(b.publicKey);
  });

  it('公钥不是 32 字节 / 私钥无法导入 → null', async () => {
    const { privateKey, publicKey } = await keyPair();
    await expect(loadFactSigningKey(secret({ privateKey, publicKey: toB64url(new Uint8Array(31)) }))).resolves.toBeNull();
    await expect(loadFactSigningKey(secret({ privateKey, publicKey: `${publicKey}AAAA` }))).resolves.toBeNull();
    await expect(loadFactSigningKey(secret({ privateKey, publicKey: 'not base64url!' }))).resolves.toBeNull();
    await expect(loadFactSigningKey(secret({ privateKey: 'bm90LWEta2V5', publicKey }))).resolves.toBeNull();
  });

  it('badIssuerNameIsNull：issuer / kid 不过 isFactIssuerSegment → null', async () => {
    const { privateKey, publicKey } = await keyPair();
    for (const over of [{ issuer: '..' }, { issuer: 'a b' }, { kid: 'k#1' }, { kid: 'x'.repeat(65) }, { issuer: '' }]) {
      await expect(loadFactSigningKey(secret({ privateKey, publicKey, ...over }))).resolves.toBeNull();
    }
  });

  it('按原始值缓存：同一值不重复导入', async () => {
    const { privateKey, publicKey } = await keyPair();
    const raw = secret({ privateKey, publicKey });
    const importSpy = vi.spyOn(crypto.subtle, 'importKey');
    const first = await loadFactSigningKey(raw);
    const second = await loadFactSigningKey(raw);
    expect(second).toBe(first);
    const imports = importSpy.mock.calls.length;
    await loadFactSigningKey(raw);
    expect(importSpy.mock.calls.length).toBe(imports);
  });
});
