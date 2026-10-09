/**
 * ADR 0042 团队业务角色：owner 在成员页查看与编辑业务角色。
 * 用例结束时还原 m-free 的角色，保证可重复运行。
 */
import { test, expect, type Page } from '@playwright/test';
import { NOT_LOCAL, NOT_LOCAL_REASON, psql, stateFor } from './helpers';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.use({ storageState: stateFor('owner1') });

function memberRow(page: Page, email: string) {
  return page.getByRole('listitem').filter({ hasText: email });
}

async function saveRoles(page: Page, email: string, value: string) {
  const row = memberRow(page, email);
  await row.getByRole('button', { name: 'Edit' }).click();
  const input = row.getByRole('textbox', { name: 'e.g. Data Protection Officer, CISO' });
  await input.fill(value);
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(input).toHaveCount(0);
}

test('DPO 成员显示业务角色芯片，可为 m-free 增删 CISO', async ({ page }) => {
  await page.goto('/en/teams/team1/members');
  await expect(memberRow(page, 'm-dpo@stack.test')).toContainText('Data Protection Officer');

  const free = memberRow(page, 'm-free@stack.test');
  await expect(free).toContainText('Business roles:');
  await expect(free.getByText('CISO', { exact: true })).toHaveCount(0);

  await saveRoles(page, 'm-free@stack.test', 'CISO');
  await expect(free.getByText('CISO', { exact: true })).toBeVisible();
  expect(psql('aster_cloud', `select array_to_string("businessRoles", ',') from "TeamMember" where "teamId"='team1' and "userId"='m-free'`)).toBe('CISO');

  // 刷新后仍在：确认已持久化而非仅本地状态
  await page.reload();
  await expect(memberRow(page, 'm-free@stack.test').getByText('CISO', { exact: true })).toBeVisible();

  // 还原：清空角色
  await saveRoles(page, 'm-free@stack.test', '');
  await expect(memberRow(page, 'm-free@stack.test').getByText('CISO', { exact: true })).toHaveCount(0);
  await expect(memberRow(page, 'm-free@stack.test')).toContainText('None');
  expect(psql('aster_cloud', `select array_to_string("businessRoles", ',') from "TeamMember" where "teamId"='team1' and "userId"='m-free'`)).toBe('');
});
