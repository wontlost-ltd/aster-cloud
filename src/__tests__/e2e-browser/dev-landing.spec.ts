import { test, expect } from '@playwright/test';

// 本 spec 只对生产站点对（aster-lang.dev ↔ aster-lang.cloud）有意义：它断言真实 dev 站点的跳转/页面，
// 指向本地 aster-cloud 栈（BASE_CLOUD=http://localhost:…）时必然失败，故本地跳过（#592）。
test.skip(/localhost|127\.0\.0\.1/.test(process.env.BASE_CLOUD ?? ''), 'production-only: asserts the live aster-lang.dev site');

/**
 * aster-lang.dev landing E2E.
 *
 * Runs against the deployed VitePress site by default. The base URL
 * here is hardcoded — overriding via env vars matters less because
 * VitePress doesn't have a local-dev quirk to work around like Next.js
 * does. To smoke-test a local build use:
 *   BASE_DEV=http://localhost:5173 pnpm test:e2e:browser
 */

const DEV_HOST = process.env.BASE_DEV || 'https://aster-lang.dev';

test.use({ baseURL: DEV_HOST });

test.describe('Dev landing - nav structure', () => {
  test('nav contains 5 items, no API entry', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('.VPNavBarMenu, nav.VPNav').first();
    await expect(nav).toBeVisible();
    // VitePress renders nav items as <a> inside .VPNavBarMenu on
    // desktop. Verify the 5 expected items + assert API is not there.
    for (const label of ['Learn', 'Playground', 'Editions', 'Community', 'Cloud']) {
      // Use a regex anchored to avoid matching e.g. "Cloud" inside body content.
      await expect(page.getByRole('link', { name: new RegExp(`^${label}$`), exact: true })).toBeVisible();
    }
    const apiLinks = await page.getByRole('link', { name: /^API$/ }).count();
    expect(apiLinks).toBe(0);
  });

  test('locale switcher offers EN / 中文 / Deutsch', async ({ page }) => {
    await page.goto('/');
    // VitePress emits a language flyout button with aria-label.
    const switcher = page.getByLabel(/Change language|切换语言|Sprache wechseln/);
    await switcher.first().click();
    await expect(page.getByText('简体中文')).toBeVisible();
    await expect(page.getByText('Deutsch')).toBeVisible();
    // English should also be in the flyout.
    await expect(page.getByText('English')).toBeVisible();
  });
});

test.describe('Dev landing - HeroAnimationTeaser', () => {
  test('teaser renders with Aster Cloud framing + CTA', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Run them on Aster Cloud/i })).toBeVisible();
    const cta = page.getByRole('link', { name: /Read Cloud API docs/i });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', /aster-lang\.cloud\/docs\/api\/policies\/evaluate/);
  });

  test('teaser shows all 3 cards (Policy / Workflow / Decision)', async ({ page }) => {
    await page.goto('/');
    for (const label of ['Policy', 'Workflow', 'Decision']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
  });
});

test.describe('Dev landing - tagline carousel', () => {
  test('tagline carousel renders with progress dots', async ({ page }) => {
    await page.goto('/');
    // Tagline dots have role="tab" inside role="tablist".
    const tablist = page.getByRole('tablist', { name: /Tagline/i });
    await expect(tablist).toBeVisible();
    const dots = tablist.getByRole('tab');
    await expect(dots).toHaveCount(6);
  });
});

test.describe('Dev landing - locale parity', () => {
  test('/zh/ shows Chinese hero text', async ({ page }) => {
    await page.goto('/zh/');
    await expect(page.getByRole('heading', { name: /Policy · Workflow · Decision|策略 · 流程 · 决策/i })).toBeVisible();
  });

  test('/de/ shows German hero text', async ({ page }) => {
    await page.goto('/de/');
    // Hero text mentions German.
    await expect(page.getByText(/Deutsch/i).first()).toBeVisible();
  });
});

test.describe('Dev landing - SEO heads', () => {
  test('canonical points to aster-lang.dev (not pages.dev)', async ({ page }) => {
    await page.goto('/');
    const canonical = page.locator('link[rel="canonical"]').first();
    await expect(canonical).toHaveAttribute('href', /^https:\/\/aster-lang\.dev\//);
  });

  test('hreflang alternates are emitted for translated pages', async ({ page }) => {
    await page.goto('/');
    for (const lang of ['en', 'zh-CN', 'de-DE', 'x-default']) {
      const link = page.locator(`link[rel="alternate"][hreflang="${lang}"]`);
      await expect(link).toHaveCount(1);
    }
  });

  test('sitemap.xml includes the landing + key learn pages', async ({ request }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('<loc>https://aster-lang.dev/</loc>');
    expect(body).toContain('aster-lang.dev/learn/playground');
    // Removed paths should NOT appear.
    expect(body).not.toContain('aster-lang.dev/api/');
    expect(body).not.toContain('aster-lang.dev/getting-started/');
  });
});

test.describe('Dev landing - search hidden on home', () => {
  test('VPNavBarSearch is not visible on / (per :has() rule in custom.css)', async ({ page }) => {
    await page.goto('/');
    const search = page.locator('.VPNavBarSearch');
    // Search element exists in DOM but is display:none.
    await expect(search).toBeHidden();
  });

  test('VPNavBarSearch IS visible on doc pages', async ({ page }) => {
    await page.goto('/learn/overview');
    const search = page.locator('.VPNavBarSearch');
    await expect(search).toBeVisible();
  });
});
