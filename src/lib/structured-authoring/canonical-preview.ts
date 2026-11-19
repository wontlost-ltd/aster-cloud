/**
 * 词汇规范预览（ADR 0058 §8.2–8.3）的客户端纯函数：响应校验、光标映射与控制字符可见化。
 *
 * 预览由 LSP `aster/canonicalPreview` 生成（aster-lang-ts ≥ 3.3.0），偏移一律是 UTF-16 code unit
 * （ADR §7.8，即 JS 字符串下标，与 Monaco model 的 offset 同一单位）。`mappings` 只列被替换的 token，
 * 其余位置按累计偏移推出。
 */
import type { CanonicalPreview } from '@aster-cloud/aster-lang-ts/browser';

export type { CanonicalPreview };

type Range = [number, number];

function isRange(v: unknown): v is Range {
  return Array.isArray(v) && v.length === 2 && Number.isInteger(v[0]) && Number.isInteger(v[1]) && v[0] <= v[1];
}

/**
 * 校验服务端响应形状；不合契约的一律当作「无预览」（null），由窗格显示「预览不可用」。
 * 服务端对无法忠实生成的预览本就返回 null（失败闭锁），这里只防协议漂移。
 */
export function parseCanonicalPreview(value: unknown): CanonicalPreview | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<CanonicalPreview>;
  if (typeof v.text !== 'string' || typeof v.resolverVersion !== 'number' || !Array.isArray(v.mappings)) return null;
  const ok = v.mappings.every(
    (m) => m && isRange(m.source) && isRange(m.preview) && typeof m.canonical === 'string' && typeof m.role === 'string',
  );
  return ok ? (v as CanonicalPreview) : null;
}

/**
 * 把源码偏移映射到预览区间。
 * - 严格落在被替换 token 内部（start < offset < end）：返回该 token 的整个 `preview` 区间（选中整词）；
 * - 其余位置（含 token 边界）：按此前所有替换的长度差累计平移，返回空区间。
 */
export function mapSourceOffsetToPreview(mappings: CanonicalPreview['mappings'], offset: number): Range {
  let delta = 0;
  for (const m of mappings) {
    const [start, end] = m.source;
    if (offset <= start) break;
    if (offset < end) return [m.preview[0], m.preview[1]];
    delta = m.preview[1] - end;
  }
  return [offset + delta, offset + delta];
}

/**
 * 预览中需可见化的字符：格式控制（\p{Cf}，含双向覆盖 U+202E）、行段分隔符、孤立代理项，
 * 以及除 Tab / 换行外的控制字符。
 */
const HIDDEN_CHAR = /[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]|(?![\t\n\r])\p{Cc}/gu;

/** 不可见字符在窗格中的占位（按 UTF-16 code unit 逐个替换，偏移不变）。 */
export const HIDDEN_CHAR_PLACEHOLDER = '⍰';

export interface HiddenChar {
  /** UTF-16 偏移 */
  offset: number;
  /** UTF-16 长度（代理对为 2） */
  length: number;
  /** 形如 `U+202E` */
  codePoint: string;
}

/**
 * 把不可见与双向控制字符替换为可见占位，返回显示文本与字符清单。
 * 每个 code unit 换成一个占位，显示文本与原文等长，`mappings` 的偏移照常可用；
 * 原字符不进 Monaco，双向覆盖也就无法打乱显示顺序。
 */
export function revealHiddenChars(text: string): { display: string; hidden: HiddenChar[] } {
  const hidden: HiddenChar[] = [];
  const display = text.replace(HIDDEN_CHAR, (ch: string, offset: number) => {
    const cp = ch.codePointAt(0) ?? 0;
    hidden.push({ offset, length: ch.length, codePoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` });
    return HIDDEN_CHAR_PLACEHOLDER.repeat(ch.length);
  });
  return { display, hidden };
}
