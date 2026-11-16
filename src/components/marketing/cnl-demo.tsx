/**
 * Animated Aster CNL demo for the marketing landing page.
 *
 * Why this exists: the landing hero used to *describe* Aster as a
 * "policy DSL in your own language" but never showed it working. The
 * difference between "we have a DSL" and "look, this compiles" is the
 * whole pitch — so the page needs to literally render CNL.
 *
 * Why not Monaco: Monaco is ~700KB minified. Mounting it on every
 * landing-page visit costs more than the conversion value of "fancy
 * editor on the home page". This component does CSS+React typewriter
 * with regex-driven syntax classes — same brand palette as the real
 * editor, ~3KB of code, no editor dependency.
 *
 * Why three snippets: one is enough to read, three signal the breadth
 * of use cases (finance / compliance / workflow). Cycling timer is
 * 7s per snippet — long enough to read the full block, short enough
 * that the page doesn't feel static.
 *
 * Accessibility: `aria-live="polite"` so screen readers can pick up
 * the typing if a user is focused on the demo, but it doesn't
 * interrupt navigation announcements. Reduced-motion users get the
 * final state of each snippet without the typewriter animation.
 */
'use client';

import { useEffect, useState, useRef, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { cn } from '@/components/ui';
import {
  getSnippetsForLocale,
  getKeywordsForLocale,
  type LocaleKeywords,
} from './cnl-demo-snippets';

/** Typewriter timing tuned by trial: 18ms/char feels alive but readable. */
const CHAR_DELAY_MS = 18;
/** Time spent on a fully-typed snippet before erasing + advancing. */
const HOLD_MS = 4000;
/** Erase speed — faster than typing so the wait between snippets is short. */
const ERASE_DELAY_MS = 8;

export function CnlDemo({ className }: { className?: string }) {
  const locale = useLocale();
  const t = useTranslations();
  // Snippets + highlighter keyword set are both locale-scoped — when the
  // user switches /en → /zh the typewriter restarts with native CNL.
  const snippets = useMemo(() => getSnippetsForLocale(locale), [locale]);
  const keywords = useMemo(() => getKeywordsForLocale(locale), [locale]);

  const [snippetIdx, setSnippetIdx] = useState(0);
  const [typedChars, setTypedChars] = useState(0);
  const [phase, setPhase] = useState<'typing' | 'hold' | 'erasing'>('typing');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset to first snippet whenever locale changes — index must not
  // outlive the snippet array it indexed into.
  useEffect(() => {
    // locale（外部）切换时重置动画状态：index 不能残留指向旧 snippet 数组。
    // 从 locale 派生的一次性重置，非渲染循环。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSnippetIdx(0);
    setTypedChars(0);
    setPhase('typing');
  }, [locale]);

  const snippet = snippets[snippetIdx];
  if (!snippet) {
    throw new Error('CnlDemo invariant: snippetIdx out of range');
  }

  // Reduced-motion users: skip the typing animation, render full snippets,
  // still cycle slowly so they see all three over time.
  const prefersReducedMotion = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }, []);

  useEffect(() => {
    if (prefersReducedMotion) {
      // Show each snippet fully for HOLD_MS * 2, then rotate.
      // reduced-motion 分支：切到当前 snippet 时一次性铺满全文（跳过打字动画），
      // 从 snippet 派生，非渲染循环。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTypedChars(snippet.source.length);
      const t = setTimeout(() => {
        setSnippetIdx((i) => (i + 1) % snippets.length);
      }, HOLD_MS * 2);
      return () => clearTimeout(t);
    }

    const step = () => {
      if (phase === 'typing') {
        if (typedChars < snippet.source.length) {
          setTypedChars((c) => c + 1);
          timerRef.current = setTimeout(step, CHAR_DELAY_MS);
        } else {
          setPhase('hold');
          timerRef.current = setTimeout(step, HOLD_MS);
        }
      } else if (phase === 'hold') {
        setPhase('erasing');
        timerRef.current = setTimeout(step, ERASE_DELAY_MS);
      } else if (phase === 'erasing') {
        if (typedChars > 0) {
          setTypedChars((c) => c - 1);
          timerRef.current = setTimeout(step, ERASE_DELAY_MS);
        } else {
          setSnippetIdx((i) => (i + 1) % snippets.length);
          setPhase('typing');
          timerRef.current = setTimeout(step, CHAR_DELAY_MS);
        }
      }
    };
    timerRef.current = setTimeout(step, CHAR_DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [snippet.source, snippetIdx, typedChars, phase, prefersReducedMotion, snippets.length]);

  const displayed = snippet.source.slice(0, typedChars);

  return (
    <div
      className={cn(
        'mx-auto w-full max-w-2xl overflow-hidden',
        'rounded-xl border border-border bg-zinc-950 shadow-xl shadow-primary/10',
        className,
      )}
      aria-live="polite"
      aria-atomic="false"
    >
      {/* Window chrome — three macOS-style dots + label */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-rose-500/70" aria-hidden />
          <span className="size-2.5 rounded-full bg-amber-400/70" aria-hidden />
          <span className="size-2.5 rounded-full bg-emerald-500/70" aria-hidden />
        </div>
        <span className="font-mono text-xs text-zinc-400">{t(snippet.labelKey)}</span>
        <span className="font-mono text-xs text-zinc-400">.aster</span>
      </div>

      {/* Code body */}
      <pre
        className="overflow-x-auto px-5 py-5 font-mono text-sm leading-relaxed"
        style={{
          // Lock minimum height so the card doesn't bounce as text types.
          // Tallest snippet has 8 lines × ~1.6rem = ~12.8rem. Pad a touch.
          minHeight: '14rem',
        }}
      >
        <code className="block whitespace-pre text-zinc-100">
          <Highlighted text={displayed} keywords={keywords} />
          {/* Blinking caret while typing or erasing */}
          {!prefersReducedMotion && phase !== 'hold' && (
            <span
              className="ml-0.5 inline-block w-[2px] animate-pulse bg-violet-400 align-middle"
              style={{ height: '1.1em' }}
              aria-hidden
            />
          )}
        </code>
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lightweight regex highlighter                                       */
/* ------------------------------------------------------------------ */

/**
 * Highlight one CNL line at a time.
 *
 * The rules deliberately match the colors of the production Monaco theme
 * (W4): Module/Rule = violet, has/given/in = sky, numbers = emerald,
 * decide/allow/approve/release = amber, comments = muted italic.
 *
 * This is *not* a full parser — it's a 60-LOC tokenizer that produces
 * the same visual impression as the real editor. If the source contains
 * unknown vocabulary it falls through as plain `zinc-100` text, which
 * is fine for the marketing snippets.
 */
function Highlighted({ text, keywords }: { text: string; keywords: LocaleKeywords }) {
  // Tokenize per line so we can mix bold-keyword + neutral-text spans.
  // The display is whitespace-pre, so we emit '\n' as actual newlines.
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          <Tokens line={line} keywords={keywords} />
          {i < lines.length - 1 && '\n'}
        </span>
      ))}
    </>
  );
}

/** Token classes mirror the Monaco theme (W4). Hard-coded Tailwind
 *  utilities — the violet/sky/emerald/amber tokens are already defined
 *  by @theme in globals.css, but the *zinc shades* below come from
 *  Tailwind's built-in palette since this component is rendered on a
 *  dark surface and benefits from precise control. */
const STRUCTURAL = 'text-violet-300 font-semibold';
const RELATIONAL = 'text-sky-300';
const CONTROL    = 'text-amber-300 font-semibold';
const ACTION     = 'text-emerald-300 font-semibold';
const NUMBER     = 'text-emerald-300';
// 代码面板固定深色底（zinc-900）：注释用 zinc-400（6.9:1），zinc-500 只有 3.67:1（#774）
const COMMENT    = 'text-zinc-400 italic';

/**
 * Per-line tokenizer. The patterns are ordered: more-specific keywords
 * first, then numbers, then "the rest" as identifier text.
 */
function Tokens({ line, keywords }: { line: string; keywords: LocaleKeywords }) {
  // Comment line short-circuit
  const trimmed = line.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
    return <span className={COMMENT}>{line}</span>;
  }

  // Tokenize: split on word/number boundaries but keep separators in the
  // output so whitespace and punctuation render correctly.
  //
  // The unicode property escape `\p{L}` matches letters from any script
  // (拉丁、CJK、希腊...)，配合 `u` flag。这样 zh `模块 评估` / de `Regel`
  // 与 en `Module` 一视同仁。`\p{N}` 同理覆盖 ASCII + 全角数字。
  const parts = line.split(/([\p{L}_][\p{L}\p{N}_]*|\p{N}+(?:\.\p{N}+)?)/u);

  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        const cls = classify(part, keywords);
        if (cls) {
          return (
            <span key={i} className={cls}>
              {part}
            </span>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

/** Token classification. Returns null for "plain identifier / punctuation". */
function classify(token: string, keywords: LocaleKeywords): string | null {
  // Numbers — ASCII digits suffice for our snippet set.
  if (/^\d/.test(token)) return NUMBER;

  if (keywords.structural.has(token)) return STRUCTURAL;
  if (keywords.relational.has(token)) return RELATIONAL;
  if (keywords.control.has(token)) return CONTROL;
  if (keywords.action.has(token)) return ACTION;

  return null;
}
