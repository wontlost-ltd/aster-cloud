// @vitest-environment node
// 决策上下文（ADR 0061 §3.5）：决策 / 链收据 / 执行三个来源并发、各自降级；只在当前租户内查。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/prisma', () => ({ db: {}, executions: {}, policies: {} }));

const { loadDecisionContext } = await import('@/lib/guard-reconciliation/decision-context');
const { emptyLookup } = await import('@/services/evidence/receipts-client');
const { PolicyApiError } = await import('@/services/policy/policy-api');

const D = '8b0c6a52-5f0e-4f3f-9a64-0c9e3f2a7b11';

function receipt() {
  return {
    auditId: 11, currentHash: 'h', prevHash: null, hashVersion: 2, eventType: 'ACTION_GUARD_DECISION',
    timestamp: '2026-11-20T00:00:00Z', metadata: {}, authoritativeConsumeAuditId: null,
  };
}

function approval(auditId: number, outcome: string) {
  return {
    auditId, decisionId: D, outcome, decidedBy: 'u-dpo', requiredRole: 'DPO', comment: null, decidedAt: '2026-11-20T00:00:00Z',
    currentHash: 'h', decisionReceiptHash: null, inputSnapshotHash: null, inputSnapshotMatched: null, inputRevealed: null,
    inputStatus: null,
  };
}

function setup() {
  const api = { summary: vi.fn(), listOrphans: vi.fn(), ackOrphan: vi.fn(), getDecision: vi.fn() };
  const deps = { fetchDecisionReceipts: vi.fn(), findExecutionForDecision: vi.fn() };
  api.getDecision.mockResolvedValue({ decisionId: D, outcome: 'ALLOW', effectiveOutcome: 'ALLOW' });
  const lookup = emptyLookup();
  lookup.receipts.set(D, receipt());
  deps.fetchDecisionReceipts.mockResolvedValue(lookup);
  deps.findExecutionForDecision.mockResolvedValue({ policyId: 'p1', executionId: 'e1' });
  return { api, deps, lookup };
}

describe('loadDecisionContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('三者正常 → ok / ok / 执行链接', async () => {
    const { api, deps } = setup();
    const ctx = await loadDecisionContext('team1', api, D, deps);
    expect(ctx).toEqual({
      decisionId: D,
      decision: { state: 'ok', value: { decisionId: D, outcome: 'ALLOW', effectiveOutcome: 'ALLOW' } },
      chain: { state: 'ok', value: { decision: receipt(), consumes: [], results: [], approvals: [] } },
      execution: { policyId: 'p1', executionId: 'e1' },
      approvalLink: null,
    });
  });

  it("decision 404 → decision.state 'not_found', chain still loaded（orphan_receipt 形状：链上有决策事件）", async () => {
    const { api, deps } = setup();
    api.getDecision.mockRejectedValue(new PolicyApiError('HTTP 404', 404));
    const ctx = await loadDecisionContext('team1', api, D, deps);
    expect(ctx.decision).toEqual({ state: 'not_found' });
    expect(ctx.chain.state).toBe('ok');
    expect(ctx.chain.state === 'ok' && ctx.chain.value.decision).toEqual(receipt());
  });

  it("getGuardDecision throws 503 / 网络错误 → decision 'unavailable', others ok", async () => {
    for (const err of [new PolicyApiError('down', 503), new Error('net')]) {
      const { api, deps } = setup();
      api.getDecision.mockRejectedValue(err);
      const ctx = await loadDecisionContext('team1', api, D, deps);
      expect(ctx.decision).toEqual({ state: 'unavailable' });
      expect(ctx.chain.state).toBe('ok');
      expect(ctx.execution).toEqual({ policyId: 'p1', executionId: 'e1' });
    }
  });

  it("chain lookup reports missing → 'not_found'; unavailable → 'unavailable'", async () => {
    const { api, deps } = setup();
    const missing = emptyLookup();
    missing.missing.add(D);
    deps.fetchDecisionReceipts.mockResolvedValueOnce(missing);
    expect((await loadDecisionContext('team1', api, D, deps)).chain).toEqual({ state: 'not_found' });

    const unavailable = emptyLookup();
    unavailable.unavailable.add(D);
    deps.fetchDecisionReceipts.mockResolvedValueOnce(unavailable);
    expect((await loadDecisionContext('team1', api, D, deps)).chain).toEqual({ state: 'unavailable' });
  });

  it('只有 consume 尝试、无决策事件 → chain ok 且 decision 为 null', async () => {
    const { api, deps } = setup();
    const partial = emptyLookup();
    partial.missing.add(D);
    partial.consumes.set(D, [{ auditId: 3, currentHash: 'h', decisionId: D, authoritative: true, attemptId: 'a', executorId: 'x', outcome: 'consumed' }]);
    deps.fetchDecisionReceipts.mockResolvedValueOnce(partial);
    const ctx = await loadDecisionContext('team1', api, D, deps);
    expect(ctx.chain.state === 'ok' && ctx.chain.value.decision).toBeNull();
    expect(ctx.chain.state === 'ok' && ctx.chain.value.consumes).toHaveLength(1);
  });

  it("fetchDecisionReceipts rejects → chain 'unavailable', decision and execution still returned", async () => {
    const { api, deps } = setup();
    deps.fetchDecisionReceipts.mockRejectedValue(new Error('boom'));
    const ctx = await loadDecisionContext('team1', api, D, deps);
    expect(ctx.chain).toEqual({ state: 'unavailable' });
    expect(ctx.decision.state).toBe('ok');
    expect(ctx.execution).toEqual({ policyId: 'p1', executionId: 'e1' });
  });

  it('execution lookup throws → execution null, others ok；无匹配 → null', async () => {
    const { api, deps } = setup();
    deps.findExecutionForDecision.mockRejectedValueOnce(new Error('db'));
    const ctx = await loadDecisionContext('team1', api, D, deps);
    expect(ctx.execution).toBeNull();
    expect(ctx.decision.state).toBe('ok');
    expect(ctx.chain.state).toBe('ok');
    deps.findExecutionForDecision.mockResolvedValueOnce(null);
    expect((await loadDecisionContext('team1', api, D, deps)).execution).toBeNull();
  });

  it('approvalLink from latest chain approval outcome；无链上审批时取决策行的 PENDING；都没有 → null', async () => {
    const { api, deps, lookup } = setup();
    lookup.approvals.set(D, [approval(20, 'APPROVED'), approval(10, 'REJECTED')]);
    expect((await loadDecisionContext('team1', api, D, deps)).approvalLink).toEqual({ status: 'APPROVED' });

    lookup.approvals.set(D, [approval(5, 'APPROVED'), approval(30, 'EXPIRED')]);
    expect((await loadDecisionContext('team1', api, D, deps)).approvalLink).toEqual({ status: 'EXPIRED' });

    lookup.approvals.delete(D);
    api.getDecision.mockResolvedValueOnce({ decisionId: D, approval: { id: 'a1', status: 'PENDING' } });
    expect((await loadDecisionContext('team1', api, D, deps)).approvalLink).toEqual({ status: 'PENDING' });

    expect((await loadDecisionContext('team1', api, D, deps)).approvalLink).toBeNull();
  });

  it('never queries another tenant：收据与执行只以入参租户查询一次，决策只经传入的窄接口', async () => {
    const { api, deps } = setup();
    await loadDecisionContext('team1', api, D, deps);
    expect(deps.fetchDecisionReceipts.mock.calls).toEqual([['team1', [D]]]);
    expect(deps.findExecutionForDecision.mock.calls).toEqual([['team1', D]]);
    expect(api.getDecision.mock.calls).toEqual([[D]]);
    expect(api.listOrphans).not.toHaveBeenCalled();
    expect(api.ackOrphan).not.toHaveBeenCalled();
  });
});
