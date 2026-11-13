/**
 * cloud 平台签发方密钥（ADR 0040 §11 D3；ADR 0046 §11.7 裁定 4：一把平台级 Ed25519 密钥，各租户在设置页显式启用）。
 *
 * Worker secret `ASTER_FACT_SIGNING_KEY` 为一行 JSON：
 * `{"issuer","kid","privateKey":"<pkcs8 base64>","publicKey":"<base64url 原始 32 字节>"}`
 * （由 `pnpm fact-key:gen --kid <kid>` 生成）。设置页用 issuer / kid / publicKey 让租户启用；签名用 privateKey。
 *
 * 解析、名字段（与签发方路径同一校验）、公钥长度、pkcs8 导入、「私钥签探针 / 公钥验签」自检任一失败都返回 null：
 * cloud 不签任何事实，登记照常进行。只告警一次，日志不含密钥。结果按原始值缓存，secret 轮换后自然失效。
 */
import { safeEnv } from '@/lib/runtime/safe-env';
import { FACT_ISSUER_MAX_LENGTH, FACT_KID_MAX_LENGTH, isFactIssuerSegment } from '@/services/policy/policy-api';

export interface FactSigningKey {
  issuer: string;
  kid: string;
  /** base64url 无填充的 32 字节 Ed25519 原始公钥（即登记到 aster-api 的值） */
  publicKey: string;
  /** 不可导出、只能 sign 的 WebCrypto 私钥 */
  privateKey: CryptoKey;
}

const PUBLIC_KEY_BYTES = 32;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;
const PROBE = new TextEncoder().encode('aster-cloud fact-signing-key self-test');

let cached: { raw: string; key: Promise<FactSigningKey | null> } | null = null;
const warned = new Set<string>();

/** 同一原始值只告警一次；reason 是固定短语，绝不拼接密钥内容。 */
function warnOnce(raw: string, reason: string): void {
  if (warned.has(raw)) return;
  warned.add(raw);
  console.warn(`[fact-signing-key] ASTER_FACT_SIGNING_KEY 不可用（${reason}）：cloud 不签发事实`);
}

function decodeBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_RE.test(value) || value.length % 4 === 1) return null;
  const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

interface RawKey {
  issuer: string;
  kid: string;
  privateKey: string;
  publicKey: string;
}

function parse(raw: string): RawKey | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return '不是 JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return '不是 JSON 对象';
  const { issuer, kid, privateKey, publicKey } = value as Record<string, unknown>;
  if (typeof issuer !== 'string' || typeof kid !== 'string' || typeof privateKey !== 'string' || typeof publicKey !== 'string') {
    return '缺少 issuer / kid / privateKey / publicKey 字符串字段';
  }
  if (!isFactIssuerSegment(issuer, FACT_ISSUER_MAX_LENGTH) || !isFactIssuerSegment(kid, FACT_KID_MAX_LENGTH)) {
    return 'issuer 或 kid 不合规';
  }
  return { issuer, kid, privateKey, publicKey };
}

async function load(raw: string): Promise<FactSigningKey | null> {
  const parsed = parse(raw);
  if (typeof parsed === 'string') {
    warnOnce(raw, parsed);
    return null;
  }
  const publicBytes = decodeBase64url(parsed.publicKey);
  const privateBytes = decodeBase64(parsed.privateKey);
  if (!publicBytes || publicBytes.length !== PUBLIC_KEY_BYTES || !privateBytes) {
    warnOnce(raw, '公钥须为 32 字节 base64url、私钥须为 base64 PKCS#8');
    return null;
  }
  try {
    const privateKey = await crypto.subtle.importKey('pkcs8', privateBytes, { name: 'Ed25519' }, false, ['sign']);
    const publicKey = await crypto.subtle.importKey('raw', publicBytes, { name: 'Ed25519' }, false, ['verify']);
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, PROBE);
    if (!(await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, PROBE))) {
      warnOnce(raw, '私钥与公钥不配对');
      return null;
    }
    // 对外给无填充的规范编码，与 aster-api 存储形式一致
    const canonical = btoa(String.fromCharCode(...publicBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { issuer: parsed.issuer, kid: parsed.kid, publicKey: canonical, privateKey };
  } catch {
    warnOnce(raw, '密钥无法导入');
    return null;
  }
}

/** 读取并自检平台签发方密钥；未配置或任一校验失败返回 null。 */
export async function loadFactSigningKey(
  raw: string | undefined = safeEnv('ASTER_FACT_SIGNING_KEY'),
): Promise<FactSigningKey | null> {
  if (!raw) return null;
  if (cached?.raw !== raw) cached = { raw, key: load(raw) };
  return cached.key;
}

/** 仅供测试：清空缓存与告警记录。 */
export function resetFactSigningKeyCacheForTests(): void {
  cached = null;
  warned.clear();
}
