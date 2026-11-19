/**
 * 策略显示排版端到端（ADR 0058 阶段 2，计划 Task 12，对应 #794 验收）。
 *
 *   1. 管理员打开 `capability.structured_authoring.enabled`、给 Pro 用户 A 直接授权；A 在团队 T 新建 zh-CN 小策略，
 *      在「排版」标签开始排版，把两词之间的空格标为结构、display 置空，打开并排视图：display 窗格出现插入标记，
 *      Monaco 里移动光标时 display 对应位置高亮；保存成功且版本带排版行。
 *   2. 同一策略「导入 JSON」一个把标识符盖进结构 span 的排版 → 保存被拒，显示 layout_structural_hides_value 的文案；
 *      再导入 canonical 与源码不一致的排版 → 显示 layout_roundtrip_mismatch 的文案；两次都不建版本。
 *   3. A 只改排版保存 → 新版本（裁决 R4）；A 提交 v1 审批。T 的 owner B 在版本列表打开待审批的 v1：source 区第一个标签是
 *      canonical 且默认选中，display 是次级标签并写明「不参与执行」；B 批准；版本对比显示「显示排版已变更」。
 *   4. 用户 D（无授权、无编辑权：团队 T 的 viewer）打开策略详情：能看到 display 次级标签（只读不设门）。
 *   5. T 的成员 C（无授权）打开编辑器：没有「排版」入口；改 content 保存时出现丢弃确认 → 确认 → 成功并出现警告 toast；
 *      新版本详情没有 display 标签，上一版本仍有。
 *   6. C 编辑一条从未附排版的策略：没有「排版」入口、保存无丢弃确认、版本详情无 display 标签（与改前一致）。
 *
 * 与计划的出入：cloud 没有「把个人策略移入团队」的路径，A 直接在团队 T 下新建（第 1 步）；策略详情页只对所有者与团队成员
 * 开放（`isPublic` 不给非成员读权限），所以第 4 步的「无授权、无编辑权」读者是团队 viewer D；第 4 步排在 C 保存之前，
 * 因为 C 的保存让活跃版本不再带排版。
 *
 * 用例自建全部用户与团队（psql 写 User / Team / TeamMember + 伪造 Auth.js 会话 cookie），能力经平台管理接口开关与授予；
 * 结束时关闭开关并尽力删除自建数据。浏览器里任何指向 *.aster-lang.dev 的请求都被拦下并使用例失败（#824）。
 *
 * 运行（cloud 生产构建，NEXT_PUBLIC_* 与 aster-api 地址都指向本地或死端口）：
 *   E2E_PG_CONTAINER=c10-pg NEXTAUTH_SECRET=… BASE_CLOUD=http://localhost:3810 \
 *     pnpm exec playwright test src/__tests__/e2e-browser/local-stack/policy-layout.spec.ts --project=chromium-desktop --workers=1
 * 截图写到 E2E_SCREENSHOT_DIR（缺省 test-results/policy-layout）。
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SESSION_COOKIE_NAME, sessionCookie } from '../../../../scripts/lib/session-cookie';
import { BASE_CLOUD, NOT_LOCAL, NOT_LOCAL_REASON, psql } from './helpers';

const SECRET = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
const SHOTS = process.env.E2E_SCREENSHOT_DIR || join(process.cwd(), 'test-results/policy-layout');
const SWITCH = 'capability.structured_authoring.enabled';
const CAP = 'structured_authoring';

const suffix = randomUUID().slice(0, 8);
const id = (role: string) => `e2e-pl-${role}-${suffix}`;
const USERS = {
  admin: { id: id('admin'), plan: 'pro', isAdmin: true },
  a: { id: id('a'), plan: 'pro', isAdmin: false },
  b: { id: id('b'), plan: 'team', isAdmin: false },
  c: { id: id('c'), plan: 'pro', isAdmin: false },
  d: { id: id('d'), plan: 'pro', isAdmin: false },
} as const;
type UserKey = keyof typeof USERS;
const TEAM_ID = id('team');

// 《静夜思》式小策略（zh-CN）：第 1 行「模块」与「静夜思」之间的空格将被标为结构、display 置空
const SOURCE = '模块 静夜思。\n\n规则 吟诵 给定 月光 作为 文本，产出 文本：\n  返回 月光。\n';
const SPACE_AT = SOURCE.indexOf(' ');
const NAME_AT = SOURCE.indexOf('吟诵');
// 把标识符「吟诵」盖进结构 span（藏值）
const HIDES_VALUE = {
  v: 1,
  spans: [{ text: SOURCE.slice(0, NAME_AT) }, { canonical: '吟诵', display: '吟' }, { text: SOURCE.slice(NAME_AT + 2) }],
};
// canonical 与源码不一致（往返不符）
const ROUNDTRIP = { v: 1, spans: [{ text: SOURCE.replace('返回 月光。', '返回 星光。') }] };

const COPY = {
  layout: 'Layout',
  start: 'Start layout',
  importJson: 'Import JSON',
  importApply: 'Import',
  remove: 'Remove layout',
  markSelection: 'Mark selection as structural',
  sideBySide: 'Side-by-side view',
  hidesValue: 'A structural span covers a value such as a name, number or text. Only keywords and spacing can be structural.',
  roundtrip: 'The display layout does not reproduce the canonical source exactly.',
  tabCanonical: 'Canonical source (executed)',
  tabDisplay: 'Display layout (not executed)',
  compareChanged: 'Display layout changed',
  dropTitle: 'This version will no longer have a display layout',
  dropConfirm: 'Save without layout',
  dropped: 'Saved. The new version has no display layout. Earlier versions keep theirs.',
};

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const cookies: Partial<Record<UserKey, string>> = {};
/** 浏览器里被拦下的 *.aster-lang.dev 请求（#824：本地栈用例不得打到线上）。 */
const blocked: string[] = [];
let policyId = '';
let plainPolicyId = '';

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

/** 状态栏的行数（来自表单状态，不是 Monaco 模型）。 */
const statusLines = (page: Page, n: number) => page.getByText(new RegExp(`\\b${n} lines\\b`)).first();

/** 以编辑（executeEdits）整体替换主编辑器内容：与用户输入同一路径进入表单状态。 */
async function editSource(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const m = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
    const ed = m.editor.getEditors().filter((e) => document.contains(e.getDomNode())).pop()!;
    ed.executeEdits('e2e', [{ range: ed.getModel()!.getFullModelRange(), text: t }]);
  }, text);
}

/**
 * 编辑器挂载后表单的 onChange 订阅要稍后才接上，过早的编辑只改了 Monaco 模型、没进表单状态。
 * 先写入多一行的探针文本，直到状态栏的行数跟上（证明订阅已接上），再写入目标文本并同样确认。
 */
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

async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const m = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
    // 页面上仍挂在 DOM 里的最后一个编辑器即策略编辑器（getEditors 可能含已卸载的实例）
    return m.editor.getEditors().filter((e) => document.contains(e.getDomNode())).pop()!.getModel()!.getValue();
  });
}

/** 设主编辑器选区（1 起始行列）；起止相同即只放光标。 */
async function select(page: Page, line: number, startColumn: number, endColumn = startColumn): Promise<void> {
  await page.evaluate(
    ([l, s, e]) => {
      const m = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
      const ed = m.editor.getEditors().filter((e) => document.contains(e.getDomNode())).pop()!;
      ed.focus();
      ed.setSelection({ startLineNumber: l, startColumn: s, endLineNumber: l, endColumn: e });
    },
    [line, startColumn, endColumn] as const,
  );
}

const layoutRows = (policy: string, version: number) =>
  Number(
    psql(
      'aster_cloud',
      `select count(*) from "PolicyVersionLayout" l join "PolicyVersion" v on v.id = l."policyVersionId"
       where v."policyId" = ${lit(policy)} and v.version = ${version}`,
    ),
  );
const versionCount = (policy: string) => Number(psql('aster_cloud', `select count(*) from "PolicyVersion" where "policyId" = ${lit(policy)}`));
const layoutSha = (policy: string, version: number) =>
  psql(
    'aster_cloud',
    `select l."layoutSha256" from "PolicyVersionLayout" l join "PolicyVersion" v on v.id = l."policyVersionId"
     where v."policyId" = ${lit(policy)} and v.version = ${version}`,
  );

/** 策略详情页「版本」面板（审批者打开版本详情、批准、对比的地方，裁决 R15）里某个版本的卡片。 */
const versionCard = (page: Page, version: number) =>
  page.locator('div.rounded-lg.shadow-sm.border.p-4').filter({ has: page.getByText(`v${version}`, { exact: true }) }).first();

async function openVersionSource(page: Page, policy: string, version: number): Promise<void> {
  await page.goto(`/en/policies/${policy}`);
  await versionCard(page, version).getByRole('button', { name: 'View source' }).click({ timeout: 30_000 });
}

/** 版本详情面板里的源码标签组（详情页源码卡片也可能有一组，面板在其后）。 */
const versionSourceTabs = (page: Page) => page.getByRole('tablist', { name: 'Source view' }).last();

test.describe('policy display layout end to end (ADR 0058 phase 2)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
  test.skip(!SECRET, '需要与被测 cloud 进程相同的 NEXTAUTH_SECRET');

  test.beforeAll(async () => {
    const values = Object.entries(USERS)
      .map(
        ([key, u]) =>
          `(${lit(u.id)}, ${lit(`PL ${key}`)}, ${lit(`${u.id}@e2e.test`)}, ${lit(`${u.id}@e2e.test`)}, now(), ${lit(u.plan)}, ${u.isAdmin}, now(), now(), now(), now())`,
      )
      .join(',\n');
    psql(
      'aster_cloud',
      `insert into "User" (id, name, email, "emailNormalized", "emailVerified", plan, "isAdmin", "onboardingCompletedAt",
         "priceLockedAt", "createdAt", "updatedAt") values ${values}`,
    );
    psql(
      'aster_cloud',
      `insert into "Team" (id, name, slug, "ownerId") values (${lit(TEAM_ID)}, 'PL Team', ${lit(TEAM_ID)}, ${lit(USERS.b.id)});
       insert into "TeamMember" (id, "teamId", "userId", role) values
         (${lit(`${TEAM_ID}-b`)}, ${lit(TEAM_ID)}, ${lit(USERS.b.id)}, 'owner'),
         (${lit(`${TEAM_ID}-a`)}, ${lit(TEAM_ID)}, ${lit(USERS.a.id)}, 'member'),
         (${lit(`${TEAM_ID}-c`)}, ${lit(TEAM_ID)}, ${lit(USERS.c.id)}, 'member'),
         (${lit(`${TEAM_ID}-d`)}, ${lit(TEAM_ID)}, ${lit(USERS.d.id)}, 'viewer')`,
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
      `delete from "TeamMember" where "teamId" = ${lit(TEAM_ID)}`,
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

  test('1. A starts a layout, marks a space structural with an empty display, sees it side by side, and saves', async ({ browser }) => {
    test.setTimeout(240_000);
    await expectOk(api('admin', 'POST', '/api/admin/platform-settings', { key: SWITCH, value: true }), 'enable switch');
    await expectOk(api('admin', 'POST', `/api/admin/capabilities/${CAP}/grants`, { subjectType: 'user', subjectId: USERS.a.id }), 'grant A');

    const page = await pageAs(browser, 'a');
    await page.goto(`/en/policies/new?teamId=${TEAM_ID}`);
    await expect(railButton(page, COPY.layout)).toBeVisible({ timeout: 30_000 });
    await waitForMonaco(page);
    await replaceSource(page, SOURCE);
    await expect.poll(() => editorValue(page)).toBe(SOURCE);
    await railButton(page, 'Details').click();
    await page.getByLabel(/^Policy Name/).first().fill(`PL e2e ${suffix}`);

    await railButton(page, COPY.layout).click();
    const tab = page.getByTestId('structured-authoring-layout');
    await tab.getByRole('button', { name: COPY.start }).click();
    // 选中第 1 行「模块」与「静夜思」之间的空格（第 3 列）标为结构，再把 display 清空
    await select(page, 1, SPACE_AT + 1, SPACE_AT + 2);
    await tab.getByRole('button', { name: COPY.markSelection }).click();
    const display = tab.getByRole('textbox', { name: 'Display text for “ ”' });
    await expect(display).toHaveValue(' ');
    await display.fill('');
    await expect(tab.getByText('The layout is valid.')).toBeVisible({ timeout: 10_000 });

    await tab.getByRole('button', { name: COPY.sideBySide }).click();
    const pane = page.getByTestId('layout-display-pane');
    await expect(pane).toBeVisible();
    await expect(pane.locator('[data-layout-insertion]')).toHaveCount(1);
    await expect(pane.locator('[data-layout-insertion]')).toHaveAttribute('title', ' ');
    expect(await pane.locator('[data-layout-display]').innerText()).toContain('模块静夜思。');
    // 窗格在 Monaco 左侧
    const paneBox = (await pane.boundingBox())!;
    const editorBox = (await page.locator('.monaco-editor').first().boundingBox())!;
    expect(paneBox.x + paneBox.width).toBeLessThanOrEqual(editorBox.x + 1);

    // Monaco 光标放在第 3 行「吟诵」之前：display 高亮该字
    await select(page, 3, 4);
    await expect(pane.locator('[data-layout-highlight]')).toHaveText('吟');
    await page.screenshot({ path: join(SHOTS, '1-a-side-by-side.png') });

    await page.getByRole('button', { name: 'Create Policy' }).click();
    await page.waitForURL(/\/en\/policies\/(?!new)[^/?]+$/, { timeout: 30_000 });
    policyId = new URL(page.url()).pathname.split('/').pop()!;
    expect(policyId).toBeTruthy();
    expect(layoutRows(policyId, 1)).toBe(1);
    await page.context().close();
  });

  test('2. importing a layout that hides a value, then one that changes the canonical, is rejected with a clear error', async ({ browser }) => {
    test.setTimeout(180_000);
    expect(policyId, 'scenario 1 saved a policy').toBeTruthy();
    const page = await pageAs(browser, 'a');
    await page.goto(`/en/policies/${policyId}/edit`);
    await expect(railButton(page, COPY.layout)).toBeVisible({ timeout: 30_000 });
    await waitForMonaco(page);
    await railButton(page, COPY.layout).click();
    const tab = page.getByTestId('structured-authoring-layout');
    // 已存排版被加载（复验通过）：结构片段行存在
    await expect(tab.locator('[data-layout-structural-row]')).toHaveCount(1);

    // 表单顶部的保存错误横幅（排版标签页自己的实时校验提示不算：这里要证明的是服务端拒绝）
    const banner = page.locator('[data-policy-form-root] > div > [role="alert"]');
    for (const [layout, copy] of [
      [HIDES_VALUE, COPY.hidesValue],
      [ROUNDTRIP, COPY.roundtrip],
    ] as const) {
      await tab.getByRole('button', { name: COPY.remove }).click();
      await tab.getByRole('button', { name: COPY.importJson }).click();
      await tab.getByLabel('Layout JSON').fill(JSON.stringify(layout));
      await tab.getByRole('button', { name: COPY.importApply, exact: true }).click();
      await page.getByRole('button', { name: 'Save Changes' }).click();
      await expect(banner).toContainText(copy, { timeout: 30_000 });
      await expect(page.getByText('Failed to save').first()).toBeVisible();
      await page.screenshot({ path: join(SHOTS, `2-a-rejected-${layout === HIDES_VALUE ? 'hides-value' : 'roundtrip'}.png`) });
      // 保存失败后仍在编辑页，排版标签页被打开
      expect(new URL(page.url()).pathname).toBe(`/en/policies/${policyId}/edit`);
      await expect(tab).toBeVisible();
    }
    expect(versionCount(policyId)).toBe(1);
    await page.context().close();
  });

  test('3. a layout-only change makes a new version; the approver reads canonical first, approves, and the compare flags the layout change', async ({ browser }) => {
    test.setTimeout(240_000);
    const a = await pageAs(browser, 'a');
    await a.goto(`/en/policies/${policyId}/edit`);
    await expect(railButton(a, COPY.layout)).toBeVisible({ timeout: 30_000 });
    await waitForMonaco(a);
    await railButton(a, COPY.layout).click();
    const tab = a.getByTestId('structured-authoring-layout');
    await tab.getByRole('textbox', { name: 'Display text for “ ”' }).fill('·');
    await expect(tab.getByText('The layout is valid.')).toBeVisible({ timeout: 10_000 });
    await a.getByRole('button', { name: 'Save Changes' }).click();
    await a.waitForURL(new RegExp(`/en/policies/${policyId}$`), { timeout: 30_000 });
    expect(versionCount(policyId)).toBe(2);
    expect(layoutRows(policyId, 2)).toBe(1);
    expect(layoutSha(policyId, 2)).not.toBe(layoutSha(policyId, 1));
    await a.context().close();

    await expectOk(api('a', 'POST', `/api/v1/policies/${policyId}/versions/1/submit`, {}), 'submit v1');

    const b = await pageAs(browser, 'b');
    await openVersionSource(b, policyId, 1);
    await expect(b.getByRole('tablist', { name: 'Source view' })).toHaveCount(2, { timeout: 30_000 });
    const tabs = versionSourceTabs(b);
    const canonicalTab = tabs.getByRole('tab').first();
    await expect(canonicalTab).toHaveText(COPY.tabCanonical);
    await expect(canonicalTab).toHaveAttribute('aria-selected', 'true');
    await expect(b.getByText('规则 吟诵 给定 月光 作为 文本，产出 文本：').last()).toBeVisible();
    await expect(b.locator('[data-layout-display]')).toHaveCount(0);
    const displayTab = tabs.getByRole('tab', { name: COPY.tabDisplay });
    await expect(displayTab).toHaveAttribute('aria-selected', 'false');
    await b.screenshot({ path: join(SHOTS, '3-b-approver-canonical-first.png') });
    await displayTab.click();
    await expect(b.locator('[data-layout-display] [data-layout-insertion]')).toHaveCount(1);
    await b.screenshot({ path: join(SHOTS, '3-b-approver-display-tab.png') });

    await b.goto(`/en/policies/${policyId}`);
    await versionCard(b, 1).getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 30_000 });
    await b.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => psql('aster_cloud', `select status from "PolicyVersion" where "policyId" = ${lit(policyId)} and version = 1`), {
      timeout: 30_000,
    }).toBe('APPROVED');

    await b.reload();
    await b.getByRole('button', { name: 'Compare versions' }).click({ timeout: 30_000 });
    const changed = b.getByTestId('layout-compare-changed');
    await expect(changed).toBeVisible({ timeout: 30_000 });
    await expect(changed).toContainText(COPY.compareChanged);
    await b.screenshot({ path: join(SHOTS, '3-b-compare-layout-changed.png') });
    await b.context().close();
  });

  test('4. a reader without the capability or edit rights (team viewer) sees the display tab', async ({ browser }) => {
    test.setTimeout(120_000);
    const d = await pageAs(browser, 'd');
    // viewer 不能进编辑页
    expect((await api('d', 'PUT', `/api/policies/${policyId}`, { name: 'x' })).status).toBeGreaterThanOrEqual(400);
    await d.goto(`/en/policies/${policyId}`);
    const tabs = d.getByRole('tablist', { name: 'Source view' });
    await expect(tabs).toBeVisible({ timeout: 30_000 });
    await expect(tabs.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
    await tabs.getByRole('tab', { name: COPY.tabDisplay }).click();
    await expect(d.locator('[data-layout-display]')).toContainText('模块·静夜思。');
    await d.screenshot({ path: join(SHOTS, '4-d-public-reader-display.png') });
    await d.context().close();
  });

  test('5. teammate C without the capability has no layout entry; changing content asks before dropping the layout', async ({ browser }) => {
    test.setTimeout(240_000);
    const c = await pageAs(browser, 'c');
    await c.goto(`/en/policies/${policyId}/edit`);
    await expect(railButton(c, 'AI')).toBeVisible({ timeout: 30_000 });
    await expect(railButton(c, COPY.layout)).toHaveCount(0);
    await waitForMonaco(c);
    await expect.poll(() => editorValue(c)).toBe(SOURCE);
    await replaceSource(c, SOURCE.replace('返回 月光。', '返回 「静夜」。'));

    await c.getByRole('button', { name: 'Save Changes' }).click();
    const dialog = c.getByRole('dialog');
    await expect(dialog).toContainText(COPY.dropTitle, { timeout: 10_000 });
    await c.screenshot({ path: join(SHOTS, '5-c-drop-confirm.png') });
    await dialog.getByRole('button', { name: COPY.dropConfirm }).click();
    await c.waitForURL(new RegExp(`/en/policies/${policyId}$`), { timeout: 30_000 });
    await expect(c.getByText(COPY.dropped)).toBeVisible({ timeout: 10_000 });
    await c.screenshot({ path: join(SHOTS, '5-c-dropped-toast.png') });
    expect(versionCount(policyId)).toBe(3);
    expect(layoutRows(policyId, 3)).toBe(0);

    await openVersionSource(c, policyId, 3);
    await expect(c.getByText('返回 「静夜」。').last()).toBeVisible({ timeout: 30_000 });
    // 活跃版本（v3）没有排版：源码卡片与版本详情都没有 display 标签
    await expect(c.getByRole('tab', { name: COPY.tabDisplay })).toHaveCount(0);
    await openVersionSource(c, policyId, 2);
    await expect(c.getByRole('tab', { name: COPY.tabDisplay })).toHaveCount(1, { timeout: 30_000 });
    await c.context().close();
  });

  test('6. C edits a policy that never had a layout: no entry, no confirmation, no display tab', async ({ browser }) => {
    test.setTimeout(180_000);
    const created = await expectOk(
      api('c', 'POST', '/api/policies', { name: `PL plain ${suffix}`, content: SOURCE, teamId: TEAM_ID, locale: 'zh-CN' }),
      'create plain policy',
    );
    plainPolicyId = String(created.id);
    expect(layoutRows(plainPolicyId, 1)).toBe(0);

    const c = await pageAs(browser, 'c');
    await c.goto(`/en/policies/${plainPolicyId}/edit`);
    await expect(railButton(c, 'AI')).toBeVisible({ timeout: 30_000 });
    await expect(railButton(c, COPY.layout)).toHaveCount(0);
    await waitForMonaco(c);
    await expect.poll(() => editorValue(c)).toBe(SOURCE);
    await replaceSource(c, SOURCE.replace('返回 月光。', '返回 「静夜」。'));
    await c.getByRole('button', { name: 'Save Changes' }).click();
    await c.waitForURL(new RegExp(`/en/policies/${plainPolicyId}$`), { timeout: 30_000 });
    await expect(c.getByRole('dialog')).toHaveCount(0);
    await expect(c.getByText(COPY.dropped)).toHaveCount(0);
    expect(versionCount(plainPolicyId)).toBe(2);

    await openVersionSource(c, plainPolicyId, 2);
    await expect(c.getByText('返回 「静夜」。').last()).toBeVisible({ timeout: 30_000 });
    await expect(c.getByRole('tablist', { name: 'Source view' })).toHaveCount(0);
    await c.screenshot({ path: join(SHOTS, '6-c-plain-policy-version.png') });
    await c.context().close();
  });
});
