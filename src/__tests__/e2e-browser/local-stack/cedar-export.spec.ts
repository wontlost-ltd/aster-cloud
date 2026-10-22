/**
 * ADR 0047 导出为 Cedar：策略详情页点击「Export to Cedar」。
 *
 * 可导出策略的源码与 aster-api `src/test/resources/cedar/guard-cedar-sample.aster` 逐字一致（跨仓不便引用，此处内联）：
 * 导出后应显示与 Cedar 比对过的探针数，并下载 `.cedar` 与 `.cedarschema.json` 两个文件。
 * 另一条规则使用 `Text.length`（Cedar 无对应字符串长度运算），应列出 E721 诊断而不下载任何文件。
 * 可导出时还核对 aster-api 审计表的 POLICY_EXPORTED（claimedRef 与文件哈希）。
 * 策略均经 `POST /api/policies` 以 t1 身份新建（与界面新建同一路径，含编译门禁），用例结束软删除。
 * 导出的是 secure-execute 会执行的版本：新建的 v1 为 DRAFT，四眼原则下单用户无法自批，故直接在 aster_cloud
 * 库中把 v1 置为 APPROVED（仅测试夹具）；另一条用例保持草稿，断言面板提示先批准。
 */
import { test, expect, type Download, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NOT_LOCAL, NOT_LOCAL_REASON, psql, stateFor } from './helpers';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
// dev 服务器为单实例，并行会互相拖慢导致超时，统一串行
test.describe.configure({ mode: 'serial' });
test.use({ storageState: stateFor('t1') });

const GUARD_PREAMBLE =
  'Define GuardRequest has principal_id, principal_type, principal_roles, action, resource_type, resource_id, context, agent_model.\n\n';

const SAMPLE_SOURCE = `Module guard.cedar.sample.

${GUARD_PREAMBLE}@id("GCS-001")
@control("EU_AI_ACT:ART14")
Rule decide given req as GuardRequest, produce Verdict:
  Let large be req.context.amount at least 10000.
  When req.action equals to "delete_customer_record", require approval by "Data Protection Officer" because "customer record deletion".
  If List.contains(req.principal_roles, "suspended"):
    Return Verdict.deny("suspended principal").
  If large and req.action equals to "refund":
    Return Verdict.escalate("large refund").
  Otherwise allow.
`;

// 能通过编译门禁、但 Cedar 无法表达的条件（字符串长度）→ E721
const TEXT_LENGTH_SOURCE = `Module guard.cedar.textlen.

${GUARD_PREAMBLE}@id("GCS-E721")
Rule decide given req as GuardRequest, produce Verdict:
  If Text.length(req.action) at least 1:
    Return Verdict.deny("x").
  Return Verdict.allow().
`;

const created: string[] = [];
// 写接口有 CSRF 校验，页面外的 API 请求须带同源 Origin
const ORIGIN = { Origin: process.env.BASE_CLOUD as string };

async function createPolicy(page: Page, name: string, content: string, approve = true): Promise<string> {
  const res = await page.request.post('/api/policies', { headers: ORIGIN, data: { name, content, locale: 'en-US' } });
  expect(res.status(), await res.text()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  created.push(id);
  if (approve) psql('aster_cloud', `update "PolicyVersion" set status = 'APPROVED' where "policyId" = '${id}' and version = 1`);
  return id;
}

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: process.env.BASE_CLOUD, storageState: stateFor('t1') });
  for (const id of created) {
    await context.request.delete(`/api/policies/${id}`, { headers: ORIGIN }).catch(() => undefined);
  }
  await context.close();
});

test('可导出策略：显示 Cedar 比对结果并下载策略与 schema 两个文件', async ({ page }) => {
  test.setTimeout(120_000);
  const id = await createPolicy(page, `e2e-cedar-sample-${Date.now()}`, SAMPLE_SOURCE);
  await page.goto(`/en/policies/${id}`);

  // 面板一次点击触发两次下载，先挂监听再点击，避免漏掉第二个
  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.getByRole('button', { name: 'Export to Cedar' }).click();

  // 导出含逐探针等价性比对，冷启动下可能较慢
  await expect(page.getByText(/Verified against Cedar on \d+ probes/)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => downloads.length).toBe(2);

  const byName = new Map(downloads.map((d) => [d.suggestedFilename(), d]));
  const cedarName = [...byName.keys()].find((n) => n.endsWith('.cedar'));
  const schemaName = [...byName.keys()].find((n) => n.endsWith('.cedarschema.json'));
  // 文件名取 aster-api 响应的 moduleName
  expect(cedarName).toBe('guard.cedar.sample.cedar');
  expect(schemaName).toBe('guard.cedar.sample.cedarschema.json');

  const cedar = readFileSync((await byName.get(cedarName!)!.path())!, 'utf8');
  expect(cedar).toContain('@aster_rule("GCS-001")');
  const schemaText = readFileSync((await byName.get(schemaName!)!.path())!, 'utf8');
  expect(Object.keys(JSON.parse(schemaText) as Record<string, unknown>).length).toBeGreaterThan(0);

  // aster-api 审计链里的 POLICY_EXPORTED：claimedRef 带本策略 id，且两个下载文件的 SHA-256 与审计记录一致
  const metadata = psql(
    'aster_policy',
    `select metadata from audit_logs where event_type = 'POLICY_EXPORTED' and metadata like '%${id}%' order by id desc limit 1`,
  );
  const audit = JSON.parse(metadata) as { claimedRef: string; policiesHash: string; schemaHash: string; target: string };
  expect(audit.target).toBe('cedar');
  expect(JSON.parse(audit.claimedRef)).toMatchObject({ cloudPolicyId: id });
  const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
  expect(sha256(cedar)).toBe(audit.policiesHash);
  expect(sha256(schemaText)).toBe(audit.schemaHash);

  // 供验收记录留存与 Cedar CLI 交叉核对
  const outDir = process.env.CEDAR_EXPORT_OUT;
  if (outDir) {
    await byName.get(cedarName!)!.saveAs(`${outDir}/${cedarName}`);
    await byName.get(schemaName!)!.saveAs(`${outDir}/${schemaName}`);
    console.log(`[cedar-export] policyId=${id} files=${cedarName},${schemaName}`);
  }
});

test('不可导出策略（Text.length）：列出 E721 诊断且不下载文件', async ({ page }) => {
  test.setTimeout(120_000);
  const id = await createPolicy(page, `e2e-cedar-textlen-${Date.now()}`, TEXT_LENGTH_SOURCE);
  await page.goto(`/en/policies/${id}`);

  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await page.getByRole('button', { name: 'Export to Cedar' }).click();

  const alert = page.getByRole('alert').filter({ hasText: 'This policy cannot be exported to Cedar' });
  await expect(alert).toBeVisible({ timeout: 60_000 });
  await expect(alert).toContainText('E721');
  expect(downloads).toHaveLength(0);
});

test('无可执行版本（仅草稿）：按钮禁用并就地说明需先批准，不下载文件', async ({ page }) => {
  test.setTimeout(120_000);
  const id = await createPolicy(page, `e2e-cedar-draft-${Date.now()}`, SAMPLE_SOURCE, false);
  await page.goto(`/en/policies/${id}`);

  const downloads: Download[] = [];
  page.on('download', (d) => downloads.push(d));
  await expect(page.getByRole('button', { name: 'Export to Cedar' })).toBeDisabled({ timeout: 60_000 });
  await expect(page.getByText('Approve a version before exporting to Cedar')).toBeVisible();
  expect(downloads).toHaveLength(0);
});
