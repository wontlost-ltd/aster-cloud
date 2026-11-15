/**
 * aster-api#460（ADR 0042 §12 D5 / D6 / D10）审批收件箱：在页面上「显示原值」后批准，审批须记为基于解除视图。
 *
 * 生产曾出现：持所需角色的审批人点了「显示原值」再批准，证据包 v6 的复核者却是 inputRevealed=false、
 * 哈希为打码视图。本用例走真实浏览器界面（不是直接调 API）：展开决策输入 → 显示原值 → 确认 → 批准，
 * 中途收起再展开（面板重新挂载，GET 只回打码视图），再核对 aster-api 落库的快照四键、解除记录，
 * 以及证据包 v6 复核者字段的来源（收据接口 approvals[] / reveals[]）。
 *
 * 前置（见 README「approval-input-reveal」）：
 * - 会话夹具含 pii-officer（`scripts/e2e-local-session.ts`）；
 * - Playwright 进程带 `ASTER_PLAN_GATE_HMAC_KEY`（与栈内 cloud / api 相同），用例以 cloud-bff 身份经
 *   evaluate-source → from-evidence 自补一条带 `@pii` 输入的待审批（与 cloud 执行路径相同）。
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { signInternalCallerHeaders } from '@/lib/api-signing';
import { BASE_API, NOT_LOCAL, NOT_LOCAL_REASON, psql, stateFor } from './helpers';

const HMAC_KEY = process.env.ASTER_PLAN_GATE_HMAC_KEY ?? '';

test.skip(NOT_LOCAL, NOT_LOCAL_REASON);
test.skip(!HMAC_KEY, '缺少 ASTER_PLAN_GATE_HMAC_KEY（栈内 cloud→api 内部签名密钥），无法自补带 @pii 输入的待审批');
test.describe.configure({ mode: 'serial' });

const TENANT = 'pii-team';
const REQUESTER = 'pii-req';
const OFFICER = 'pii-officer';
const ROLE = 'Risk Officer';
const EMAIL = 'john.smith@example.com';

const SOURCE = [
  'Module guard.e2e.pii.team.',
  '',
  'Define Applicant has amount as Int, email as @pii(L2, email) Text.',
  '',
  'Rule decide given applicant as Applicant, produce Verdict:',
  '  If applicant.amount greater than 10:',
  `    Return Verdict.require_approval("${ROLE}", "large amount").`,
  '  Return Verdict.allow().',
  '',
].join('\n');

const CONTEXT = { applicant: { amount: 1000, email: EMAIL } };

/** 种子：团队 pii-team，pii-req 为属主（发起人），pii-officer 持已验证业务角色 Risk Officer。幂等。 */
function seedTeam(): void {
  psql('aster_cloud', `
    INSERT INTO "User"(id, name, email, plan) VALUES
      ('${REQUESTER}', 'PII Requester', '${REQUESTER}@stack.test', 'team'),
      ('${OFFICER}', 'PII Risk Officer', '${OFFICER}@stack.test', 'pro')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO "Team"(id, name, slug, "ownerId") VALUES ('${TENANT}', 'PII Team', '${TENANT}', '${REQUESTER}')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO "TeamMember"(id, "teamId", "userId", role, "businessRoles") VALUES
      ('${TENANT}-${REQUESTER}', '${TENANT}', '${REQUESTER}', 'owner', '{}'),
      ('${TENANT}-${OFFICER}', '${TENANT}', '${OFFICER}', 'member', '{"${ROLE}"}')
    ON CONFLICT (id) DO UPDATE SET "businessRoles" = EXCLUDED."businessRoles";`);
}

/** 以 cloud-bff 身份（canonical v3）调 aster-api 内部通道。 */
async function internalPost(path: string, body: unknown, userId: string): Promise<Record<string, unknown>> {
  const text = JSON.stringify(body);
  const headers = await signInternalCallerHeaders('POST', path, text, TENANT, 'owner', { userId });
  const res = await fetch(`${BASE_API}${path}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'X-Tenant-Id': TENANT, 'X-User-Id': userId, 'X-User-Role': 'owner' },
    body: text,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** evaluate-source → from-evidence（与 cloud 执行需审批策略的路径相同），返回 decisionId。 */
async function seedPendingPiiApproval(): Promise<string> {
  const evaluated = await internalPost('/api/v1/policies/evaluate-source',
    { source: SOURCE, context: CONTEXT, locale: 'en-US', functionName: 'decide' }, REQUESTER);
  const correlationId = (evaluated.evidence as { correlationId?: string } | undefined)?.correlationId;
  if (!correlationId) throw new Error(`evaluate-source 未返回证据 correlationId: ${JSON.stringify(evaluated)}`);
  const action = {
    principal: { id: `e2e-${randomUUID()}`, type: 'agent' },
    action: { name: 'approve_loan' },
    resource: { type: 'loan', id: 'L-460' },
    context: CONTEXT,
  };
  // 评估事件异步入链：from-evidence 在其入链前回 409，短暂重试
  for (let attempt = 0; ; attempt++) {
    try {
      const decided = await internalPost('/api/v1/guard/decisions/from-evidence', { correlationId, action }, REQUESTER);
      if (decided.effectiveOutcome !== 'PENDING') throw new Error(`期望 PENDING: ${JSON.stringify(decided)}`);
      return decided.decisionId as string;
    } catch (e) {
      if (attempt >= 30) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function row(page: Page, decisionId: string) {
  return page.locator(`tr[data-decision-id="${decisionId}"]`);
}

let decisionId = '';

test.beforeAll(async () => {
  seedTeam();
  decisionId = await seedPendingPiiApproval();
});

test.describe('Risk Officer 在页面上显示原值后批准', () => {
  test.use({ storageState: stateFor(OFFICER) });

  test('审批记为基于解除视图：inputRevealed=true，哈希为解除视图，收据带 reveals[]', async ({ page }) => {
    await page.goto('/en/approvals');
    const r = row(page, decisionId);
    await expect(r).toBeVisible();
    await r.getByRole('button', { name: 'Show decision input' }).click();

    const panel = page.getByTestId('approval-input-panel');
    await expect(panel.getByTestId('pii-masked')).toBeVisible();
    await expect(panel).not.toContainText(EMAIL);
    // 「显示原值」在输入树之前，附打码字段数与留痕说明，与行上的「查看决策输入」区分开
    await expect(panel.getByTestId('reveal-hint')).toContainText('1 field is masked');

    // 捕获界面实际提交的哈希：解除响应里的视图哈希与批准请求体里的哈希必须一致
    const revealResponse = page.waitForResponse((res) => res.url().endsWith('/input/reveal') && res.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Show original values' }).click();
    await page.getByRole('alertdialog', { name: 'Show original values' }).getByRole('button', { name: 'Show values' }).click();
    const revealed = await (await revealResponse).json() as { inputSnapshotHash: string; revealed: boolean };
    expect(revealed.revealed).toBe(true);
    await expect(panel.getByTestId('banner-revealed')).toBeVisible();
    await expect(panel).toContainText(EMAIL);

    // 生产缺陷的触发路径：解除后面板重新挂载（收起再展开；刷新页面同理），GET 只回打码视图。
    // 面板须自动取回本人的解除视图，批准提交的仍是解除视图的哈希
    await r.getByRole('button', { name: 'Hide decision input' }).click();
    await r.getByRole('button', { name: 'Show decision input' }).click();
    await expect(panel.getByTestId('banner-revealed')).toBeVisible();
    await expect(panel).toContainText(EMAIL);

    await r.getByRole('button', { name: 'Approve' }).click();
    const approveRequest = page.waitForRequest((req) => req.url().endsWith('/approve') && req.method() === 'POST');
    const dialog = page.getByRole('dialog', { name: 'Approve' });
    await expect(dialog.getByTestId('decision-view-note')).toHaveText('You are deciding on the original values you revealed.');
    await dialog.getByRole('button', { name: 'Confirm approval' }).click();
    const submitted = JSON.parse((await approveRequest).postData() ?? '{}') as { inputSnapshotHash?: string };
    expect(submitted.inputSnapshotHash).toBe(revealed.inputSnapshotHash);
    await expect(r).toHaveCount(0, { timeout: 20_000 });

    // aster-api 落库：快照四键 + 本人解除记录
    const stored = psql('aster_policy', `select status || '|' || input_snapshot_hash || '|' || input_snapshot_matched
      || '|' || input_revealed || '|' || input_status from guard_approvals where decision_id = '${decisionId}'`);
    expect(stored).toBe(`APPROVED|${revealed.inputSnapshotHash}|true|true|available`);
    const reveals = psql('aster_policy', `select count(*) from guard_input_reveals r join guard_approvals a
      on a.id = r.approval_id where a.decision_id = '${decisionId}' and r.revealed_by = '${OFFICER}'`);
    expect(reveals).toBe('1');

    // 证据包 v6 复核者的 inputRevealed / inputSnapshotHash 取自收据接口 approvals[]（services/evidence/receipts-client）
    const path = '/api/v1/audit/receipts';
    const query = `decisionIds=${decisionId}`;
    const headers = await signInternalCallerHeaders('GET', path, '', TENANT, 'owner', { query, userId: REQUESTER });
    const res = await fetch(`${BASE_API}${path}?${query}`, {
      headers: { ...headers, 'X-Tenant-Id': TENANT, 'X-User-Id': REQUESTER, 'X-User-Role': 'owner' },
    });
    expect(res.status).toBe(200);
    const lookup = await res.json() as { approvals?: Array<Record<string, unknown>>; reveals?: Array<Record<string, unknown>> };
    expect(lookup.approvals).toEqual([expect.objectContaining({
      decisionId,
      outcome: 'APPROVED',
      inputSnapshotHash: revealed.inputSnapshotHash,
      inputSnapshotMatched: true,
      inputRevealed: true,
    })]);
    expect(lookup.reveals).toEqual([expect.objectContaining({ decisionId, performedBy: OFFICER })]);
  });
});
