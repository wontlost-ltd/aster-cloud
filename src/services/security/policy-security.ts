/**
 * 策略安全服务 - 哈希
 *
 * 提供策略源码哈希与链式哈希。
 */

import { createHash } from 'crypto';

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
 * 验证哈希格式
 */
export function isValidHashFormat(hash: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(hash);
}
