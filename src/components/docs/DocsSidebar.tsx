'use client';

import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { Link } from '@/i18n/navigation';
import { docsSidebar } from '@/lib/docs/sidebar';
import {
  DocsSidebarModeToggle,
  useSidebarMode,
} from '@/components/docs/DocsSidebarModeToggle';
import { DocsSidebarTasks } from '@/components/docs/DocsSidebarTasks';

/**
 * Left rail navigation for /docs/*.
 *
 * Server component would also work, but the active-link detection needs
 * the current pathname — and reading it server-side via headers() means
 * the entire sidebar rerenders on every navigation. Marking client-side
 * lets next-intl's <Link> swap the active state without a full server
 * round-trip on every page change.
 */
export function DocsSidebar() {
  const t = useTranslations();
  const locale = useLocale();
  const pathname = usePathname();
  const [mode, setMode] = useSidebarMode();

  // pathname from next-intl/navigation is locale-stripped
  // (e.g. /docs/getting-started/overview).
  // Strip /docs/ prefix to compare with sidebar item hrefs.
  const currentSlug = pathname.replace(/^\/docs\/?/, '');

  const referenceTree = (
    <>
      {docsSidebar.map((section) => (
        <div key={section.titleKey} className="mb-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-muted">
            {t(section.titleKey)}
          </h2>
          <ul className="space-y-1">
            {section.items.map((item) => {
              const isActive = currentSlug === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={`/docs/${item.href}`}
                    locale={locale}
                    className={
                      (isActive
                        ? 'block rounded-md bg-bg-soft px-3 py-1.5 text-sm font-medium text-fg max-sm:py-3'
                        : 'block rounded-md px-3 py-1.5 text-sm text-fg-muted transition-colors hover:bg-bg-soft hover:text-fg max-sm:py-3') +
                      ' focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                    }
                    aria-current={isActive ? 'page' : undefined}
                  >
                    {t(item.labelKey)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );

  const sections = (
    <>
      <DocsSidebarModeToggle mode={mode} onChange={setMode} />
      {mode === 'reference' ? referenceTree : <DocsSidebarTasks />}
    </>
  );

  return (
    <>
      {/* Mobile: collapsible <details> below top nav. Hidden on lg+
          where the sticky sidebar takes over. */}
      <details className="lg:hidden border-b border-border bg-bg">
        <summary
          className={
            'flex cursor-pointer items-center justify-between px-4 py-3 text-sm font-medium text-fg ' +
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
          }
        >
          <span>{t('docs.sidebar.ariaLabel')}</span>
          <span aria-hidden className="text-fg-muted">▾</span>
        </summary>
        <nav
          className="border-t border-border px-4 py-4"
          aria-label={t('docs.sidebar.ariaLabel')}
        >
          {sections}
        </nav>
      </details>

      {/* Desktop: persistent left rail. */}
      <nav
        className="hidden lg:block w-64 shrink-0 border-r border-border bg-bg"
        aria-label={t('docs.sidebar.ariaLabel')}
      >
        <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto px-6 py-8">
          {sections}
        </div>
      </nav>
    </>
  );
}
