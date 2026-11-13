/**
 * RFC 8785（JSON Canonicalization Scheme）规范化，即 aster-api `jcs-sha256/v1` 的规范化部分（ADR 0040 §12 D2）。
 *
 * 字节级定义由 aster-api 的共享向量 `jcs-sha256-v1-vectors.json`（本仓 `src/__tests__/fixtures/` 逐字节副本）锁定，
 * 与 aster-api `JcsCanonicalizer` 一致：
 * - 对象成员按键的 UTF-16 码元序排序（JS 默认 `sort` 即此序），无空白；
 * - 字符串按 RFC 8785 §3.2.2.2 输出：只转义 `"`、`\` 与 U+0000–U+001F（短形式优先，其余为小写 `\u00xx`），
 *   其余字符原样——这正是 ECMAScript `JSON.stringify(string)` 的输出；不做 Unicode 正规化；
 *   含孤立代理项的字符串（键也一样）无法编码为 UTF-8 → `invalid_string`；
 * - 数字按 ECMAScript `Number::toString`（`JSON.stringify(number)`，−0 → `0`）；先过 I-JSON（RFC 7493 §2.2）：
 *   非有限数或 |x| > 2^53−1 → `unsafe_integer`，不做舍入（这类值须以字符串发送）；
 * - `true / false / null` 原样。
 *
 * cloud 只规范化自己构造的 JS 值（签名载荷、与 action 比对的 claim 值），所以不存在重复键；
 * JSON 之外的值（`undefined`、函数、`bigint`、symbol、Date / Map 等非普通对象、稀疏数组空位）一律
 * `unsupported_value`，不像 `JSON.stringify` 那样静默丢弃或经 `toJSON` 隐式转换——否则签名字节与线上请求体不一致。
 */

export type JcsErrorCode = 'unsafe_integer' | 'invalid_string' | 'unsupported_value';

export class JcsError extends Error {
  constructor(readonly code: JcsErrorCode, message: string) {
    super(message);
    this.name = 'JcsError';
  }
}

// 不配对的高代理项或低代理项（等价于 !String.prototype.isWellFormed，避免依赖运行时是否提供该方法）
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function writeString(s: string): string {
  if (LONE_SURROGATE_RE.test(s)) throw new JcsError('invalid_string', '字符串含孤立代理项');
  return JSON.stringify(s);
}

function writeNumber(n: number): string {
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) {
    throw new JcsError('unsafe_integer', `数字不在 I-JSON 安全范围内（须以字符串发送）: ${n}`);
  }
  return JSON.stringify(n);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function write(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return writeNumber(value);
    case 'string':
      return writeString(value);
    case 'object':
      return Array.isArray(value) ? writeArray(value) : writeObject(value);
    default:
      throw new JcsError('unsupported_value', `不是 JSON 值: ${typeof value}`);
  }
}

function writeArray(items: unknown[]): string {
  const parts: string[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!(i in items)) throw new JcsError('unsupported_value', '稀疏数组含空位');
    parts.push(write(items[i]));
  }
  return `[${parts.join(',')}]`;
}

function writeObject(value: object): string {
  if (!isPlainObject(value)) throw new JcsError('unsupported_value', '不是普通 JSON 对象');
  if (Object.getOwnPropertySymbols(value).length > 0) throw new JcsError('unsupported_value', '对象含 symbol 键');
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${writeString(k)}:${write(value[k])}`).join(',')}}`;
}

/** 把 JS 值规范化为 RFC 8785 文本（其 UTF-8 编码即规范字节串）。不满足约束抛 {@link JcsError}。 */
export function jcsCanonicalize(value: unknown): string {
  return write(value);
}
