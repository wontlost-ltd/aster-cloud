import { describe, expect, it } from 'vitest';
import { PLANS } from '@/lib/plans';
import { getSignupPlanSummary } from '@/lib/signup-plan-summary';

describe('getSignupPlanSummary', () => {
  it('reflects Free and Pro limits from the plan source of truth', () => {
    expect(getSignupPlanSummary()).toEqual({
      free: { policies: PLANS.free.limits.policies, evaluations: PLANS.free.limits.executions },
      pro: { policies: PLANS.pro.limits.policies, evaluations: PLANS.pro.limits.executions },
    });
  });
});
