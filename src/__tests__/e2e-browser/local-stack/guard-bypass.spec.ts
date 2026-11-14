/**
 * Guard 绕过红队：aster-cloud 本地栈场景（wontlost-ltd/aster-api#466 阶段 A，计划 Task A6）。
 *
 * <p>只在本地栈手动运行，不进任何 CI（跟进项 F1：缺可复现的 cloud + api + Postgres CI 环境）。
 * aster-api 侧的自动化必需检查是 JUnit 任务 `guardBypassTest`（`Guard bypass suite (#466)`），本文件不在其中。
 *
 * 场景：
 *   C7a 篡改的自报 applicant（仍需审批）→ 来源门 DENY unverified_input，不建待审批、不签执行收据
 *   C2  对 C7a 的 DENY 决策 consume → 409 not_allowed
 *   C3/C4/C5 审批通过的 from-evidence 收据：本地验签 ok、篡改载荷 bad_signature、改哈希 409 action_mismatch、
 *       正确哈希 200、重放 409 receipt_consumed、结果回写 200
 *   C7b 自报金额填小使规则 ALLOW（aster-api#510 裁定 (a)，ADR 0046 §11.8）：ALLOW 也须过来源门 → DENY unverified_input，
 *       执行响应 success=false、guard 块带原因码，策略结论仍为 approved
 *   C7c 正向对照：fixture 来源为真实申请人签事实 → 同一条 ALLOW 路径 guard 放行并签执行收据
 *
 * 前置同 credit-pilot.spec.ts：`pnpm seed:credit-pilot`、容器设 `ASTER_FACT_SIGNING_KEY`、`CP_API_KEY` 为 cp-owner 的 key、
 * 会话夹具含 cp-officer。会新增 4 次执行、批准一条 credit-pilot 待审批，并消耗其执行收据。
 */
import { test, expect, type Browser, type Page } from '@playwright/test';
import { PILOT_APPLICANTS, type PilotApplicant } from '@/config/credit-pilot-source';
import {
  NOT_LOCAL,
  NOT_LOCAL_REASON,
  apiGet,
  apiPost,
  psql,
  stateFor,
  verifyExecutionReceipt,
  type ExecutionReceipt,
} from './helpers';
import { randomUUID } from 'node:crypto';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.skip(!process.env.CP_API_KEY, '缺少 CP_API_KEY，无法执行试点策略');
test.describe.configure({ mode: 'serial' });

const POLICY = 'pol-credit-pilot';
const TENANT = 'credit-pilot';
const API_KEY = process.env.CP_API_KEY ?? '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** C7a 的 DENY 决策，供 C2 使用。 */
let deniedDecisionId = '';

async function asUser<T>(browser: Browser, user: Parameters<typeof stateFor>[0], fn: (page: Page) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ storageState: stateFor(user) });
  try {
    return await fn(await context.newPage());
  } finally {
    await context.close();
  }
}

/** v1 执行响应中本套件关心的部分（ADR 0046 §11.8 第 5 条：success 与 guard 块）。 */
interface ExecuteBody {
  success: boolean;
  data: { decision: string; metadata: { outcome: string; evidenceCorrelationId: string } };
  guard?: { required: string; decisionId?: string; effectiveOutcome?: string; reasonCode?: string; error?: string };
}

/** 经 cloud v1 执行端点执行一笔申请，返回完整响应体。 */
async function executeBody(
  request: import('@playwright/test').APIRequestContext,
  applicant: PilotApplicant,
): Promise<ExecuteBody> {
  const res = await request.post(`/api/v1/policies/${POLICY}/execute`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    data: { input: { applicant } },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as ExecuteBody;
  // 关联号随后拼进 psql 查询：先校验为 UUID，响应异常时不会把任意文本带进 SQL
  expect(body.data.metadata.evidenceCorrelationId).toMatch(UUID_RE);
  return body;
}

/** 执行一笔申请，返回执行元数据（outcome、证据关联号）。 */
async function execute(
  request: import('@playwright/test').APIRequestContext,
  applicant: PilotApplicant,
): Promise<{ outcome: string; evidenceCorrelationId: string }> {
  return (await executeBody(request, applicant)).data.metadata;
}

function decisionByCorrelation(corr: string): string {
  return psql('aster_policy',
    `select id from guard_decisions where tenant_id='${TENANT}' and evidence_correlation_id='${corr}'`);
}

function consumeBody(actionHash: string): Record<string, string> {
  return { actionHash, attemptId: randomUUID(), executorId: 'e2e-guard-bypass@local' };
}

test('C7a 篡改的自报 applicant（仍需审批）→ DENY unverified_input，无待审批', async ({ request }) => {
  // 收入改为任何 fixture 都没有的值：cloud 的 fixture.creditPilot 来源不为它签 context.applicant（仅与 fixture JCS 相等时签）
  const tampered = { ...PILOT_APPLICANTS.requireApproval, monthlyIncome: 9500 };
  const metadata = await execute(request, tampered);
  expect(metadata.outcome).toBe('REQUIRE_APPROVAL');

  const row = psql('aster_policy',
    `select id || '|' || (response_json->>'effectiveOutcome') || '|' || coalesce(reason_code, '') from guard_decisions `
    + `where tenant_id='${TENANT}' and evidence_correlation_id='${metadata.evidenceCorrelationId}'`);
  const [id, effective, reasonCode] = row.split('|');
  expect(id, '本次执行未开 guard 决策').toMatch(UUID_RE);
  expect(effective).toBe('DENY');
  expect(reasonCode).toBe('unverified_input');
  expect(psql('aster_policy', `select count(*) from guard_approvals where decision_id='${id}'`)).toBe('0');
  expect(psql('aster_policy', `select count(*) from guard_receipts where decision_id='${id}'`)).toBe('0');
  deniedDecisionId = id;
});

test('C2 DENY 决策 consume → 409 not_allowed', async () => {
  test.skip(!deniedDecisionId, '依赖 C7a 产出的 DENY 决策');
  const r = await apiPost(`/api/v1/guard/receipts/${deniedDecisionId}/consume`, API_KEY, consumeBody('a'.repeat(64)));
  expect(r.status, r.text).toBe(409);
  expect(r.json).toEqual({ error: 'not_allowed', effectiveOutcome: 'DENY' });
  expect(psql('aster_policy', `select count(*) from guard_receipts where decision_id='${deniedDecisionId}'`)).toBe('0');
});

/**
 * from-evidence 的 action 由 cloud 构造、执行方即 cloud，所以「正确哈希」取收据载荷里的 actionHash。
 * ADR 0054 §8 ④（cloud 自行 consume）落地后，本例改为断言 cloud 的 `consumedBy.executorId` 以 `aster-cloud-exec@`
 * 开头、测试自身的 consume 得到 409 receipt_consumed。
 */
test('C3/C4/C5 审批通过的 from-evidence 收据：验签、改哈希、重放', async ({ browser, request }) => {
  test.setTimeout(180_000);
  const metadata = await execute(request, PILOT_APPLICANTS.requireApproval);
  expect(metadata.outcome).toBe('REQUIRE_APPROVAL');
  const decisionId = decisionByCorrelation(metadata.evidenceCorrelationId);
  expect(decisionId, '本次执行未开 guard 决策').toMatch(UUID_RE);
  expect(psql('aster_policy', `select status from guard_approvals where decision_id='${decisionId}'`)).toBe('PENDING');

  await test.step('合规官在审批页批准', () =>
    asUser(browser, 'cp-officer', async (page) => {
      await page.goto('/en/approvals');
      const row = page.locator(`tr[data-decision-id="${decisionId}"]`);
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: 'Approve' }).click();
      const dialog = page.getByRole('dialog', { name: 'Approve' });
      await dialog.getByLabel('Comment (optional)').fill('E2E Guard 绕过套件：合规官批准');
      await dialog.getByRole('button', { name: 'Confirm approval' }).click();
      await expect(row).toHaveCount(0, { timeout: 20_000 });
      expect(psql('aster_policy', `select status from guard_approvals where decision_id='${decisionId}'`)).toBe('APPROVED');
    }));

  const decision = await apiGet(`/api/v1/guard/decisions/${decisionId}`, API_KEY);
  expect(decision.status, decision.text).toBe(200);
  expect(decision.json?.effectiveOutcome).toBe('ALLOW');
  const receipt = decision.json?.executionReceipt as ExecutionReceipt;
  expect(receipt, '审批转 ALLOW 应签发执行收据').toBeTruthy();
  const keys = await apiGet('/api/v1/guard/keys', API_KEY);
  expect(keys.status, keys.text).toBe(200);
  const jwks = keys.json as unknown as Parameters<typeof verifyExecutionReceipt>[1];
  const expected = { tenantId: TENANT, decisionId, now: new Date() };

  await test.step('C5 本地验签：原收据 ok、篡改载荷 bad_signature', () => {
    expect(verifyExecutionReceipt(receipt, jwks, expected)).toBe('ok');
    // evaluateSource 锚定的 from-evidence 决策没有已保存的策略版本，载荷不含该键
    expect(receipt.payload).not.toHaveProperty('policyVersionId');
    const later = new Date(Date.parse(receipt.payload.expiresAt) + 1000).toISOString();
    const forged: ExecutionReceipt = { ...receipt, payload: { ...receipt.payload, expiresAt: later } };
    expect(verifyExecutionReceipt(forged, jwks, expected)).toBe('bad_signature');
    expect(verifyExecutionReceipt(receipt, jwks, { ...expected, decisionId: randomUUID() })).toBe('decision_mismatch');
  });

  const hash = receipt.payload.actionHash;
  const flipped = hash.slice(0, -1) + (hash.endsWith('0') ? '1' : '0');
  await test.step('C3 改哈希 consume → 409 action_mismatch（不烧收据）', async () => {
    const r = await apiPost(`/api/v1/guard/receipts/${decisionId}/consume`, API_KEY, consumeBody(flipped));
    expect(r.status, r.text).toBe(409);
    expect(r.text).toBe('{"error":"action_mismatch"}');
    expect(psql('aster_policy', `select consumed_at is null from guard_receipts where decision_id='${decisionId}'`)).toBe('t');
  });

  await test.step('C4 正确哈希 200 → 重放 409 receipt_consumed → 结果回写 200', async () => {
    const first = consumeBody(hash);
    const ok = await apiPost(`/api/v1/guard/receipts/${decisionId}/consume`, API_KEY, first);
    expect(ok.status, ok.text).toBe(200);
    const replay = await apiPost(`/api/v1/guard/receipts/${decisionId}/consume`, API_KEY, consumeBody(hash));
    expect(replay.status, replay.text).toBe(409);
    expect(replay.json?.error).toBe('receipt_consumed');
    expect(replay.json?.attemptId).toBe(first.attemptId);
    const result = await apiPost(`/api/v1/guard/receipts/${decisionId}/result`, API_KEY,
      { attemptId: first.attemptId, executorId: first.executorId, status: 'executed' });
    expect(result.status, result.text).toBe(200);
    const audit = await apiGet(`/api/v1/audit/receipts?decisionIds=${decisionId}`, API_KEY);
    expect(audit.status, audit.text).toBe(200);
    const consumes = (audit.json?.consumes ?? []) as Array<{ authoritative: boolean; attemptId: string }>;
    expect(consumes.filter((c) => c.authoritative)).toEqual([expect.objectContaining({ attemptId: first.attemptId })]);
  });
});

/**
 * aster-api#510（用户裁定 (a)：ALLOW 也须过来源门，ADR 0046 §11.8）。高风险档案策略在自报金额「填小」后规则直接 ALLOW；
 * cloud 对这类 ALLOW 同样以证据登记 guard 决策，未附可验证事实即 DENY unverified_input。执行响应保留策略结论
 * （data.decision=approved、metadata.outcome=ALLOW），success=false，guard 块给出 guard 结论。
 *
 * 金额取 19999 而不是计划草稿里的 20000：`{ ...requireApproval, requestedAmount: 20000 }` 与 `PILOT_APPLICANTS.allow`
 * 逐字段相等，fixture 来源会为它签事实（输入被证实），那就不是「自报篡改」了。
 */
test('C7b 自报金额填小使规则 ALLOW：须过来源门 → DENY unverified_input（aster-api#510 裁定 (a)）', async ({ request }) => {
  const tampered = { ...PILOT_APPLICANTS.requireApproval, requestedAmount: 19999 };
  const body = await executeBody(request, tampered);
  expect(body.data.metadata.outcome).toBe('ALLOW');
  expect(body.data.decision).toBe('approved');
  expect(body.success, '高风险档案下 guard 未放行的 ALLOW 不构成执行授权').toBe(false);
  expect(body.guard).toEqual(expect.objectContaining({
    required: 'provenance', effectiveOutcome: 'DENY', reasonCode: 'unverified_input',
  }));

  const row = psql('aster_policy',
    `select id || '|' || (response_json->>'effectiveOutcome') || '|' || coalesce(reason_code, '') from guard_decisions `
    + `where tenant_id='${TENANT}' and evidence_correlation_id='${body.data.metadata.evidenceCorrelationId}'`);
  const [id, effective, reasonCode] = row.split('|');
  expect(id, 'ALLOW 结论也须开 guard 决策并过来源门').toMatch(UUID_RE);
  expect(`${effective}|${reasonCode}`).toBe('DENY|unverified_input');
  expect(body.guard?.decisionId).toBe(id);
  expect(psql('aster_policy', `select count(*) from guard_receipts where decision_id='${id}'`)).toBe('0');
  const r = await apiPost(`/api/v1/guard/receipts/${id}/consume`, API_KEY, consumeBody('a'.repeat(64)));
  expect(r.status, r.text).toBe(409);
  expect(r.json).toEqual({ error: 'not_allowed', effectiveOutcome: 'DENY' });
});

/** 正向对照：真实申请人（fixture 来源签 context.applicant）走同一条 ALLOW 路径 → guard ALLOW 并签执行收据。 */
test('C7c 已核实的 ALLOW → guard ALLOW，签发执行收据', async ({ request }) => {
  const body = await executeBody(request, PILOT_APPLICANTS.allow);
  expect(body.data.metadata.outcome).toBe('ALLOW');
  expect(body.success).toBe(true);
  expect(body.guard).toEqual(expect.objectContaining({ required: 'provenance', effectiveOutcome: 'ALLOW' }));
  const id = body.guard?.decisionId ?? '';
  expect(id).toMatch(UUID_RE);
  expect(psql('aster_policy', `select count(*) from guard_receipts where decision_id='${id}'`)).toBe('1');
});
