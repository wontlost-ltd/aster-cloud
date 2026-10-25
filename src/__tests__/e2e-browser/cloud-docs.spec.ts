import { test, expect } from '@playwright/test';

/**
 * Cloud docs E2E — critical paths on aster-lang.cloud/docs/*.
 *
 * Locales tested: en (bare), zh (/zh prefix), de (/de prefix), matching
 * the as-needed localePrefix in src/i18n/routing.ts.
 *
 * Each spec runs against the deployed site by default. Override via
 *   BASE_CLOUD=http://localhost:3000 pnpm test:e2e:browser
 * for pre-deploy validation.
 */

test.describe('Cloud docs - landing redirect', () => {
  test('/docs/ redirects EN to getting-started/overview (bare URL)', async ({ page }) => {
    const response = await page.goto('/docs/');
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/docs\/getting-started\/overview$/);
  });

  test('/zh/docs/ redirects to /zh/docs/getting-started/overview', async ({ page }) => {
    await page.goto('/zh/docs/');
    await expect(page).toHaveURL(/\/zh\/docs\/getting-started\/overview$/);
  });

  test('/de/docs/ redirects to /de/docs/getting-started/overview', async ({ page }) => {
    await page.goto('/de/docs/');
    await expect(page).toHaveURL(/\/de\/docs\/getting-started\/overview$/);
  });
});

test.describe('Cloud docs - section-parent redirects', () => {
  // Section-parent URLs exist as 308 redirects so breadcrumb hover
  // prefetches and bookmark/sitemap landings always resolve to a real
  // page. See src/lib/docs/section-redirect.ts. If a sidebar reorder
  // changes the first child of any section, these assertions will fail
  // — that's intentional, the redirect target must follow the sidebar.
  const SECTION_REDIRECTS: ReadonlyArray<{ from: string; toRe: RegExp }> = [
    { from: '/docs/getting-started',  toRe: /\/docs\/getting-started\/overview$/ },
    { from: '/docs/api',              toRe: /\/docs\/api\/policies\/evaluate$/ },
    { from: '/docs/api/policies',     toRe: /\/docs\/api\/policies\/evaluate$/ },
    { from: '/docs/api/workflows',    toRe: /\/docs\/api\/workflows\/events$/ },
    { from: '/docs/api/audit',        toRe: /\/docs\/api\/audit\/logs$/ },
    { from: '/docs/api/graphql',      toRe: /\/docs\/api\/graphql\/overview$/ },
    { from: '/docs/api/websocket',    toRe: /\/docs\/api\/websocket\/preview$/ },
  ];

  for (const { from, toRe } of SECTION_REDIRECTS) {
    test(`EN ${from} resolves (308 redirect to first child)`, async ({ page }) => {
      const response = await page.goto(from);
      expect(response?.status()).toBeLessThan(400);
      await expect(page).toHaveURL(toRe);
    });
  }

  // One ZH + one DE spot-check covers the locale-prefix branch in
  // redirectToFirstChild() without re-asserting the full matrix.
  test('ZH /zh/docs/api resolves to /zh/docs/api/policies/evaluate', async ({ page }) => {
    const response = await page.goto('/zh/docs/api');
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/zh\/docs\/api\/policies\/evaluate$/);
  });

  test('DE /de/docs/api/workflows resolves to /de/docs/api/workflows/events', async ({ page }) => {
    const response = await page.goto('/de/docs/api/workflows');
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/de\/docs\/api\/workflows\/events$/);
  });
});

test.describe('Cloud docs - sidebar navigation', () => {
  test('sidebar lists all 6 section groups on en getting-started', async ({ page }) => {
    await page.goto('/docs/getting-started/overview');
    // The sidebar is hidden < lg; ensure desktop viewport so it renders.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.reload();
    const sidebar = page.getByRole('navigation', { name: /Documentation sections/i });
    await expect(sidebar).toBeVisible();
    for (const heading of [
      'Getting Started',
      'Policy Evaluation',
      'Workflows',
      'Audit',
      'GraphQL',
      'WebSocket',
    ]) {
      await expect(sidebar.getByRole('heading', { name: heading })).toBeVisible();
    }
  });

  test('clicking a sidebar item navigates to that page', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/docs/getting-started/overview');
    await page.getByRole('navigation', { name: /Documentation sections/i })
      .getByRole('link', { name: 'Evaluate Policy' })
      .click();
    await expect(page).toHaveURL(/\/docs\/api\/policies\/evaluate$/);
  });

  test('zh sidebar renders Chinese labels', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/zh/docs/getting-started/overview');
    const sidebar = page.getByRole('navigation', { name: /文档章节|Documentation sections/i });
    await expect(sidebar.getByRole('heading', { name: '入门' })).toBeVisible();
    await expect(sidebar.getByRole('heading', { name: '策略评估' })).toBeVisible();
  });
});

test.describe('Cloud docs - breadcrumb', () => {
  test('breadcrumb shows localized path on zh API page', async ({ page }) => {
    await page.goto('/zh/docs/api/policies/evaluate');
    const breadcrumb = page.getByRole('navigation', { name: /面包屑导航|Breadcrumb/ });
    await expect(breadcrumb).toBeVisible();
    // Resolved against sidebar i18n keys per DocsBreadcrumb logic.
    await expect(breadcrumb).toContainText('文档');
    await expect(breadcrumb).toContainText('策略评估');
  });

  test('breadcrumb root link navigates back to /docs/', async ({ page }) => {
    await page.goto('/docs/api/policies/evaluate');
    const breadcrumb = page.getByRole('navigation', { name: /Breadcrumb/i });
    await breadcrumb.getByRole('link', { name: /Docs/i }).first().click();
    await expect(page).toHaveURL(/\/docs\/getting-started\/overview$/);
  });
});

test.describe('Cloud docs - locale switcher', () => {
  test('switcher changes URL prefix without leaving the page', async ({ page }) => {
    await page.goto('/docs/api/policies/evaluate');
    const switcher = page.getByLabel(/Change language|切换语言|Sprache wechseln/);
    await switcher.selectOption('zh');
    await expect(page).toHaveURL(/\/zh\/docs\/api\/policies\/evaluate$/);
    await expect(switcher).toHaveValue('zh');
  });
});

test.describe('Cloud docs - translation fallback banner', () => {
  // All zh/de API pages are now fully translated, so the banner should
  // never render in production. The infrastructure (TranslationFallbackBanner
  // component + mark-fallbacks.mjs + fallback frontmatter flag) is retained
  // so that future fallback content is automatically annotated; these
  // tests assert the banner stays dormant on translated pages.
  test('zh API page does NOT show fallback banner (real translation)', async ({ page }) => {
    await page.goto('/zh/docs/api/audit/logs');
    await expect(page.getByText('翻译进行中')).not.toBeVisible();
  });

  test('zh policies/evaluate does NOT show fallback banner (real translation)', async ({ page }) => {
    await page.goto('/zh/docs/api/policies/evaluate');
    await expect(page.getByText('翻译进行中')).not.toBeVisible();
  });

  test('zh getting-started/overview does NOT show fallback banner (real translation)', async ({ page }) => {
    await page.goto('/zh/docs/getting-started/overview');
    await expect(page.getByText('翻译进行中')).not.toBeVisible();
  });

  test('en pages never show fallback banner', async ({ page }) => {
    await page.goto('/docs/api/audit/logs');
    // The banner text is locale-scoped via i18n; EN text isn't shown
    // because the banner isn't injected into en.mdx.
    await expect(page.getByText('Translation in progress')).not.toBeVisible();
  });
});

test.describe('Cloud docs - SEO heads', () => {
  test('canonical points to current locale URL (en bare, zh prefixed)', async ({ page }) => {
    await page.goto('/zh/docs/api/policies/evaluate');
    const zhCanonical = page.locator('link[rel="canonical"]');
    await expect(zhCanonical).toHaveAttribute(
      'href',
      'https://aster-lang.cloud/zh/docs/api/policies/evaluate',
    );

    await page.goto('/docs/api/policies/evaluate');
    const enCanonical = page.locator('link[rel="canonical"]');
    await expect(enCanonical).toHaveAttribute(
      'href',
      'https://aster-lang.cloud/docs/api/policies/evaluate',
    );
  });

  test('hreflang alternates emit correct hrefs (zh policies/evaluate translation)', async ({ page }) => {
    // policies/evaluate is now a real Chinese translation. The page
    // still emits reciprocal hreflang alternates pointing to the
    // /en, /zh, /de URLs.
    await page.goto('/zh/docs/api/policies/evaluate');
    const expectations = {
      en: 'https://aster-lang.cloud/docs/api/policies/evaluate',
      zh: 'https://aster-lang.cloud/zh/docs/api/policies/evaluate',
      de: 'https://aster-lang.cloud/de/docs/api/policies/evaluate',
      'x-default': 'https://aster-lang.cloud/docs/api/policies/evaluate',
    };
    for (const [lang, expectedHref] of Object.entries(expectations)) {
      const link = page.locator(
        `link[rel="alternate"][hreflang="${lang}"], link[rel="alternate"][hrefLang="${lang}"]`,
      );
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute('href', expectedHref);
    }
  });

  test('hreflang alternates emit correct hrefs (en getting-started/overview)', async ({ page }) => {
    await page.goto('/docs/getting-started/overview');
    const expectations = {
      en: 'https://aster-lang.cloud/docs/getting-started/overview',
      zh: 'https://aster-lang.cloud/zh/docs/getting-started/overview',
      de: 'https://aster-lang.cloud/de/docs/getting-started/overview',
      'x-default': 'https://aster-lang.cloud/docs/getting-started/overview',
    };
    for (const [lang, expectedHref] of Object.entries(expectations)) {
      const link = page.locator(
        `link[rel="alternate"][hreflang="${lang}"], link[rel="alternate"][hrefLang="${lang}"]`,
      );
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute('href', expectedHref);
    }
  });
});

test.describe('Cloud docs - fallback SEO', () => {
  // All API pages are now fully translated, so no page should emit
  // canonical→EN + robots noindex. These assertions guard against the
  // SEO regression where a translated page accidentally keeps the
  // `fallback: true` frontmatter flag and gets de-indexed.
  test('translated page canonicalizes to locale URL + no noindex (audit/logs)', async ({ page }) => {
    await page.goto('/zh/docs/api/audit/logs');
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveAttribute(
      'href',
      'https://aster-lang.cloud/zh/docs/api/audit/logs',
    );
    const robots = page.locator('meta[name="robots"]');
    await expect(robots).toHaveCount(0);
  });

  test('translated page canonicalizes to locale URL + no noindex (policies/evaluate)', async ({ page }) => {
    await page.goto('/zh/docs/api/policies/evaluate');
    const canonical = page.locator('link[rel="canonical"]');
    await expect(canonical).toHaveAttribute(
      'href',
      'https://aster-lang.cloud/zh/docs/api/policies/evaluate',
    );
    const robots = page.locator('meta[name="robots"]');
    await expect(robots).toHaveCount(0);
  });
});

test.describe('Cloud docs - session-aware chrome', () => {
  // The chrome starts in the `probing` state (skeleton) and resolves
  // to `anonymous` for unauthenticated visitors. We verify the
  // anonymous state by asserting the Sign in + Open Console controls
  // appear after the probe settles. Authenticated state is covered by
  // integration tests (sets a session cookie) because the live deploy
  // doesn't carry credentials.

  test('anonymous user sees Sign in + Open Console after probe', async ({ page }) => {
    await page.goto('/docs/getting-started/overview');
    // Probe resolves quickly; the skeleton clears within a few hundred ms.
    await expect(page.getByRole('link', { name: /Sign in/i })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByRole('link', { name: /Open Console/i })).toBeVisible();
  });

  test('zh docs renders the localized Sign in / Open Console', async ({ page }) => {
    await page.goto('/zh/docs/getting-started/overview');
    await expect(page.getByRole('link', { name: '登录' })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('link', { name: '打开控制台' })).toBeVisible();
  });

  test('de docs renders the localized Sign in / Open Console', async ({ page }) => {
    await page.goto('/de/docs/getting-started/overview');
    await expect(page.getByRole('link', { name: 'Anmelden' })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByRole('link', { name: 'Konsole öffnen' })).toBeVisible();
  });

  test('session probe responds with no-store + Vary: Cookie', async ({ request }) => {
    const res = await request.get('/api/docs/session-state');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('private, no-store, max-age=0');
    expect(res.headers()['vary']).toBe('Cookie');
    const body = await res.json();
    // PII guard — body never contains email/userId/tenant.
    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('tenantId');
    expect(body).toHaveProperty('schemaVersion', 1);
  });

  test('docs HTML contains no email-like literals (PII guard)', async ({ request }) => {
    // Cross-locale check on a representative leaf page. The build-time
    // PII scan covers the full surface; this guards the runtime case
    // where an MDX edit could accidentally inline a real address.
    for (const path of [
      '/docs/getting-started/overview',
      '/zh/docs/getting-started/overview',
      '/de/docs/getting-started/overview',
    ]) {
      const res = await request.get(path);
      const html = await res.text();
      // Allow MDX sample domains (example.com, acme.com, etc.).
      const matches = html.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}\b/g) ?? [];
      const offending = matches.filter((m) => {
        const domain = m.split('@')[1]?.toLowerCase() ?? '';
        const sampleDomains = ['example.com', 'example.org', 'acme.com', 'acme-corp.com', 'aster-lang.dev', 'localhost'];
        return !sampleDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
      });
      expect(offending, `unexpected emails on ${path}: ${offending.join(', ')}`).toEqual([]);
    }
  });
});

test.describe('Cloud docs - page actions', () => {
  // The action bar mounts between breadcrumb and article. Anonymous
  // visitors should still see the "public" primary action (e.g. Try
  // in Playground on /docs/getting-started/quickstart since the
  // preview tenant is public). Auth-gated actions are not rendered.
  test('anonymous user sees the Try in Playground primary action on quickstart', async ({ page }) => {
    await page.goto('/docs/getting-started/quickstart');
    await expect(
      page.getByRole('link', { name: /Try in Playground/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('zh shows the localized primary action', async ({ page }) => {
    await page.goto('/zh/docs/getting-started/quickstart');
    await expect(page.getByRole('link', { name: '在 Playground 试用' })).toBeVisible({
      timeout: 5_000,
    });
  });

  test('anonymous user does not see "Open in Editor" on policies/evaluate', async ({ page }) => {
    await page.goto('/docs/api/policies/evaluate');
    // primary still renders (playground public), but Editor is auth-gated.
    await expect(page.getByRole('link', { name: /Try in Playground/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Open in Editor/i })).not.toBeVisible();
  });

  test('docs/jump endpoint responds 400 on malformed body without leaking anything', async ({ request }) => {
    const res = await request.post('/api/docs/jump', {
      data: { slug: 'x' }, // missing fields
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(400);
    expect(res.headers()['cache-control']).toBe('private, no-store, max-age=0');
  });
});

test.describe('Cloud docs - code-block toolbar', () => {
  // Every <pre> in MDX gets a Copy button via the DocsCodeBlock
  // override in mdx-components.tsx. Verify this baseline.
  test('docs page renders a Copy button toolbar on code fences', async ({ page }) => {
    await page.goto('/docs/api/policies/evaluate');
    const copyButtons = page.getByRole('button', { name: /Copy code to clipboard/i });
    await expect(copyButtons.first()).toBeVisible();
  });

  test('zh docs renders localized Copy button label', async ({ page }) => {
    await page.goto('/zh/docs/api/policies/evaluate');
    const copyButtons = page.getByRole('button', { name: /将代码复制到剪贴板/ });
    await expect(copyButtons.first()).toBeVisible();
  });
});

test.describe('Cloud docs - sitemap + robots', () => {
  test('sitemap.xml emits one <loc> per (slug × locale) with reciprocal hreflang', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    const body = await res.text();
    // Each of the 3 locales for the canonical API page must be a
    // first-class <loc> entry (not just an alternate).
    expect(body).toContain('<loc>https://aster-lang.cloud/docs/api/policies/evaluate</loc>');
    expect(body).toContain('<loc>https://aster-lang.cloud/zh/docs/api/policies/evaluate</loc>');
    expect(body).toContain('<loc>https://aster-lang.cloud/de/docs/api/policies/evaluate</loc>');
    // And each must carry reciprocal alternates so search engines
    // can fan out the full locale set from any starting URL.
    expect(body).toContain('hreflang="zh" href="https://aster-lang.cloud/zh/docs/api/policies/evaluate"');
    expect(body).toContain('hreflang="de" href="https://aster-lang.cloud/de/docs/api/policies/evaluate"');
    expect(body).toContain('hreflang="x-default"');
  });

  test('robots.txt allows /docs/, disallows /api/ + full private inventory per locale', async ({ request }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/Allow:\s*\/docs\//);
    expect(body).toMatch(/Disallow:\s*\/api\//);
    expect(body).toMatch(/Sitemap:\s*https:\/\/aster-lang\.cloud\/sitemap\.xml/);

    // Inventory check — every (auth)/* + (dashboard)/* top-level
    // segment + onboarding must be blocked across all 3 locales. If
    // a new private route segment is added without updating
    // robots.ts PRIVATE_PATHS, this test catches it.
    const requiredPaths = [
      'login', 'signup', 'forgot-password', 'reset-password', 'logout',
      'onboarding', 'renew',
      'dashboard', 'admin', 'billing', 'domain-vocabularies',
      'policies', 'reports', 'security', 'settings', 'teams',
    ];
    for (const seg of requiredPaths) {
      for (const prefix of ['', '/zh', '/de']) {
        const path = `${prefix}/${seg}`;
        // Either bare or trailing-slash form satisfies the requirement.
        // 完整转义 path 的正则元字符（原仅转义 `/` = 不完整）（CodeQL incomplete-sanitization）。
        const escapedPath = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        const re = new RegExp(`Disallow:\\s*${escapedPath}(\\/)?\\s*$`, 'm');
        expect(body).toMatch(re);
      }
    }
  });
});
