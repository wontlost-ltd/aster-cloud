// 引擎执行失败（aster-api 返回 error 且无 result）必须被标记为 engineError，
// 不能被当作策略的「拒绝」决策——否则执行页显示「拒绝」、执行记录存 decision=deny。
import { describe, it, expect } from 'vitest';
import { buildCNLResult, deriveExecutionDecision } from '@/services/policy/cnl-executor';
import type { PolicyEvaluateResponse } from '@/services/policy/policy-api';
import type { Policy } from '@/lib/prisma';

const policy = { id: 'p1', name: 'P' } as Policy;

describe('buildCNLResult — 引擎失败（无 result）', () => {
  const failure = {
    result: null,
    executionTimeMs: 0,
    error: 'CNL 动态执行失败: Polyglot 执行失败: java.lang.IllegalArgumentException: Lambda func_power expects at least 2 arguments',
  } as unknown as PolicyEvaluateResponse;

  it('标记 metadata.engineError，并保留原始错误信息', () => {
    const r = buildCNLResult(policy, failure);
    expect(r.allowed).toBe(false);
    expect(r.metadata.engineError).toBe(true);
    expect(r.deniedReasons[0]).toContain('Lambda func_power');
  });

  it('派生的执行决策是 error 而不是 denied', () => {
    expect(deriveExecutionDecision(buildCNLResult(policy, failure))).toBe('error');
  });

  it('无 error 字段的空响应同样视为引擎失败', () => {
    const r = buildCNLResult(policy, { result: null, executionTimeMs: 0, error: null } as unknown as PolicyEvaluateResponse);
    expect(deriveExecutionDecision(r)).toBe('error');
  });

  it('真实的 DENY 仍然是 denied（不受影响）', () => {
    const r = buildCNLResult(policy, {
      result: { __type: 'Verdict', outcome: 'DENY', reason: 'dti' }, executionTimeMs: 1, error: null,
    } as PolicyEvaluateResponse);
    expect(r.metadata.engineError).toBeUndefined();
    expect(deriveExecutionDecision(r)).toBe('denied');
  });
});
