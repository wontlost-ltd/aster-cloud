'use client';

/**
 * 显示排版（LayoutMap 的 display 侧）的只读渲染（ADR 0058 §7.7 第 3 条、§7.8）。
 *
 * - 内容 span 原样显示（两个视图里逐字相同）；
 * - 结构 span 有独立样式，`title` / `aria-description` 给出它在 canonical 里的写法，读者随时能看到实际执行的关键词；
 * - display 为空串的结构 span 渲染一个插入标记，隐藏的关键词不会无声消失；
 * - `highlight` 与 `markers` 是 display 偏移（UTF-16 code unit，由调用方经 canonical → display 投影得到）。
 *
 * 只从包的 `./layout` 子路径取类型：主入口经 `node:crypto` 会拖垮客户端包（见 policy-review-panel.tsx 的说明）。
 */
import { useMemo, type MouseEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { LayoutRange, PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';

export type LayoutMarkerSeverity = 'error' | 'warning';

export interface LayoutDisplayMarker {
  range: LayoutRange;
  severity: LayoutMarkerSeverity;
}

export interface LayoutDisplayViewProps {
  layout: PolicyLayout;
  highlight?: LayoutRange | null;
  markers?: ReadonlyArray<LayoutDisplayMarker>;
  /** 给出时按字符（码点）切分，点击第 n 个 display code unit 处的字符回调 n。 */
  onDisplayOffsetClick?: (offset: number) => void;
}

/** 一个 span 在 display 里的位置；结构 span 带 canonical 写法。 */
interface Block {
  start: number;
  display: string;
  canonical: string | null;
}

/** 渲染单元：同一 span 内、高亮与标记状态都不变的一段 display。 */
interface Piece {
  start: number;
  text: string;
}

export const HIGHLIGHT_CLASS = 'bg-amber-200 text-fg dark:bg-amber-500/40 dark:text-fg';
export const MARKER_CLASS: Record<LayoutMarkerSeverity, string> = {
  error: 'underline decoration-wavy decoration-red-600 dark:decoration-red-400',
  warning: 'underline decoration-wavy decoration-amber-600 dark:decoration-amber-400',
};

function toBlocks(layout: PolicyLayout): Block[] {
  let offset = 0;
  return layout.spans.map((span) => {
    const block: Block = 'text' in span
      ? { start: offset, display: span.text, canonical: null }
      : { start: offset, display: span.display, canonical: span.canonical };
    offset += block.display.length;
    return block;
  });
}

/** 码点边界（不在代理对中间切分）。 */
function codePointCuts(block: Block): number[] {
  const cuts: number[] = [];
  let i = 0;
  for (const ch of block.display) {
    i += ch.length;
    cuts.push(block.start + i);
  }
  return cuts;
}

/** 切点落在代理对中间时移到码点边界：起点向前、终点向后，区间只会变宽、不会拆出孤立代理项。 */
function snapToCodePoint(block: Block, offset: number, direction: -1 | 1): number {
  const i = offset - block.start;
  if (i <= 0 || i >= block.display.length) return offset;
  const high = block.display.charCodeAt(i - 1);
  const low = block.display.charCodeAt(i);
  const splitsPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
  return splitsPair ? offset + (direction === -1 ? -1 : 1) : offset;
}

/** 把一个 span 在给定的切点处切开；只保留落在 span 内部的切点。 */
function splitBlock(block: Block, cuts: readonly number[]): Piece[] {
  const end = block.start + block.display.length;
  const inner = [...new Set(cuts)].filter((c) => c > block.start && c < end).sort((a, b) => a - b);
  const bounds = [block.start, ...inner, end];
  return bounds.slice(0, -1).map((s, i) => ({
    start: s,
    text: block.display.slice(s - block.start, bounds[i + 1] - block.start),
  }));
}

const overlaps = (start: number, end: number, r: LayoutRange) => start < r.end && end > r.start;

export function LayoutDisplayView({ layout, highlight = null, markers = [], onDisplayOffsetClick }: LayoutDisplayViewProps) {
  const t = useTranslations('policyLayout');
  const blocks = useMemo(() => toBlocks(layout), [layout]);
  const ranges = useMemo(
    () => [...(highlight ? [highlight] : []), ...markers.map((m) => m.range)],
    [highlight, markers],
  );

  /** 片段的高亮与标记状态；多个标记重叠时 error 优先。 */
  const pieceState = (start: number, end: number) => {
    const hit = markers.filter((m) => overlaps(start, end, m.range));
    const severity: LayoutMarkerSeverity | undefined = hit.some((m) => m.severity === 'error')
      ? 'error'
      : hit[0]?.severity;
    return { highlighted: highlight !== null && overlaps(start, end, highlight), severity };
  };

  const renderPieces = (block: Block) => {
    const cuts = ranges.flatMap((r) => [snapToCodePoint(block, r.start, -1), snapToCodePoint(block, r.end, 1)]);
    const all = onDisplayOffsetClick ? [...cuts, ...codePointCuts(block)] : cuts;
    return splitBlock(block, all).map((p) => {
      const { highlighted, severity } = pieceState(p.start, p.start + p.text.length);
      // 没有任何状态、也不可点击的片段直接作为文本节点，保持 DOM 精简
      if (!highlighted && !severity && !onDisplayOffsetClick) return p.text;
      const className = [highlighted ? HIGHLIGHT_CLASS : '', severity ? MARKER_CLASS[severity] : ''].filter(Boolean).join(' ');
      return (
        <span
          key={p.start}
          className={className || undefined}
          data-display-offset={onDisplayOffsetClick ? p.start : undefined}
          data-layout-highlight={highlighted ? '' : undefined}
          data-layout-marker={severity}
        >
          {p.text}
        </span>
      );
    });
  };

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (!onDisplayOffsetClick) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-display-offset]');
    if (target) onDisplayOffsetClick(Number(target.dataset.displayOffset));
  };

  return (
    <pre
      tabIndex={0}
      role="region"
      aria-label={t('displayLabel')}
      data-layout-display=""
      onClick={onDisplayOffsetClick ? handleClick : undefined}
      className="max-h-[500px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-subtle p-4 font-mono text-sm text-fg dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
    >
      {blocks.map((block) => {
        if (block.canonical === null) {
          return <span key={block.start} data-layout-content="">{renderPieces(block)}</span>;
        }
        if (block.display === '') {
          return (
            <span
              key={`${block.start}-ins`}
              data-layout-insertion=""
              data-layout-structural=""
              role="img"
              aria-label={t('insertionLabel', { canonical: block.canonical })}
              title={block.canonical}
              className="mx-px inline-block h-[1.1em] w-0.5 rounded-sm bg-sky-600 align-text-bottom dark:bg-sky-400"
            />
          );
        }
        return (
          <span
            key={block.start}
            data-layout-structural=""
            title={block.canonical}
            aria-description={block.canonical}
            className="rounded-sm bg-sky-100 text-sky-900 underline decoration-dotted decoration-sky-600 underline-offset-2 dark:bg-sky-900/50 dark:text-sky-100 dark:decoration-sky-400"
          >
            {renderPieces(block)}
          </span>
        );
      })}
    </pre>
  );
}
