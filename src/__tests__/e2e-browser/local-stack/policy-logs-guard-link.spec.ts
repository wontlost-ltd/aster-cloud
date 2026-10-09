/**
 * ADR 0042 §5.4 执行日志 → 审批入口：待审批行带「Pending approval · View」链接。
 */
import { test, expect } from '@playwright/test';
import { NOT_LOCAL, NOT_LOCAL_REASON, stateFor } from './helpers';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.use({ storageState: stateFor('m-free') });

test('待审批执行行链接到 /approvals?decisionId=', async ({ page }) => {
  await page.goto('/en/policies/pol-adr0041-team/logs');
  const link = page.getByRole('link', { name: 'Pending approval · View' }).first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/\/approvals\?decisionId=[0-9a-f-]{36}$/);

  // 点击后进入收件箱并高亮对应决策行
  const decisionId = href!.split('decisionId=')[1];
  await link.click();
  await expect(page).toHaveURL(/\/approvals\?decisionId=/);
  await expect(page.locator(`tr[data-decision-id="${decisionId}"]`)).toBeVisible();
});
