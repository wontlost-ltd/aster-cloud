/**
 * 编辑器的 LayoutMap 纯函数（ADR 0058 §7.4、§7.8，计划 T9）：span 编辑与位置投影。客户端与服务端都可用。
 *
 * - 排版只从 canonical 派生：恒等排版 → 在同一个内容 span 内切出结构 span → 改它的 display → 可恢复为内容。
 *   任何操作序列之后 `toCanonical(layout)` 都等于源码（§7.4 只允许在 canonical 上切分）。
 * - 偏移一律是 UTF-16 code unit，换行不归一化；行列 1 起始，与 Monaco 行模型一致。
 *   切分点不得落在代理对中间（emoji 等），否则抛 `splits_surrogate`。
 * - 全部返回新对象、不改入参；非法输入抛 `RangeError`，`message` 是下列稳定码之一，供界面本地化。
 */
import { LAYOUT_LIMITS, type LayoutLimitName, type LayoutRange, type LayoutSpan, type PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';

export type LayoutEditErrorCode = 'empty_range' | 'crosses_structural' | 'splits_surrogate' | 'out_of_range';

export const LAYOUT_EDIT_ERROR_CODES: readonly LayoutEditErrorCode[] = [
  'empty_range',
  'crosses_structural',
  'splits_surrogate',
  'out_of_range',
];

function fail(code: LayoutEditErrorCode): never {
  throw new RangeError(code);
}

/** `RangeError` 的稳定码；不是本模块抛出的错误返回 null。 */
export function layoutEditErrorCode(e: unknown): LayoutEditErrorCode | null {
  if (!(e instanceof RangeError)) return null;
  return (LAYOUT_EDIT_ERROR_CODES as readonly string[]).includes(e.message) ? (e.message as LayoutEditErrorCode) : null;
}

const canonicalOf = (span: LayoutSpan) => ('text' in span ? span.text : span.canonical);
const displayOf = (span: LayoutSpan) => ('text' in span ? span.text : span.display);
const isStructural = (span: LayoutSpan): span is { canonical: string; display: string } => !('text' in span);

/** `offset` 是否把 `text` 中的一个代理对拆开（前一个是高代理、当前是低代理）。 */
function splitsSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const high = text.charCodeAt(offset - 1);
  const low = text.charCodeAt(offset);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

function assertOffset(offset: number, max: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > max) fail('out_of_range');
}

/** 合并相邻内容 span；结构 span 各自携带一段映射，不合并。 */
function mergeAdjacentContent(spans: readonly LayoutSpan[]): LayoutSpan[] {
  const out: LayoutSpan[] = [];
  for (const span of spans) {
    const prev = out[out.length - 1];
    if (prev && 'text' in prev && 'text' in span) out[out.length - 1] = { text: prev.text + span.text };
    else out.push(span);
  }
  return out;
}

/** 恒等排版：整篇源码是一个内容 span（两个视图逐字相同）。 */
export function identityLayout(source: string): PolicyLayout {
  if (source === '') fail('empty_range');
  return { v: 1, spans: [{ text: source }] };
}

/**
 * 把 canonical 区间 `[start, end)` 标为结构 span，display 为 `display`。区间必须完全落在同一个内容 span 内，
 * 该内容 span 被切成至多三段。
 */
export function markStructural(layout: PolicyLayout, start: number, end: number, display: string): PolicyLayout {
  const source = layout.spans.map(canonicalOf).join('');
  assertOffset(start, source.length);
  assertOffset(end, source.length);
  if (end < start) fail('out_of_range');
  if (end === start) fail('empty_range');
  if (splitsSurrogate(source, start) || splitsSurrogate(source, end)) fail('splits_surrogate');

  let at = 0;
  for (let i = 0; i < layout.spans.length; i++) {
    const span = layout.spans[i];
    const len = canonicalOf(span).length;
    const inside = start >= at && end <= at + len;
    if (inside && 'text' in span) {
      const before = span.text.slice(0, start - at);
      const after = span.text.slice(end - at);
      const pieces: LayoutSpan[] = [
        ...(before ? [{ text: before }] : []),
        { canonical: span.text.slice(start - at, end - at), display },
        ...(after ? [{ text: after }] : []),
      ];
      return { v: 1, spans: [...layout.spans.slice(0, i), ...pieces, ...layout.spans.slice(i + 1)] };
    }
    at += len;
  }
  return fail('crosses_structural');
}

function assertStructuralIndex(layout: PolicyLayout, index: number): void {
  if (!Number.isInteger(index) || !layout.spans[index] || !isStructural(layout.spans[index])) fail('out_of_range');
}

/** 第 `index` 个 span（必须是结构 span）恢复为内容 `{ text: canonical }`，并与相邻内容 span 合并。 */
export function unmarkStructural(layout: PolicyLayout, index: number): PolicyLayout {
  assertStructuralIndex(layout, index);
  const spans = layout.spans.map((span, i) => (i === index ? { text: canonicalOf(span) } : span));
  return { v: 1, spans: mergeAdjacentContent(spans) };
}

/** 改第 `index` 个结构 span 的 display（可为空串以隐藏）。 */
export function setStructuralDisplay(layout: PolicyLayout, index: number, display: string): PolicyLayout {
  assertStructuralIndex(layout, index);
  const spans = layout.spans.map((span, i) => (i === index ? { canonical: canonicalOf(span), display } : span));
  return { v: 1, spans };
}

/** 各行起点偏移；只按 `\n` 断行（`\r\n` 的 `\r` 属于上一行的行尾，与 Monaco 行模型一致）。 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** 第 `line` 行（1 起始）内容的结束偏移：不含行尾的 `\n` 与其前的 `\r`（Monaco 的最大列 = 内容长度 + 1）。 */
function lineContentEnd(text: string, starts: readonly number[], line: number): number {
  if (line >= starts.length) return text.length;
  const newline = starts[line] - 1;
  return newline > starts[line - 1] && text.charCodeAt(newline - 1) === 0x0d ? newline - 1 : newline;
}

/** 1 起始的行列 → UTF-16 偏移。列可到行尾之后一位（行末插入点）。 */
export function offsetAt(text: string, line: number, column: number): number {
  const starts = lineStarts(text);
  if (!Number.isInteger(line) || line < 1 || line > starts.length) fail('out_of_range');
  const lineStart = starts[line - 1];
  const lineEnd = lineContentEnd(text, starts, line);
  if (!Number.isInteger(column) || column < 1 || column > lineEnd - lineStart + 1) fail('out_of_range');
  return lineStart + column - 1;
}

/**
 * 同 `offsetAt`，但把越界的行列夹到最近的合法位置。用于外部给出的诊断区间（终点列可能越过行尾、
 * 源码可能已比诊断短），保证投影不因越界而丢掉整条诊断。
 */
export function offsetAtClamped(text: string, line: number, column: number): number {
  const starts = lineStarts(text);
  const l = Math.min(Math.max(Math.trunc(line) || 1, 1), starts.length);
  const lineStart = starts[l - 1];
  const lineEnd = lineContentEnd(text, starts, l);
  return lineStart + Math.min(Math.max(Math.trunc(column) || 1, 1), lineEnd - lineStart + 1) - 1;
}

/**
 * UTF-16 偏移 → 1 起始的行列；`offsetAt` 的逆。落在 `\r\n` 两个 code unit 之间的偏移没有对应的 Monaco 位置，
 * 归到该行行尾（`\r` 之前），与 Monaco 对这类位置的夹取一致。
 */
export function positionAt(text: string, offset: number): { line: number; column: number } {
  assertOffset(offset, text.length);
  const at = offset > 0 && text.charCodeAt(offset - 1) === 0x0d && text.charCodeAt(offset) === 0x0a ? offset - 1 : offset;
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < at; i = text.indexOf('\n', i + 1)) line++;
  return { line, column: at - lineStart + 1 };
}

/**
 * canonical 区间 `[start, end)` 投到 display（诊断与 R14 延期的 trace 都只经这一个函数投影）：
 * - 端点落在内容 span 内按相对位置一一对应，区间长度不变；
 * - 端点落在结构 span 内（含部分重叠）扩到该 span 的整段 display；display 为空时是零宽插入点；
 * - `start === end` 返回 `start` 投影后的一个点。
 */
export function projectCanonicalRange(layout: PolicyLayout, start: number, end: number): LayoutRange {
  const length = layout.spans.reduce((n, span) => n + canonicalOf(span).length, 0);
  assertOffset(start, length);
  assertOffset(end, length);
  if (end < start) fail('out_of_range');

  let from: number | null = null;
  let to: number | null = null;
  let cAt = 0;
  let dAt = 0;
  for (const span of layout.spans) {
    const cLen = canonicalOf(span).length;
    const dLen = displayOf(span).length;
    if (from === null && start < cAt + cLen) from = 'text' in span ? dAt + (start - cAt) : dAt;
    // end - 1 是区间里最后一个 code unit：内容 span 取它之后一位，结构 span 取整段 display 的末尾
    if (to === null && end > start && end - 1 < cAt + cLen) to = 'text' in span ? dAt + (end - cAt) : dAt + dLen;
    cAt += cLen;
    dAt += dLen;
  }
  const s = from ?? dAt;
  return { start: s, end: end === start ? s : Math.max(s, to ?? dAt) };
}

/** 源码的 UTF-8 字节数与行数（与包的上限口径一致：按 `\r\n`、`\r`、`\n` 断行，末尾换行不另计一行）。 */
function sourceLineCount(source: string): number {
  if (source === '') return 0;
  const breaks = source.match(/\r\n|\r|\n/g)?.length ?? 0;
  return /[\r\n]$/.test(source) ? breaks : breaks + 1;
}

/** 源码超出排版上限（§7.6）时返回超出的上限名与实际值，否则 null。编辑器据此不提供排版入口。 */
export function sourceLayoutLimitExceeded(
  source: string,
): { limit: Extract<LayoutLimitName, 'sourceBytes' | 'sourceLines'>; actual: number } | null {
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > LAYOUT_LIMITS.sourceBytes) return { limit: 'sourceBytes', actual: bytes };
  const lines = sourceLineCount(source);
  if (lines > LAYOUT_LIMITS.sourceLines) return { limit: 'sourceLines', actual: lines };
  return null;
}
