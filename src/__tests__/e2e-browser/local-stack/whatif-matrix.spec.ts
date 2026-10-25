/**
 * ADR 0043 What-If 四态转移矩阵：v1（require_approval）→ v2（escalate）。
 *
 * 窗口内的执行数随栈上其他用例与时间变化，不写死：以本次批次给出的可回放总数为基线断言。
 * 夹具策略只对 delete_customer_record 分支：v1 需审批、v2 升级；其余动作两版都放行。
 * 故断言（1）矩阵各格之和等于可比执行数；（2）至少有一条「Needs approval → Escalate」；
 * （3）除 Allow → Allow 外不出现其他转移。
 */
import { test, expect, type Page } from '@playwright/test';
import { NOT_LOCAL, NOT_LOCAL_REASON, stateFor } from './helpers';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
// dev 服务器为单实例，并行会互相拖慢导致超时，统一串行
test.describe.configure({ mode: 'serial' });
test.use({ storageState: stateFor('m-free') });

// 取页面文案中的第一个整数；文案不存在时为 0
async function leadingCount(page: Page, pattern: RegExp): Promise<number> {
  const text = page.getByText(pattern);
  if ((await text.count()) === 0) return 0;
  const match = /(\d+)/.exec(await text.first().innerText());
  return match ? Number(match[1]) : 0;
}

test('v1→v2 回放后展示 Needs approval → Escalate 转移，计数与回放基线一致', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/en/policies/pol-adr0041-team');
  await page.getByRole('button', { name: 'Compare versions' }).click();

  // 版本对比的两个原生 select：基准 / 比较
  const selects = page.locator('select').filter({ has: page.locator('option', { hasText: /^v\d+ - / }) });
  await expect(selects).toHaveCount(2);
  await selects.nth(0).selectOption('1');
  await selects.nth(1).selectOption('2');

  // 种子执行可能发生在今天，需包含今天
  await page.getByLabel('Include today (not yet complete)').check();
  await page.getByRole('button', { name: 'Run analysis' }).click();

  // 批次完成前不出结果，最长等 90 秒
  await expect(page.getByText('Decision transitions')).toBeVisible({ timeout: 90_000 });

  const sampled = await leadingCount(page, /^Based on all \d+ re-runnable executions/);
  const incomparable = await leadingCount(page, /executions could not be compared/);
  expect(sampled, '窗口内没有可回放的执行').toBeGreaterThan(0);

  const row = page.getByRole('row').filter({ hasText: 'Needs approval → Escalate' });
  await expect(row).toBeVisible();

  // 读出矩阵所有数据行：「From → To」与计数
  const cells = await page.getByRole('row').filter({ hasText: '→' }).evaluateAll(rows =>
    rows.map(r => Array.from(r.querySelectorAll('td')).map(td => td.textContent?.trim() ?? '')));
  const transitions = new Map(cells.filter(c => c.length >= 2).map(c => [c[0]!, Number(c[c.length - 1])]));
  expect(transitions.get('Needs approval → Escalate') ?? 0).toBeGreaterThan(0);
  expect([...transitions.keys()].filter(k => k !== 'Needs approval → Escalate' && k !== 'Allow → Allow')).toEqual([]);
  const total = [...transitions.values()].reduce((a, b) => a + b, 0);
  expect(total, '矩阵各格之和应等于可比执行数').toBe(sampled - incomparable);
});
