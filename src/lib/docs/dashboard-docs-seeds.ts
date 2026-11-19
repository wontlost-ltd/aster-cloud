/**
 * Server-side helper that produces a small set of docs commands the
 * dashboard's Cmd+K palette seeds into its catalog. The dashboard
 * palette can't lazy-import a JSON chunk on open (it builds its
 * command list synchronously inside the layout's RSC), so we walk
 * the canonical sidebar order, look each slug up in the active
 * locale's search index for the localized title, and pipe up to
 * MAX_SEEDS entries through as `DocsCommandSeed[]`, followed by the
 * PINNED_SEED_SLUGS guides that sit too far down the sidebar.
 *
 * Order: the canonical `docsSidebar` order — getting-started first,
 * then the API namespaces in declared order. The search index is
 * sorted alphabetically by slug, so reading it directly would lead
 * with `api/...` and bury onboarding pages; enumerating
 * `docsSidebar` instead preserves the IA's "what should I see
 * first" intent.
 *
 * The three locale indexes are small (≤2KB gzipped each), so static
 * import is cheap and keeps the helper synchronous.
 */

import type { DocsCommandSeed } from '@/components/dashboard/command-palette-commands';
import type { SearchIndex } from '@/lib/docs/search-runtime';
import { docsSidebar } from '@/lib/docs/sidebar';
import type { RouteSlug } from '@/lib/docs/task-views';
import enIndex from '@/lib/docs/search-index.en.json';
import extEn from '@/lib/docs/external-index.en.json';
import extZh from '@/lib/docs/external-index.zh.json';
import extDe from '@/lib/docs/external-index.de.json';
import extHi from '@/lib/docs/external-index.hi.json';
import zhIndex from '@/lib/docs/search-index.zh.json';
import deIndex from '@/lib/docs/search-index.de.json';

const INDEXES: Record<string, SearchIndex> = {
  en: enIndex as SearchIndex,
  zh: zhIndex as SearchIndex,
  de: deIndex as SearchIndex,
};

/**
 * aster-lang.dev 的文档索引（构建期抓取，见
 * scripts/docs-migration/fetch-external-docs-index.mjs）。
 *
 * <p>四语齐全（de/hi 在上游按 en 回退，但保留各自 locale 字段用于拼 URL 前缀），
 * 故这里不需要再做一次回退。
 */
const EXTERNAL_INDEXES: Record<string, SearchIndex> = {
  en: extEn as SearchIndex,
  zh: extZh as SearchIndex,
  de: extDe as SearchIndex,
  hi: extHi as SearchIndex,
};

/** aster-lang.dev 站点根地址（UI 与 href 共用）。 */
export const ASTER_DEV_BASE_URL = 'https://www.aster-lang.dev';
/** UI 上展示的站外来源名。 */
export const ASTER_DEV_LABEL = 'aster-lang.dev';

/**
 * 取 aster-lang.dev 索引与该 locale 的绝对 URL 前缀。
 *
 * <p>该站 en 无前缀、其余带 /<locale>（与本站同惯例，已逐个实测确认）。
 */
export function getExternalDocs(locale: string): { index: SearchIndex; baseUrl: string; label: string } {
  const resolved = EXTERNAL_INDEXES[locale] ? locale : 'en';
  return {
    index: EXTERNAL_INDEXES[resolved],
    baseUrl: resolved === 'en' ? ASTER_DEV_BASE_URL : `${ASTER_DEV_BASE_URL}/${resolved}`,
    label: ASTER_DEV_LABEL,
  };
}

/**
 * 取某 locale 的文档搜索索引（未知 locale 回退 en，与 buildDocsSeeds 同口径）。
 *
 * <p>站内助手复用同一份索引做检索——不另建索引，避免两处内容漂移。
 * hi 暂无独立文档索引，回退 en（文档站尚未出 hi 版）。
 */
export function getDocsSearchIndex(locale: string): SearchIndex {
  return INDEXES[locale] ?? INDEXES.en;
}

/**
 * 文档路由前缀（`''` 表示 en 无前缀）。
 *
 * <p>★必须与 {@link getDocsSearchIndex} 的回退**同步**：hi 没有文档索引，
 * 内容回退到 en，路由也只有 `/docs/...` 而没有 `/hi/docs/...`。
 * 若前缀仍按原 locale 拼，hi 用户点开每条文档结果都是 404。
 */
export function getDocsRoutePrefix(locale: string): string {
  const resolved = INDEXES[locale] ? locale : 'en';
  return resolved === 'en' ? '' : `/${resolved}`;
}

/** Max number of sidebar-order docs commands surfaced in the dashboard palette. */
const MAX_SEEDS = 12;

/**
 * 侧栏前 MAX_SEEDS 条之外固定加入的文档（#795）：结构化编写的四篇指南。
 * 它们在侧栏「指南」分区里排得靠后，按侧栏顺序取前 12 条时进不了 Cmd+K；
 * 编辑器的模型 / 词汇 / 排版标签页也链接到它们。
 */
export const PINNED_SEED_SLUGS = [
  'guides/domain-modelling',
  'guides/domain-vocabulary',
  'guides/display-layouts',
  'guides/structured-authoring-admin',
] as const satisfies readonly RouteSlug[];

/**
 * Build the docs seed list for a given locale. Returns hrefs that
 * already carry the locale prefix where the docs route expects one
 * (zh/de keep their prefix; en is bare), matching
 * `localePrefix: 'as-needed'`.
 */
export function buildDocsSeeds(locale: string): DocsCommandSeed[] {
  // Resolve to a shipped locale so an unknown value falls back to en
  // for BOTH the title lookup AND the href prefix — otherwise the
  // generated hrefs would carry a /<unknown>/docs/... prefix that
  // returns 404.
  const resolvedLocale = INDEXES[locale] ? locale : 'en';
  const index = INDEXES[resolvedLocale];
  const titleBySlug = new Map<string, string>();
  for (const entry of index.entries) {
    titleBySlug.set(entry.slug, entry.title || entry.slug);
  }
  const prefix = resolvedLocale === 'en' ? '' : `/${resolvedLocale}`;
  const seedFor = (slug: string): DocsCommandSeed => ({
    id: `docs-${slug.replace(/\//g, '-')}`,
    label: titleBySlug.get(slug) ?? slug,
    href: `${prefix}/docs/${slug}`,
  });
  const seeds: DocsCommandSeed[] = [];
  outer: for (const section of docsSidebar) {
    for (const item of section.items) {
      seeds.push(seedFor(item.href));
      if (seeds.length >= MAX_SEEDS) break outer;
    }
  }
  const taken = new Set(seeds.map((seed) => seed.id));
  for (const slug of PINNED_SEED_SLUGS) {
    const seed = seedFor(slug);
    if (!taken.has(seed.id)) seeds.push(seed);
  }
  return seeds;
}
