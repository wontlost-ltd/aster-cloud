'use client';

import { useTranslations } from 'next-intl';
import { usePathname } from '@/i18n/navigation';
import { Link } from '@/i18n/navigation';
import { docsSidebar } from '@/lib/docs/sidebar';

/**
 * Auto-derived breadcrumb for /docs/* pages.
 *
 * Label resolution priority (per segment):
 *   1. Exact match against docsSidebar item.href → use that item's labelKey
 *   2. Exact match against docsSidebar section heading slug → titleKey
 *      (e.g. "/docs/api/policies" matches the apiPolicies section)
 *   3. Fallback: title-cased slug
 *
 * Result: zh/de breadcrumbs render with localized section + leaf names
 * instead of slug-titlecased ASCII for non-leaf segments.
 */

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(' ');
}

/**
 * Build a slug → labelKey map from the sidebar config so each crumb
 * has a chance to resolve to a localized name. Section heading slug
 * is derived from the first item's href (the segment of the leaf
 * minus its tail), e.g. "api/policies/evaluate" → "api/policies".
 */
function buildLabelIndex(): Map<string, string> {
  const idx = new Map<string, string>();
  for (const section of docsSidebar) {
    if (section.items.length > 0) {
      const firstHref = section.items[0].href;
      const sectionPath = firstHref.split('/').slice(0, -1).join('/');
      if (sectionPath) idx.set(sectionPath, section.titleKey);
    }
    for (const item of section.items) {
      idx.set(item.href, item.labelKey);
    }
  }
  return idx;
}

const LABEL_INDEX = buildLabelIndex();

export function DocsBreadcrumb() {
  const t = useTranslations();
  const pathname = usePathname();
  const segs = pathname.replace(/^\/+|\/+$/g, '').split('/'); // ["docs","api","policies","evaluate"]
  if (segs.length <= 1) return null;

  const items = segs.map((seg, i) => {
    const href = '/' + segs.slice(0, i + 1).join('/');
    const isLast = i === segs.length - 1;

    let label: string;
    if (i === 0) {
      label = t('docs.breadcrumb.root');
    } else {
      // sidebar hrefs don't include the "docs/" prefix; strip it.
      const slug = segs.slice(1, i + 1).join('/');
      const key = LABEL_INDEX.get(slug);
      label = key ? t(key) : titleCase(seg);
    }
    return { label, href, isLast };
  });

  return (
    <nav aria-label={t('docs.breadcrumb.ariaLabel')} className="mb-6 text-sm text-fg-muted">
      {/* 移动端：链接上下内边距撑到 44px 高的点击区；折行时行高即 44px，上下两行的点击区不重叠（#774） */}
      <ol className="flex flex-wrap items-center gap-1.5 max-sm:gap-y-0">
        {items.map((it, i) => (
          <li key={it.href} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>/</span>}
            {it.isLast ? (
              <span aria-current="page" className="text-fg">
                {it.label}
              </span>
            ) : (
              <Link
                href={it.href}
                className={
                  'hover:text-fg transition-colors rounded-sm max-sm:inline-block max-sm:min-w-11 max-sm:py-3 max-sm:text-center ' +
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                }
              >
                {it.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
