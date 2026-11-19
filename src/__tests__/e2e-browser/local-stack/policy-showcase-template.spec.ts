/**
 * #791 结构化编写展示模板《静夜思》端到端：从模板选择器应用、经正常保存路径存成真实策略。
 *
 *   1. 无授权的 Pro 用户 N 打开新建页「模板」标签：展示模板显示为锁定（说明 + 文档链接），原有普通模板照常可点。
 *   2. 管理员打开 `capability.structured_authoring.enabled` 并授予 Pro 用户 A。A 在新建页（已预填入门模板）选展示模板：
 *      确认框说明别名与排版也会被替换；应用后编辑器是 zh-CN 源码，并排视图的 display 读作原诗；保存。
 *      落库：版本源码 = 模板源码，aliasSet = {"PLUS":["接 着"]}，带一行排版且与模板排版逐字一致；策略经 aster-api 真编译并执行，
 *      输出后两句。版本详情的 display 标签读作原诗。
 *
 * 用例自建用户（psql 写 User + 伪造 Auth.js 会话 cookie），能力经平台管理接口开关与授予；结束时关闭开关并尽力清理。
 * 浏览器里任何指向 *.aster-lang.dev 的请求都被拦下并使用例失败（#824）。
 *
 * 运行（cloud 生产构建，NEXT_PUBLIC_* 与 aster-api 地址都指向本地或死端口）：
 *   E2E_PG_CONTAINER=poem-pg NEXTAUTH_SECRET=… BASE_CLOUD=http://localhost:3791 \
 *     pnpm exec playwright test src/__tests__/e2e-browser/local-stack/policy-showcase-template.spec.ts --project=chromium-desktop --workers=1
 * 截图写到 E2E_SCREENSHOT_DIR（缺省 test-results/policy-showcase-template）。
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SESSION_COOKIE_NAME, sessionCookie } from '../../../../scripts/lib/session-cookie';
import { jingyesiShowcaseExample as TEMPLATE } from '@/data/policy-example-showcase';
import { BASE_CLOUD, NOT_LOCAL, NOT_LOCAL_REASON, psql } from './helpers';

const SECRET = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
const SHOTS = process.env.E2E_SCREENSHOT_DIR || join(process.cwd(), 'test-results/policy-showcase-template');
const SWITCH = 'capability.structured_authoring.enabled';
const CAP = 'structured_authoring';
const SOURCE = TEMPLATE.sources['zh-CN'];
const POEM = ['床前明月光，', '疑是地上霜。', '举头望明月，', '低头思故乡。'];

const suffix = randomUUID().slice(0, 8);
const id = (role: string) => `e2e-st-${role}-${suffix}`;
const USERS = {
  admin: { id: id('admin'), plan: 'pro', isAdmin: true },
  a: { id: id('a'), plan: 'pro', isAdmin: false },
  n: { id: id('n'), plan: 'pro', isAdmin: false },
} as const;
type UserKey = keyof typeof USERS;

const COPY = {
  templates: 'Templates',
  layout: 'Layout',
  showcaseName: 'Quiet Night Thoughts (Chinese showcase)',
  locked: 'Locked',
  needsCapability: 'Needs structured authoring. An administrator grants it per user.',
  replaceExtras: 'The editor content, keyword aliases and display layout will be replaced with the template’s. This cannot be undone.',
  replace: 'Replace',
  create: 'Create Policy',
  tabDisplay: 'Display layout (not executed)',
};

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const cookies: Partial<Record<UserKey, string>> = {};
const blocked: string[] = [];
let policyId = '';

async function api(user: UserKey, method: string, path: string, data?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE_CLOUD}${path}`, {
    method,
    headers: {
      Cookie: `${SESSION_COOKIE_NAME}=${cookies[user]}`,
      Origin: BASE_CLOUD,
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function expectOk(p: Promise<{ status: number; json: Record<string, unknown> }>, label: string) {
  const r = await p;
  expect(r.status, `${label}: ${JSON.stringify(r.json)}`).toBeLessThan(300);
  return r.json;
}

async function pageAs(browser: Browser, user: UserKey): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.route(/^[a-z]+:\/\/([^/]*\.)?aster-lang\.dev(\/|$|:)/, (route) => {
    blocked.push(route.request().url());
    return route.abort();
  });
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: cookies[user]!, url: BASE_CLOUD, httpOnly: true, sameSite: 'Lax' }]);
  return context.newPage();
}

const railButton = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

async function waitForMonaco(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { monaco?: { editor: { getEditors(): Array<{ getDomNode(): Node | null }> } } }).monaco?.editor.getEditors().some((e) => document.contains(e.getDomNode()))));
}

async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const m = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
    return m.editor.getEditors().filter((e) => document.contains(e.getDomNode())).pop()!.getModel()!.getValue();
  });
}

async function openTemplates(page: Page) {
  await railButton(page, COPY.templates).click();
  await expect(page.getByText('Picking a template clears the editor and replaces its content.')).toBeVisible({ timeout: 30_000 });
}

test.describe('showcase template end to end (#791)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
  test.skip(!SECRET, '需要与被测 cloud 进程相同的 NEXTAUTH_SECRET');

  test.beforeAll(async () => {
    const values = Object.entries(USERS)
      .map(
        ([key, u]) =>
          `(${lit(u.id)}, ${lit(`ST ${key}`)}, ${lit(`${u.id}@e2e.test`)}, ${lit(`${u.id}@e2e.test`)}, now(), ${lit(u.plan)}, ${u.isAdmin}, now(), now(), now(), now())`,
      )
      .join(',\n');
    psql(
      'aster_cloud',
      `insert into "User" (id, name, email, "emailNormalized", "emailVerified", plan, "isAdmin", "onboardingCompletedAt",
         "priceLockedAt", "createdAt", "updatedAt") values ${values}`,
    );
    for (const [key, u] of Object.entries(USERS)) {
      cookies[key as UserKey] = await sessionCookie({ id: u.id, email: `${u.id}@e2e.test`, plan: u.plan }, SECRET!);
    }
  });

  test.afterAll(async () => {
    if (cookies.admin) await api('admin', 'POST', '/api/admin/platform-settings', { key: SWITCH, value: false }).catch(() => undefined);
    const ids = Object.values(USERS).map((u) => lit(u.id)).join(', ');
    for (const sql of [
      `delete from "CapabilityGrant" where "userId" in (${ids})`,
      `update "Policy" set "deletedAt" = now() where "userId" in (${ids})`,
    ]) {
      try {
        psql('aster_cloud', sql);
      } catch {
        // 尽力清理：外键挡住时保留，不影响用例结论
      }
    }
  });

  test.afterEach(() => {
    expect(blocked, '浏览器不得请求 *.aster-lang.dev').toEqual([]);
  });

  test('1. without structured authoring the showcase is locked; content-only templates are unchanged', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, 'n');
    await page.goto('/en/policies/new');
    await waitForMonaco(page);
    await expect(railButton(page, COPY.layout)).toHaveCount(0);
    await openTemplates(page);

    const locked = page.getByTestId(`template-locked-${TEMPLATE.id}`);
    await expect(locked).toBeVisible();
    await expect(locked).toContainText(COPY.locked);
    await expect(locked).toContainText(COPY.needsCapability);
    // localePrefix 为 as-needed：默认语言 en 的链接不带前缀
    for (const [name, slug] of [
      ['Structured authoring access', 'structured-authoring-admin'],
      ['Display layouts', 'display-layouts'],
    ]) {
      const link = locked.getByRole('link', { name });
      await expect(link).toHaveAttribute('href', new RegExp(`^(/en)?/docs/guides/${slug}$`));
      expect((await page.request.get((await link.getAttribute('href'))!)).status(), slug).toBe(200);
    }
    await expect(locked.getByRole('button')).toHaveCount(0);
    for (const name of ['Basic starter', 'Loan Evaluation']) {
      await expect(page.getByRole('button', { name: new RegExp(name) }).first()).toBeEnabled();
    }
    await locked.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, '1-picker-locked-without-capability.png') });
    await page.context().close();
  });

  test('2. with structured authoring: apply the showcase, see the poem side by side, save as a real policy', async ({ browser }) => {
    test.setTimeout(300_000);
    await expectOk(api('admin', 'POST', '/api/admin/platform-settings', { key: SWITCH, value: true }), 'enable switch');
    await expectOk(api('admin', 'POST', `/api/admin/capabilities/${CAP}/grants`, { subjectType: 'user', subjectId: USERS.a.id }), 'grant A');

    const page = await pageAs(browser, 'a');
    await page.goto('/en/policies/new');
    await expect(railButton(page, COPY.layout)).toBeVisible({ timeout: 30_000 });
    await waitForMonaco(page);
    await openTemplates(page);
    const showcase = page.getByRole('button', { name: new RegExp(COPY.showcaseName.replace(/[()]/g, '\\$&')) });
    await expect(showcase).toContainText('Also sets keyword aliases and a display layout.');
    await showcase.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, '2-picker-with-capability.png') });

    // 新建页预填了入门模板：照常确认，且文案说明别名与排版也会替换
    await showcase.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(COPY.replaceExtras, { timeout: 10_000 });
    await dialog.getByRole('button', { name: COPY.replace, exact: true }).click();
    await expect.poll(() => editorValue(page), { timeout: 30_000 }).toBe(SOURCE);

    const pane = page.getByTestId('layout-display-pane');
    await expect(pane).toBeVisible({ timeout: 30_000 });
    const display = await pane.locator('[data-layout-display]').innerText();
    expect(display.split('\n').slice(0, 4)).toEqual(POEM);
    await page.screenshot({ path: join(SHOTS, '3-applied-side-by-side.png') });

    await railButton(page, COPY.layout).click();
    await expect(page.getByTestId('structured-authoring-layout').getByText('The layout is valid.')).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: join(SHOTS, '4-applied-layout-tab.png') });

    await page.getByRole('button', { name: COPY.create }).click();
    await page.waitForURL(/\/en\/policies\/(?!new)[^/?]+$/, { timeout: 60_000 });
    policyId = new URL(page.url()).pathname.split('/').pop()!;
    expect(policyId).toBeTruthy();

    // 落库：源码、冻结别名、排版行
    const version = (col: string) =>
      psql('aster_cloud', `select ${col} from "PolicyVersion" where "policyId" = ${lit(policyId)} and version = 1`);
    expect(version('content')).toBe(SOURCE.trim());
    expect(JSON.parse(version('"aliasSet"'))).toEqual({ PLUS: ['接 着'] });
    const stored = psql(
      'aster_cloud',
      `select l.layout from "PolicyVersionLayout" l join "PolicyVersion" v on v.id = l."policyVersionId"
       where v."policyId" = ${lit(policyId)} and v.version = 1`,
    );
    // 存储形态合并相邻内容 span；模板排版没有相邻内容 span，故与模板逐项相同
    expect(JSON.parse(stored)).toEqual(TEMPLATE.layout);

    // 经 aster-api 真编译（zh-CN + 冻结别名）并执行：输出后两句
    const run = await api('a', 'POST', `/api/policies/${policyId}/execute`, { input: TEMPLATE.defaultInputs['zh-CN'] });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    // 文本输出不是允许/拒绝裁决，decision 为 indeterminate；这里核对的是规则真实求值的结果
    expect(run.json.executedFunction).toBe('吟');
    expect((run.json.output as { result?: unknown }).result).toBe('举头望明月，低头思故乡。');

    // 版本详情：display 标签读作原诗
    await page.goto(`/en/policies/${policyId}`);
    const tabs = page.getByRole('tablist', { name: 'Source view' }).first();
    await expect(tabs).toBeVisible({ timeout: 30_000 });
    await tabs.getByRole('tab', { name: COPY.tabDisplay }).click();
    const saved = page.locator('[data-layout-display]').first();
    await expect(saved).toBeVisible();
    expect((await saved.innerText()).split('\n').slice(0, 4)).toEqual(POEM);
    await saved.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, '5-saved-version-display.png') });
    await page.context().close();
  });
});
