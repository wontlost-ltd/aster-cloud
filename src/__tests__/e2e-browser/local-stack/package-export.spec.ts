/**
 * ADR 0059 P2（T20）：策略详情页「导出」菜单里的策略包导出，桌面与 390px 移动视口各跑一遍。
 *
 * 1. pro 用户、已批准版本、开关打开：操作组里是「Export」下拉（Cedar + JRE 包），菜单项 ≥ 44×44、完整可见不被裁；
 *    键盘 Tab 到触发按钮、Enter 打开、Esc 关闭并回焦；选 JRE 后下载 zip，状态区（aria-live）显示的 SHA-256
 *    与响应头及下载文件的实际哈希三者相同；
 * 2. 不可导出时状态区按诊断码给出本地化原因（E730）；
 * 3. free 用户看不到任何包选项（套餐门）；开关关时 pro 用户同样看不到（菜单回到「Export to Cedar」单按钮）；
 * 4. 菜单打开与下载完成两种状态下 axe（WCAG 2.0/2.1/2.2 A + AA）零违规；移动端无横向溢出。
 *
 * aster-api 的包导出端点（A5）合入之前，可导出性检查拿不到结论（'unknown'，照常显示 JRE 项），下载请求在浏览器侧
 * 以 page.route 回放契约形状的响应（zip 字节 + X-Aster-Package-* 头）。设 PACKAGE_EXPORT_LIVE=1 时不回放，
 * 走真实的 cloud → aster-api 链路（需 aster-api 以 ASTER_EXPORT_PACKAGE_ENABLED=true 与 dev 测试密钥运行），
 * 并另跑「含 IO 的策略包项禁用、显示 E730」的真实检查用例。
 *
 * 夹具：UI 审计种子（`pnpm ui-audit:seed`，storageState 在 UI_AUDIT_STATE_DIR）。开关经管理接口由 ui-platform 切换
 * （同进程即时生效，不受 60 s 设置缓存影响），结束时关回去；用例新建的策略在结束时软删除。
 * 设 E2E_SCREENSHOT_DIR 时把各状态截图写到该目录。
 */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { NOT_LOCAL, NOT_LOCAL_REASON, expectUnclipped, psql } from './helpers';

const STATE_DIR = process.env.UI_AUDIT_STATE_DIR || join(process.cwd(), '.superpowers/ui-audit');
const state = (user: 'ui-pro' | 'ui-free' | 'ui-platform') => join(STATE_DIR, `state-${user}.json`);
const BASE = (process.env.BASE_CLOUD || '').replace(/\/$/, '');
const ORIGIN = { Origin: BASE };
const LIVE = process.env.PACKAGE_EXPORT_LIVE === '1';
const SHOTS = process.env.E2E_SCREENSHOT_DIR;
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const FLAG = 'policy_export.package.enabled';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.describe.configure({ mode: 'serial' });

const SOURCE = (module: string) => `Module ${module}.

Rule evaluateLoan given tier as Text, produce Text:
  If tier equals to "gold":
    Return "allow".
  Return "review".
`;

const IO_SOURCE = (module: string) => `Module ${module}.

Rule notify given name as Text, produce Text. It performs io:
  Return name.
`;

const VIEWPORTS = [
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
] as const;

const ids = { pro: '', free: '', proIo: '' };

async function setFlag(browser: Browser, value: boolean): Promise<void> {
  const ctx = await browser.newContext({ storageState: state('ui-platform'), baseURL: BASE });
  const res = await ctx.request.post('/api/admin/platform-settings', { headers: ORIGIN, data: { key: FLAG, value } });
  expect(res.status(), await res.text()).toBe(200);
  await ctx.close();
}

async function createApproved(browser: Browser, user: 'ui-pro' | 'ui-free', name: string, content: string): Promise<string> {
  const ctx = await browser.newContext({ storageState: state(user), baseURL: BASE });
  const res = await ctx.request.post('/api/policies', { headers: ORIGIN, data: { name, content, locale: 'en-US' } });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await ctx.close();
  // 单用户无法自批（四眼原则），经 psql 把 v1 置为已批准
  psql('aster_cloud', `update "PolicyVersion" set status = 'APPROVED' where "policyId" = '${id}' and version = 1`);
  return id;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const run = Date.now();
  ids.pro = await createApproved(browser, 'ui-pro', `e2e-pkg-pro-${run}`, SOURCE(`aster.e2e.pkgpro${run}`));
  ids.free = await createApproved(browser, 'ui-free', `e2e-pkg-free-${run}`, SOURCE(`aster.e2e.pkgfree${run}`));
  if (LIVE) ids.proIo = await createApproved(browser, 'ui-pro', `e2e-pkg-io-${run}`, IO_SOURCE(`aster.e2e.pkgio${run}`));
  await setFlag(browser, true);
});

test.afterAll(async ({ browser }) => {
  await setFlag(browser, false).catch(() => undefined);
  for (const [user, id] of [['ui-pro', ids.pro], ['ui-free', ids.free], ['ui-pro', ids.proIo]] as const) {
    if (!id) continue;
    const ctx = await browser.newContext({ storageState: state(user), baseURL: BASE });
    await ctx.request.delete(`/api/policies/${id}`, { headers: ORIGIN }).catch(() => undefined);
    await ctx.close();
  }
});

/** 详情页在服务端等可导出性检查时流式渲染，同一 testid 可能短暂出现两份，一律限定在主区里找 */
const main = (page: Page) => page.locator('#dashboard-main');

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(summary, `axe violations ${label}`).toEqual([]);
}

/** 浏览器侧回放契约形状的包下载响应（A5 合入前）；返回回放的 zip 字节与哈希 */
async function replayZip(page: Page): Promise<{ bytes: Buffer; sha256: string; body: () => unknown }> {
  const bytes = Buffer.from('PK\u0003\u0004 e2e replay of an aster policy package zip', 'latin1');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let requestBody: unknown = null;
  await page.route('**/api/policies/*/export/package', async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      body: bytes,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="loan-v1-jre-b.zip"; filename*=UTF-8''loan-v1-jre-b.zip`,
        'X-Aster-Package-Sha256': sha256,
        'X-Aster-Package-Signed': 'true',
        'Cache-Control': 'private, no-store',
      },
    });
  });
  return { bytes, sha256, body: () => requestBody };
}

for (const vp of VIEWPORTS) {
  test.describe(`policy package export (${vp.name})`, () => {
    test.use(vp.use);

    test('pro: Export menu with Cedar + JRE items, 44px targets, unclipped, keyboard open / Esc / focus return', async ({ browser }) => {
      const ctx = await browser.newContext({ ...vp.use, storageState: state('ui-pro'), baseURL: BASE });
      const page = await ctx.newPage();
      await page.goto(`/en/policies/${ids.pro}`);
      const trigger = main(page).getByTestId('policy-export-menu-button');
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAccessibleName('Export');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      // 触发按钮与操作组其他按钮同高
      const heights = await main(page).getByTestId('policy-actions').evaluate((g) =>
        Array.from(g.querySelectorAll<HTMLElement>('a[href], button')).map((el) => Math.round(el.getBoundingClientRect().height)));
      expect(new Set(heights).size, `action heights ${heights}`).toBe(1);

      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      for (const item of ['export-item-cedar', 'export-item-jre']) {
        const loc = main(page).getByTestId(item);
        await expectUnclipped(loc);
        const box = (await loc.boundingBox())!;
        expect(box.height, `${item} height`).toBeGreaterThanOrEqual(44);
        expect(box.width, `${item} width`).toBeGreaterThanOrEqual(44);
      }
      // Node 包在 C3 之前不可用，不显示
      await expect(main(page).getByTestId('export-item-node')).toHaveCount(0);
      if (vp.name === 'mobile') {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, 'horizontal overflow').toBeLessThanOrEqual(0);
      }
      await shot(page, `${vp.name}-menu-open`);
      await expectNoAxeViolations(page, 'menu open');

      await page.keyboard.press('Escape');
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await expect(trigger).toBeFocused();
      await ctx.close();
    });

    test('pro: choosing JRE downloads the zip; the shown SHA-256 equals the header and the file', async ({ browser }) => {
      const ctx = await browser.newContext({ ...vp.use, storageState: state('ui-pro'), baseURL: BASE, acceptDownloads: true });
      const page = await ctx.newPage();
      const replay = LIVE ? null : await replayZip(page);
      await page.goto(`/en/policies/${ids.pro}`);
      const trigger = main(page).getByTestId('policy-export-menu-button');
      await trigger.click();
      const responsePromise = page.waitForResponse((r) => r.url().includes('/export/package') && r.request().method() === 'POST');
      const downloadPromise = page.waitForEvent('download');
      await main(page).getByTestId('export-item-jre').click();
      const [response, download] = await Promise.all([responsePromise, downloadPromise]);
      expect(response.status()).toBe(200);
      const headerSha = response.headers()['x-aster-package-sha256'];
      const file = readFileSync(await download.path());
      const fileSha = createHash('sha256').update(file).digest('hex');
      expect(download.suggestedFilename()).toMatch(/-jre-b\.zip$/);
      const shown = main(page).getByTestId('package-export-sha256');
      await expect(shown).toHaveText(headerSha);
      expect(fileSha).toBe(headerSha);
      if (replay) {
        expect(fileSha).toBe(replay.sha256);
        expect(replay.body()).toEqual({ target: 'jre', uiLocale: 'en' });
      }
      // 结果在 aria-live 状态区里，操作组外；焦点回到触发按钮
      const status = main(page).getByTestId('package-export-status');
      await expect(status).toHaveAttribute('aria-live', 'polite');
      expect(await main(page).getByTestId('policy-actions').evaluate((g, s) => g.contains(s), await status.elementHandle())).toBe(false);
      await expect(trigger).toBeFocused();
      await expectUnclipped(main(page).getByTestId('package-export-copy'));
      if (vp.name === 'mobile') {
        const box = (await main(page).getByTestId('package-export-copy').boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(44);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, 'horizontal overflow (long SHA-256 must wrap)').toBeLessThanOrEqual(0);
      }
      await shot(page, `${vp.name}-downloaded`);
      await expectNoAxeViolations(page, 'downloaded');
      await ctx.close();
    });

    test('refusal shows the localized reason for each diagnostic code', async ({ browser }) => {
      test.skip(LIVE, '真实链路下由下方的 IO 策略用例覆盖');
      const ctx = await browser.newContext({ ...vp.use, storageState: state('ui-pro'), baseURL: BASE });
      const page = await ctx.newPage();
      await page.route('**/api/policies/*/export/package', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ exportable: false, diagnostics: [{
          severity: 'error', code: 'E730', startLine: 3, startColumn: 3, endLine: 3, endColumn: 3,
          message: "Function 'notify' declares IO capability Http; exported packages cannot perform IO",
        }] }),
      }));
      await page.goto(`/zh/policies/${ids.pro}`);
      await main(page).getByTestId('policy-export-menu-button').click();
      await main(page).getByTestId('export-item-jre').click();
      const refused = main(page).getByTestId('package-export-refused');
      await expect(refused).toHaveAttribute('role', 'alert');
      await expect(refused).toContainText('E730');
      await expect(refused).toContainText('3:3');
      await expect(refused).toContainText('导出的包不能执行 IO');
      await shot(page, `${vp.name}-refused-zh`);
      await expectNoAxeViolations(page, 'refused');
      await ctx.close();
    });

    test('live: a policy with an IO capability has its package item disabled and shows E730', async ({ browser }) => {
      test.skip(!LIVE, '需要 aster-api 包导出端点（A5），设 PACKAGE_EXPORT_LIVE=1');
      const ctx = await browser.newContext({ ...vp.use, storageState: state('ui-pro'), baseURL: BASE });
      const page = await ctx.newPage();
      await page.goto(`/en/policies/${ids.proIo}`);
      await main(page).getByTestId('policy-export-menu-button').click();
      const item = main(page).getByTestId('export-item-jre');
      await expect(item).toHaveAttribute('aria-disabled', 'true');
      await item.click();
      await expect(main(page).getByTestId('package-export-refused')).toContainText('E730');
      await ctx.close();
    });

    test('free plan: no package items; the Cedar action is unchanged', async ({ browser }) => {
      const ctx = await browser.newContext({ ...vp.use, storageState: state('ui-free'), baseURL: BASE });
      const page = await ctx.newPage();
      await page.goto(`/en/policies/${ids.free}`);
      await expect(main(page).getByTestId('policy-actions')).toBeVisible();
      await expect(main(page).getByTestId('policy-export-menu-button')).toHaveCount(0);
      await expect(main(page).getByTestId('export-item-jre')).toHaveCount(0);
      await expect(main(page).getByTestId('package-export-status')).toHaveCount(0);
      await ctx.close();
    });
  });
}

test('flag off: pro users see no package items either', async ({ browser }) => {
  await setFlag(browser, false);
  try {
    const ctx = await browser.newContext({ storageState: state('ui-pro'), baseURL: BASE });
    const page = await ctx.newPage();
    await page.goto(`/en/policies/${ids.pro}`);
    await expect(main(page).getByTestId('policy-actions')).toBeVisible();
    await expect(main(page).getByTestId('policy-export-menu-button')).toHaveCount(0);
    await expect(main(page).getByTestId('package-export-status')).toHaveCount(0);
    await ctx.close();
  } finally {
    await setFlag(browser, true);
  }
});
