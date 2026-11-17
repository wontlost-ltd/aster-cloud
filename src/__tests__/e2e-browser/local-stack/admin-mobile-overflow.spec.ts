/**
 * 平台管理页移动端不横向溢出（#774）：/admin 的「平台控制」卡片与 /admin/revalidation 的工具链标识。
 *
 * 根因：/admin「平台控制」网格没写列定义，隐式列为 auto、网格项 min-width:auto，卡片里最长的不可断内容
 * （长邮箱、长主机名）把整列撑出视口；复核页的工具链标识是一整串无空格的 key=value 列表。
 * UI 审计种子里只有短邮箱、没有动态 BYOK 主机、也没有最近一次复核，所以一直没暴露。
 *
 * 用例现建一个平台管理员和一个长邮箱用户（psql 写 User 行 + 伪造 Auth.js 会话 cookie），经应用接口给 BYOK 白名单加一个
 * 长主机名、发起一次 report 模式（只报告不拦截）的全量复核；在 390 / 360px × en / zh × 浅色 / 深色下断言：
 *   - 页面没有横向溢出（scrollWidth ≤ clientWidth）；
 *   - 「平台控制」每张卡片的右缘不越出父容器，卡片内没有越出卡片右缘的后代（横向滚动区内的除外）；
 *   - 长邮箱 / 长主机名完整渲染（不截断）；工具链标识完整可复制且落在所在区块内。
 * 结束时删除两名用户与 BYOK 主机。复核记录（report 模式）会保留在 aster-api。
 *
 * 运行（本地栈，cloud 生产构建在 BASE_CLOUD，需要 aster-api）：
 *   E2E_PG_CONTAINER=ui-admin-pg NEXTAUTH_SECRET=… BASE_CLOUD=http://localhost:3791 BASE_API=http://localhost:8791 \
 *     pnpm exec playwright test src/__tests__/e2e-browser/local-stack/admin-mobile-overflow.spec.ts --project=chromium-desktop --workers=1
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { SESSION_COOKIE_NAME, sessionCookie } from '../../../../scripts/lib/session-cookie';
import { BASE_CLOUD, NOT_LOCAL, NOT_LOCAL_REASON, psql } from './helpers';

const SECRET = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
const RUN_KEY = 'aster.admin.revalidation.recentRunId';
const suffix = randomUUID().slice(0, 8);
const ADMIN_ID = `e2e-admin805-${suffix}`;
// 生产里真实出现过的那类长内容：没有空格的长邮箱、长 ID、长主机名
const LONG_USER_ID = `e2e-long805-${suffix}-cmh7x2k9q0000qwertyuiopasdfghjkl`;
const LONG_EMAIL = `alexandra.konstantinopoulou-whitfield.${suffix}@compliance-operations.example-enterprise.com`;
const LONG_HOST = `llm-gateway-${suffix}.eu-central-1.compliance-operations.example-enterprise.com`;

const VIEWPORTS = [390, 360] as const;
const LOCALES = ['en', 'zh'] as const;
const THEMES = ['light', 'dark'] as const;

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

let cookie = '';
let runId = '';

async function newMobilePage(browser: Browser, width: number, theme: 'light' | 'dark'): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: theme,
  });
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: cookie, url: BASE_CLOUD, httpOnly: true, sameSite: 'Lax' }]);
  if (runId) await context.addInitScript(([k, v]) => window.localStorage.setItem(k, v), [RUN_KEY, runId] as const);
  return context.newPage();
}

async function api(method: 'POST' | 'GET', path: string, data?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE_CLOUD}${path}`, {
    method,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
      Origin: BASE_CLOUD,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** 页面没有横向溢出 */
async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const { sw, cw } = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  expect(sw, `${label}: scrollWidth ${sw} > clientWidth ${cw}`).toBeLessThanOrEqual(cw);
}

test.describe('admin pages on mobile do not overflow horizontally (#774)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
  test.skip(!SECRET, '需要与被测 cloud 进程相同的 NEXTAUTH_SECRET');

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    psql(
      'aster_cloud',
      `insert into "User" (id, name, email, "emailNormalized", "emailVerified", plan, "isAdmin", "onboardingCompletedAt",
         "priceLockedAt", "createdAt", "updatedAt")
       values (${lit(ADMIN_ID)}, 'Admin 805', ${lit(`${ADMIN_ID}@e2e.test`)}, ${lit(`${ADMIN_ID}@e2e.test`)}, now(), 'pro', true, now(), now(), now(), now()),
              (${lit(LONG_USER_ID)}, null, ${lit(LONG_EMAIL)}, ${lit(LONG_EMAIL)}, now(), 'pro', false, now(), now(), now(), now())`,
    );
    cookie = await sessionCookie({ id: ADMIN_ID, email: `${ADMIN_ID}@e2e.test`, plan: 'pro' }, SECRET!);
    const byok = await api('POST', '/api/admin/byok-allowlist', { action: 'add', host: LONG_HOST });
    expect(byok.status, `BYOK add: ${JSON.stringify(byok.json)}`).toBeLessThan(300);
    // 只报告、不拦截；已有运行中的复核（409 active_run_exists，如上一轮刚发起的）时等它结束再发起，最多约 2 分钟
    let run = await api('POST', '/api/admin/revalidation/runs', { scope: 'all', mode: 'report' });
    for (let i = 0; run.status === 409 && i < 24; i += 1) {
      await new Promise((r) => setTimeout(r, 5_000));
      run = await api('POST', '/api/admin/revalidation/runs', { scope: 'all', mode: 'report' });
    }
    expect(run.status, `revalidation run: ${JSON.stringify(run.json)}`).toBeLessThan(300);
    runId = String(run.json.runId ?? run.json.id);
  });

  test.afterAll(async () => {
    if (cookie) await api('POST', '/api/admin/byok-allowlist', { action: 'remove', host: LONG_HOST }).catch(() => undefined);
    psql('aster_cloud', `delete from "User" where id in (${lit(ADMIN_ID)}, ${lit(LONG_USER_ID)})`);
  });

  for (const width of VIEWPORTS) {
    for (const locale of LOCALES) {
      for (const theme of THEMES) {
        const label = `${width}px ${locale} ${theme}`;

        test(`/admin platform controls stay inside their parent — ${label}`, async ({ browser }) => {
          const page = await newMobilePage(browser, width, theme);
          await page.goto(`/${locale}/admin`);
          const section = page.locator('section', { has: page.locator('#admin-controls-heading') });
          // 等长内容渲染出来：长邮箱（结构词别名卡）与长主机名（BYOK 卡）
          await expect(section.getByText(LONG_EMAIL)).toBeVisible({ timeout: 20_000 });
          await expect(section.getByText(LONG_HOST)).toBeVisible({ timeout: 20_000 });
          await expectNoHorizontalOverflow(page, label);

          const report = await section.evaluate((sec) => {
            const grid = sec.querySelector(':scope > div') as HTMLElement;
            const parent = grid.getBoundingClientRect();
            const inScroller = (el: Element, stop: Element) => {
              for (let p = el.parentElement; p && p !== stop; p = p.parentElement) {
                const ox = getComputedStyle(p).overflowX;
                if (ox === 'auto' || ox === 'scroll') return true;
              }
              return false;
            };
            return Array.from(grid.children).map((card) => {
              const r = card.getBoundingClientRect();
              const spill = Array.from(card.querySelectorAll('*')).filter((d) => {
                const dr = d.getBoundingClientRect();
                return dr.width > 0 && dr.right > r.right + 0.5 && !inScroller(d, card);
              });
              return {
                title: card.querySelector('h2')?.textContent?.trim() ?? '?',
                right: r.right,
                parentRight: parent.right,
                spill: spill.slice(0, 3).map((d) => `${d.tagName.toLowerCase()} "${(d.textContent ?? '').trim().slice(0, 40)}"`),
              };
            });
          });
          expect(report).toHaveLength(5);
          for (const c of report) {
            expect(c.right, `${label} card "${c.title}" right edge ${c.right} > parent ${c.parentRight}`).toBeLessThanOrEqual(c.parentRight + 0.5);
            expect(c.spill, `${label} card "${c.title}" has content past its right edge`).toEqual([]);
          }
          // 长邮箱在结构词别名卡的纵向滚动列表里（overflow-y:auto 会让横轴也变成可滚动，上面的检查豁免了它）：
          // 单独断言长内容折行后完整落在列表可视宽度内、列表不需要横滑
          for (const text of [LONG_EMAIL, LONG_HOST]) {
            const box = await section.getByText(text).evaluate((el) => {
              let clip: Element | null = el.parentElement;
              while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement;
              const outer = (clip ?? el.closest('section')!).getBoundingClientRect();
              const r = el.getBoundingClientRect();
              return { right: r.right, outerRight: outer.right, scrolls: clip ? clip.scrollWidth > clip.clientWidth + 1 : false };
            });
            expect(box.right, `${label} "${text.slice(0, 20)}…" right ${box.right} > ${box.outerRight}`).toBeLessThanOrEqual(box.outerRight + 0.5);
            expect(box.scrolls, `${label} "${text.slice(0, 20)}…" makes its list scroll sideways`).toBe(false);
          }
          await page.context().close();
        });

        test(`/admin/revalidation toolchain id wraps inside its section — ${label}`, async ({ browser }) => {
          const page = await newMobilePage(browser, width, theme);
          const preview = await api('GET', '/api/admin/revalidation/preview?scope=all');
          const toolchainId = String(preview.json.toolchainId ?? '');
          expect(toolchainId, 'preview 未返回工具链标识').toContain(';');
          await page.goto(`/${locale}/admin/revalidation`);
          const code = page.locator('code', { hasText: toolchainId.split(';')[0] });
          await expect(code).toBeVisible({ timeout: 20_000 });
          // 完整值仍在（<wbr> 不产生字符），可选中复制
          expect(await code.textContent()).toBe(toolchainId);
          await expectNoHorizontalOverflow(page, label);
          const fits = await code.evaluate((el) => {
            const box = el.closest('section')!.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            return { right: r.right, sectionRight: box.right, lines: el.getClientRects().length };
          });
          expect(fits.right, `${label} toolchain id right ${fits.right} > section ${fits.sectionRight}`).toBeLessThanOrEqual(fits.sectionRight);
          expect(fits.lines, `${label} toolchain id should wrap onto several lines`).toBeGreaterThan(1);
          await page.context().close();
        });
      }
    }
  }
});
