/**
 * ADR 0042 审批收件箱：按已验证业务角色决定能否审批。
 * m-dpo 持有 "Data Protection Officer" → 可审批；m-free / owner1 无该角色 → 只读。
 *
 * 待审批 24 小时过期，用例不依赖栈里手工维护的数据：beforeAll 经 aster-api 自补两条新的待审批，
 * 一条由 DPO 批准，另一条留给只读视角。
 */
import { test, expect, type Page } from '@playwright/test';
import { NOT_LOCAL, NOT_LOCAL_REASON, psql, seedPendingGuardApproval, stateFor } from './helpers';

const GUARD_API_KEY = process.env.E2E_GUARD_API_KEY ?? '';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.skip(!GUARD_API_KEY, '缺少 E2E_GUARD_API_KEY（team1 成员的 API key），无法自补待审批');
// dev 服务器为单实例，并行会互相拖慢导致超时，统一串行
test.describe.configure({ mode: 'serial' });

let toApprove = '';
let toView = '';

test.beforeAll(async () => {
  toApprove = await seedPendingGuardApproval(GUARD_API_KEY);
  toView = await seedPendingGuardApproval(GUARD_API_KEY);
});

function decisionRow(page: Page, decisionId: string) {
  return page.locator(`tr[data-decision-id="${decisionId}"]`);
}

async function openPending(page: Page, decisionId: string) {
  await page.goto('/en/approvals');
  await expect(page.getByRole('heading', { name: 'Approvals' }).first()).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Pending' })).toHaveAttribute('aria-selected', 'true');
  await expect(decisionRow(page, decisionId)).toBeVisible();
}

test.describe('DPO 可审批', () => {
  test.use({ storageState: stateFor('m-dpo') });

  test('待审批行带 Approve / Reject 按钮', async ({ page }) => {
    await openPending(page, toView);
    const row = decisionRow(page, toView);
    await expect(row).toContainText('Data Protection Officer');
    await expect(row).toContainText('Pending');
    await expect(row.getByRole('button', { name: 'Approve' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Reject' })).toBeVisible();
  });

  test('批准一条后移入 Approved 页签，aster-api 行变为 APPROVED', async ({ page }) => {
    await openPending(page, toApprove);
    const row = decisionRow(page, toApprove);
    await row.getByRole('button', { name: 'Approve' }).click();
    const dialog = page.getByRole('dialog', { name: 'Approve' });
    await dialog.getByLabel('Comment (optional)').fill('E2E 本地验收：DPO 批准');
    await dialog.getByRole('button', { name: 'Confirm approval' }).click();
    // 决定后列表重新拉取（dev 首次编译接口可能较慢）
    await expect(row).toHaveCount(0, { timeout: 20_000 });

    await page.getByRole('tab', { name: 'Approved' }).click();
    const approvedRow = decisionRow(page, toApprove);
    await expect(approvedRow).toContainText('Approved');
    await expect(approvedRow).toContainText('Decided by');

    const status = psql('aster_policy', `select status from guard_approvals where decision_id='${toApprove}'`);
    expect(status).toBe('APPROVED');
  });
});

for (const user of ['m-free', 'owner1'] as const) {
  test.describe(`${user} 只读`, () => {
    test.use({ storageState: stateFor(user) });

    test('可见待审批行但无操作按钮，显示 View only', async ({ page }) => {
      await openPending(page, toView);
      await expect(decisionRow(page, toView).getByText('View only')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Reject' })).toHaveCount(0);
    });
  });
}
