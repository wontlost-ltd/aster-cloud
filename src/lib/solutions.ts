/**
 * 需求验证落地页（/solutions/*）的清单：页面 slug ↔ 试点申请用例。
 *
 * 落地页不进主导航，只供直链 / 分发；sitemap、事件白名单、表单校验都从这里取，避免各处手写列表漂移。
 */

/** 试点申请可选的用例（与数据库 enum `PilotUseCase` 一一对应）。 */
export const PILOT_USE_CASES = [
  'insurance_rating',
  'credit_decisions',
  'agent_guardrails',
  'eligibility_rules',
  'other',
] as const;
export type PilotUseCase = (typeof PILOT_USE_CASES)[number];

/** 落地页 slug → 该页默认勾选的用例。 */
export const SOLUTION_PAGES = {
  'insurance-rating': 'insurance_rating',
  'credit-decisions': 'credit_decisions',
  'agent-guardrails': 'agent_guardrails',
  'eligibility-rules': 'eligibility_rules',
} as const satisfies Record<string, PilotUseCase>;

export type SolutionSlug = keyof typeof SOLUTION_PAGES;
export const SOLUTION_SLUGS = Object.keys(SOLUTION_PAGES) as SolutionSlug[];

export function isSolutionSlug(value: unknown): value is SolutionSlug {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SOLUTION_PAGES, value);
}

/** 试点申请表单的角色下拉选项（存枚举值，不存自由文本）。 */
export const PILOT_ROLES = [
  'compliance_risk_audit',
  'actuarial_pricing',
  'credit_risk',
  'policy_program',
  'engineering_it',
  'product_business',
  'executive',
  'other',
] as const;
export type PilotRole = (typeof PILOT_ROLES)[number];
