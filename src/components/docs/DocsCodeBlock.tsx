'use client';

/**
 * `<DocsCodeBlock>` — replacement for MDX's default `<pre>` element.
 *
 * Wraps every code fence in the docs surface with a small toolbar:
 *   - Copy button (always rendered for fences whose text we can
 *     extract).
 *   - "Open in Playground" link (only when the fence carries
 *     `data-snippet-playground="true"` and a `data-snippet-id`).
 *
 * Why override `<pre>` rather than introduce a new MDX component:
 *   - Zero authoring cost. Authors keep writing standard fences;
 *     the toolbar appears automatically after the rehype plugin
 *     decorates the element.
 *   - Touches no existing MDX content. Pre-Phase-3 fences continue
 *     to render with just the Copy button (auto-enabled), no
 *     migration required for that affordance.
 *
 * a11y:
 *   - Toolbar is a `<div role="toolbar">` with an aria-label so AT
 *     can announce the snippet's purpose.
 *   - Copy success / failure is announced via a dedicated
 *     `role="status" aria-live="polite"` live region so SR users
 *     hear the transition without focus moving. The button's
 *     accessible name also updates to mirror the state.
 *   - Buttons inherit standard focus rings.
 *
 * Telemetry: docs_snippet_copied and docs_snippet_opened events
 * carry `{ slug, snippet_id, language }`. Slug is read from the
 * pathname (no PII); snippet_id is the author-supplied identifier
 * (also non-PII).
 */

import {
  useEffect,
  useRef,
  useState,
  type DetailedHTMLProps,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@aster-cloud/ui';
import { Link } from '@/i18n/navigation';
import { track, Events } from '@/lib/mixpanel';

type PreProps = DetailedHTMLProps<HTMLAttributes<HTMLPreElement>, HTMLPreElement> & {
  /** rehype-snippet-meta output — Playground deeplink trigger. */
  'data-snippet-playground'?: string;
  /** Author-supplied stable id, matched against the template registry. */
  'data-snippet-id'?: string;
  /** Fence language, mirrored from rehype-pretty-code. */
  'data-snippet-lang'?: string;
};

/**
 * Strip the locale + /docs/ prefix from a path so we can attribute
 * telemetry events to a stable slug. Mirrors `DocsPageActions`'s
 * `resolveSlug` logic but inlined here to avoid a cross-component
 * dependency for a one-line helper.
 */
function readSlug(pathname: string): string {
  const stripped = pathname.replace(/^\/[a-z]{2}(?=\/)/, '');
  const m = stripped.match(/^\/docs\/(.+?)\/?$/);
  return m ? m[1] : 'unknown';
}

/**
 * Extract the visible text of a code block from a React subtree so
 * Copy can write it to the clipboard. We descend into known content
 * nodes (string, array, fragment, `<code>`, `<span>`, etc.). For
 * shiki-tokenized output, every glyph lives inside nested spans —
 * the recursion handles that.
 */
function extractText(node: ReactNode): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) {
    const children = (node as { props?: { children?: ReactNode } }).props?.children;
    return extractText(children);
  }
  return '';
}

type CopyStatus = 'idle' | 'copied' | 'error';

export function DocsCodeBlock(props: PreProps) {
  const t = useTranslations();
  const pathname = usePathname() ?? '/';
  const slug = readSlug(pathname);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  // Ref-managed reset timer so back-to-back clicks don't leave
  // stale timeouts that race each other (an earlier 2s timer could
  // otherwise clear the `copied` state from a later click).
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  function scheduleReset(ms: number): void {
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setCopyStatus('idle');
      resetTimerRef.current = null;
    }, ms);
  }

  const snippetId = props['data-snippet-id'] ?? null;
  const snippetLang = props['data-snippet-lang'] ?? null;
  const playgroundEligible = props['data-snippet-playground'] === 'true' && !!snippetId;

  const text = extractText(props.children);

  const onCopy = async () => {
    if (!text) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setCopyStatus('error');
      scheduleReset(3_000);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('copied');
      track(Events.DOCS_SNIPPET_COPIED, {
        route_slug: slug,
        snippet_id: snippetId,
        language: snippetLang,
      });
      scheduleReset(2_000);
    } catch {
      setCopyStatus('error');
      scheduleReset(3_000);
    }
  };

  // Playground deeplink — locale-aware. `next-intl`'s `<Link>`
  // automatically prepends `/zh` or `/de` so the destination renders
  // inside the right locale subtree (the page lives under `[locale]`).
  const playgroundHref = playgroundEligible
    ? `/policies/new?from=docs&template=${encodeURIComponent(snippetId as string)}`
    : null;

  const onOpen = () => {
    if (!playgroundHref) return;
    track(Events.DOCS_SNIPPET_OPENED, {
      route_slug: slug,
      snippet_id: snippetId,
      language: snippetLang,
      target: '/policies/new',
    });
  };

  // Accessible name of the copy button changes with status so screen
  // readers actually announce the state change. A dedicated visually-
  // hidden live region tells SR users "Copied" / "Copy failed" the
  // moment status flips, even if focus is still on the button.
  const copyA11yName =
    copyStatus === 'copied'
      ? t('docs.codeBlock.copied')
      : copyStatus === 'error'
        ? t('docs.codeBlock.copyFailed')
        : t('docs.codeBlock.copyAriaLabel');

  const copyVisibleLabel =
    copyStatus === 'copied'
      ? t('docs.codeBlock.copied')
      : copyStatus === 'error'
        ? t('docs.codeBlock.copyFailed')
        : t('docs.codeBlock.copy');

  return (
    <div className="docs-code-wrap not-prose relative my-6 rounded-md border border-border bg-bg-soft overflow-hidden">
      <div
        role="toolbar"
        aria-label={t('docs.codeBlock.toolbarLabel')}
        className="flex flex-wrap items-center justify-end gap-2 px-2 py-1 border-b border-border bg-bg/50"
      >
        {playgroundHref && (
          <Link
            href={playgroundHref}
            onClick={onOpen}
            className={cn(
              'inline-flex items-center whitespace-nowrap rounded px-3 py-2 min-h-[36px] text-xs font-medium text-fg-muted',
              'hover:text-fg hover:bg-bg-subtle transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-bg',
            )}
          >
            {t('docs.codeBlock.openInPlayground')}
          </Link>
        )}
        <button
          type="button"
          onClick={onCopy}
          disabled={!text}
          aria-label={copyA11yName}
          className={cn(
            'inline-flex items-center whitespace-nowrap rounded px-3 py-2 min-h-[36px] text-xs font-medium text-fg-muted',
            'hover:text-fg hover:bg-bg-subtle transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-bg',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        >
          {copyVisibleLabel}
        </button>
      </div>
      {/* Live region — announces copy status changes without moving
          focus. `aria-live="polite"` defers the announcement; `role="status"`
          keeps it from interrupting other speech. */}
      <span role="status" aria-live="polite" className="sr-only">
        {copyStatus === 'copied'
          ? t('docs.codeBlock.copied')
          : copyStatus === 'error'
            ? t('docs.codeBlock.copyFailed')
            : ''}
      </span>
      {/* Forward the original <pre>. The wrapper sets border + bg +
          radius so globals.css's pre styling doesn't double-frame. */}
      {/* 长代码行会横向滚动：tabIndex=0 让键盘用户能聚焦后用方向键滚动（WCAG 2.1.1，axe scrollable-region-focusable） */}
      <pre
        {...props}
        tabIndex={0}
        className={cn(
          'docs-code !border-0 !bg-transparent !rounded-none !my-0 overflow-x-auto px-4 py-3 text-sm leading-relaxed',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary',
          props.className,
        )}
      />
    </div>
  );
}
