'use client';

/**
 * `<ActionableStep>` — numbered step card with an optional in-product CTA.
 *
 * Used in MDX quickstart pages to turn pure-prose instructions into a
 * one-click path into the relevant app surface. Example:
 *
 *   <ActionableStep
 *     step={1}
 *     titleKey="docs.quickstart.steps.tenantId.title"
 *     descriptionKey="docs.quickstart.steps.tenantId.description"
 *     href="/settings/api-keys"
 *   />
 *
 * The component reads the live docs session via `useDocsSession()`:
 *   - Authenticated → the primary action is a locale-aware next-intl
 *     <Link> straight to the configured `href`.
 *   - Anonymous → the same CTA is wrapped in a sign-in bounce that
 *     preserves the destination via `?callbackUrl=<encoded href>` so
 *     the deeplink survives the auth flow.
 *
 * a11y: rendered as an `<ol>` step inside MDX. Each card is its own
 * `<li>` with the numeric badge in an `aria-hidden` decoration; the
 * step heading carries the visible number for SR users so the
 * meaning isn't lost.
 *
 * Telemetry: emits `docs_cta_clicked` so quickstart conversion shows
 * up in the same funnel as the page action bar.
 */

import { useTranslations, useLocale } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { cn } from '@aster-cloud/ui';
import { useDocsSession } from '@/lib/docs/use-docs-session';
import { track, Events } from '@/lib/mixpanel';

type Props = {
  /** 1-based step number. Drives the visible badge + heading prefix. */
  step: number;
  /** i18n key for the step title. */
  titleKey: string;
  /** i18n key for the step description (multi-sentence allowed). */
  descriptionKey: string;
  /** Optional CTA — when omitted the card renders without a button. */
  href?: string;
  /** i18n key for the CTA label. Required when `href` is provided. */
  ctaKey?: string;
  /**
   * Stable id for telemetry — defaults to `quickstart_step_<n>`.
   * Override when a single page hosts multiple ActionableStep groups.
   */
  ctaId?: string;
};

export function ActionableStep({
  step,
  titleKey,
  descriptionKey,
  href,
  ctaKey,
  ctaId,
}: Props) {
  const t = useTranslations();
  const locale = useLocale();
  const session = useDocsSession();

  const onClick = () => {
    if (!href) return;
    track(Events.DOCS_CTA_CLICKED, {
      route_slug: `quickstart_step_${step}`,
      cta_id: ctaId ?? `quickstart_step_${step}`,
      target: href.split('?')[0],
      auth_state:
        session.status === 'authenticated'
          ? 'authenticated'
          : session.status === 'anonymous'
            ? 'anonymous'
            : 'probing',
      locale,
    });
  };

  // For anonymous users, build a callbackUrl-preserving login link so
  // the click still lands the user at `href` after sign-in. The login
  // page consumes `?callbackUrl=` already (see login-content.tsx).
  const ctaHref =
    !href
      ? null
      : session.status === 'authenticated'
        ? href
        : `/login?callbackUrl=${encodeURIComponent(`/${locale}${href}`)}`;

  return (
    <li className="docs-step not-prose my-6 grid grid-cols-[2.5rem_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-bg-soft p-4">
      <div
        aria-hidden="true"
        className={cn(
          'h-10 w-10 rounded-full bg-primary text-primary-fg',
          'flex items-center justify-center text-base font-semibold',
        )}
      >
        {step}
      </div>
      <div>
        <h3 className="m-0 text-lg font-semibold text-fg">
          <span className="sr-only">{t('docs.quickstart.stepPrefix', { step })}</span>
          {t(titleKey)}
        </h3>
        <p className="mt-1 mb-0 text-sm leading-relaxed text-fg-muted">
          {t(descriptionKey)}
        </p>
      </div>
      {ctaHref && ctaKey && (
        <div className="col-start-2 mt-3">
          <Link
            href={ctaHref}
            onClick={onClick}
            className={cn(
              // 正文列表里独立成块的操作按钮：移动端显式启用 44px 点击区（globals.css .tap-target）
              'tap-target',
              // `max-w-full` + `whitespace-normal` + `text-left` so the
              // CTA wraps gracefully when future translations expand
              // (German labels can run ~35% longer than English).
              'inline-flex max-w-full items-center whitespace-normal text-left rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-fg',
              'hover:bg-primary-hover transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
            )}
          >
            {t(ctaKey)}
          </Link>
        </div>
      )}
    </li>
  );
}
