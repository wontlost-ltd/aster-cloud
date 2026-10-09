/**
 * ADR 0043 What-If 四态转移矩阵：v1（require_approval）→ v2（escalate）。
 */
import { test, expect } from '@playwright/test';
import { NOT_LOCAL, NOT_LOCAL_REASON, stateFor } from './helpers';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
// dev 服务器为单实例，并行会互相拖慢导致超时，统一串行
test.describe.configure({ mode: 'serial' });
test.use({ storageState: stateFor('m-free') });

test('v1→v2 回放后展示 Needs approval → Escalate 转移', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/en/policies/pol-adr0041-team');
  await page.getByRole('button', { name: 'Compare versions' }).click();

  // 版本对比的两个原生 select：基准 / 比较
  const selects = page.locator('select').filter({ has: page.locator('option', { hasText: /^v\d+ - / }) });
  await expect(selects).toHaveCount(2);
  await selects.nth(0).selectOption('1');
  await selects.nth(1).selectOption('2');

  // 种子执行发生在今天，需包含今天
  await page.getByLabel('Include today (not yet complete)').check();
  await page.getByRole('button', { name: 'Run analysis' }).click();

  // 批次完成前不出结果，最长等 90 秒
  await expect(page.getByText('Decision transitions')).toBeVisible({ timeout: 90_000 });
  const row = page.getByRole('row').filter({ hasText: 'Needs approval → Escalate' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('cell').last()).toHaveText('2');
});
