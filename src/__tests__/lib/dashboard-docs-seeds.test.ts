/**
 * Invariants for the dashboard Cmd+K palette's docs seed list.
 *
 * The seeds are produced from the canonical `docsSidebar` order with
 * titles looked up in the active locale's search index. The runtime
 * must:
 *   - Cap the result at MAX_SEEDS (12) so the palette stays scannable.
 *   - Apply locale-aware hrefs ('' for `en`, `/zh` / `/de` otherwise).
 *   - Lead with the five getting-started pages (the IA's stated
 *     intent — preserved by walking `docsSidebar` in declared order
 *     rather than the search-index's alphabetical order).
 *   - Localize labels from the active index (so a zh dashboard user
 *     sees zh page titles even when scrolling docs entries inside
 *     the dashboard palette).
 *   - Fall back to the en index when the requested locale isn't
 *     part of the static import set.
 */

import { describe, it, expect } from 'vitest';
import { buildDocsSeeds } from '@/lib/docs/dashboard-docs-seeds';

const GETTING_STARTED_SLUGS = new Set<string>([
  'getting-started/overview',
  'getting-started/authentication',
  'getting-started/api-keys',
  'getting-started/quickstart',
  'getting-started/errors',
]);

describe('buildDocsSeeds', () => {
  it('returns at most 12 entries', () => {
    expect(buildDocsSeeds('en').length).toBeLessThanOrEqual(12);
  });

  it('leads with the five getting-started pages', () => {
    const seeds = buildDocsSeeds('en');
    const firstFourSlugs = seeds
      .slice(0, GETTING_STARTED_SLUGS.size)
      .map((s) => s.href.replace(/^\/docs\//, ''));
    for (const slug of firstFourSlugs) {
      expect(
        GETTING_STARTED_SLUGS.has(slug),
        `expected the first seeds to be onboarding pages, got: ${slug}`,
      ).toBe(true);
    }
  });

  it("uses bare /docs/<slug> hrefs for the default locale ('en')", () => {
    const seeds = buildDocsSeeds('en');
    for (const seed of seeds) {
      expect(seed.href.startsWith('/docs/'), seed.href).toBe(true);
    }
  });

  it("prefixes /zh and /de hrefs for non-default locales", () => {
    for (const seed of buildDocsSeeds('zh')) {
      expect(seed.href.startsWith('/zh/docs/'), seed.href).toBe(true);
    }
    for (const seed of buildDocsSeeds('de')) {
      expect(seed.href.startsWith('/de/docs/'), seed.href).toBe(true);
    }
  });

  it('falls back to the en index when the locale is unknown', () => {
    const seeds = buildDocsSeeds('fr-not-shipped');
    // No prefix when falling back to en.
    for (const seed of seeds) {
      expect(seed.href.startsWith('/docs/'), seed.href).toBe(true);
    }
    expect(seeds.length).toBeGreaterThan(0);
  });

  it('labels each seed with a non-empty string', () => {
    for (const seed of buildDocsSeeds('en')) {
      expect(seed.label.length).toBeGreaterThan(0);
    }
  });

  it('every seed id is `docs-<slug-with-dashes>`', () => {
    for (const seed of buildDocsSeeds('en')) {
      expect(seed.id.startsWith('docs-'), seed.id).toBe(true);
      // The id is the slug with `/` rewritten to `-`. Reversing the
      // rewrite recovers the slug. We can't verify it round-trips
      // perfectly because slugs may contain `-` natively, but we
      // can at least pin the prefix and structure.
      // `[a-z0-9-]+` 已覆盖含 `-` 的 slug；原 `(?:-[a-z0-9-]+)*` 与前段重叠 → 多项式回溯
      // （CodeQL js/redos）。等价简化为单量词，断言意图不变（前缀 docs- + 允许字符集）。
      expect(seed.id).toMatch(/^docs-[a-z0-9-]+$/);
    }
  });
});
