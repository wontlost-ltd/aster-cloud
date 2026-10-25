'use client';

/**
 * Sticky action bar at the top of every docs page.
 *
 * Reads the current pathname, looks up the page's `PageActionSet`,
 * filters the actions by the live `useDocsSession()` capabilities,
 * and renders one primary + zero-or-more secondary CTAs.
 *
 * Hidden when:
 *   - the route has no registered actions (returns null silently),
 *   - 探针返回的 capabilities 既不允许主动作、也不允许任何次要动作。
 *
 * Capability filtering:
 *   - `public` actions always render.
 *   - All other actions only render when the matching capability
 *     bool is true —— 匿名与已登录都以探针 capabilities 为准
 *     （见 page-actions.ts 的 pickAvailableActions）。
 *   - During `probing` the bar renders a height-reserved skeleton
 *     pill so the H1 doesn't shift down when the probe resolves and
 *     actions materialize.
 *
 * Audit jump:
 *   - Actions with `audit: true` fire a fire-and-forget POST to
 *     `/api/docs/jump` with `slug + cta_id + target + locale`. We
 *     use `navigator.sendBeacon` so the dispatch survives the
 *     navigation that the click triggers. If sendBeacon is missing,
 *     we fall back to `fetch(..., { keepalive: true })`.
 *
 * Mobile collapse:
 *   - Below `sm`, the secondary actions tuck into an overflow menu
 *     so the action bar doesn't steal the entire first fold of the
 *     article on a phone.
 *
 * a11y:
 *   - The bar is a `<nav>` landmark with a localized `aria-label`
 *     drawn from `docs.actions.ariaLabel`.
 *   - Buttons / links inherit standard focus rings.
 *   - The overflow menu uses plain disclosure semantics (matches
 *     `DocsTopNav` rationale: 3 items is too few to justify the ARIA
 *     menu pattern's roving focus contract).
 */

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { cn } from '@aster-cloud/ui';
import { useDocsSession } from '@/lib/docs/use-docs-session';
import {
  getPageActions,
  pickAvailableActions,
  type PageAction,
} from '@/lib/docs/page-actions';
import { track, Events } from '@/lib/mixpanel';

/**
 * Strip a leading `/<locale>/` prefix and the `/docs/` segment so we
 * can match against the bare slugs in the action registry. Mirrors the
 * `DocsBreadcrumb` slug-resolution logic (the registry uses the same
 * slug shape as `docsSidebar`).
 */
function resolveSlug(pathname: string): string | null {
  const stripped = pathname.replace(/^\/[a-z]{2}(?=\/)/, '');
  const m = stripped.match(/^\/docs\/(.+?)\/?$/);
  return m ? m[1] : null;
}

/**
 * Fire-and-forget audit jump. Uses `sendBeacon` so the request
 * survives the click-driven navigation; `keepalive: true` is the
 * fallback for environments without beacon support (e.g. some
 * Firefox configs).
 *
 * The body is JSON, but the Blob `Content-Type` is `text/plain` —
 * `application/json` is not a CORS-safelisted request header for
 * beacon dispatch and several browsers reject the call when it's
 * set. The route handler parses `request.json()` regardless of
 * declared MIME type, so this is purely a transport-layer concern.
 */
function fireAuditJump(payload: {
  slug: string;
  cta_id: string;
  target: string;
  locale: string;
}): void {
  const body = JSON.stringify(payload);
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const ok = navigator.sendBeacon(
        '/api/docs/jump',
        new Blob([body], { type: 'text/plain' }),
      );
      if (ok) return;
    }
  } catch {
    // fall through to fetch.
  }
  try {
    // application/json is NOT a CORS-safelisted Content-Type, but
    // this fetch is same-origin (the endpoint lives on the same
    // host as the docs page) so the safelisting restriction
    // doesn't apply. The route handler parses request.json()
    // regardless of declared MIME type.
    void fetch('/api/docs/jump', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Best-effort; the jump itself proceeds either way.
  }
}

type AuthState = 'authenticated' | 'anonymous' | 'probing';

function ActionLink({
  action,
  slug,
  locale,
  authState,
  presentation,
  onTrigger,
}: {
  action: PageAction;
  slug: string;
  locale: string;
  authState: AuthState;
  /** `button` = pill-shaped CTA. `menuItem` = full-row inside dropdown. */
  presentation: 'button' | 'menuItem';
  onTrigger: () => void;
}) {
  const t = useTranslations();
  const buttonBase =
    'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ' +
    'focus-visible:ring-offset-2 focus-visible:ring-offset-bg transition-colors';
  const buttonVariant =
    action.variant === 'primary'
      ? 'bg-primary text-primary-fg hover:bg-primary-hover'
      : 'border border-border bg-bg text-fg hover:bg-bg-subtle';
  const menuItemClass =
    'block w-full text-left px-4 py-2 text-sm text-fg hover:bg-bg-subtle ' +
    'focus-visible:outline-none focus-visible:bg-bg-subtle';

  const className =
    presentation === 'menuItem' ? menuItemClass : cn(buttonBase, buttonVariant);

  const onClick = () => {
    track(Events.DOCS_CTA_CLICKED, {
      route_slug: slug,
      cta_id: action.id,
      target: action.href.split('?')[0],
      // Coarse auth state — no PII. Lets the funnel split conversion
      // by whether the reader was already signed in when they clicked.
      auth_state: authState,
      locale,
    });
    if (action.audit) {
      fireAuditJump({
        slug,
        cta_id: action.id,
        target: action.href.split('?')[0],
        locale,
      });
    }
    onTrigger();
  };

  return (
    <Link href={action.href} onClick={onClick} className={className}>
      {t(action.labelKey)}
    </Link>
  );
}

function OverflowMenu({
  actions,
  slug,
  locale,
  authState,
}: {
  actions: PageAction[];
  slug: string;
  locale: string;
  authState: AuthState;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const closeAndReturnFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    function onPointer(ev: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(ev.target as Node)) {
        closeAndReturnFocus();
      }
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') closeAndReturnFocus();
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        ref={buttonRef}
        aria-label={t('docs.actions.moreLabel')}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center rounded-md border border-border bg-bg px-3 py-1.5 text-sm font-medium text-fg hover:bg-bg-subtle',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          'focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
        )}
      >
        {t('docs.actions.more')}
      </button>
      {open && (
        <div
          className={cn(
            'absolute right-0 mt-2 w-56 rounded-md border border-border bg-bg shadow-lg py-1 z-30',
            'ring-1 ring-black/5 dark:ring-white/10',
          )}
        >
          {actions.map((a) => (
            <ActionLink
              key={a.id}
              action={a}
              slug={slug}
              locale={locale}
              authState={authState}
              presentation="menuItem"
              onTrigger={closeAndReturnFocus}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function DocsPageActions() {
  const t = useTranslations();
  const pathname = usePathname() ?? '/';
  const locale = useLocale();
  const session = useDocsSession();
  const slug = resolveSlug(pathname);
  if (!slug) return null;
  const set = getPageActions(slug);
  if (!set) return null;

  const authState: AuthState =
    session.status === 'authenticated'
      ? 'authenticated'
      : session.status === 'anonymous'
        ? 'anonymous'
        : 'probing';

  const { primary, secondary } = pickAvailableActions(set, session);

  // Reserve action-bar height during `probing` to avoid CLS when the
  // probe resolves and the bar materializes. A small skeleton pill
  // matches the height of the resolved primary CTA.
  const sharedNavClass = cn(
    'docs-page-actions mb-6 flex flex-wrap items-center gap-2 sm:gap-3',
    'sticky top-16 z-20 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 py-2',
    'border-b border-border bg-bg/90 backdrop-blur',
  );
  const ariaLabel = t('docs.actions.ariaLabel');

  if (session.status === 'probing') {
    return (
      <nav aria-label={ariaLabel} aria-busy="true" className={sharedNavClass}>
        <div
          className="h-8 w-40 rounded-md bg-bg-subtle animate-pulse motion-reduce:animate-none"
          aria-hidden="true"
        />
      </nav>
    );
  }

  if (!primary && secondary.length === 0) return null;

  return (
    <nav aria-label={ariaLabel} className={sharedNavClass}>
      {primary && (
        <ActionLink
          action={primary}
          slug={slug}
          locale={locale}
          authState={authState}
          presentation="button"
          onTrigger={() => undefined}
        />
      )}
      {/* Desktop: render all secondary inline. Mobile: tuck into a
          single overflow menu so the first fold isn't clobbered. */}
      <div className="hidden sm:flex items-center gap-2">
        {secondary.map((a) => (
          <ActionLink
            key={a.id}
            action={a}
            slug={slug}
            locale={locale}
            authState={authState}
            presentation="button"
            onTrigger={() => undefined}
          />
        ))}
      </div>
      {secondary.length > 0 && (
        <div className="sm:hidden">
          <OverflowMenu
            actions={secondary}
            slug={slug}
            locale={locale}
            authState={authState}
          />
        </div>
      )}
    </nav>
  );
}
