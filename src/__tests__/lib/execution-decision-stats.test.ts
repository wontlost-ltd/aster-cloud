// 执行统计按决策口径派生（UI E2E O2）：待处置/无决策不计失败、不参与通过率。

import { describe, it, expect } from 'vitest';
import { deriveDecisionStats } from '@/lib/policy-execution-log';

describe('deriveDecisionStats', () => {
  it('每种决策各一行：通过=approved，失败=denied+error，待处置单列', () => {
    // approved×1, denied×1, error×1, require_approval×1, escalate×1, indeterminate×1
    const r = deriveDecisionStats({ totalExecutions: 6, successCount: 1, indeterminateCount: 1, pendingCount: 2 });
    expect(r.failureCount).toBe(2);
    expect(r.pendingCount).toBe(2);
    expect(r.successRate).toBeCloseTo(100 / 3);
  });

  it('★全是待审批行 ⇒ 失败 0、通过率 0 但不把待处置算失败', () => {
    const r = deriveDecisionStats({ totalExecutions: 5, successCount: 0, indeterminateCount: 0, pendingCount: 5 });
    expect(r.failureCount).toBe(0);
    expect(r.successRate).toBe(0);
  });

  it('通过 + 待处置 ⇒ 通过率 100%（待处置不进分母）', () => {
    const r = deriveDecisionStats({ totalExecutions: 5, successCount: 1, indeterminateCount: 0, pendingCount: 4 });
    expect(r.failureCount).toBe(0);
    expect(r.successRate).toBe(100);
  });

  it('空数据 ⇒ 0，不出现 NaN', () => {
    const r = deriveDecisionStats({ totalExecutions: 0, successCount: 0, indeterminateCount: 0, pendingCount: 0 });
    expect(r).toEqual({ failureCount: 0, pendingCount: 0, successRate: 0 });
  });
});
