/**
 * #774 用户反馈：「接受团队邀请、审批策略版本很难——条目像是藏在前台面板的容器里」。
 *
 * 根因（本地栈复现）：
 * - 仪表盘首页不展示任何待办：待接受的邀请只在 /teams，待审批版本只在 /approvals；
 * - 移动端通知面板以铃铛右缘为锚、固定 320px 宽，左侧 132px 落在视口外，条目文字被截；
 * - 移动端 /approvals「策略版本审批」表格的操作列被 overflow-x-auto 容器裁到视口外，「Review」看不见。
 *
 * 这里在桌面与移动两种视口走完两条真实流程，并断言每个可操作项都完整落在视口与所有裁剪祖先之内：
 * - 受邀人从仪表盘直接接受邀请；
 * - 团队成员提交版本审批，团队 owner（非作者）从仪表盘进入并批准；作者本人只能看到「等待他人审批」（四眼原则不变）。
 *
 * 夹具：UI 审计的种子（`pnpm ui-audit:seed`，storageState 与 fixtures.json 在 UI_AUDIT_STATE_DIR，默认
 * .superpowers/ui-audit）。用例自建邀请与版本，结束时把受邀人移出团队，可重复运行。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { NOT_LOCAL, NOT_LOCAL_REASON } from './helpers';

const STATE_DIR = process.env.UI_AUDIT_STATE_DIR || join(process.cwd(), '.superpowers/ui-audit');
const state = (role: string) => join(STATE_DIR, `state-${role}.json`);
const BASE = (process.env.BASE_CLOUD || '').replace(/\/$/, '');

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.describe.configure({ mode: 'serial' });

interface Fixtures { teamId: string; teamPolicyId: string }
function fixtures(): Fixtures {
  return JSON.parse(readFileSync(join(STATE_DIR, 'fixtures.json'), 'utf8')) as Fixtures;
}

const VIEWPORTS = [
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 } }, invitee: 'ui-free', email: 'ui-free@ui-audit.test' },
  { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, invitee: 'ui-pro', email: 'ui-pro@ui-audit.test' },
] as const;

/** 以某个角色的会话调用本站 API（同源 Origin，满足 CSRF 校验） */
async function api(browser: Browser, role: string) {
  const ctx = await browser.newContext({ storageState: state(role), baseURL: BASE });
  const headers = { 'Content-Type': 'application/json', Origin: BASE };
  return {
    get: (url: string) => ctx.request.get(url),
    post: (url: string, data: unknown) => ctx.request.post(url, { headers, data }),
    del: (url: string) => ctx.request.delete(url, { headers }),
    close: () => ctx.close(),
  };
}

/**
 * 可操作项必须完整可见：页面纵向滚到元素处后，元素盒子在视口内、不被任何会裁剪的祖先（overflow 非 visible）截掉，
 * 且中心点命中元素本身（没有被遮挡）。
 */
async function expectUnclipped(target: Locator): Promise<void> {
  await expect(target).toBeVisible();
  const problem = await target.evaluate((el) => {
    // 只纵向滚动页面把元素带到视口中部；不能用 scrollIntoView——它会顺带横向滚动内层容器，
    // 把本该被裁掉的操作项「救」回来，正好掩盖这次要抓的缺陷
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - window.innerHeight / 2));
    const r = el.getBoundingClientRect();
    if (r.left < -0.5 || r.right > window.innerWidth + 0.5) return `outside viewport: x=${Math.round(r.left)}..${Math.round(r.right)} vw=${window.innerWidth}`;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const pr = p.getBoundingClientRect();
      if (r.left < pr.left - 0.5 || r.right > pr.right + 0.5 || r.top < pr.top - 0.5 || r.bottom > pr.bottom + 0.5) {
        return `clipped by ${p.tagName.toLowerCase()}.${Array.from(p.classList).slice(0, 4).join('.')}`;
      }
    }
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) return `covered by ${hit?.tagName.toLowerCase() ?? 'nothing'}`;
    return null;
  });
  expect(problem, 'actionable item must be fully visible and clickable').toBeNull();
}

async function openDashboard(page: Page): Promise<void> {
  await page.goto('/en/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

for (const vp of VIEWPORTS) {
  test.describe(`pending invitations (${vp.name})`, () => {
    test.use({ ...vp.use, storageState: state(vp.invitee) });

    test.beforeAll(async ({ browser }) => {
      const { teamId } = fixtures();
      const owner = await api(browser, 'ui-owner');
      // 上次运行若中途失败，受邀人可能还在团队里：先移出，再发新邀请
      await removeFromTeam(owner, teamId, vp.email);
      const res = await owner.post(`/api/teams/${teamId}/invitations`, { email: vp.email, role: 'member' });
      // 上次运行留下的未接受邀请仍有效：服务端回 400 invitation_already_pending，直接复用
      const body = await res.text();
      expect(res.status() === 201 || body.includes('invitation_already_pending'), body).toBe(true);
      await owner.close();
    });

    test.afterAll(async ({ browser }) => {
      const owner = await api(browser, 'ui-owner');
      await removeFromTeam(owner, fixtures().teamId, vp.email);
      await owner.close();
    });

    test('the dashboard shows the invitation with a visible Accept action', async ({ page }) => {
      await openDashboard(page);
      const card = page.getByRole('region', { name: /pending invitations/i });
      await expect(card).toBeVisible();
      await expect(card).toContainText('UI Audit Team');
      const accept = card.getByRole('button', { name: /^accept$/i }).first();
      await expectUnclipped(accept);
      await accept.click();
      await expect(card).toBeHidden();
      // 已成为成员：团队页列出该团队
      await page.goto('/en/teams');
      await expect(page.getByRole('link', { name: /UI Audit Team/ }).first()).toBeVisible();
    });

    test('the notifications panel stays inside the viewport', async ({ page }) => {
      await openDashboard(page);
      await page.getByRole('button', { name: /notifications/i }).click();
      const panel = page.getByRole('dialog', { name: /notifications/i });
      await expectUnclipped(panel);
    });
  });

  test.describe(`pending version approvals (${vp.name})`, () => {
    test.use({ ...vp.use, storageState: state('ui-owner') });
    let version = 0;

    test.beforeAll(async ({ browser }) => {
      const { teamPolicyId } = fixtures();
      const member = await api(browser, 'ui-member');
      const source = `Module aster.audit.loan.\n\nRule evaluateLoan given tier as Text, produce Text:\n  If tier equals to "gold":\n    Return "allow".\n  Return "r${Date.now()}".\n`;
      const created = await member.post(`/api/v1/policies/${teamPolicyId}/versions`, { source, locale: 'en-US' });
      expect(created.status()).toBe(201);
      version = ((await created.json()) as { version: number }).version;
      const submitted = await member.post(`/api/v1/policies/${teamPolicyId}/versions/${version}/submit`, {});
      expect(submitted.status()).toBe(200);
      await member.close();
    });

    test('the author sees it as awaiting others, with no approve action (four-eyes)', async ({ browser }) => {
      const ctx = await browser.newContext({ ...vp.use, storageState: state('ui-member'), baseURL: BASE });
      const page = await ctx.newPage();
      await openDashboard(page);
      await expect(page.getByRole('region', { name: /awaiting your review/i })).toHaveCount(0);
      await page.goto(`/en/policies/${fixtures().teamPolicyId}/versions`);
      const own = page.getByRole('row').filter({ has: page.getByRole('cell', { name: `v${version}`, exact: true }) });
      await expect(own).toContainText(/waiting for another approver/i);
      await expect(own.getByRole('button')).toHaveCount(0);
      await ctx.close();
    });

    test('a reviewer finds it on the dashboard and approves it', async ({ page }) => {
      await openDashboard(page);
      const card = page.getByRole('region', { name: /awaiting your review/i });
      await expect(card).toBeVisible();
      const row = card.getByRole('listitem').filter({ hasText: `v${version}` });
      const review = row.getByRole('link', { name: /review/i });
      await expectUnclipped(review);
      await review.click();
      await expect(page).toHaveURL(new RegExp(`/policies/${fixtures().teamPolicyId}/versions`));
      // 版本行的操作收在「Actions」展开区里：展开后的「Approve」也必须完整可见（不能被表格的滚动容器裁掉）
      const versionRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: `v${version}`, exact: true }) });
      const menuButton = versionRow.getByRole('button', { name: /actions/i });
      await expectUnclipped(menuButton);
      await menuButton.click();
      const approve = versionRow.getByRole('button', { name: /^approve$/i });
      await expectUnclipped(approve);
      await approve.click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: /approve/i }).last().click();
      await expect(versionRow).toContainText(/approved/i);
    });

    test('the approvals inbox keeps the Review action on screen', async ({ browser, page }) => {
      // 再提交一版，让收件箱里有待审批条目
      const { teamPolicyId } = fixtures();
      const member = await api(browser, 'ui-member');
      const source = `Module aster.audit.loan.\n\nRule evaluateLoan given tier as Text, produce Text:\n  If tier equals to "gold":\n    Return "allow".\n  Return "s${Date.now()}".\n`;
      const created = await member.post(`/api/v1/policies/${teamPolicyId}/versions`, { source, locale: 'en-US' });
      const v = ((await created.json()) as { version: number }).version;
      await member.post(`/api/v1/policies/${teamPolicyId}/versions/${v}/submit`, {});
      await member.close();

      await page.goto('/en/approvals');
      const section = page.getByRole('region', { name: /policy version approvals/i });
      const item = section.locator(`[data-version-id]:visible`).filter({ hasText: `v${v}` });
      await expectUnclipped(item.getByRole('link', { name: /review/i }));
    });
  });
}

async function removeFromTeam(owner: Awaited<ReturnType<typeof api>>, teamId: string, email: string): Promise<void> {
  const res = await owner.get(`/api/teams/${teamId}/members`);
  if (!res.ok()) return;
  const body = (await res.json()) as { members?: Array<{ id: string; user?: { email?: string } }> } | Array<{ id: string; user?: { email?: string } }>;
  const members = Array.isArray(body) ? body : body.members ?? [];
  for (const m of members) {
    if (m.user?.email === email) await owner.del(`/api/teams/${teamId}/members/${m.id}`);
  }
}
