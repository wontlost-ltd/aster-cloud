/**
 * Canonical JSON serializer — P0-A 规则集升级回归工具的漂移检测地基（ADR 0030 §3.5 / 附录 A.2）。
 *
 * 决策级持久层的 `canonicalInputHash` / `canonicalOutputHash` / `traceHash` 都基于本模块：
 * 只有在**确定性的** canonical 形式下逐字节比对才有意义（否则 key 顺序 / Decimal 表示 /
 * null 处理的差异会污染 old↔new toolchain 的漂移判定，把无害差异误报成 regression）。
 *
 * 设计铁律（ADR 附录 A.2）：
 *   - object key 按 Unicode code point 升序；array 保序。
 *   - `null` 显式输出；**missing ≠ null**；不丢空对象 / 空数组 / false / 0 / ""。
 *   - string 原值不做 trim / case-fold。
 *   - number 须 finite；NaN / Infinity 拒绝（NON_CANONICAL_NUMBER）。
 *   - Decimal **类型感知**：仅当 typeCtx 声明某路径为 Decimal 时才做 decimal canonical
 *     （无 exponent / 无前导 + / 无无意义前导零 / 无 trailing zero / `-0`→`0` / 整数无 `.0`）。
 *   - JSON `1` ≠ string `"1"`（不全局转换数字字符串）。
 *
 * 纯模块：无 Node-only API 依赖除 `node:crypto`（hash 用），无 DB / 网络 / 环境读取。
 * 双引擎地基：本 TS 实现须与 Java 权威实现字节级一致（Phase 后续补 Java 侧 + parity）。
 */

import { createHash } from 'node:crypto';

/** 当前 canonical 算法版本，写进 hash 前缀 + Execution.canonicalizationVersion。变更算法必 bump。 */
export const CANONICALIZATION_VERSION = 'aster-canonical-json/v1';

/** canonical 化失败原因（对齐 Execution.replayabilityReasons 的 NON_REPLAYABLE 语义）。 */
export type CanonicalErrorReason =
  | 'NON_CANONICAL_NUMBER'
  | 'NON_INTEGER_NUMBER'
  | 'UNSUPPORTED_VALUE'
  | 'DECIMAL_TOO_LARGE';

/**
 * Decimal 展开的资源上限（防大指数 DoS / RangeError）。金融金额远在此范围内，
 * 超限统一报 DECIMAL_TOO_LARGE 而非非受控异常（Codex 审查 L1#3）。
 */
const MAX_DECIMAL_DIGITS = 4096;
const MAX_DECIMAL_EXPONENT = 4096;

export class CanonicalJsonError extends Error {
  constructor(
    public readonly reason: CanonicalErrorReason,
    message: string,
    /** 出错值所在的 JSON 路径（如 `input.amount`），便于诊断。 */
    public readonly path: string,
  ) {
    super(`${reason} at ${path}: ${message}`);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * 类型上下文：声明哪些字段路径是 Decimal，须做 decimal canonical。
 *
 * 路径用点号连接（array 元素用 `[]` 通配，如 `applicants[].income`）。M1 只支持
 * 精确路径 + `[]` 通配；无 typeCtx 时所有 number 按 JSON number 处理（IEEE-754 规范化）。
 * Decimal 值在 JSON 里应以 **string** 承载（避免 IEEE-754 精度损失），typeCtx 标注后
 * 按 decimal 规范化；若声明为 Decimal 的路径出现 number，也接受并规范化其字符串形式。
 */
export interface CanonicalTypeContext {
  /** 声明为 Decimal 的字段路径集合（`[]` 表示任意 array 下标）。 */
  decimalPaths: ReadonlySet<string>;
}

/** 把具体 array 下标路径归一为 `[]` 通配，用于 typeCtx 匹配。 */
function normalizePathForMatch(path: string): string {
  return path.replace(/\[\d+\]/g, '[]');
}

function isDecimalPath(path: string, ctx: CanonicalTypeContext | undefined): boolean {
  if (!ctx) return false;
  return ctx.decimalPaths.has(normalizePathForMatch(path));
}

/**
 * 规范化 JSON string（TS 侧用 JSON.stringify 转义；code point 保序，不做业务变换）。
 *
 * ★Java parity 注意（Codex L1#2）：本实现的转义策略 = JS `JSON.stringify`（短转义 \n\t 等 /
 * U+0000..001F / 不转义 `/` / 不转义 U+2028 U+2029 / lone surrogate 输出 \udxxx）。Java 权威
 * 侧**不能**依赖 Jackson/Gson 默认转义自动对齐——须实现逐 code point 的 canonical string writer
 * 复刻此策略，并由 TS↔Java golden fixture 固化（发布前 parity gate，见 ADR 0030 附录 A）。
 * 此处不声明「已跨实现保证」，只声明「TS 侧策略确定」。
 */
function canonicalString(value: string): string {
  return JSON.stringify(value);
}

/**
 * 规范化普通 JSON number（非 Decimal 路径）——★双引擎地基铁律：**只允许 safe integer**。
 *
 * 原因（Codex 审查 L1#1/L4）：JS `Number#toString()` 与 Java `Double.toString()` 对同一
 * IEEE-754 浮点（如 `1e21`/`0.1`/`1e-7`）产生**不同字符串表示** → 双引擎 hash 不一致，
 * 直接打穿「回放不误报漂移」的地基。金融决策里所有小数/金额本就应走 Decimal（string 承载 +
 * typeCtx），用 IEEE-754 float 表示金额是错误姿势。故非 Decimal number 强制 safe integer，
 * 小数一律要求走 Decimal 路径（否则报 NON_INTEGER_NUMBER，调用方须补 typeCtx 声明）。
 */
function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError('NON_CANONICAL_NUMBER', `number 非 finite: ${value}`, path);
  }
  // -0 归一为 0（ADR：-0→0）。safe integer 范围内 -0 === 0，toString 即 "0"。
  const normalized = value === 0 ? 0 : value;
  if (!Number.isSafeInteger(normalized)) {
    throw new CanonicalJsonError(
      'NON_INTEGER_NUMBER',
      `非 Decimal number 只允许 safe integer（小数/超范围须走 Decimal string + typeCtx 声明）: ${value}`,
      path,
    );
  }
  // safe integer 的 toString 跨引擎一致（十进制整数无表示歧义）。
  return normalized.toString();
}

/**
 * 规范化 Decimal 值（decimal canonical form）：
 *   无 exponent / 无前导 `+` / 无无意义前导零 / 无 trailing zero / `-0`→`0` / 整数无 `.0`。
 * 接受 string（推荐，避免精度损失）或 number（会先转 string）。
 */
function canonicalDecimal(raw: string | number, path: string): string {
  // Decimal number 入参先转其整数字符串（number 已受 safe-integer 约束时才可能到这；
  // 但 Decimal 路径的 number 允许非整数——用 JS 表示转字符串后再规范化）。
  // string 入参：★不 trim（与「string 不 trim」铁律一致，Codex L1#4）——含空白即非法。
  let s: string;
  if (typeof raw === 'number') {
    // ★Decimal 路径也只接受 safe integer number（Codex 复审 #1 闭环）：非整数 JS number
    // 走 Number#toString() 会重新引入跨引擎表示/精度隐患。精确 Decimal 必须以 string 承载。
    if (!Number.isFinite(raw)) {
      throw new CanonicalJsonError('NON_CANONICAL_NUMBER', `Decimal number 非 finite: ${raw}`, path);
    }
    if (!Number.isSafeInteger(raw === 0 ? 0 : raw)) {
      throw new CanonicalJsonError(
        'NON_INTEGER_NUMBER',
        `Decimal 路径的 number 只允许 safe integer；精确小数须以 string 承载（避免 IEEE-754 精度损失）: ${raw}`,
        path,
      );
    }
    s = (raw === 0 ? 0 : raw).toString();
  } else {
    s = raw;
  }

  // 允许可选符号 + 整数部分 + 可选小数部分 + 可选指数（无前后空白）。
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) {
    throw new CanonicalJsonError('NON_CANONICAL_NUMBER', `Decimal 格式非法: ${JSON.stringify(raw)}`, path);
  }

  const sign = m[1] === '-' ? '-' : '';
  let intPart = m[2] ?? '0';
  let fracPart = m[3] ?? '';
  const expStr = m[4] ?? '0';

  // 资源上限：拒绝大指数 / 超长数字串（防 DoS / RangeError，Codex L1#3）。
  if (expStr.length > 10) {
    throw new CanonicalJsonError('DECIMAL_TOO_LARGE', `Decimal 指数过大: ${expStr}`, path);
  }
  const exp = parseInt(expStr, 10);
  if (Math.abs(exp) > MAX_DECIMAL_EXPONENT) {
    throw new CanonicalJsonError('DECIMAL_TOO_LARGE', `Decimal 指数超限(${exp} > ±${MAX_DECIMAL_EXPONENT})`, path);
  }

  // 展开指数：把 int.frac 视为无小数点的数字串，用 exp 决定小数点位置。
  let digits = intPart + fracPart;
  let pointPos = intPart.length + exp; // 小数点在 digits 中的位置（从左数）。

  // 展开后总位数上限（防 1e4096 类构造出超长串）。
  const expandedLen = pointPos <= 0
    ? (1 - pointPos) + digits.length
    : Math.max(pointPos, digits.length);
  if (expandedLen > MAX_DECIMAL_DIGITS) {
    throw new CanonicalJsonError('DECIMAL_TOO_LARGE', `Decimal 展开位数超限(${expandedLen} > ${MAX_DECIMAL_DIGITS})`, path);
  }

  if (pointPos <= 0) {
    digits = '0'.repeat(1 - pointPos) + digits;
    pointPos = 1;
  }
  if (pointPos >= digits.length) {
    digits = digits + '0'.repeat(pointPos - digits.length);
  }
  intPart = digits.slice(0, pointPos);
  fracPart = digits.slice(pointPos);

  // 去无意义前导零（保留至少一位）。
  intPart = intPart.replace(/^0+(?=\d)/, '');
  // 去 trailing zero。
  fracPart = fracPart.replace(/0+$/, '');

  const body = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
  // -0 归一为 0。
  if (sign === '-' && /^0(?:\.0*)?$/.test(body)) {
    return intPart; // "0"
  }
  return sign + body;
}

function canonicalizeValue(
  value: unknown,
  path: string,
  ctx: CanonicalTypeContext | undefined,
): string {
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (isDecimalPath(path, ctx)) {
      return canonicalDecimal(value as number, path);
    }
    return canonicalNumber(value as number, path);
  }

  if (t === 'string') {
    if (isDecimalPath(path, ctx)) {
      // Decimal 路径上的 string 承载精确值 → decimal canonical。
      return canonicalDecimal(value as string, path);
    }
    return canonicalString(value as string);
  }

  if (Array.isArray(value)) {
    // array 保序；元素路径用 `[i]`（typeCtx 匹配时归一为 `[]`）。
    // ★拒绝 sparse array holes（Codex L2）：map 会跳过 hole 产生非法/歧义 canonical，
    // 用显式 `i in value` 检测，hole 直接 UNSUPPORTED_VALUE。
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      // own-property 检测（非 `i in value`，后者会把原型链索引当存在，Codex 复审 #3）。
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw new CanonicalJsonError('UNSUPPORTED_VALUE', `sparse array hole at index ${i}`, `${path}[${i}]`);
      }
      parts.push(canonicalizeValue(value[i], `${path}[${i}]`, ctx));
    }
    return `[${parts.join(',')}]`;
  }

  if (t === 'object') {
    // ★只接受 plain object（Codex L2）：Date/Map/Set/RegExp 等 typeof 也是 object，
    // Object.keys 为空会被静默 canonical 成 `{}`，吞掉语义差异 → 显式拒绝非 plain object。
    if (!isPlainObject(value)) {
      throw new CanonicalJsonError(
        'UNSUPPORTED_VALUE',
        `非 plain object（Date/Map/Set/RegExp/class 实例等不支持，须先转纯 JSON）: ${Object.prototype.toString.call(value)}`,
        path,
      );
    }
    // object key 按 Unicode code point 升序（含代理对，见 compareByCodePoint）。
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(compareByCodePoint);
    const parts = keys.map((k) => {
      // 路径用 `.` 连接（与 typeCtx decimalPaths 写法一致，如 `applicants[].income`）。
      // ★已知限制（Codex L3）：JSON key 含 `.` 或 `[` 时路径会与 typeCtx 语法歧义。
      // M1 缓解：Decimal 字段路径应从 schema/typed 模型自动导出（非手写散落），金融 input
      // 字段名不含 `.`/`[`。含特殊字符 key 的子孙退化为普通处理——普通 number 走 safe-integer
      // 铁律、string 保原值，不会静默精度漂移。M2 改 tokenized path array 彻底消歧义。
      const childPath = path === '' ? k : `${path}.${k}`;
      // value 显式输出（missing≠null：只有实际存在的 key 才输出）。
      return `${canonicalString(k)}:${canonicalizeValue(obj[k], childPath, ctx)}`;
    });
    return `{${parts.join(',')}}`;
  }

  // undefined / function / symbol / bigint 等非 JSON 值。
  throw new CanonicalJsonError('UNSUPPORTED_VALUE', `不支持的值类型: ${t}`, path);
}

/**
 * 判断是否 plain object（对象字面量 / `Object.create(null)`），排除 Date/Map/Set/RegExp/
 * class 实例等——它们 typeof 也是 'object' 但非纯 JSON 容器（Codex L2）。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 按 Unicode code point 比较（正确处理代理对，避免 code unit 序在补充平面字符上的偏差）。 */
function compareByCodePoint(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const ca = ai[i]!.codePointAt(0)!;
    const cb = bi[i]!.codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return ai.length - bi.length;
}

/**
 * 把任意 JSON 值序列化为 canonical 字符串（确定性、跨实现可复现）。
 * @throws CanonicalJsonError 遇到 NaN/Infinity/非法 Decimal/非 JSON 值。
 */
export function canonicalJson(value: unknown, ctx?: CanonicalTypeContext): string {
  return canonicalizeValue(value, '', ctx);
}

/**
 * 计算 canonical hash：`sha256(CANONICALIZATION_VERSION + "\n" + canonicalJson(value))`（hex）。
 * 版本前缀确保算法演进时旧 hash 不会与新 hash 意外碰撞（ADR 附录 A.2）。
 */
export function canonicalHash(value: unknown, ctx?: CanonicalTypeContext): string {
  const canonical = canonicalJson(value, ctx);
  return createHash('sha256')
    .update(`${CANONICALIZATION_VERSION}\n${canonical}`, 'utf8')
    .digest('hex');
}

/** 便捷构造 typeCtx（从 Decimal 路径数组）。 */
export function decimalTypeContext(decimalPaths: readonly string[]): CanonicalTypeContext {
  return { decimalPaths: new Set(decimalPaths.map(normalizePathForMatch)) };
}
