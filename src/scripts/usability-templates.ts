/**
 * 可用性测试租户的模板策略（中文词法）。
 * 独立成模块：seed-usability-tenant.ts 在模块顶层执行 main()，测试与门禁要引用模板时不能 import 脚本本身。
 */
export interface TemplateSpec {
  id: string;
  name: string;
  description: string;
  content: string;
}

export const TEMPLATES: TemplateSpec[] = [
  {
    id: 'tpl-blank-loan',
    name: '空白贷款模板',
    description: '仅含模块声明的最小起点（任务 1 用）',
    content: '模块 aster.finance.loan。\n',
  },
  {
    id: 'tpl-half-loan',
    name: '半成品贷款模板',
    description: '含违约判断与默认通过，缺负债、金额与分数分支',
    content: `模块 aster.finance.loan。

定义 Applicant 包含
  creditScore 作为 整数，
  monthlyIncome 作为 Decimal，
  monthlyDebt 作为 Decimal，
  requestedAmount 作为 Decimal，
  activeDefaults 作为 整数。

规则 evaluateLoanEligibility 给定 applicant 作为 Applicant 产出 Verdict：
  如果 applicant.activeDefaults 至少 1：
    返回 Verdict.deny("active_default")。
  返回 Verdict.allow()。
`,
  },
  {
    id: 'tpl-complete-loan',
    name: '完整贷款模板',
    description: 'Verdict 四态完整版（任务 3 修改基线）',
    content: `模块 aster.finance.loan。

定义 Applicant 包含
  creditScore 作为 整数，
  monthlyIncome 作为 Decimal，
  monthlyDebt 作为 Decimal，
  requestedAmount 作为 Decimal，
  activeDefaults 作为 整数。

规则 evaluateLoanEligibility 给定 applicant 作为 Applicant 产出 Verdict：
  如果 applicant.activeDefaults 至少 1：
    返回 Verdict.deny("active_default")。
  如果 applicant.monthlyDebt 大于 applicant.monthlyIncome 乘以 0.45m：
    返回 Verdict.deny("dti_exceeds_limit")。
  如果 applicant.requestedAmount 至少 50000m：
    返回 Verdict.require_approval("Credit Officer", "large_exposure")。
  如果 applicant.creditScore 至少 620 并且 applicant.creditScore 至多 679：
    返回 Verdict.escalate("borderline_credit_score")。
  返回 Verdict.allow()。
`,
  },
];
