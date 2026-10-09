/**
 * ADR 0041 证据包 v2：导出 JSON，校验 manifest.schemaVersion 与 guard-approval 审阅人。
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { NOT_LOCAL, NOT_LOCAL_REASON, stateFor } from './helpers';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
// dev 服务器为单实例，并行会互相拖慢导致超时，统一串行
test.describe.configure({ mode: 'serial' });
test.use({ storageState: stateFor('m-free') });

interface Reviewer { source: string; role: string; roleVerified: boolean; outcome: string }
interface Bundle {
  manifest: { schemaVersion: string; bundleHash: string };
  entries: Array<{ reviewers?: Reviewer[] }>;
}

test('导出 JSON 证据包：schemaVersion 2 且含已验证角色的 guard-approval 审阅人', async ({ page }) => {
  await page.goto('/en/reports');
  await expect(page.getByRole('heading', { name: 'Evidence export' }).first()).toBeVisible();

  await page.getByLabel('Policy').selectOption({ label: 'ADR0041 team acceptance' });
  await page.getByLabel('Format').selectOption({ label: 'JSON' });

  // 导出成功后页面直接跳转到下载路由，捕获下载文件
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^aster-evidence-[0-9a-f]{12}\.json$/);
  const bundle = JSON.parse(readFileSync(await download.path(), 'utf8')) as Bundle;

  expect(bundle.manifest.schemaVersion).toBe('3');
  expect(bundle.manifest.bundleHash).toMatch(/^[0-9a-f]{64}$/);
  const reviewers = bundle.entries.flatMap((e) => e.reviewers ?? []);
  expect(reviewers).toContainEqual(
    expect.objectContaining({ source: 'guard-approval', role: 'Data Protection Officer', roleVerified: true }),
  );

  // 历史列表里出现已完成的记录，且下载链接可用同一会话取回同一包
  const firstRow = page.getByRole('row').filter({ hasText: 'Completed' }).first();
  await expect(firstRow).toBeVisible();
  const href = await firstRow.getByRole('link', { name: 'Download' }).getAttribute('href');
  expect(href).toMatch(/^\/api\/reports\/[^/]+\/download$/);
  const res = await page.request.get(href!);
  expect(res.ok()).toBeTruthy();
  const again = (await res.json()) as Bundle;
  expect(again.manifest.bundleHash).toBe(bundle.manifest.bundleHash);
});
