/**
 * Guard 对账治理页：aster-cloud 本地栈端到端（ADR 0061 计划 Task 8，cloud#769）。
 *
 * 前置：同 guard-bypass / credit-pilot（`pnpm seed:credit-pilot`、`CP_API_KEY` 为 cp-owner 的 key、会话夹具含
 * cp-owner 与 cp-analyst）；aster-api 为含 ADR 0061 A1 的镜像，且容器设
 * `ASTER_GUARD_RECONCILIATION_CRON='*\/10 * * * * ?'`、`ASTER_GUARD_RECONCILIATION_MIN_INTERVAL=PT5S`，
 * 使上报后数十秒内即可检出孤儿。
 *
 * 场景：
 *   1. 以 CP_API_KEY 上报一条无 decisionId 的副作用 → 对账检出 `side_effect_without_decision`（critical）。
 *   2. 成员 cp-analyst：/governance 摘要卡里 credit-pilot 的 critical ≥ 1；明细页看到该行、没有「确认」，
 *      展开显示「上报未带决策 id」；直接调 BFF 确认 → 403。
 *   3. 管理员 cp-owner：确认（说明 `e2e ack`）→ 行离开 OPEN 视图；ACKNOWLEDGED 视图显示说明与确认人；
 *      链上有 `GUARD_ORPHAN_ACKNOWLEDGED`，metadata.comment = `e2e ack`、performed_by = cp-owner。
 *   4. 同一行再次确认（直接调 BFF）→ 409 `not_open`，带当前状态。
 * 会新增一条副作用上报、一条孤儿与一条确认链事件。
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { NOT_LOCAL, NOT_LOCAL_REASON, apiPost, psql, stateFor } from './helpers';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.skip(!process.env.CP_API_KEY, '缺少 CP_API_KEY，无法以 credit-pilot 租户上报副作用');
test.describe.configure({ mode: 'serial' });

const TENANT = 'credit-pilot';
const API_KEY = process.env.CP_API_KEY ?? '';
const EFFECT_ID = `e2e-rec-${randomUUID()}`;
const COMMENT = 'e2e ack';

/** 检出的孤儿 id（场景 1 写入，后续场景使用）。 */
let orphanId = 0;

async function asUser<T>(browser: Browser, user: Parameters<typeof stateFor>[0], fn: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ storageState: stateFor(user) });
  try {
    return await fn(await context.newPage());
  } finally {
    await context.close();
  }
}

/**
 * 直接调确认 BFF（同浏览器会话）。cloud 中间件对写请求做 CSRF 校验（Origin / Referer），页面内 fetch 自带 Origin，
 * APIRequestContext 不带，须显式给出；否则 403 `csrf_forbidden` 会被误当成权限判定。
 */
async function postAck(page: Page, comment: string) {
  const origin = new URL(page.url()).origin;
  return page.request.post(`/api/guard-reconciliation/${TENANT}/orphans/${orphanId}/ack`, {
    headers: { Origin: origin },
    data: { comment },
  });
}

/** 明细页：指定租户、缺省过滤（OPEN + critical,warning）。 */
async function openDetails(page: Page) {
  await page.goto(`/en/governance/reconciliation?tenant=${TENANT}`);
  await expect(page.getByTestId(`orphan-${orphanId}`)).toBeVisible({ timeout: 30_000 });
}

test('1. 上报无决策的副作用 → 对账检出 side_effect_without_decision', async () => {
  const res = await apiPost('/api/v1/guard/side-effects', API_KEY, {
    effects: [{
      effectId: EFFECT_ID,
      source: 'e2e-reconciliation',
      occurredAt: new Date().toISOString(),
      action: { name: 'delete_customer_record' },
      resource: { type: 'customer', id: 'C-E2E-REC' },
    }],
  });
  expect(res.status, res.text).toBe(200);
  expect(res.json).toMatchObject({ accepted: 1 });

  // effectId 由本用例生成（e2e-rec-<uuid>），拼进 SQL 前已知只含安全字符
  expect(EFFECT_ID).toMatch(/^e2e-rec-[0-9a-f-]{36}$/);
  await expect.poll(() => psql('aster_policy',
    `select id from guard_orphan_actions where tenant_id = '${TENANT}' and kind = 'side_effect_without_decision' `
    + `and status = 'OPEN' and detail->>'effectId' = '${EFFECT_ID}'`), { timeout: 90_000, intervals: [2_000] })
    .toMatch(/^[1-9][0-9]*$/);
  orphanId = Number(psql('aster_policy',
    `select id from guard_orphan_actions where tenant_id = '${TENANT}' and detail->>'effectId' = '${EFFECT_ID}'`));
});

test('2. 成员：摘要卡计数、明细行无确认按钮、展开说明未带决策 id、BFF 确认 403', async ({ browser }) => {
  await asUser(browser, 'cp-analyst', async (page) => {
    await page.goto('/en/governance');
    const row = page.getByTestId(`reconciliation-tenant-${TENANT}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    const critical = await row.locator('[data-severity="critical"]').innerText();
    expect(Number(critical.match(/\d+/)?.[0] ?? 0)).toBeGreaterThanOrEqual(1);
    await row.getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/governance/reconciliation\\?tenant=${TENANT}`));

    const orphan = page.getByTestId(`orphan-${orphanId}`);
    await expect(orphan).toBeVisible({ timeout: 30_000 });
    await expect(orphan).toContainText('Side effect without a decision');
    await expect(page).toHaveURL(/status=OPEN&severity=critical%2Cwarning/);
    await expect(orphan.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
    await orphan.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByTestId('no-decision-id')).toHaveText('The report did not include a decision ID.');
    await expect(page.getByTestId(`orphan-details-${orphanId}`)).toContainText(EFFECT_ID);

    // 现查角色为 member → BFF 403 forbidden（非 CSRF），不调用 aster-api
    const forbidden = await postAck(page, 'member attempt');
    expect(forbidden.status()).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: 'forbidden' });
  });
  // 成员的尝试未到达 aster-api：该行仍为 OPEN
  expect(psql('aster_policy', `select status from guard_orphan_actions where id = ${orphanId}`)).toBe('OPEN');
});

test('3. 管理员确认：行离开 OPEN 视图，ACKNOWLEDGED 显示说明与确认人，链上有确认事件', async ({ browser }) => {
  await asUser(browser, 'cp-owner', async (page) => {
    await openDetails(page);
    const orphan = page.getByTestId(`orphan-${orphanId}`);
    await orphan.getByRole('button', { name: 'Acknowledge' }).click();
    const dialog = page.getByTestId(`ack-dialog-${orphanId}`);
    await expect(dialog).toContainText('cannot be undone');
    const submit = dialog.getByRole('button', { name: 'Acknowledge permanently' });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel('What did you check? (required)').fill(`  ${COMMENT}  `);
    await submit.click();
    await expect(page.getByTestId('reconciliation-notice')).toHaveText('The orphan action was acknowledged.');
    await expect(orphan).toHaveCount(0);

    await page.getByRole('tab', { name: 'Acknowledged' }).click();
    await expect(page).toHaveURL(/status=ACKNOWLEDGED/);
    const acked = page.getByTestId(`orphan-${orphanId}`);
    await expect(acked).toBeVisible({ timeout: 30_000 });
    await acked.getByRole('button', { name: 'Details' }).click();
    const info = page.getByTestId('ack-info');
    await expect(info).toContainText(COMMENT);
    await expect(info).toContainText('cp-owner');
    await expect(info).not.toContainText('Unknown user');
  });

  expect(psql('aster_policy', `select status || '|' || coalesce(ack_comment, '') from guard_orphan_actions where id = ${orphanId}`))
    .toBe(`ACKNOWLEDGED|${COMMENT}`);
  const event = psql('aster_policy',
    `select performed_by || '|' || (metadata::jsonb->>'comment') from audit_logs `
    + `where event_type = 'GUARD_ORPHAN_ACKNOWLEDGED' and tenant_id = '${TENANT}' `
    + `and (metadata::jsonb->>'orphanId') = '${orphanId}' order by id desc limit 1`);
  expect(event).toBe(`cp-owner|${COMMENT}`);
});

test('4. 再次确认同一行 → 409 not_open，带当前状态', async ({ browser }) => {
  await asUser(browser, 'cp-owner', async (page) => {
    await page.goto('/en/governance');
    const res = await postAck(page, 'again');
    expect(res.status()).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_open', status: 'ACKNOWLEDGED' });
  });
});
