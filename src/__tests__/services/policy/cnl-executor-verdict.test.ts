// ADR 0041 §4：Verdict 五态派生 + 证据字段透传 + agent 透传到 evaluate-source 请求体。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildCNLResult, deriveExecutionDecision, deriveExecutionOutcome, executePolicyUnified } from '@/services/policy/cnl-executor';
import { PolicyApiClient, type PolicyEvaluateResponse } from '@/services/policy/policy-api';
import type { Policy } from '@/lib/prisma';

const policy = { id: 'p1', name: 'P' } as Policy;
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('cnl-executor Verdict 五态（ADR 0041 §4）', () => {
  it('metadata.reason：decision.reason 优先，回退 Verdict 结果 reason，ALLOW 无理由则缺省', () => {
    const fromResult = buildCNLResult(policy, { result: { __type: 'Verdict', outcome: 'DENY', reason: 'large_exposure' }, executionTimeMs: 1, error: null } as PolicyEvaluateResponse);
    expect(fromResult.metadata.reason).toBe('large_exposure');
    const fromDecision = buildCNLResult(policy, {
      result: { __type: 'Verdict', outcome: 'DENY', reason: 'r-result' }, decision: { outcome: 'DENY', reason: 'r-decision' },
      executionTimeMs: 1, error: null,
    } as PolicyEvaluateResponse);
    expect(fromDecision.metadata.reason).toBe('r-decision');
    const allow = buildCNLResult(policy, { result: { __type: 'Verdict', outcome: 'ALLOW' }, executionTimeMs: 1, error: null } as PolicyEvaluateResponse);
    expect(allow.metadata.reason).toBeUndefined();
  });

  it('REQUIRE_APPROVAL 派生 require_approval 并保留 outcome/ruleId/controls/evidence', () => {
    const resp = {
      result: { __type: 'Verdict', outcome: 'REQUIRE_APPROVAL', role: 'DPO', reason: 'r' }, executionTimeMs: 3, error: null,
      decision: { outcome: 'REQUIRE_APPROVAL', role: 'DPO', reason: 'r' }, ruleId: 'CUST-DEL-001', controls: ['GDPR:ART17'], evidence: { correlationId: 'c-1' },
    };
    const r = buildCNLResult(policy, resp as PolicyEvaluateResponse);
    expect(r.metadata.outcome).toBe('REQUIRE_APPROVAL');
    expect(r.metadata.ruleId).toBe('CUST-DEL-001');
    expect(r.metadata.controls).toEqual(['GDPR:ART17']);
    expect(r.metadata.evidenceCorrelationId).toBe('c-1');
    expect(r.allowed).toBe(false);
    expect(r.metadata.decision).toBeUndefined();
    // 待批准不是拒绝：不计入 deniedReasons/denyCount
    expect(r.deniedReasons).toEqual([]);
    expect(r.metadata.denyCount).toBe(0);
    expect(deriveExecutionDecision(r)).toBe('require_approval');
    expect(deriveExecutionOutcome(r)).toBe('REQUIRE_APPROVAL');
  });

  it('ESCALATE → escalate；非 Verdict 非布尔 → indeterminate；engineError → error', () => {
    const esc = buildCNLResult(policy, { result: { __type: 'Verdict', outcome: 'ESCALATE' }, executionTimeMs: 1, error: null } as PolicyEvaluateResponse);
    expect(deriveExecutionDecision(esc)).toBe('escalate');
    expect(deriveExecutionOutcome(esc)).toBe('ESCALATE');
    const vague = buildCNLResult(policy, { result: { tier: '转人工审核' }, executionTimeMs: 1, error: null } as PolicyEvaluateResponse);
    expect(deriveExecutionDecision(vague)).toBe('indeterminate');
    expect(deriveExecutionOutcome(vague)).toBe('INDETERMINATE');
    const err = { ...vague, metadata: { ...vague.metadata, engineError: true } };
    expect(deriveExecutionDecision(err)).toBe('error');
    expect(deriveExecutionOutcome(err)).toBe('ERROR');
    const allow = buildCNLResult(policy, { result: { __type: 'Verdict', outcome: 'ALLOW' }, executionTimeMs: 1, error: null } as PolicyEvaluateResponse);
    expect(deriveExecutionDecision(allow)).toBe('approved');
    expect(allow.allowed).toBe(true);
    expect(deriveExecutionOutcome(allow)).toBe('ALLOW');
    const deny = buildCNLResult(policy, { result: { __type: 'Verdict', outcome: 'DENY', reason: 'no' }, executionTimeMs: 1, error: null } as PolicyEvaluateResponse);
    expect(deriveExecutionDecision(deny)).toBe('denied');
    expect(deriveExecutionOutcome(deny)).toBe('DENY');
    expect(deny.deniedReasons).toEqual(['no']);
  });

  it('无证据字段的旧响应不写 ruleId/controls/evidenceCorrelationId 键', () => {
    const r = buildCNLResult(policy, { result: true, executionTimeMs: 1, error: null } as PolicyEvaluateResponse);
    expect(r.metadata).not.toHaveProperty('ruleId');
    expect(r.metadata).not.toHaveProperty('controls');
    expect(r.metadata).not.toHaveProperty('evidenceCorrelationId');
    expect(r.metadata).not.toHaveProperty('profile');
    expect(deriveExecutionOutcome(r)).toBe('ALLOW');
  });

  it('评估响应带 profile 时透传到 metadata（ADR 0046 §6）', () => {
    const r = buildCNLResult(policy, { result: true, executionTimeMs: 1, error: null, profile: 'eu-ai-act-high-risk' } as PolicyEvaluateResponse);
    expect(r.metadata.profile).toBe('eu-ai-act-high-risk');
  });

  it('evaluateSource 透传 agent 到请求体，无 agent 时不带键', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    global.fetch = vi.fn(async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ result: 1, executionTimeMs: 1, error: null }), { status: 200 });
    }) as never;
    const client = new PolicyApiClient('t1', 'u1');
    await client.evaluateSource('Module M.', {}, { agent: { provider: 'anthropic', model: 'claude', session: 's' } });
    await client.evaluateSource('Module M.', {});
    expect(calls[0].body.agent).toEqual({ provider: 'anthropic', model: 'claude', session: 's' });
    expect(calls[1].body).not.toHaveProperty('agent');
  });

  it('executePolicyUnified 把 options.agent 透传给 evaluateSource', async () => {
    const spy = vi.spyOn(PolicyApiClient.prototype, 'evaluateSource')
      .mockResolvedValue({ result: true, executionTimeMs: 1, error: null });
    const cnl = { id: 'p1', name: 'P', userId: 'u1', teamId: null, content: 'Module M.\nRule r given x: Return true.' } as unknown as Policy;
    await executePolicyUnified({ policy: cnl, input: {}, userId: 'u1', agent: { provider: 'anthropic', model: 'claude' } });
    expect(spy).toHaveBeenCalledWith(cnl.content, {}, expect.objectContaining({ agent: { provider: 'anthropic', model: 'claude' } }));
    spy.mockRestore();
  });
});
