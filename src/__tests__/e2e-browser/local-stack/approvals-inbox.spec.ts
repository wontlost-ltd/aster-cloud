/**
 * ADR 0042 审批收件箱：按已验证业务角色决定能否审批。
 * m-dpo 持有 "Data Protection Officer" → 可审批；m-free / owner1 无该角色 → 只读。
 */
import { test, expect, type Page } from '@playwright/test';
import { NOT_LOCAL, NOT_LOCAL_REASON, psql, stateFor } from './helpers';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
// dev 服务器为单实例，并行会互相拖慢导致超时，统一串行
test.describe.configure({ mode: 'serial' });

const TEAM = 'Stack Team';

// 收件箱数据行（带 data-decision-id 的 tr），且属于 team1 工作区
function teamRows(page: Page) {
  return page.locator('tr[data-decision-id]').filter({ hasText: TEAM });
}

async function openPending(page: Page) {
  await page.goto('/en/approvals');
  await expect(page.getByRole('heading', { name: 'Approvals' }).first()).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Pending' })).toHaveAttribute('aria-selected', 'true');
  await expect(teamRows(page).first()).toBeVisible();
}

test.describe('DPO 可审批', () => {
  test.use({ storageState: stateFor('m-dpo') });

  test('待审批行带 Approve / Reject 按钮', async ({ page }) => {
    await openPending(page);
    const row = teamRows(page).first();
    await expect(row).toContainText('Data Protection Officer');
    await expect(row).toContainText('Pending');
    await expect(row.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Reject' })).toBeVisible();
  });

  test('批准一条后移入 Approved 页签，aster-api 行变为 APPROVED', async ({ page }) => {
    // 只挑 e2e 发起的待审批（不动 m-free 的，那些供日志页用例使用）
    const decisionId = psql(
      'aster_policy',
      "select decision_id from guard_approvals where tenant_id='team1' and status='PENDING' " +
        "and principal_id like 'e2e-%' and expires_at > now() order by created_at asc limit 1",
    );
    test.skip(!decisionId, '没有可用的 e2e 待审批；先运行 aster-guard scripts/e2e-local.mjs 生成一条');

    await openPending(page);
    const row = page.locator(`tr[data-decision-id="${decisionId}"]`);
    await row.getByRole('button', { name: 'Approve' }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve' });
    await dialog.getByLabel('Comment (optional)').fill('E2E 本地验收：DPO 批准');
    await dialog.getByRole('button', { name: 'Confirm approval' }).click();
    // 决定后列表重新拉取（dev 首次编译接口可能较慢）
    await expect(row).toHaveCount(0, { timeout: 20_000 });

    await page.getByRole('tab', { name: 'Approved' }).click();
    const approvedRow = page.locator(`tr[data-decision-id="${decisionId}"]`);
    await expect(approvedRow).toContainText('Approved');
    await expect(approvedRow).toContainText('Decided by');

    const status = psql('aster_policy', `select status from guard_approvals where decision_id='${decisionId}'`);
    expect(status).toBe('APPROVED');
  });
});

for (const user of ['m-free', 'owner1'] as const) {
  test.describe(`${user} 只读`, () => {
    test.use({ storageState: stateFor(user) });

    test('可见待审批行但无操作按钮，显示 View only', async ({ page }) => {
      await openPending(page);
      const rows = teamRows(page);
      await expect(rows.first().getByText('View only')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);
    });
  });
}
