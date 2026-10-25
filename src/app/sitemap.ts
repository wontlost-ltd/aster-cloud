import type { MetadataRoute } from 'next';
import { locales, defaultLocale } from '@/i18n/config';
import { selectDocsContentLocale } from '@/lib/docs/locale-content';
import docsIndexEn from '@/lib/docs/search-index.en.json';

/**
 * Site-wide sitemap generator.
 *
 * Includes:
 *   - All docs subsite routes × 3 locales with proper `alternates.languages`
 *     so search engines understand the cross-locale equivalence.
 *   - Public marketing pages (/, /pricing, /privacy, /terms, /equivalence)
 *     × 3 locales.
 *
 * Excludes:
 *   - Dashboard, auth, API routes (not public; require login).
 *
 * URL shape follows `localePrefix: 'as-needed'` (src/i18n/navigation.ts:8):
 *   default locale (en) → bare /path
 *   zh/de → /zh/path, /de/path
 *
 * 文档路由清单来自构建期生成的 `search-index.en.json`（build-docs-index.mjs 在
 * `next build` 之前遍历 en.mdx 写出），随打包内联进 bundle。不能在这里运行时
 * 遍历文件系统：生产跑在 Cloudflare Workers（OpenNext，incrementalCache=dummy），
 * sitemap 每次请求都会重新执行，而 Worker 里没有源码目录，fs 遍历只会静默得到
 * 空列表——这正是线上 sitemap 丢失全部文档 URL 的原因。
 *
 * 文档只对有真实内容的语种（en/zh/de）出 <loc> 与 hreflang：其余语种（如 hi）的
 * 文档页是英文底稿回退，页面本身 canonical→en 且 noindex，不应进入 sitemap，
 * 否则 sitemap 会列出 noindex URL、并与页面 <link rel="alternate"> 不一致。
 */

const SITE_URL = 'https://aster-lang.cloud';

function localizedUrl(slug: string, locale: string): string {
  const prefix = locale === defaultLocale ? '' : `/${locale}`;
  return `${SITE_URL}${prefix}${slug}`;
}

/** 文档有真实翻译内容的语种（与 docs 页面 generateMetadata 的 hreflang 集合一致）。 */
const DOCS_LOCALES: readonly string[] = locales.filter(
  (loc) => !selectDocsContentLocale(loc).isEnglishFallback,
);

function alternatesFor(
  slug: string,
  siteLocales: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const loc of siteLocales) {
    out[loc] = localizedUrl(slug, loc);
  }
  out['x-default'] = localizedUrl(slug, defaultLocale);
  return out;
}

/**
 * 所有文档叶子页的 slug（形如 `/docs/api/policies/evaluate`），按字典序排序。
 */
function enumerateDocsRoutes(): string[] {
  return docsIndexEn.entries.map((e) => `/docs/${e.slug}`).sort();
}

const PUBLIC_MARKETING_SLUGS = [
  '/',
  '/pricing',
  '/privacy',
  '/terms',
  '/equivalence',
  '/demos',
  '/demos/credit',
  '/demos/vocab',
  '/demos/kitten',
];

/**
 * Push one entry per (slug × locale). Each entry carries reciprocal
 * hreflang alternates so search engines can pick the right variant
 * regardless of which `<loc>` they crawl first.
 *
 * Note: one-entry-per-locale (instead of one default-locale entry with
 * alternates) is what Google's own multilingual sitemap guidance
 * recommends — it makes localized URLs first-class crawl candidates.
 */
function pushLocaleVariants(
  entries: MetadataRoute.Sitemap,
  slug: string,
  siteLocales: readonly string[],
  base: { lastModified: Date; changeFrequency: 'weekly' | 'monthly'; priority: number },
) {
  const alternates = { languages: alternatesFor(slug, siteLocales) };
  for (const loc of siteLocales) {
    entries.push({
      url: localizedUrl(slug, loc),
      ...base,
      alternates,
    });
  }
}

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const entries: MetadataRoute.Sitemap = [];

  for (const slug of PUBLIC_MARKETING_SLUGS) {
    pushLocaleVariants(entries, slug, locales, {
      lastModified: now,
      changeFrequency: 'weekly',
      priority: slug === '/' ? 1.0 : 0.7,
    });
  }

  for (const slug of enumerateDocsRoutes()) {
    pushLocaleVariants(entries, slug, DOCS_LOCALES, {
      lastModified: now,
      changeFrequency: 'monthly',
      priority: slug === '/docs' ? 0.9 : 0.6,
    });
  }

  return entries;
}
