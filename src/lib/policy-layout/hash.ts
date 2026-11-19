/** 服务端 SHA-256：UTF-8 编码后取 64 位小写十六进制，无前缀（与 PolicyVersionLayout 的 CHECK 一致）。 */
import { createHash } from 'node:crypto';

export function sha256Utf8Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
