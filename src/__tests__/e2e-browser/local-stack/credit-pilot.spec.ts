/**
 * ADR 0044 §5 信贷试点端到端：执行需审批申请 → 日志 guard 入口 → 合规官批准 →
 * What-If v1→v2 转移 → 证据包 v3 导出与 Article 14 款项对照。
 * 执行走 API（执行页表单由 schema 动态生成，难以稳定驱动），其余步骤全部走页面。
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { PILOT_APPLICANTS } from '@/config/credit-pilot-source';
import { EXPECTED_CLAUSE_STATUS, diffClauses, type ClauseMappingLike } from '../../../../scripts/lib/credit-pilot-expectations';
import { NOT_LOCAL, NOT_LOCAL_REASON, psql, stateFor } from './helpers';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
// dev 服务器为单实例，并行会互相拖慢导致超时，统一串行
test.describe.configure({ mode: 'serial' });

const POLICY = 'pol-credit-pilot';
const API_KEY = process.env.CP_API_KEY;

interface Bundle {
  manifest: { schemaVersion: string; regulatoryMapping: ClauseMappingLike };
  entries: Array<{ whatIf?: unknown }>;
}

/** 以指定角色开新上下文执行一段页面操作，结束即关闭。 */
async function asUser<T>(
  browser: Browser,
  user: Parameters<typeof stateFor>[0],
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({ storageState: stateFor(user) });
  try {
    return await fn(await context.newPage());
  } finally {
    await context.close();
  }
}

test('信贷试点：执行、审批、What-If、证据导出与 Article 14 对照', async ({ browser, request }) => {
  test.setTimeout(180_000);
  test.skip(!API_KEY, '缺少 CP_API_KEY，无法执行试点策略');

  await test.step('API 执行一笔需审批申请', async () => {
    const res = await request.post(`/api/v1/policies/${POLICY}/execute`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      data: { input: { applicant: PILOT_APPLICANTS.requireApproval } },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.metadata.outcome).toBe('REQUIRE_APPROVAL');
    expect(body.data.metadata.evidenceCorrelationId).toBeTruthy();
  });

  await test.step('日志最新行带待审批入口', () =>
    asUser(browser, 'cp-analyst', async (page) => {
      await page.goto(`/en/policies/${POLICY}/logs`);
      const link = page.getByRole('link', { name: 'Pending approval · View' }).first();
      await expect(link).toBeVisible();
      expect(await link.getAttribute('href')).toMatch(/\/approvals\?decisionId=[0-9a-f-]{36}$/);
    }));

  await test.step('合规官批准最新待审批', () =>
    asUser(browser, 'cp-officer', async (page) => {
      const decisionId = psql(
        'aster_policy',
        "select decision_id from guard_approvals where tenant_id='credit-pilot' and status='PENDING' " +
          'order by created_at desc limit 1',
      );
      expect(decisionId, '试点租户没有待审批').toBeTruthy();
      await page.goto('/en/approvals');
      const row = page.locator(`tr[data-decision-id="${decisionId}"]`);
      await row.getByRole('button', { name: 'Approve' }).click();
      const dialog = page.getByRole('dialog', { name: 'Approve' });
      await dialog.getByLabel('Comment (optional)').fill('E2E 信贷试点：合规官批准');
      await dialog.getByRole('button', { name: 'Confirm approval' }).click();
      // 决定后列表重新拉取（dev 首次编译接口可能较慢）
      await expect(row).toHaveCount(0, { timeout: 20_000 });
      const status = psql('aster_policy', `select status from guard_approvals where decision_id='${decisionId}'`);
      expect(status).toBe('APPROVED');
    }));

  await test.step('What-If v1→v2 出现 Needs approval → Allow 转移', () =>
    asUser(browser, 'cp-analyst', async (page) => {
      await page.goto(`/en/policies/${POLICY}`);
      await page.getByRole('button', { name: 'Compare versions' }).click();
      const selects = page.locator('select').filter({ has: page.locator('option', { hasText: /^v\d+ - / }) });
      await expect(selects).toHaveCount(2);
      await selects.nth(0).selectOption('1');
      await selects.nth(1).selectOption('2');
      // 本轮执行发生在今天，需包含今天
      await page.getByLabel('Include today (not yet complete)').check();
      await page.getByRole('button', { name: 'Run analysis' }).click();
      await expect(page.getByText('Decision transitions')).toBeVisible({ timeout: 90_000 });
      const row = page.getByRole('row').filter({ hasText: 'Needs approval → Allow' });
      await expect(row).toBeVisible();
      const count = Number(await row.getByRole('cell').last().textContent());
      expect(count).toBeGreaterThanOrEqual(1);
    }));

  await test.step('导出证据包 v3 并对照 Article 14 款项', () =>
    asUser(browser, 'cp-owner', async (page) => {
      await page.goto('/en/reports');
      await page.getByLabel('Policy').selectOption({ label: 'Credit pilot (ADR 0044)' });
      await page.getByLabel('Format').selectOption({ label: 'JSON' });
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/^aster-evidence-[0-9a-f]{12}\.json$/);
      const bundle = JSON.parse(readFileSync(await download.path(), 'utf8')) as Bundle;

      expect(bundle.manifest.schemaVersion).toBe('3');
      expect(diffClauses(bundle.manifest.regulatoryMapping, EXPECTED_CLAUSE_STATUS)).toEqual([]);
      expect(bundle.entries.some((e) => e.whatIf != null)).toBe(true);
    }));
});
