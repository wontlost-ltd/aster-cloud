'use client';

/**
 * Trust-establishing footer at the bottom of every docs page.
 *
 * Public row (always visible): last updated date · API version ·
 * link to changelog · "Suggest edit" link to a GitHub issue
 * template pre-filled with the route + locale.
 *
 * Authenticated row (rendered only when the docs session reports
 * `hasActiveTeam`): a page-scoped reminder
 * ("This page documents API version: <v>") sourced from the MDX
 * frontmatter — never from tenant data. We never display the
 * tenant name, email, plan name, or any other PII; the row's
 * purpose is to keep the documented version conspicuous for
 * team-affiliated readers who are most likely to be implementing
 * against it, not to claim personalization.
 *
 * Data source: the per-route page.tsx wrapper exports `frontmatter`
 * pulled from the active locale's MDX module (en/zh/de.mdx). This
 * footer receives that object as a prop, so:
 *   - When the MDX has `updated:` / `apiVersion:` / `changelog:`,
 *     the matching fields render.
 *   - When they're absent, the corresponding slots render nothing
 *     rather than crash — frontmatter migration is a follow-up
 *     concern, the footer is forward-compatible.
 *
 * a11y: rendered as a `<footer>` landmark with a localized
 * `aria-label`. Links inherit standard focus rings.
 */

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { cn } from '@aster-cloud/ui';
import { useDocsSession } from '@/lib/docs/use-docs-session';
import {
  buildSuggestEditUrl,
  formatDate,
} from '@/lib/docs/trust-footer-helpers';

// Re-export so the tests in src/__tests__/lib/docs-trust-footer-url.test.ts
// can import the pure helpers without the test bundle pulling in
// next-intl + next/navigation (which can't resolve in the vitest
// environment). Same pattern as Phase 3 build-callback.ts.
export { buildSuggestEditUrl, formatDate } from '@/lib/docs/trust-footer-helpers';

export type DocsFrontmatter = {
  title?: string;
  description?: string;
  /** ISO 8601 date, e.g. "2026-06-03". */
  updated?: string;
  /** Semantic version or simple label (e.g. "v1"). */
  apiVersion?: string;
  /** Either an absolute URL or a path under the site (e.g. /changelog/v1). */
  changelog?: string;
  /** Marker — locale fallback flag, see TranslationFallbackBanner. */
  fallback?: boolean;
};

type Props = {
  /** Frontmatter object from the rendered MDX module. */
  frontmatter: DocsFrontmatter | null | undefined;
  /** Canonical route slug (e.g. "/docs/api/policies/evaluate"). */
  routeSlug: string;
  /** Active locale, used to localize the suggest-edit GitHub link. */
  locale: string;
};

// `buildSuggestEditUrl` and `formatDate` live in
// `@/lib/docs/trust-footer-helpers` so they can be unit-tested
// without pulling next-intl into the vitest env. They're re-exported
// from this module above for backward compatibility.

export function DocsTrustFooter({ frontmatter, routeSlug, locale }: Props) {
  const t = useTranslations();
  const session = useDocsSession();

  const updated = formatDate(frontmatter?.updated, locale);
  const apiVersion = frontmatter?.apiVersion ?? null;
  const changelogHref = frontmatter?.changelog ?? null;
  const suggestEditUrl = buildSuggestEditUrl(routeSlug, locale);

  // Hide the public row entirely if no useful field is set yet (avoid
  // rendering a sparse single-link footer that reads more like a
  // half-built UI than a deliberate trust signal).
  const hasPublicContent = !!(updated || apiVersion || changelogHref);

  return (
    <footer
      aria-label={t('docs.trustFooter.ariaLabel')}
      className="docs-trust-footer not-prose mt-12 border-t border-border pt-6"
    >
      {hasPublicContent && (
        <ul
          className={cn(
            'flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-muted',
          )}
          role="list"
        >
          {updated && (
            <li>
              <span className="font-medium">{t('docs.trustFooter.lastUpdated')}:</span>{' '}
              <time dateTime={frontmatter?.updated}>{updated}</time>
            </li>
          )}
          {apiVersion && (
            <li>
              <span className="font-medium">{t('docs.trustFooter.apiVersion')}:</span>{' '}
              {apiVersion}
            </li>
          )}
          {changelogHref && (
            <li>
              <Link
                href={changelogHref}
                className="tap-target underline hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-bg rounded-sm"
              >
                {t('docs.trustFooter.changelog')}
              </Link>
            </li>
          )}
          <li>
            <a
              href={suggestEditUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-bg rounded-sm"
            >
              {t('docs.trustFooter.suggestEdit')}
            </a>
          </li>
        </ul>
      )}
      {!hasPublicContent && (
        <p className="text-xs text-fg-muted">
          <a
            href={suggestEditUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-bg rounded-sm"
          >
            {t('docs.trustFooter.suggestEdit')}
          </a>
        </p>
      )}
      {/* Authenticated extension row — only renders when the probe
          reports `hasActiveTeam=true`. apiVersion comes from MDX
          frontmatter (PUBLIC static data, not the user's tenant),
          but team-affiliated readers are the audience most likely
          to be implementing against this version, so we keep the
          extra reminder visible to them only. Solo users still see
          the same value in the public row above. The label is
          deliberately scoped to "this page" so we don't overstate
          personalization that the probe doesn't carry. */}
      {session.status === 'authenticated' &&
        session.capabilities.hasActiveTeam &&
        apiVersion && (
          <p className="mt-3 text-xs text-fg-muted">
            <span className="font-medium">
              {t('docs.trustFooter.yourTenantVersion')}:
            </span>{' '}
            {apiVersion}
          </p>
        )}
    </footer>
  );
}
