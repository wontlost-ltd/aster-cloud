import { test, expect, type Page } from '@playwright/test';

// 本 spec 只对生产站点对（aster-lang.dev ↔ aster-lang.cloud）有意义：它断言真实 dev 站点的跳转/页面，
// 指向本地 aster-cloud 栈（BASE_CLOUD=http://localhost:…）时必然失败，故本地跳过（#592）。
test.skip(/localhost|127\.0\.0\.1/.test(process.env.BASE_CLOUD ?? ''), 'production-only: asserts the live aster-lang.dev site');

/**
 * aster-lang.dev 落地页 E2E。
 *
 * dev 站点现为 Next.js（App Router，localePrefix as-needed：en 无前缀，zh/de/hi 带前缀），
 * 本 spec 断言的是用户可感知的结构——页头/页脚导航、首屏主标题与 CTA、语言切换、
 * 多语言 hreflang、文档页侧栏——而不是任何框架私有的 class 名，避免再次随框架迁移整体失效。
 *
 * 默认打线上站点；本地预览可用 BASE_DEV 覆盖：
 *   BASE_DEV=http://localhost:3000 pnpm test:e2e:browser
 */

const DEV_HOST = process.env.BASE_DEV || 'https://aster-lang.dev';
const CLOUD_HOST = 'https://aster-lang.cloud';
const GITHUB_REPO = 'https://github.com/aster-cloud/aster-lang-core';

test.use({ baseURL: DEV_HOST });

/** 收集页面运行期错误（console.error + 未捕获异常），用于「无控制台错误」断言。 */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** 页头主导航：页面上第一个 <nav>（位于 <header> 内）。 */
function headerNav(page: Page) {
  return page.locator('header nav').first();
}

/** 页脚导航。 */
function footerNav(page: Page) {
  return page.locator('footer nav').first();
}

test.describe('Dev landing - nav structure', () => {
  test('header nav exposes Docs / Language Guide / Reference / Playground', async ({ page }) => {
    await page.goto('/');
    const nav = headerNav(page);
    await expect(nav).toBeVisible();
    const expected: ReadonlyArray<[string, string]> = [
      ['Docs', '/docs'],
      ['Language Guide', '/docs/language-guide'],
      ['Reference', '/docs/reference'],
      ['Playground', '/playground'],
    ];
    for (const [label, href] of expected) {
      await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute('href', href);
    }
    // 旧 VitePress 时代的 API 入口已移除，API 文档在 aster-lang.cloud/docs。
    await expect(nav.getByRole('link', { name: /^API$/ })).toHaveCount(0);
  });

  test('footer links to Aster Cloud and the GitHub repository', async ({ page }) => {
    await page.goto('/');
    const footer = footerNav(page);
    await expect(footer.getByRole('link', { name: 'Aster Cloud', exact: true })).toHaveAttribute(
      'href',
      new RegExp(`^${CLOUD_HOST.replace(/[.]/g, '\\.')}/?$`),
    );
    await expect(footer.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute('href', GITHUB_REPO);
    for (const [label, href] of [['Documentation', '/docs'], ['Playground', '/playground'], ['Blog', '/blog']]) {
      await expect(footer.getByRole('link', { name: label, exact: true })).toHaveAttribute('href', href);
    }
  });

  test('primary routes respond 200', async ({ request }) => {
    for (const path of ['/', '/docs', '/docs/language-guide', '/docs/reference', '/playground', '/blog', '/zh', '/de']) {
      const res = await request.get(path);
      expect(res.status(), `GET ${path}`).toBe(200);
    }
  });
});

test.describe('Dev landing - hero', () => {
  test('hero heading + primary CTAs render', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /Rules in your language\. Decisions you can trust\./,
    );
    await expect(page.getByRole('link', { name: 'Try in Playground' })).toHaveAttribute('href', '/playground');
    await expect(page.getByRole('link', { name: '5-Minute Quick Start' })).toHaveAttribute('href', '/docs');
  });

  test('home page loads without console errors', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/', { waitUntil: 'networkidle' });
    expect(errors).toEqual([]);
  });
});

test.describe('Dev landing - locale switcher', () => {
  test('language menu offers English / 中文 / Deutsch / हिन्दी', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Switch language|切换语言|Sprache wechseln/ }).click();
    const items = page.getByRole('option');
    for (const label of ['English', '中文', 'Deutsch', 'हिन्दी']) {
      await expect(items.filter({ hasText: label })).toHaveCount(1);
    }
  });

  test('choosing 中文 navigates to the /zh home', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Switch language/ }).click();
    await page.getByRole('option').filter({ hasText: '中文' }).click();
    await expect(page).toHaveURL(/\/zh\/?$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
  });
});

test.describe('Dev landing - locale parity', () => {
  test('/zh shows Chinese hero + localized nav', async ({ page }) => {
    await page.goto('/zh');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('用你的语言写规则');
    await expect(headerNav(page).getByRole('link', { name: '文档', exact: true })).toHaveAttribute('href', '/zh/docs');
    await expect(headerNav(page).getByRole('link', { name: '演练场', exact: true })).toHaveAttribute('href', '/zh/playground');
  });

  test('/de shows German hero', async ({ page }) => {
    await page.goto('/de');
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Regeln in deiner Sprache');
  });
});

test.describe('Dev landing - SEO heads', () => {
  test('hreflang alternates are emitted for every locale', async ({ page }) => {
    await page.goto('/');
    const expected: Record<string, string> = { en: '/', zh: '/zh', de: '/de', hi: '/hi' };
    for (const [lang, href] of Object.entries(expected)) {
      const link = page.locator(`link[rel="alternate"][hreflang="${lang}"], link[rel="alternate"][hrefLang="${lang}"]`);
      await expect(link).toHaveCount(1);
      // 允许相对或绝对 URL，只要路径一致。
      const actual = await link.getAttribute('href');
      expect(new URL(actual ?? '', DEV_HOST).pathname).toBe(href);
    }
  });

  test('home page has a descriptive <title>', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/^Aster Lang — /);
  });
});

test.describe('Dev landing - docs page', () => {
  test('docs page renders sidebar + on-this-page navigation', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/docs', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Docs' })).toBeAttached();
    await expect(page.getByRole('navigation', { name: 'On this page' })).toBeAttached();
    expect(errors).toEqual([]);
  });
});
