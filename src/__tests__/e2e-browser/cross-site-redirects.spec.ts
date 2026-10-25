import { test, expect, request as playwrightRequest } from '@playwright/test';

// 本 spec 只对生产站点对（aster-lang.dev ↔ aster-lang.cloud）有意义：它断言真实 dev 站点的跳转/页面，
// 指向本地 aster-cloud 栈（BASE_CLOUD=http://localhost:…）时必然失败，故本地跳过（#592）。
test.skip(/localhost|127\.0\.0\.1/.test(process.env.BASE_CLOUD ?? ''), 'production-only: asserts the live aster-lang.dev site');

/**
 * Cross-site redirect E2E — aster-lang.dev legacy URLs must 308 to
 * aster-lang.cloud/docs/* equivalents. These specs hit the real DNS
 * to validate the Cloudflare Pages _redirects file in production.
 *
 * Each test issues a manual fetch (no redirect-follow) so we can
 * assert the exact intermediate status + Location header.
 *
 * The full follow chain is also verified at the end of each test by
 * loading the final URL in a browser and asserting content.
 */

const DEV_HOST = process.env.BASE_DEV || 'https://aster-lang.dev';
const CLOUD_HOST = process.env.BASE_CLOUD || 'https://aster-lang.cloud';

async function rawStatus(url: string): Promise<{ status: number; location?: string }> {
  const req = await playwrightRequest.newContext({ ignoreHTTPSErrors: false });
  const res = await req.fetch(url, { maxRedirects: 0 });
  return {
    status: res.status(),
    location: res.headers()['location'],
  };
}

test.describe('Cross-site redirects - /api/* → cloud /docs/api/*', () => {
  test('GET /api/policies/evaluate → 308 → cloud bare', async () => {
    const { status, location } = await rawStatus(`${DEV_HOST}/api/policies/evaluate`);
    expect(status).toBe(308);
    expect(location).toBe(`${CLOUD_HOST}/docs/api/policies/evaluate`);
  });

  test('GET /zh/api/audit/logs → 308 → cloud /zh/docs/...', async () => {
    const { status, location } = await rawStatus(`${DEV_HOST}/zh/api/audit/logs`);
    expect(status).toBe(308);
    expect(location).toBe(`${CLOUD_HOST}/zh/docs/api/audit/logs`);
  });

  test('GET /de/api/graphql/overview → 308 → cloud /de/docs/...', async () => {
    const { status, location } = await rawStatus(`${DEV_HOST}/de/api/graphql/overview`);
    expect(status).toBe(308);
    expect(location).toBe(`${CLOUD_HOST}/de/docs/api/graphql/overview`);
  });
});

test.describe('Cross-site redirects - /getting-started/* → cloud /docs/getting-started/*', () => {
  test('GET /getting-started/quickstart → 308 → cloud bare', async () => {
    const { status, location } = await rawStatus(`${DEV_HOST}/getting-started/quickstart`);
    expect(status).toBe(308);
    expect(location).toBe(`${CLOUD_HOST}/docs/getting-started/quickstart`);
  });

  test('GET /zh/getting-started/overview → 308 → cloud zh', async () => {
    const { status, location } = await rawStatus(`${DEV_HOST}/zh/getting-started/overview`);
    expect(status).toBe(308);
    expect(location).toBe(`${CLOUD_HOST}/zh/docs/getting-started/overview`);
  });
});

test.describe('Cross-site redirects - legacy roots', () => {
  test('GET /graphql → 308 → cloud /docs/api/graphql/overview', async () => {
    const { status, location } = await rawStatus(`${DEV_HOST}/graphql`);
    expect(status).toBe(308);
    expect(location).toBe(`${CLOUD_HOST}/docs/api/graphql/overview`);
  });

  test('GET /websocket → 308 → cloud /docs/api/websocket/preview', async () => {
    const { status, location } = await rawStatus(`${DEV_HOST}/websocket`);
    expect(status).toBe(308);
    expect(location).toBe(`${CLOUD_HOST}/docs/api/websocket/preview`);
  });
});

test.describe('Cross-site redirects - same-site (still in scope)', () => {
  // Same-site redirects emit a relative Location header (Cloudflare
  // Pages behavior). Tests accept either absolute or relative form.
  test('GET /pricing → 301 → /editions/ (same site)', async () => {
    const { status, location } = await rawStatus(`${DEV_HOST}/pricing`);
    expect(status).toBe(301);
    expect(location).toMatch(/^(https:\/\/aster-lang\.dev)?\/editions\/$/);
  });

  test('GET /enterprise → 301 → /community/compliance/ (same site)', async () => {
    const { status, location } = await rawStatus(`${DEV_HOST}/enterprise`);
    expect(status).toBe(301);
    expect(location).toMatch(/^(https:\/\/aster-lang\.dev)?\/community\/compliance\/$/);
  });
});

test.describe('Cross-site redirects - full chain renders content', () => {
  test('clicking landing CTA from aster-lang.dev lands on Cloud docs', async ({ page }) => {
    await page.goto(`${DEV_HOST}/`);
    // The HeroAnimationTeaser CTA points at the Cloud API docs.
    const cta = page.getByRole('link', { name: /Read Cloud API docs/i });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', /aster-lang\.cloud\/docs\/api\/policies\/evaluate/);
  });

  test('following /api/policies/evaluate lands on Cloud Evaluate Policy page', async ({ page }) => {
    const response = await page.goto(`${DEV_HOST}/api/policies/evaluate`);
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(`${CLOUD_HOST}/docs/api/policies/evaluate`);
    // Cloud page should render the docs chrome (top nav with "Aster cloud").
    await expect(page.getByRole('link', { name: /Aster cloud/i }).first()).toBeVisible();
  });
});
