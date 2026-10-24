import { PLANS } from '@/lib/plans';

/** 注册页套餐摘要始终直接读取套餐配额，避免文案与定价配置漂移。 */
export function getSignupPlanSummary() {
  return {
    free: {
      policies: PLANS.free.limits.policies,
      evaluations: PLANS.free.limits.executions,
    },
    pro: {
      policies: PLANS.pro.limits.policies,
      evaluations: PLANS.pro.limits.executions,
    },
  };
}
