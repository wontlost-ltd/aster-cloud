// deriveExecutionDecision 审计决策派生测试。
//
// executions 表新增 decision 列（approved/denied/indeterminate/error），与 boolean
// success(=allowed) 正交、更细。服务端从执行结果派生（绝不信客户端）。indeterminate
// （值/计算输出，如 greet 返回文本）靠 decision 与真实 deny 区分。本测试钉四态互斥 + 优先级。

import { describe, it, expect } from 'vitest';
import {
  deriveExecutionDecision,
  type PolicyExecutionResult,
} from '@/services/policy/cnl-executor';

function result(
  over: Partial<Omit<PolicyExecutionResult, 'metadata'>> & {
    metadata?: Partial<PolicyExecutionResult['metadata']>;
  },
): PolicyExecutionResult {
  const { metadata: metaOver, ...rest } = over;
  return {
    allowed: false,
    approved: false,
    matchedRules: [],
    deniedReasons: [],
    ...rest,
    metadata: {
      evaluatedAt: '2026-07-03T00:00:00Z',
      policyId: 'p1',
      policyName: 'P',
      ruleCount: 1,
      matchedRuleCount: 0,
      denyCount: 0,
      engine: 'aster-cnl',
      ...(metaOver ?? {}),
    },
  } as PolicyExecutionResult;
}

describe('deriveExecutionDecision — 四态互斥（服务端派生）', () => {
  it('approved：allowed=true 且无 error/indeterminate', () => {
    expect(deriveExecutionDecision(result({ allowed: true, approved: true }))).toBe('approved');
  });

  it('denied：allowed=false 且非 indeterminate/error（真实拒绝）', () => {
    expect(deriveExecutionDecision(result({ allowed: false, deniedReasons: ['credit too low'] }))).toBe('denied');
  });

  it('indeterminate：值/计算输出（如 greet 返回文本）→ 独立态，不与 denied 混淆', () => {
    const r = result({ allowed: false, metadata: { decision: 'indeterminate' } });
    expect(deriveExecutionDecision(r)).toBe('indeterminate');
  });

  it('error：引擎报错（编译/运行失败）', () => {
    expect(deriveExecutionDecision(result({ allowed: false, metadata: { engineError: true } }))).toBe('error');
  });

  it('优先级：engineError 压过 indeterminate/allowed', () => {
    const r = result({ allowed: true, metadata: { engineError: true, decision: 'indeterminate' } });
    expect(deriveExecutionDecision(r)).toBe('error');
  });

  it('优先级：indeterminate 压过 allowed（理论上不共存，防御性）', () => {
    const r = result({ allowed: true, metadata: { decision: 'indeterminate' } });
    expect(deriveExecutionDecision(r)).toBe('indeterminate');
  });
});

describe('deriveExecutionDecision — Verdict 待批准/升级专属态（ADR 0041 §4）', () => {
  it('outcome=REQUIRE_APPROVAL → require_approval', () => {
    expect(deriveExecutionDecision(result({ metadata: { outcome: 'REQUIRE_APPROVAL' } }))).toBe('require_approval');
  });

  it('outcome=ESCALATE → escalate', () => {
    expect(deriveExecutionDecision(result({ metadata: { outcome: 'ESCALATE' } }))).toBe('escalate');
  });

  it('engineError 优先于 outcome', () => {
    expect(deriveExecutionDecision(result({ metadata: { engineError: true, outcome: 'ESCALATE' } }))).toBe('error');
  });
});
