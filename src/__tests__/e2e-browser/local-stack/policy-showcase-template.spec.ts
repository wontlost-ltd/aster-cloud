/**
 * 「静夜思」特色模板端到端（ADR 0060 §8 证明 4，计划 Task 13 Step 4，cloud#830）：原诗即策略，经真实 aster-api 执行输出诗名。
 *
 *   1. 只有结构化编写能力、没有结构词别名授权的 Pro 用户 N 打开新建页「模板」标签：模板锁定，说明缺结构词别名权限
 *      （带文档链接），原有普通模板照常可点。
 *   2. 管理员打开 `capability.structured_authoring.enabled`，给 Pro 用户 A 授予结构化编写与结构词别名。A 在团队 T 的新建页
 *      （已预填入门模板）选「静夜思」：确认框说明别名、本策略词汇与排版也会被替换；应用后编辑器是原诗源码，并排视图的
 *      display 与原诗一字不差；「词汇」标签的「本策略」分组列出 思故乡 → 静夜思（字面量）与 望明月 → Text。保存。
 *      落库：源码、aliasSet、embeddedVocabulary 都是 ADR §8 的值，排版行与模板逐字一致。
 *   3. A 提交 v1；团队 owner B 在版本面板看到四条结构词别名与两条内嵌词条（字面量行有标记），批准。
 *   4. 批准后 A 新增同形个人词条 望明月 → Moon；经 `/api/policies/<id>/execute` 让 aster-api（1.0.52）真编译执行：
 *      冻结的下层词汇 + 内嵌词汇（内嵌优先），输出 `静夜思`。
 *   5. 以 v1 为目标发起批量 What-If：aster-api 回源拿到 aliasSet 与合并词汇，批次完成、无失败条目。
 *
 * 用例自建用户与团队（psql 写 User / Team / TeamMember / StructuralAliasGrant 由管理接口授予，伪造会话 cookie，
 * 需 `NEXTAUTH_SECRET` 与被测进程一致、`E2E_PG_CONTAINER` 指向栈的 Postgres）。结束时关闭开关并尽力清理。
 * 浏览器里任何指向 *.aster-lang.dev 的请求都被拦下并使用例失败（#824）。
 *
 * 运行（cloud 生产构建，NEXT_PUBLIC_* 与 aster-api 地址都指向本地或死端口）：
 *   E2E_PG_CONTAINER=t13-pg NEXTAUTH_SECRET=… BASE_CLOUD=http://localhost:3913 \
 *     pnpm exec playwright test src/__tests__/e2e-browser/local-stack/policy-showcase-template.spec.ts --project=chromium-desktop --workers=1
 * 截图写到 E2E_SCREENSHOT_DIR（缺省 test-results/policy-showcase-template）。
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SESSION_COOKIE_NAME, sessionCookie } from '../../../../scripts/lib/session-cookie';
import { JINGYESI_POEM } from '@/config/jingyesi-poem';
import { jingyesiShowcaseExample as TEMPLATE } from '@/data/policy-example-showcase';
import { BASE_CLOUD, NOT_LOCAL, NOT_LOCAL_REASON, psql } from './helpers';

const SECRET = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
const SHOTS = process.env.E2E_SCREENSHOT_DIR || join(process.cwd(), 'test-results/policy-showcase-template');
const SWITCH = 'capability.structured_authoring.enabled';
const CAP = 'structured_authoring';
const SOURCE = TEMPLATE.sources['zh-CN'];
// ADR 0060 §8 的两项编译输入（规范序列化）
const ALIAS_SET = { FUNC_PRODUCE: ['举头'], FUNC_TO: ['疑是'], MODULE_DECL: ['床前'], RETURN: ['低头'] };
const STORED_EMBEDDED =
  '{"v":1,"terms":[{"kind":"literal","localized":"思故乡","canonical":"静夜思"},{"kind":"struct","localized":"望明月","canonical":"Text"}]}';

const suffix = randomUUID().slice(0, 8);
const id = (role: string) => `e2e-jys-${role}-${suffix}`;
const USERS = {
  admin: { id: id('admin'), plan: 'pro', isAdmin: true },
  a: { id: id('a'), plan: 'pro', isAdmin: false },
  b: { id: id('b'), plan: 'team', isAdmin: false },
  n: { id: id('n'), plan: 'pro', isAdmin: false },
} as const;
type UserKey = keyof typeof USERS;
const TEAM_ID = id('team');

const COPY = {
  templates: 'Templates',
  layout: 'Layout',
  vocabulary: 'Vocabulary',
  showcaseName: 'Quiet Night Thoughts (Chinese showcase)',
  locked: 'Locked',
  needsStructural: 'Needs permission for structural keyword aliases.',
  needsCapability: 'Needs structured authoring. An administrator grants it per user.',
  includesExtras: 'Also sets keyword aliases, this policy’s vocabulary and a display layout.',
  replaceExtras:
    'The editor content, keyword aliases, this policy’s vocabulary and the display layout will be replaced with the template’s. Your personal and team vocabulary are not changed. This cannot be undone.',
  replace: 'Replace',
  create: 'Create Policy',
  expandsTo: 'Expands to text',
  embeddedMap: 'Policy vocabulary (compiled with this version)',
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

const version = (col: string) =>
  psql('aster_cloud', `select ${col} from "PolicyVersion" where "policyId" = ${lit(policyId)} and version = 1`);

/** 策略详情页「版本」面板里某个版本的卡片。 */
const versionCard = (page: Page, v: number) =>
  page.locator('div.rounded-lg.shadow-sm.border.p-4').filter({ has: page.getByText(`v${v}`, { exact: true }) }).first();

test.describe('Jingyesi showcase template end to end (ADR 0060 §8, cloud#830)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
  test.skip(!SECRET, '需要与被测 cloud 进程相同的 NEXTAUTH_SECRET');

  test.beforeAll(async () => {
    const values = Object.entries(USERS)
      .map(
        ([key, u]) =>
          `(${lit(u.id)}, ${lit(`JYS ${key}`)}, ${lit(`${u.id}@e2e.test`)}, ${lit(`${u.id}@e2e.test`)}, now(), ${lit(u.plan)}, ${u.isAdmin}, now(), now(), now(), now())`,
      )
      .join(',\n');
    psql(
      'aster_cloud',
      `insert into "User" (id, name, email, "emailNormalized", "emailVerified", plan, "isAdmin", "onboardingCompletedAt",
         "priceLockedAt", "createdAt", "updatedAt") values ${values}`,
    );
    psql(
      'aster_cloud',
      `insert into "Team" (id, name, slug, "ownerId") values (${lit(TEAM_ID)}, 'JYS Team', ${lit(TEAM_ID)}, ${lit(USERS.b.id)});
       insert into "TeamMember" (id, "teamId", "userId", role) values
         (${lit(`${TEAM_ID}-b`)}, ${lit(TEAM_ID)}, ${lit(USERS.b.id)}, 'owner'),
         (${lit(`${TEAM_ID}-a`)}, ${lit(TEAM_ID)}, ${lit(USERS.a.id)}, 'member')`,
    );
    for (const [key, u] of Object.entries(USERS)) {
      cookies[key as UserKey] = await sessionCookie({ id: u.id, email: `${u.id}@e2e.test`, plan: u.plan }, SECRET!);
    }
    await expectOk(api('admin', 'POST', '/api/admin/platform-settings', { key: SWITCH, value: true }), 'enable switch');
    for (const user of ['a', 'n'] as const) {
      await expectOk(api('admin', 'POST', `/api/admin/capabilities/${CAP}/grants`, { subjectType: 'user', subjectId: USERS[user].id }), `grant ${user}`);
    }
    await expectOk(api('admin', 'POST', '/api/admin/structural-alias-grants', { userId: USERS.a.id }), 'structural aliases for A');
  });

  test.afterAll(async () => {
    if (cookies.admin) {
      await api('admin', 'DELETE', '/api/admin/structural-alias-grants', { userId: USERS.a.id }).catch(() => undefined);
      await api('admin', 'POST', '/api/admin/platform-settings', { key: SWITCH, value: false }).catch(() => undefined);
    }
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

  test('1. without the structural alias grant the template is locked; content-only templates are unchanged', async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, 'n');
    await page.goto('/en/policies/new');
    await expect(railButton(page, COPY.layout)).toBeVisible({ timeout: 30_000 });
    await waitForMonaco(page);
    await openTemplates(page);

    const locked = page.getByTestId(`template-locked-${TEMPLATE.id}`);
    await expect(locked).toBeVisible();
    await expect(locked).toContainText(COPY.locked);
    await expect(locked).toContainText(COPY.needsStructural);
    await expect(locked).not.toContainText(COPY.needsCapability);
    await expect(locked.getByRole('button')).toHaveCount(0);
    const link = locked.getByRole('link', { name: 'Structured authoring access' });
    expect((await page.request.get((await link.getAttribute('href'))!)).status()).toBe(200);
    for (const name of ['Basic starter', 'Loan Evaluation']) {
      await expect(page.getByRole('button', { name: new RegExp(name) }).first()).toBeEnabled();
    }
    await locked.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, '1-picker-locked-without-structural-grant.png') });
    await page.context().close();
  });

  test('2. A applies the template: the display is the original poem, the Vocabulary tab lists this policy’s terms; A saves', async ({ browser }) => {
    test.setTimeout(300_000);
    // 模板应用与保存前后的词条总数：模板从不写个人 / 团队词汇（DomainTerm 是二者共用的词条表）
    const domainTermsBefore = psql('aster_cloud', 'select count(*) from "DomainTerm"');
    const page = await pageAs(browser, 'a');
    await page.goto(`/en/policies/new?teamId=${TEAM_ID}`);
    await expect(railButton(page, COPY.layout)).toBeVisible({ timeout: 30_000 });
    await waitForMonaco(page);
    await openTemplates(page);
    const showcase = page.getByRole('button', { name: new RegExp(COPY.showcaseName.replace(/[()]/g, '\\$&')) });
    await expect(showcase).toContainText(COPY.includesExtras);
    await expect(showcase).toContainText('静夜思');
    await showcase.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, '2-picker-with-capabilities.png') });

    // 新建页预填了入门模板：照常确认，文案说明别名、本策略词汇与排版也会替换
    await showcase.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(COPY.replaceExtras, { timeout: 10_000 });
    await dialog.getByRole('button', { name: COPY.replace, exact: true }).click();
    await expect.poll(() => editorValue(page), { timeout: 30_000 }).toBe(SOURCE);

    const pane = page.getByTestId('layout-display-pane');
    await expect(pane).toBeVisible({ timeout: 30_000 });
    // 并排视图的 display 就是原诗，一字不差
    expect(await pane.locator('[data-layout-display]').innerText()).toBe(JINGYESI_POEM);
    await page.screenshot({ path: join(SHOTS, '3-applied-display-is-the-poem.png') });

    await railButton(page, COPY.vocabulary).click();
    const section = page.getByTestId('structured-authoring-vocabulary').getByTestId('embedded-vocabulary');
    await expect(section).toBeVisible({ timeout: 30_000 });
    const terms = section.getByTestId('embedded-term');
    await expect(terms).toHaveCount(2);
    await expect(terms.filter({ hasText: '思故乡' })).toContainText('静夜思');
    await expect(terms.filter({ hasText: '思故乡' })).toContainText(COPY.expandsTo);
    await expect(terms.filter({ hasText: '望明月' })).toContainText('Text');
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, '4-applied-vocabulary-this-policy.png') });

    await page.getByRole('button', { name: COPY.create }).click();
    await page.waitForURL(/\/en\/policies\/(?!new)[^/?]+$/, { timeout: 60_000 });
    policyId = new URL(page.url()).pathname.split('/').pop()!;
    expect(policyId).toBeTruthy();

    // 落库：源码（逐字节，含末尾换行）、冻结别名、内嵌词汇规范序列化、排版行
    expect(psql('aster_cloud', `select encode(convert_to(content, 'UTF8'), 'hex') from "PolicyVersion" where "policyId" = ${lit(policyId)} and version = 1`))
      .toBe(Buffer.from(SOURCE, 'utf8').toString('hex'));
    expect(JSON.parse(version('"aliasSet"'))).toEqual(ALIAS_SET);
    expect(version('"embeddedVocabulary"')).toBe(STORED_EMBEDDED);
    expect(psql('aster_cloud', `select "teamId" from "Policy" where id = ${lit(policyId)}`)).toBe(TEAM_ID);
    const stored = psql(
      'aster_cloud',
      `select l.layout from "PolicyVersionLayout" l join "PolicyVersion" v on v.id = l."policyVersionId"
       where v."policyId" = ${lit(policyId)} and v.version = 1`,
    );
    expect(JSON.parse(stored)).toEqual(TEMPLATE.layout);
    // 模板从不写个人 / 团队词汇
    expect(psql('aster_cloud', `select count(*) from "UserDomainTerm" where "userId" = ${lit(USERS.a.id)}`)).toBe('0');
    expect(psql('aster_cloud', 'select count(*) from "DomainTerm"')).toBe(domainTermsBefore);
    await page.context().close();
  });

  test('3. the approver sees the four structural aliases and the two embedded terms, and approves v1', async ({ browser }) => {
    test.setTimeout(180_000);
    expect(policyId, 'scenario 2 saved a policy').toBeTruthy();
    await expectOk(api('a', 'POST', `/api/v1/policies/${policyId}/versions/1/submit`, {}), 'submit v1');

    const b = await pageAs(browser, 'b');
    await b.goto(`/en/policies/${policyId}`);
    await versionCard(b, 1).getByRole('button', { name: 'View source' }).click({ timeout: 30_000 });
    const map = b.getByRole('region', { name: COPY.embeddedMap });
    await expect(map).toBeVisible({ timeout: 30_000 });
    const rows = map.getByTestId('embedded-vocabulary-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('思故乡');
    await expect(rows.nth(0)).toContainText('"静夜思"');
    await expect(rows.nth(0)).toContainText(COPY.expandsTo);
    await expect(rows.nth(1)).toContainText('望明月');
    await expect(rows.nth(1)).toContainText('Text');
    // 别名映射表（在内嵌词汇表之上）：四个领字都在
    const aliasTable = b.locator('table').filter({ hasText: '床前' }).first();
    for (const alias of ['床前', '疑是', '举头', '低头']) await expect(aliasTable).toContainText(alias);
    await aliasTable.scrollIntoViewIfNeeded();
    await b.screenshot({ path: join(SHOTS, '5-approver-aliases-and-embedded-terms.png') });

    await b.goto(`/en/policies/${policyId}`);
    await versionCard(b, 1).getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 30_000 });
    await b.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => version('status'), { timeout: 30_000 }).toBe('APPROVED');
    await b.context().close();
  });

  test('4. after approval the author adds a colliding personal term; executing through aster-api still outputs 静夜思', async ({ browser }) => {
    test.setTimeout(180_000);
    await expectOk(
      api('a', 'POST', '/api/v1/domain-vocabularies/terms', {
        domain: `e2e-jys-${suffix}`,
        locale: 'zh-CN',
        kind: 'struct',
        canonical: 'Moon',
        localized: '望明月',
      }),
      'author term 望明月 → Moon',
    );
    const run = await api('a', 'POST', `/api/policies/${policyId}/execute`, { input: {} });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json.executedFunction, JSON.stringify(run.json)).toBe('地上霜');
    expect((run.json.output as { result?: unknown }).result).toBe('静夜思');

    // 执行页（浏览器）同一路径：显示输出「静夜思」
    const page = await pageAs(browser, 'a');
    await page.goto(`/en/policies/${policyId}/execute`);
    // 规则列表认冻结的 FUNC_TO 别名（「疑是 地上霜」），按版本语言 zh-CN 提取 schema：入口无参数，输入为空对象
    await expect(page.getByRole('combobox', { name: 'Rule' })).toHaveValue('地上霜', { timeout: 60_000 });
    await expect(page.getByText('Unable to parse policy parameters')).toHaveCount(0);
    await page.getByRole('button', { name: 'Execute Policy' }).click();
    await expect(page.getByText('静夜思', { exact: true }).last()).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: join(SHOTS, '6-execute-result.png') });
    await page.context().close();
  });

  test('5. a batch What-If targeting the approved version completes (every execution replayed)', async () => {
    test.setTimeout(180_000);
    const v1 = version('id');
    const created = await expectOk(
      api('a', 'POST', `/api/v1/policies/${policyId}/whatif-batches`, {
        baseVersionId: v1,
        targetVersionId: v1,
        windowKind: 'LAST_MONTH',
        includeToday: true,
      }),
      'create what-if batch',
    );
    const batchId = String(created.batchId ?? created.id);
    expect(batchId).toBeTruthy();
    let batch: Record<string, unknown> = {};
    await expect
      .poll(
        async () => {
          batch = (await api('a', 'GET', `/api/v1/policies/${policyId}/whatif-batches/${batchId}`)).json;
          return batch.status;
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .toMatch(/^(COMPLETED|FAILED|EXPIRED)$/);
    // COMPLETED 即全量成功（失败批次只给 failureKinds，ADR 0034 §1.1）；回放样本含场景 4 的执行
    expect(batch.status, JSON.stringify(batch)).toBe('COMPLETED');
    expect(Number(batch.plannedCount), JSON.stringify(batch)).toBeGreaterThanOrEqual(1);
    console.log(`[what-if] ${JSON.stringify(batch)}`);
    // 批次接口按 ADR 0034 §1.1 只给结论类别（文本输出为 INDETERMINATE），不给值。逐条核对：每条回放都成功
    // （v1 带冻结 aliasSet 与合并词汇重编译并求值，缺任一项即编译失败、记 failure_kind），且被回放的源执行输出都是「静夜思」。
    const items = psql(
      'aster_policy',
      `select execution_id || '|' || success || '|' || coalesce(failure_kind, '-') || '|' || target_outcome
       from replay_batch_item where batch_id = ${lit(batchId)} order by execution_id`,
    ).split('\n');
    expect(items).toHaveLength(Number(batch.plannedCount));
    for (const item of items) {
      const [executionId, success, failure, outcome] = item.split('|');
      expect([success, failure, outcome], item).toEqual(['true', '-', 'INDETERMINATE']);
      expect(psql('aster_cloud', `select output->>'result' from "Execution" where id = ${lit(executionId)}`)).toBe('静夜思');
    }
  });
});
