/**
 * ADR 0042 §5.4 执行日志 → 审批入口：待审批行带「Pending approval · View」链接。
 *
 * 待审批 24 小时过期，用例不依赖栈里手工维护的数据：beforeAll 经 aster-api 以 team1 成员的 key
 * 执行 guard.customer/decide（即 pol-adr0041-team），自补一条新的待审批执行，日志页因此必有待审批行。
 */
import { test, expect } from '@playwright/test';
import { NOT_LOCAL, NOT_LOCAL_REASON, seedPendingGuardApproval, stateFor } from './helpers';

const GUARD_API_KEY = process.env.E2E_GUARD_API_KEY ?? '';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.skip(!GUARD_API_KEY, '缺少 E2E_GUARD_API_KEY（team1 成员的 API key），无法自补待审批执行');
// dev 服务器为单实例，并行会互相拖慢导致超时，统一串行
test.describe.configure({ mode: 'serial' });
test.use({ storageState: stateFor('m-free') });

test.beforeAll(async () => {
  await seedPendingGuardApproval(GUARD_API_KEY);
});

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
