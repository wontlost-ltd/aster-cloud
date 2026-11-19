/**
 * 结构化编写端到端（ADR 0058 阶段 1，计划 Task 15）。
 *
 *   1. 管理员打开 `capability.structured_authoring.enabled`、给 Pro 用户 A 直接授权；A 打开编辑器看到「模型 / 词汇」标签，
 *      用表单新建结构体、从词汇标签插入一个术语，打开词汇规范预览：光标同步，且「不带词汇编译预览文本」与
 *      「带词汇编译源码」的 Core IR（去 origin）相同；保存成功。
 *   2. 管理员给团队 T 设 seatCap=1；T 的 owner 在团队设置页委派给成员 B 成功，再委派给 C 显示座位已满；
 *      移除 B 后 B 刷新编辑器不再有标签。
 *   3. 关闭全局开关后 A 刷新编辑器不再有标签，A 之前保存的策略仍可执行。
 *
 * 用例自建全部用户与团队（psql 写 User / Team / TeamMember 行 + 伪造 Auth.js 会话 cookie），能力经平台管理接口开关与授予；
 * 结束时关闭开关并删除自建数据。需要：cloud 生产构建（NEXT_PUBLIC_LSP_HOST 指向本地 LSP 网关 `node lsp-server.mjs`，
 * 语言服务为 cloud 依赖的同一 aster-lang-ts 版本）、aster-api（执行）、与 cloud 进程相同的 NEXTAUTH_SECRET。
 *
 * 运行：
 *   E2E_PG_CONTAINER=c5-pg NEXTAUTH_SECRET=… BASE_CLOUD=http://localhost:3805 \
 *     pnpm exec playwright test src/__tests__/e2e-browser/local-stack/structured-authoring.spec.ts --project=chromium-desktop --workers=1
 * 截图写到 E2E_SCREENSHOT_DIR（缺省 test-results/structured-authoring）。
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { SESSION_COOKIE_NAME, sessionCookie } from '../../../../scripts/lib/session-cookie';
import { BASE_CLOUD, NOT_LOCAL, NOT_LOCAL_REASON, psql } from './helpers';

const SECRET = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
const SHOTS = process.env.E2E_SCREENSHOT_DIR || join(process.cwd(), 'test-results/structured-authoring');
const SWITCH = 'capability.structured_authoring.enabled';
const CAP = 'structured_authoring';

const suffix = randomUUID().slice(0, 8);
const id = (role: string) => `e2e-sa-${role}-${suffix}`;
const USERS = {
  admin: { id: id('admin'), plan: 'pro', isAdmin: true },
  a: { id: id('a'), plan: 'pro', isAdmin: false },
  owner: { id: id('owner'), plan: 'team', isAdmin: false },
  b: { id: id('b'), plan: 'pro', isAdmin: false },
  c: { id: id('c'), plan: 'pro', isAdmin: false },
} as const;
type UserKey = keyof typeof USERS;
const TEAM_ID = id('team');
const DOMAIN = `e2e-sa-${suffix}`;
// de-DE：本用例写于 aster-lang-ts 3.3.0（en-US 文档不套用租户词汇，#365，3.4.0 修复）；en-US 的预览由
// src/__tests__/lib/lsp-canonical-preview-en-us.test.ts 对真实语言服务器验收
const LOCALE = 'de-DE';
// A 的词汇：本地化写法 → 规范名（字段挂在结构下）
const TERMS = [
  { kind: 'struct', canonical: 'Driver', localized: 'Fahrer' },
  { kind: 'field', canonical: 'age', localized: 'alter', parentCanonical: 'Driver' },
] as const;
// 规则参数类型留空，由词汇标签页插入「Fahrer」；结构体由模型标签页表单生成
const DRAFT = [
  `Modul e2e.sa${suffix.replace(/[^a-z]/g, '')}.`,
  '',
  'Regel pruefen gegeben antragsteller als , liefert Text:',
  '  wenn antragsteller.alter größer als 17',
  '    gib zurück "Genehmigt".',
  '  sonst',
  '    gib zurück "Abgelehnt".',
  '',
].join('\n');

const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const cookies: Partial<Record<UserKey, string>> = {};
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
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: cookies[user]!, url: BASE_CLOUD, httpOnly: true, sameSite: 'Lax' }]);
  return context.newPage();
}

const railButton = (page: Page, name: 'Model' | 'Vocabulary' | 'Modell' | 'Vokabular') =>
  page.getByRole('navigation').getByRole('button', { name, exact: true });

/** 编辑器（主文档）的源码；Monaco 由编辑器挂到 window.monaco。 */
async function editorValue(page: Page): Promise<string> {
  return page.evaluate(() => {
    const m = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
    const ed = m.editor.getEditors().find((e) => !e.getModel()?.uri.toString().includes('aster-canonical-preview'));
    return ed?.getModel()?.getValue() ?? '';
  });
}

async function previewState(page: Page): Promise<{ text: string; selected: string } | null> {
  return page.evaluate(() => {
    const m = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
    const ed = m.editor.getEditors().find((e) => e.getModel()?.uri.toString().includes('aster-canonical-preview'));
    const model = ed?.getModel();
    const sel = ed?.getSelection();
    if (!model) return null;
    return { text: model.getValue(), selected: sel ? model.getValueInRange(sel) : '' };
  });
}

/** 把主编辑器光标放到第 line 行、某段文字之后 / 之中（offsetInMatch）。 */
async function placeCursor(page: Page, line: number, match: string, offsetInMatch: number): Promise<void> {
  await page.evaluate(
    ([l, s, o]) => {
      const m = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
      const ed = m.editor.getEditors().find((e) => !e.getModel()?.uri.toString().includes('aster-canonical-preview'))!;
      const col = ed.getModel()!.getLineContent(l as number).indexOf(s as string) + 1 + (o as number);
      ed.focus();
      ed.setPosition({ lineNumber: l as number, column: col });
    },
    [line, match, offsetInMatch] as const,
  );
}

function compareCoreIr(source: string, preview: string, rows: unknown[]): Record<string, unknown> {
  const out = execFileSync('pnpm', ['exec', 'tsx', 'src/__tests__/e2e-browser/local-stack/structured-authoring-core-ir.ts'], {
    input: JSON.stringify({ source, preview, locale: LOCALE, rows }),
    env: { ...process.env, NODE_OPTIONS: '--conditions=import' },
    encoding: 'utf8',
  });
  return JSON.parse(out) as Record<string, unknown>;
}

test.describe('structured authoring end to end (ADR 0058 phase 1)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
  test.skip(!SECRET, '需要与被测 cloud 进程相同的 NEXTAUTH_SECRET');

  test.beforeAll(async () => {
    const values = Object.entries(USERS)
      .map(
        ([key, u]) =>
          `(${lit(u.id)}, ${lit(`SA ${key}`)}, ${lit(`${u.id}@e2e.test`)}, ${lit(`${u.id}@e2e.test`)}, now(), ${lit(u.plan)}, ${u.isAdmin}, now(), now(), now(), now())`,
      )
      .join(',\n');
    psql(
      'aster_cloud',
      `insert into "User" (id, name, email, "emailNormalized", "emailVerified", plan, "isAdmin", "onboardingCompletedAt",
         "priceLockedAt", "createdAt", "updatedAt") values ${values}`,
    );
    psql(
      'aster_cloud',
      `insert into "Team" (id, name, slug, "ownerId") values (${lit(TEAM_ID)}, 'SA Team', ${lit(TEAM_ID)}, ${lit(USERS.owner.id)});
       insert into "TeamMember" (id, "teamId", "userId", role) values
         (${lit(`${TEAM_ID}-o`)}, ${lit(TEAM_ID)}, ${lit(USERS.owner.id)}, 'owner'),
         (${lit(`${TEAM_ID}-b`)}, ${lit(TEAM_ID)}, ${lit(USERS.b.id)}, 'member'),
         (${lit(`${TEAM_ID}-c`)}, ${lit(TEAM_ID)}, ${lit(USERS.c.id)}, 'member')`,
    );
    for (const [key, u] of Object.entries(USERS)) {
      cookies[key as UserKey] = await sessionCookie({ id: u.id, email: `${u.id}@e2e.test`, plan: u.plan }, SECRET!);
    }
    for (const term of TERMS) {
      await expectOk(api('a', 'POST', '/api/v1/domain-vocabularies/terms', { domain: DOMAIN, locale: LOCALE, ...term }), `term ${term.localized}`);
    }
  });

  test.afterAll(async () => {
    if (cookies.admin) await api('admin', 'POST', '/api/admin/platform-settings', { key: SWITCH, value: false }).catch(() => undefined);
    const ids = Object.values(USERS).map((u) => lit(u.id)).join(', ');
    for (const sql of [
      `delete from "CapabilityGrant" where "userId" in (${ids}) or "teamId" = ${lit(TEAM_ID)} or "delegatingTeamId" = ${lit(TEAM_ID)}`,
      `delete from "CapabilityTeamAllotment" where "teamId" = ${lit(TEAM_ID)}`,
      `delete from "TeamMember" where "teamId" = ${lit(TEAM_ID)}`,
      `delete from "Team" where id = ${lit(TEAM_ID)}`,
      `update "Policy" set "deletedAt" = now() where "userId" in (${ids})`,
      `delete from "User" where id in (${ids})`,
    ]) {
      try {
        psql('aster_cloud', sql);
      } catch {
        // 尽力清理：表名随迁移演进时不影响用例结论
      }
    }
  });

  test('1. admin enables the switch and grants A; A authors with the tabs and the canonical preview, then saves', async ({ browser }) => {
    test.setTimeout(240_000);
    await expectOk(api('admin', 'POST', '/api/admin/platform-settings', { key: SWITCH, value: true }), 'enable switch');
    await expectOk(api('admin', 'POST', `/api/admin/capabilities/${CAP}/grants`, { subjectType: 'user', subjectId: USERS.a.id }), 'grant A');

    const page = await pageAs(browser, 'a');
    // 德语界面：新建策略的语言随界面为 de-DE（标签文案取 demo-supplement 的 de）
    await page.goto('/de/policies/new');
    await expect(railButton(page, 'Modell')).toBeVisible({ timeout: 30_000 });
    await expect(railButton(page, 'Vokabular')).toBeVisible();
    await page.waitForFunction(() => Boolean((window as unknown as { monaco?: unknown }).monaco));
    // 以编辑（executeEdits）整体替换，与用户输入同一路径进入表单状态；model.setValue 是整体刷新事件，编辑器表单不跟随
    await page.evaluate((draft) => {
      const m = (window as unknown as { monaco: typeof import('monaco-editor') }).monaco;
      const ed = m.editor.getEditors()[0];
      ed.executeEdits('e2e', [{ range: ed.getModel()!.getFullModelRange(), text: draft }]);
    }, DRAFT);

    // 模型标签页：表单生成结构体并插到文档末尾
    await railButton(page, 'Modell').click();
    const model = page.getByTestId('structured-authoring-model');
    await model.getByRole('button', { name: 'Neue Struktur' }).click();
    const form = model.getByRole('form', { name: 'Neue Struktur' });
    await form.getByLabel('Name der Struktur').fill('Fahrer');
    await form.getByLabel('Feldname').fill('alter');
    await form.getByLabel('Feldtyp').selectOption('Ganzzahl');
    await form.getByRole('button', { name: 'Einfügen' }).click();
    await expect.poll(() => editorValue(page)).toContain('Definiere Fahrer mit alter als Ganzzahl.');

    // 词汇标签页：光标放在参数类型处，点击术语插入本地化写法
    await placeCursor(page, 3, 'antragsteller als ', 'antragsteller als '.length);
    await railButton(page, 'Vokabular').click();
    const vocab = page.getByTestId('structured-authoring-vocabulary');
    await vocab.getByRole('button', { name: /Fahrer/ }).first().click();
    await expect.poll(() => editorValue(page)).toContain('Regel pruefen gegeben antragsteller als Fahrer, liefert Text:');

    // 词汇规范预览：开关在词汇标签页顶部
    await vocab.getByRole('button', { name: 'Kanonische Vorschau anzeigen' }).click();
    const pane = page.getByTestId('canonical-preview-pane');
    await expect(pane).toBeVisible();
    // 分栏真的分出了空间：预览 Monaco 可见且有实际高度，源码编辑器仍在上方
    await expect(pane.locator('.monaco-editor')).toBeVisible({ timeout: 30_000 });
    expect((await pane.boundingBox())?.height ?? 0).toBeGreaterThan(150);
    await expect(page.locator('.monaco-editor').first()).toBeInViewport();
    await expect.poll(async () => (await previewState(page))?.text ?? '', { timeout: 30_000 }).toContain('gegeben antragsteller als Driver');
    const source = await editorValue(page);
    const preview = (await previewState(page))!.text;
    expect(preview).toContain('wenn antragsteller.age größer als 17');
    expect(preview).toContain('Definiere Driver mit age als Ganzzahl.');
    expect(preview).not.toMatch(/Fahrer|alter/);

    // 光标同步：源码光标落在「Fahrer」内 → 预览选中整个「Driver」
    await placeCursor(page, 3, 'Fahrer', 3);
    await expect.poll(async () => (await previewState(page))?.selected).toBe('Driver');
    await page.screenshot({ path: join(SHOTS, 'a-canonical-preview.png') });

    // 忠实性：不带词汇编译预览 ≡ 带词汇编译源码（Core IR 去 origin）
    const rows = TERMS.map((t, i) => ({ domainTermId: String(i), domain: DOMAIN, locale: LOCALE, ...t }));
    const verdict = compareCoreIr(source, preview, rows);
    expect(verdict, JSON.stringify(verdict)).toMatchObject({ vocabularyInScope: true, sourceOk: true, previewOk: true, equal: true });

    // 命令面板：切换预览（关闭）
    // 焦点须在编辑器的输入区内，⌘K 才归编辑器命令面板（否则是全站跳转面板）
    await page.locator('.monaco-editor textarea').first().focus();
    await page.keyboard.press('ControlOrMeta+k');
    await page.getByRole('button', { name: 'Kanonische Vorschau umschalten' }).click();
    await expect(pane).toBeHidden();

    // 保存
    await page.getByRole('navigation').getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByLabel(/^Richtlinienname/).first().fill(`SA e2e ${suffix}`);
    await page.getByRole('button', { name: 'Richtlinie erstellen' }).click();
    await page.waitForURL(/\/de\/policies\/(?!new)[^/]+$/, { timeout: 30_000 });
    policyId = new URL(page.url()).pathname.split('/').pop()!;
    expect(policyId).toBeTruthy();
    await page.context().close();
  });

  test('2. owner delegates within the seat cap; removing B drops the tabs', async ({ browser }) => {
    test.setTimeout(180_000);
    await expectOk(
      api('admin', 'PUT', `/api/admin/capabilities/${CAP}/teams/${TEAM_ID}/allotment`, { seatCap: 1, ownerGrantingEnabled: true }),
      'allotment',
    );
    const owner = await pageAs(browser, 'owner');
    await owner.goto(`/en/teams/${TEAM_ID}/settings`);
    // 座位卡片：标题所在头部的上一级容器
    const card = owner.getByRole('heading', { name: 'Structured Authoring seats' }).locator('xpath=../..');
    await expect(card.getByText('Seats used: 0 / 1')).toBeVisible({ timeout: 30_000 });
    await card.getByLabel('Member').selectOption({ label: 'SA b' });
    await card.getByRole('button', { name: 'Delegate', exact: true }).click();
    await expect(card.getByText('Seats used: 1 / 1')).toBeVisible();
    await card.getByLabel('Member').selectOption({ label: 'SA c' });
    await card.getByRole('button', { name: 'Delegate', exact: true }).click();
    await expect(card.getByRole('alert')).toHaveText('All seats are in use. Revoke a delegation or ask a platform admin for more seats.');
    await owner.screenshot({ path: join(SHOTS, 'owner-seat-cap.png') });

    const b = await pageAs(browser, 'b');
    await b.goto('/en/policies/new');
    await expect(railButton(b, 'Model')).toBeVisible({ timeout: 30_000 });

    await expectOk(api('owner', 'DELETE', `/api/teams/${TEAM_ID}/members/${TEAM_ID}-b`), 'remove B');
    await b.reload();
    await expect(b.getByRole('navigation').getByRole('button', { name: 'AI', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(railButton(b, 'Model')).toHaveCount(0);
    await expect(railButton(b, 'Vocabulary')).toHaveCount(0);
    await owner.context().close();
    await b.context().close();
  });

  test('3. switching the capability off removes the tabs; the saved policy still executes', async ({ browser }) => {
    test.setTimeout(180_000);
    expect(policyId, 'scenario 1 saved a policy').toBeTruthy();
    await expectOk(api('admin', 'POST', '/api/admin/platform-settings', { key: SWITCH, value: false }), 'disable switch');

    const page = await pageAs(browser, 'a');
    await page.goto(`/en/policies/${policyId}/edit`);
    await expect(page.getByRole('navigation').getByRole('button', { name: 'AI', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(railButton(page, 'Model')).toHaveCount(0);
    await expect(railButton(page, 'Vocabulary')).toHaveCount(0);
    await expect(page.getByTestId('canonical-preview-pane')).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, 'a-switch-off.png') });

    const run = await api('a', 'POST', `/api/policies/${policyId}/execute`, { input: { antragsteller: { age: 30 } } });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(JSON.stringify(run.json)).toContain('Genehmigt');
    await page.context().close();
  });
});
