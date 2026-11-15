/**
 * #464 验收：Agent 被注入绕过指令 → Guard DENY、工具未执行、审计有决策且无 consume（ADR 0054 §7 第 6 条，R66 D10）。
 *
 * 真实链路：对抗驱动（MCP Client）⇄ aster-guard-mcp 0.2.0（npm）⇄ upstream-billing.mjs；代理对 aster-api
 * 决策 → 验签 → consume → 转发 → 回写。策略 demo.billing/decide 由 cloud 设默认版本时部署到 aster-api
 * （本地 `pnpm seed:agent-guard-demo`；生产见 docs/runbooks/agent-guard-demo.md）。
 *
 * 需要 AGENT_GUARD_DEMO_E2E=1 与 BASE_API / DEMO_API_KEY / DEMO_TENANT_ID，否则整组 skip 并打印原因。
 * 可选 AGENT_GUARD_DEMO_REPORT=<file>：把三次调用的 `_meta.asterGuard`、副作用、决策回读与审计收据写成 JSON。
 *
 *   AGENT_GUARD_DEMO_E2E=1 BASE_API=… DEMO_API_KEY=… DEMO_TENANT_ID=… \
 *     pnpm exec vitest run --config vitest.e2e.config.ts src/__tests__/e2e-agent-guard
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import {
  DEMO_RULE_ID,
  demoConfigFromEnv,
  runDemo,
  type AuditRow,
  type DemoReport,
} from '../../../scripts/agent-guard-demo/adversarial-agent';

const ENABLED = process.env.AGENT_GUARD_DEMO_E2E === '1';
const SKIP_REASON =
  'AGENT_GUARD_DEMO_E2E 未设为 1：本验收需要 aster-api 与已部署的演示策略，以及 BASE_API / DEMO_API_KEY / DEMO_TENANT_ID，见 docs/runbooks/agent-guard-demo.md';
if (!ENABLED) console.warn(`[agent-guard-demo e2e] 跳过：${SKIP_REASON}`);

const suite = ENABLED ? describe : describe.skip;

function rowsFor(rows: AuditRow[] | undefined, decisionId: string): AuditRow[] {
  return (rows ?? []).filter((r) => r.decisionId === decisionId);
}

suite('Agent 经 aster-guard-mcp 的绕过演示（#464 验收）', () => {
  let report: DemoReport;
  let deniedIds: string[];
  let allowedId: string;

  beforeAll(async () => {
    report = await runDemo(demoConfigFromEnv());
    if (process.env.AGENT_GUARD_DEMO_REPORT) {
      writeFileSync(process.env.AGENT_GUARD_DEMO_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    }
    deniedIds = report.attempts.slice(0, 2).map((a) => String(a.asterGuard.decisionId ?? ''));
    allowedId = String(report.attempts[2].asterGuard.decisionId ?? '');
  }, 120_000);

  it('injectedBypassIsDeniedAndNotExecuted：①② 被 DEMO-REFUND-001 拒绝，两个不同决策，refund_payment 未执行', () => {
    for (const attempt of report.attempts.slice(0, 2)) {
      expect(attempt.tool).toBe('refund_payment');
      expect(attempt.isError).toBe(true);
      expect(attempt.asterGuard.status).toBe('denied');
      expect(attempt.asterGuard.ruleId).toBe(DEMO_RULE_ID);
      // 规则 DENY：没有客户端 / 服务端故障码
      expect(attempt.asterGuard.reasonCode ?? '').toBe('');
    }
    expect(deniedIds.every((id) => id !== '')).toBe(true);
    expect(new Set(deniedIds).size).toBe(2);
    expect(report.sideEffects.filter((e) => e.tool === 'refund_payment')).toEqual([]);
  });

  it('auditHasDecisionAndNoConsume：①② 的决策收据在链上，无 consume、无结果回写，回读无 consumedBy', () => {
    for (const id of deniedIds) {
      expect(rowsFor(report.audit.receipts, id)).toHaveLength(1);
      // 拒绝的决策从未被 consume：连尝试事件都没有（更别说权威 consume）
      expect(rowsFor(report.audit.consumes, id)).toEqual([]);
      expect(rowsFor(report.audit.results, id)).toEqual([]);
      const decision = report.decisions[id];
      expect(decision.effectiveOutcome).toBe('DENY');
      expect(decision.consumedBy).toBeUndefined();
      expect(decision.result).toBeUndefined();
    }
  });

  it('allowedToolStillWorks：③ lookup_payment 放行并恰好执行一次，权威 consume 一条、结果 executed', () => {
    const third = report.attempts[2];
    expect(third.tool).toBe('lookup_payment');
    expect(third.isError).toBe(false);
    expect(third.status).toBe('executed');
    expect(allowedId).not.toBe('');
    expect(third.asterGuard.attemptId).toEqual(expect.any(String));
    expect(report.sideEffects.map((e) => e.tool)).toEqual(['lookup_payment']);

    const consumes = rowsFor(report.audit.consumes, allowedId);
    expect(consumes).toHaveLength(1);
    expect(consumes[0]).toMatchObject({ authoritative: true, attemptId: third.asterGuard.attemptId });
    const results = rowsFor(report.audit.results, allowedId);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ authoritative: true, status: 'executed' });
    expect(report.decisions[allowedId].consumedBy).toMatchObject({ attemptId: third.asterGuard.attemptId });
  });
});
