/**
 * #786：策略详情页「导出为 Cedar」的位置、提示位置与显隐；版本列表行菜单「Submit for approval」被容器裁掉。
 *
 * 1. 「Export to Cedar」在页头右上的操作组里，与 Execute / Edit / Delete 同组同高；移动端（390px）折行、不横向溢出，
 *    每个操作的点击区 ≥ 44×44（#785）；
 * 2. 导出结果出现在紧贴操作组下方的 aria-live 状态区里，出现前后操作组里各按钮的位置不变、仍完整可见；
 * 3. 只在可导出时显示：不可导出（Text.length，E721）的策略从首帧到加载完毕按钮都没出现过（不闪）；
 *    可导出的策略按钮随服务端 HTML 一起到达（没有「加载中」状态）；只有草稿时按钮禁用并在状态区提示先批准；
 * 4. 版本页只有一个草稿版本时（表格最后一行），「⋮」菜单里的「Submit for approval」完整可见、点得到
 *    （此前被 DataTable 的 overflow-x-auto 外壳裁掉）；团队邀请接受页（/teams/invite?token=…）的操作同样完整可见
 *    （仪表盘与 /teams 的待接受邀请卡由 pending-actions 覆盖）。
 *
 * 夹具：UI 审计的种子（`pnpm ui-audit:seed`，storageState 在 UI_AUDIT_STATE_DIR，默认 .superpowers/ui-audit）。
 * 用例以 ui-owner 身份经 `POST /api/policies` 新建三条个人策略，前两条经 psql 把 v1 置为 APPROVED（单用户无法自批），
 * 结束时软删除。需要 aster-api 提供可导出性检查端点（`POST /api/v1/policies/export/cedar/check`）。
 * 5. 策略包导出（ADR 0059 P2）打开后操作组里的「Export」下拉：与同组按钮同高、移动端点击区 ≥ 44×44、
 *    下拉随服务端 HTML 一起到达，单按钮从未出现过（不闪）。上面 1–4 在开关关闭时断言（beforeAll 经管理接口关闭）。
 */
import { join } from 'node:path';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { NOT_LOCAL, NOT_LOCAL_REASON, expectUnclipped, psql } from './helpers';

const STATE_DIR = process.env.UI_AUDIT_STATE_DIR || join(process.cwd(), '.superpowers/ui-audit');
const OWNER_STATE = join(STATE_DIR, 'state-ui-owner.json');
const BASE = (process.env.BASE_CLOUD || '').replace(/\/$/, '');
const ORIGIN = { Origin: BASE };

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.describe.configure({ mode: 'serial' });

const GUARD_PREAMBLE =
  'Define GuardRequest has principal_id, principal_type, principal_roles, action, resource_type, resource_id, context, agent_model.\n\n';

// 与 aster-api `src/test/resources/cedar/guard-cedar-sample.aster` 同形（模块名不同），可导出
const EXPORTABLE = (module: string) => `Module ${module}.

${GUARD_PREAMBLE}@id("GCS-786")
Rule decide given req as GuardRequest, produce Verdict:
  Let large be req.context.amount at least 10000.
  When req.action equals to "delete_customer_record", require approval by "Data Protection Officer" because "customer record deletion".
  If List.contains(req.principal_roles, "suspended"):
    Return Verdict.deny("suspended principal").
  If large and req.action equals to "refund":
    Return Verdict.escalate("large refund").
  Otherwise allow.
`;

// 能通过编译门禁、但 Cedar 无法表达（字符串长度）→ E721，不可导出
const NOT_EXPORTABLE = `Module guard.cedar.textlen786.

${GUARD_PREAMBLE}@id("GCS-786-E721")
Rule decide given req as GuardRequest, produce Verdict:
  If Text.length(req.action) at least 1:
    Return Verdict.deny("x").
  Return Verdict.allow().
`;

const VIEWPORTS = [
  { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
] as const;

const ids = { exportable: '', notExportable: '', draft: '' };

const PLATFORM_STATE = join(STATE_DIR, 'state-ui-platform.json');

/** 经管理接口切换策略包导出开关（同进程即时生效，不受设置缓存影响） */
async function setPackageExportFlag(browser: Browser, value: boolean): Promise<void> {
  const ctx = await browser.newContext({ storageState: PLATFORM_STATE, baseURL: BASE });
  const res = await ctx.request.post('/api/admin/platform-settings', { headers: ORIGIN, data: { key: 'policy_export.package.enabled', value } });
  expect(res.status(), await res.text()).toBe(200);
  await ctx.close();
}

async function ownerContext(browser: Browser) {
  return browser.newContext({ storageState: OWNER_STATE, baseURL: BASE });
}

async function createPolicy(browser: Browser, name: string, content: string, approve: boolean): Promise<string> {
  const ctx = await ownerContext(browser);
  const res = await ctx.request.post('/api/policies', { headers: ORIGIN, data: { name, content, locale: 'en-US' } });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await ctx.close();
  if (approve) psql('aster_cloud', `update "PolicyVersion" set status = 'APPROVED' where "policyId" = '${id}' and version = 1`);
  return id;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  await setPackageExportFlag(browser, false);
  const run = Date.now();
  ids.exportable = await createPolicy(browser, `e2e-786-cedar-${run}`, EXPORTABLE(`guard.cedar.e786a${run}`), true);
  ids.notExportable = await createPolicy(browser, `e2e-786-textlen-${run}`, NOT_EXPORTABLE, true);
  ids.draft = await createPolicy(browser, `e2e-786-draft-${run}`, EXPORTABLE(`guard.cedar.e786d${run}`), false);
});

test.afterAll(async ({ browser }) => {
  const ctx = await ownerContext(browser);
  for (const id of Object.values(ids).filter(Boolean)) {
    await ctx.request.delete(`/api/policies/${id}`, { headers: ORIGIN }).catch(() => undefined);
  }
  await ctx.close();
});

/**
 * 页面主区。详情页在服务端等可导出性检查时会流式渲染：内容先落在一个隐藏的流式容器里、再换进主区，
 * 换入之前同一个 testid 会出现两份，故一律限定在主区里找。
 */
const main = (page: Page) => page.locator('#dashboard-main');

/** 页面一创建就记录导出按钮是否出现过（含水合前后的任何瞬间） */
async function watchExportButton(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cedarSeen: boolean };
    w.__cedarSeen = false;
    const check = () => {
      if (document.querySelector('[data-testid="cedar-export-button"]')) w.__cedarSeen = true;
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', check);
  });
}

/** 操作组里每个按钮 / 链接的盒子（视口坐标，已滚到顶部） */
async function actionBoxes(page: Page) {
  return main(page).getByTestId('policy-actions').evaluate((group) => {
    window.scrollTo(0, 0);
    return Array.from(group.querySelectorAll<HTMLElement>('a[href], button')).map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute('aria-label') || el.innerText.trim(), x: r.x, y: r.y, w: r.width, h: r.height };
    });
  });
}

const INVITEE = { id: 'ui-pro', email: 'ui-pro@ui-audit.test' };

/** 团队 owner 给 ui-pro 发一份邀请（已有未接受的就复用），返回其 token */
async function pendingInvitationToken(browser: Browser): Promise<string> {
  const ctx = await ownerContext(browser);
  await ctx.request.post('/api/teams/ui-audit-team/invitations', { headers: ORIGIN, data: { email: INVITEE.email, role: 'member' } });
  await ctx.close();
  const token = psql('aster_cloud', `select token from "TeamInvitation" where email = '${INVITEE.email}' order by "createdAt" desc limit 1`);
  expect(token, 'invitation token').not.toBe('');
  return token;
}

for (const vp of VIEWPORTS) {
  test.describe(`policy detail actions (${vp.name})`, () => {
    test.use({ ...vp.use, storageState: OWNER_STATE });

    test('Export to Cedar sits in the top-right action group with matching style and tap targets', async ({ page }) => {
      await page.goto(`/en/policies/${ids.exportable}`);
      const group = main(page).getByTestId('policy-actions');
      const exportButton = group.getByRole('button', { name: 'Export to Cedar' });
      await expect(exportButton).toBeEnabled();
      const boxes = await actionBoxes(page);
      expect(boxes.map((b) => b.name)).toEqual(['Execute', 'Edit', 'Export to Cedar', 'Delete']);
      // 与同组按钮同高
      const heights = new Set(boxes.map((b) => Math.round(b.h)));
      expect(heights.size, JSON.stringify(boxes)).toBe(1);
      for (const name of ['Execute', 'Edit', 'Export to Cedar', 'Delete']) {
        await expectUnclipped(group.getByRole(name === 'Execute' || name === 'Edit' ? 'link' : 'button', { name, exact: true }));
      }
      // 页面不横向溢出
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (vp.name === 'desktop') {
        // 桌面：一行排在页头右侧
        expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1);
        const right = Math.max(...boxes.map((b) => b.x + b.w));
        const h1 = await page.getByRole('heading', { level: 1 }).boundingBox();
        expect(right).toBeGreaterThan((h1?.x ?? 0) + 800);
      } else {
        // 移动端：点击区 ≥ 44×44（真实尺寸或 ::after 撑出的点击区）
        const targets = await group.evaluate((g) => Array.from(g.querySelectorAll<HTMLElement>('a[href], button')).map((el) => {
          const r = el.getBoundingClientRect();
          const after = getComputedStyle(el, '::after');
          const w = Math.max(r.width, after.content !== 'none' ? parseFloat(after.width) || 0 : 0);
          const h = Math.max(r.height, after.content !== 'none' ? parseFloat(after.height) || 0 : 0);
          return { name: el.getAttribute('aria-label') || el.innerText.trim(), w, h };
        }));
        for (const t of targets) expect(t.w >= 44 && t.h >= 44, JSON.stringify(t)).toBe(true);
      }
    });

    test('the export result appears right under the action group, live-announced, without moving the actions', async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto(`/en/policies/${ids.exportable}`);
      const status = main(page).getByTestId('cedar-export-status');
      await expect(status).toHaveAttribute('aria-live', 'polite');
      const before = await actionBoxes(page);
      const downloads: unknown[] = [];
      page.on('download', (d) => downloads.push(d));
      await main(page).getByTestId('policy-actions').getByRole('button', { name: 'Export to Cedar' }).click();
      const message = status.getByText(/Verified against Cedar on \d+ probes/);
      await expect(message).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => downloads.length).toBe(2);
      // 操作组不受影响：位置不变、仍完整可见
      expect(await actionBoxes(page)).toEqual(before);
      await expectUnclipped(main(page).getByTestId('policy-actions').getByRole('button', { name: 'Delete' }));
      // 状态区紧贴操作组下方
      const groupBox = (await main(page).getByTestId('policy-actions').boundingBox())!;
      const msgBox = (await message.boundingBox())!;
      expect(msgBox.y).toBeGreaterThanOrEqual(groupBox.y + groupBox.height - 1);
      expect(msgBox.y - (groupBox.y + groupBox.height)).toBeLessThan(48);
      if (vp.name === 'desktop') {
        // 桌面靠右，与操作组右缘对齐
        expect(Math.abs(msgBox.x + msgBox.width - (groupBox.x + groupBox.width))).toBeLessThan(2);
      }
    });

    test('a policy that cannot be exported never shows the button, not even for a moment', async ({ page }) => {
      await watchExportButton(page);
      await page.goto(`/en/policies/${ids.notExportable}`);
      await page.waitForLoadState('networkidle');
      await expect(main(page).getByTestId('policy-actions').getByRole('link', { name: 'Edit' })).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __cedarSeen: boolean }).__cedarSeen)).toBe(false);
      await expect(main(page).getByTestId('cedar-export-status')).toHaveCount(0);
    });

    test('an exportable policy has the button in the server-rendered HTML (no loading state to flash)', async ({ page }) => {
      const html = await (await page.request.get(`/en/policies/${ids.exportable}`)).text();
      expect(html).toContain('data-testid="cedar-export-button"');
      const notHtml = await (await page.request.get(`/en/policies/${ids.notExportable}`)).text();
      expect(notHtml).not.toContain('data-testid="cedar-export-button"');
    });

    test('draft only: the button is disabled and the approve-first hint sits in the status region', async ({ page }) => {
      await page.goto(`/en/policies/${ids.draft}`);
      const button = main(page).getByTestId('policy-actions').getByRole('button', { name: 'Export to Cedar' });
      await expect(button).toBeDisabled();
      const hint = main(page).getByTestId('cedar-export-status').getByText('Approve a version before exporting to Cedar');
      await expect(hint).toBeVisible();
      await expect(button).toHaveAttribute('aria-describedby', (await hint.getAttribute('id'))!);
    });
  });

  test.describe(`policy detail Export menu, package export on (${vp.name})`, () => {
    test.use({ ...vp.use, storageState: OWNER_STATE });
    test.beforeAll(async ({ browser }) => setPackageExportFlag(browser, true));
    test.afterAll(async ({ browser }) => setPackageExportFlag(browser, false));

    test('the Export menu replaces the Cedar button in place, with matching height and tap targets', async ({ page }) => {
      await watchExportButton(page);
      await page.goto(`/en/policies/${ids.exportable}`);
      const group = main(page).getByTestId('policy-actions');
      const trigger = group.getByTestId('policy-export-menu-button');
      await expect(trigger).toBeVisible();
      const boxes = await actionBoxes(page);
      expect(boxes.map((b) => b.name)).toEqual(['Execute', 'Edit', 'Export', 'Delete']);
      expect(new Set(boxes.map((b) => Math.round(b.h))).size, JSON.stringify(boxes)).toBe(1);
      await expectUnclipped(trigger);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (vp.name === 'mobile') {
        const t = await trigger.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const after = getComputedStyle(el, '::after');
          return {
            w: Math.max(r.width, after.content !== 'none' ? parseFloat(after.width) || 0 : 0),
            h: Math.max(r.height, after.content !== 'none' ? parseFloat(after.height) || 0 : 0),
          };
        });
        expect(t.w >= 44 && t.h >= 44, JSON.stringify(t)).toBe(true);
      }
      // 下拉形态下单按钮从首帧起就没出现过
      expect(await page.evaluate(() => (window as unknown as { __cedarSeen: boolean }).__cedarSeen)).toBe(false);
    });

    test('the Export menu arrives with the server-rendered HTML (no loading state to flash)', async ({ page }) => {
      const html = await (await page.request.get(`/en/policies/${ids.exportable}`)).text();
      expect(html).toContain('data-testid="policy-export-menu-button"');
      expect(html).not.toContain('data-testid="cedar-export-button"');
    });
  });

  test.describe(`versions row menu (${vp.name})`, () => {
    test.use({ ...vp.use, storageState: OWNER_STATE });

    test('"Submit for approval" on the last (only) row is fully visible and clickable', async ({ page }) => {
      await page.goto(`/en/policies/${ids.draft}/versions`);
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'v1', exact: true }) });
      const menuButton = row.getByRole('button', { name: /actions/i });
      await expectUnclipped(menuButton);
      await menuButton.click();
      const submit = page.getByRole('button', { name: 'Submit for approval' });
      await expectUnclipped(submit);
      if (vp.name === 'mobile') {
        const box = (await submit.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      await submit.click();
      // 打开提交对话框（取消，不改数据）
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: /cancel/i }).click();
      await expect(dialog).toBeHidden();
    });

    test('the menu follows its trigger when the page scrolls', async ({ page }) => {
      await page.goto(`/en/policies/${ids.draft}/versions`);
      const row = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'v1', exact: true }) });
      const menuButton = row.getByRole('button', { name: /actions/i });
      await menuButton.click();
      const submit = page.getByRole('button', { name: 'Submit for approval' });
      const gap = async () => {
        const t = (await menuButton.boundingBox())!;
        const s = (await submit.boundingBox())!;
        return Math.round(s.y - (t.y + t.height));
      };
      const g0 = await gap();
      await page.evaluate(() => window.scrollBy(0, 40));
      await expect.poll(gap).toBe(g0);
    });
  });

  test.describe(`team invitation acceptance (${vp.name})`, () => {
    test.use({ ...vp.use, storageState: join(STATE_DIR, `state-${INVITEE.id}.json`) });

    test.afterAll(() => {
      psql('aster_cloud', `delete from "TeamInvitation" where email = '${INVITEE.email}'`);
    });

    test('Accept and Cancel on the invitation page are fully visible', async ({ page, browser }) => {
      const token = await pendingInvitationToken(browser);
      await page.goto(`/en/teams/invite?token=${token}`);
      await expectUnclipped(page.getByRole('button', { name: /accept invitation/i }));
      await expectUnclipped(page.getByRole('main').getByRole('link', { name: /^cancel$/i }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
}
