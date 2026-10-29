/**
 * 策略安全服务 - 哈希与签名
 *
 * 提供策略源码哈希、链式哈希、请求签名和验证功能。
 * 遵循零信任原则：前端验证 ≠ 后端验证
 */

import { createHmac, createHash, timingSafeEqual as cryptoTimingSafeEqual } from 'crypto';

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // 5 分钟

export interface SignedRequest {
  policyId: string;
  hash: string;
  input: unknown;
  timestamp: number;
  nonce: string;
  signature: string;
  version?: number; // 可选：指定执行版本（不传则使用默认版本）
}

export interface SignaturePayload {
  policyId: string;
  hash: string;
  input: unknown;
  timestamp: number;
  nonce: string;
  version?: number; // 可选：指定执行版本
}

/**
 * 计算策略源码的 SHA-256 哈希
 */
export function computeSourceHash(source: string): string {
  return `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;
}

/**
 * 计算链式哈希（包含前一版本哈希）
 *
 * 链式哈希确保版本历史的完整性：
 * - 任何历史版本被篡改，后续所有哈希失效
 * - 无法插入、删除或替换中间版本
 */
export function computeChainedHash(source: string, prevHash: string | null): string {
  const content = prevHash ? `${source}${prevHash}` : source;
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

/**
 * 生成请求签名
 *
 * 使用 HMAC-SHA256 对请求负载进行签名。
 * 注意：在生产环境中，签名应在服务端（BFF 层）完成，
 * 而不是在客户端浏览器中。
 */
export function signRequest(payload: SignaturePayload, secret: string): string {
  const data = JSON.stringify({
    policyId: payload.policyId,
    hash: payload.hash,
    input: payload.input,
    timestamp: payload.timestamp,
    nonce: payload.nonce,
    version: payload.version, // 包含版本号（可选）
  });

  const signature = createHmac('sha256', secret).update(data).digest('hex');
  return `hmac-sha256:${signature}`;
}

/**
 * 验证请求签名
 *
 * 使用时间安全比较防止时序攻击。
 */
export function verifySignature(request: SignedRequest, secret: string): boolean {
  // 空密钥（含全空白）签出的签名任何人都能算，一律视为无效
  if (!secret || !secret.trim()) {
    return false;
  }
  const expectedSignature = signRequest(
    {
      policyId: request.policyId,
      hash: request.hash,
      input: request.input,
      timestamp: request.timestamp,
      nonce: request.nonce,
      version: request.version, // 包含版本号（可选）
    },
    secret
  );

  return timingSafeEqual(request.signature, expectedSignature);
}

/**
 * 验证时间戳是否在有效窗口内
 *
 * 防止重放攻击的第一道防线，配合 Nonce 使用。
 */
export function validateTimestamp(timestamp: number): boolean {
  const now = Date.now();
  const diff = Math.abs(now - timestamp);
  return diff <= TIMESTAMP_WINDOW_MS;
}

/**
 * 时间安全的字符串比较
 *
 * 防止时序攻击：无论字符串在哪个位置不同，
 * 比较时间都是恒定的。
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  try {
    return cryptoTimingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * 验证哈希格式
 */
export function isValidHashFormat(hash: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(hash);
}

/**
 * 验证签名格式
 */
export function isValidSignatureFormat(signature: string): boolean {
  return /^hmac-sha256:[a-f0-9]{64}$/.test(signature);
}
