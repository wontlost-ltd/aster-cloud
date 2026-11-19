/**
 * 策略内嵌词汇端到端（ADR 0060 §7.5，计划 Task 11 Step 4）。
 *
 *   1. 管理员打开 `capability.structured_authoring.enabled` 并授予 Pro 用户 A；A 新建 zh-CN《静夜思》式小策略
 *      （`返回 思故乡。`、`产出 望明月`），没有任何个人词汇。在「词汇」标签的「本策略」分组加字面量 `思故乡 → 静夜思`
 *      与类型 `望明月 → Text`；打开词汇规范预览：预览把触发词换成 `「静夜思」`、把 `望明月` 换成 `Text`。保存。
 *   2. 版本 v1 的 `embeddedVocabulary` 列是 ADR §8 的规范序列化；经 `/api/policies/<id>/execute` 让 aster-api 真编译
 *      执行，输出 `静夜思`。
 *   3. 策略详情的版本面板（审批视图）在源码下方列出「策略自带词汇」映射表，字面量行带「Expands to text」。
 *   4. 编辑页预填这两条词条；只改源码保存（请求省略字段，PUT 沿用活跃版本），新版本带同一内嵌词汇文本。
 *
 * 与计划的出入：计划 Step 4 还写了「运算符别名」；别名规则 v2（单词汉字别名）在 T12，v1 别名必须是多词短语，
 * 与诗的写法无关，所以这里只覆盖内嵌词汇本身。
 *
 * 用例自建用户（psql 写 User + 伪造 Auth.js 会话 cookie），能力经平台管理接口开关与授予；结束时关闭开关并尽力清理。
 * 浏览器里任何指向 *.aster-lang.dev 的请求都被拦下并使用例失败（#824）。
 *
 * 运行（cloud 生产构建，NEXT_PUBLIC_LSP_HOST 指向本地网关 `PORT=<端口> ALLOWED_ORIGINS=<BASE_CLOUD> node lsp-server.mjs`）：
 *   E2E_PG_CONTAINER=t11-pg NEXTAUTH_SECRET=… BASE_CLOUD=http://localhost:3612 \
 *     pnpm exec playwright test src/__tests__/e2e-browser/local-stack/embedded-vocabulary.spec.ts --project=chromium-desktop --workers=1
 * 截图写到 E2E_SCREENSHOT_DIR（缺省 test-results/embedded-vocabulary）。
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SESSION_COOKIE_NAME, sessionCookie } from '../../../../scripts/lib/session-cookie';
import { BASE_CLOUD, NOT_LOCAL, NOT_LOCAL_REASON, psql } from './helpers';

const SECRET = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
const SHOTS = process.env.E2E_SCREENSHOT_DIR || join(process.cwd(), 'test-results/embedded-vocabulary');
const SWITCH = 'capability.structured_authoring.enabled';
const CAP = 'structured_authoring';

const suffix = randomUUID().slice(0, 8);
const id = (role: string) => `e2e-ev-${role}-${suffix}`;
const USERS = {
  admin: { id: id('admin'), plan: 'pro', isAdmin: true },
  a: { id: id('a'), plan: 'pro', isAdmin: false },
} as const;
type UserKey = keyof typeof USERS;

const SOURCE = '模块 明月光。\n规则 地上霜，产出 望明月：\n  返回 思故乡。';
// ADR 0060 §8 的规范序列化（字面量排在结构体之前：按 kind 的码点序）
const STORED = '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},{"kind":"struct","localized":"望明月","canonical":"Text"}]}';

const COPY = {
  vocabulary: 'Vocabulary',
  details: 'Details',
  kind: 'Kind',
  written: 'Written form',
  text: 'Text',
  canonical: 'Canonical name',
  add: 'Add term',
  kindType: 'Type',
  showPreview: 'Show canonical preview',
  create: 'Create Policy',
  mapTitle: 'Policy vocabulary (compiled with this version)',
  expandsTo: 'Expands to text',
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

const statusLines = (page: Page, n: number) => page.getByText(new RegExp(`\\b${n} lines\\b`)).first();

/** 主编辑器（非预览）。 */
async function editSource(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const m = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
    const ed = m.editor.getEditors().filter((e) => document.contains(e.getDomNode()) && !e.getModel()?.uri.toString().includes('aster-canonical-preview')).pop()!;
    ed.executeEdits('e2e', [{ range: ed.getModel()!.getFullModelRange(), text: t }]);
  }, text);
}

/** 编辑器挂载后表单订阅稍后才接上：先写多一行的探针直到状态栏行数跟上，再写入目标文本。 */
async function replaceSource(page: Page, text: string): Promise<void> {
  const lines = (t: string) => t.split('\n').length;
  const probe = `${text}\n`;
  await expect(async () => {
    await editSource(page, probe);
    await expect(statusLines(page, lines(probe))).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await editSource(page, text);
  await expect(statusLines(page, lines(text))).toBeVisible();
}

async function previewText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const m = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
    const ed = m.editor.getEditors().find((e) => e.getModel()?.uri.toString().includes('aster-canonical-preview'));
    return ed?.getModel()?.getValue() ?? '';
  });
}

const storedEmbedded = (policy: string, version: number) =>
  psql('aster_cloud', `select coalesce("embeddedVocabulary", '<null>') from "PolicyVersion" where "policyId" = ${lit(policy)} and version = ${version}`);

/** 在「本策略」分组的表单里加一条词条。 */
async function addTerm(page: Page, term: { kind?: string; written: string; value: string; valueLabel: string }): Promise<void> {
  const section = page.getByTestId('embedded-vocabulary');
  if (term.kind) await section.getByLabel(COPY.kind).selectOption({ label: term.kind });
  await section.getByLabel(COPY.written, { exact: true }).fill(term.written);
  await section.getByLabel(term.valueLabel, { exact: true }).fill(term.value);
  await section.getByRole('button', { name: COPY.add }).click();
  await expect(section.getByTestId('embedded-term').filter({ hasText: term.written })).toHaveCount(1);
}

test.describe('policy embedded vocabulary end to end (ADR 0060 T11)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
  test.skip(!SECRET, '需要与被测 cloud 进程相同的 NEXTAUTH_SECRET');

  test.beforeAll(async () => {
    const values = Object.entries(USERS)
      .map(
        ([key, u]) =>
          `(${lit(u.id)}, ${lit(`EV ${key}`)}, ${lit(`${u.id}@e2e.test`)}, ${lit(`${u.id}@e2e.test`)}, now(), ${lit(u.plan)}, ${u.isAdmin}, now(), now(), now(), now())`,
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

  test('1. A adds a literal and a type in "This policy", the canonical preview substitutes them, and A saves', async ({ browser }) => {
    test.setTimeout(240_000);
    await expectOk(api('admin', 'POST', '/api/admin/platform-settings', { key: SWITCH, value: true }), 'enable switch');
    await expectOk(api('admin', 'POST', `/api/admin/capabilities/${CAP}/grants`, { subjectType: 'user', subjectId: USERS.a.id }), 'grant A');

    const page = await pageAs(browser, 'a');
    await page.goto('/en/policies/new');
    await expect(railButton(page, COPY.vocabulary)).toBeVisible({ timeout: 30_000 });
    await waitForMonaco(page);
    await replaceSource(page, SOURCE);
    await railButton(page, COPY.details).click();
    await page.getByLabel(/^Policy Name/).first().fill(`EV e2e ${suffix}`);

    await railButton(page, COPY.vocabulary).click();
    const tab = page.getByTestId('structured-authoring-vocabulary');
    await expect(tab.getByTestId('embedded-vocabulary')).toBeVisible();
    await addTerm(page, { written: '思故乡', value: '静夜思', valueLabel: COPY.text });
    await addTerm(page, { kind: COPY.kindType, written: '望明月', value: 'Text', valueLabel: COPY.canonical });
    await expect(tab.getByTestId('embedded-term').first()).toContainText(COPY.expandsTo);
    await page.screenshot({ path: join(SHOTS, '1-this-policy-terms.png') });

    await tab.getByRole('button', { name: COPY.showPreview }).click();
    const pane = page.getByTestId('canonical-preview-pane');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => previewText(page), { timeout: 30_000 }).toContain('「静夜思」');
    expect(await previewText(page)).toBe(SOURCE.replace('望明月', 'Text').replace('思故乡', '「静夜思」'));
    await page.screenshot({ path: join(SHOTS, '2-canonical-preview.png') });

    await page.getByRole('button', { name: COPY.create }).click();
    await page.waitForURL(/\/en\/policies\/(?!new)[^/?]+$/, { timeout: 30_000 });
    policyId = new URL(page.url()).pathname.split('/').pop()!;
    expect(policyId).toBeTruthy();
    await page.context().close();
  });

  test('2. the version stores the canonical embedded vocabulary and executes to 静夜思', async () => {
    test.setTimeout(120_000);
    expect(storedEmbedded(policyId, 1)).toBe(STORED);
    const run = await api('a', 'POST', `/api/policies/${policyId}/execute`, { input: {} });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect((run.json.output as { result?: unknown }).result).toBe('静夜思');
  });

  test('3. the approval view lists the embedded vocabulary under the source', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await pageAs(browser, 'a');
    await page.goto(`/en/policies/${policyId}`);
    const card = page.locator('div.rounded-lg.shadow-sm.border.p-4').filter({ has: page.getByText('v1', { exact: true }) }).first();
    await card.getByRole('button', { name: 'View source' }).click({ timeout: 30_000 });
    const map = page.getByRole('region', { name: COPY.mapTitle });
    await expect(map).toBeVisible({ timeout: 30_000 });
    const rows = map.getByTestId('embedded-vocabulary-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('思故乡');
    await expect(rows.nth(0)).toContainText('"静夜思"');
    await expect(rows.nth(0)).toContainText(COPY.expandsTo);
    await expect(rows.nth(1)).toContainText('望明月');
    await expect(rows.nth(1)).toContainText('Text');
    await map.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, '3-version-detail-map.png') });
    await page.context().close();
  });

  test('4. the editor prefills the terms; saving a source-only change keeps them on the new version', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, 'a');
    await page.goto(`/en/policies/${policyId}/edit`);
    await waitForMonaco(page);
    await railButton(page, COPY.vocabulary).click();
    const section = page.getByTestId('embedded-vocabulary');
    await expect(section.getByTestId('embedded-term')).toHaveCount(2);
    await replaceSource(page, `${SOURCE}\n`);
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => storedEmbedded(policyId, 2), { timeout: 30_000 }).toBe(STORED);
    await page.context().close();
  });
});
