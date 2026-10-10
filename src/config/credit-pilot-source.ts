/**
 * 信贷试点 Verdict 策略源文（ADR 0044 §2、ADR 0046 §6）。
 *
 * v1/v2 的 en 版与 aster-lang-test 语料 `credit-pilot.aster` 逐字一致（仅阈值参数化）；
 * v3 把 v1 的五个分支逐条改写为 When/Otherwise 语法糖并声明 eu-ai-act-high-risk 档案，结论与 v1 相同。
 * zh/de 只翻译关键字，规则名、参数名与字段名保持 ASCII，使 execute 输入键跨语言一致。
 */

export type PilotLocale = 'en' | 'zh' | 'de';
export type PilotThreshold = 50000 | 80000;

export const CREDIT_PILOT = {
  teamId: 'credit-pilot',
  ownerId: 'cp-owner',
  officerId: 'cp-officer',
  analystId: 'cp-analyst',
  policyId: 'pol-credit-pilot',
  // 前两项是 What-If 对比的 v1→v2；第三项 v3 为在线默认版本
  versionIds: ['pv-credit-pilot-1', 'pv-credit-pilot-2', 'pv-credit-pilot-3'],
  profile: 'eu-ai-act-high-risk',
  role: 'Credit Officer',
} as const;

export interface PilotApplicant {
  creditScore: number;
  monthlyIncome: number;
  monthlyDebt: number;
  requestedAmount: number;
  activeDefaults: number;
}

// 四组申请人与语料黄金用例一致，分别命中 allow / deny / require_approval / escalate。
export const PILOT_APPLICANTS: Record<'allow' | 'deny' | 'requireApproval' | 'escalate', PilotApplicant> = {
  allow: { creditScore: 760, monthlyIncome: 9000, monthlyDebt: 2000, requestedAmount: 20000, activeDefaults: 0 },
  deny: { creditScore: 760, monthlyIncome: 9000, monthlyDebt: 2000, requestedAmount: 20000, activeDefaults: 1 },
  requireApproval: { creditScore: 760, monthlyIncome: 9000, monthlyDebt: 2000, requestedAmount: 60000, activeDefaults: 0 },
  escalate: { creditScore: 650, monthlyIncome: 9000, monthlyDebt: 2000, requestedAmount: 20000, activeDefaults: 0 },
};

function enSource(threshold: PilotThreshold): string {
  return `Module aster.pilot.credit.

Define Applicant has
  creditScore as Int,
  monthlyIncome as Decimal,
  monthlyDebt as Decimal,
  requestedAmount as Decimal,
  activeDefaults as Int.

@id("CP-DECIDE")
@control("EU_AI_ACT:ART14")
@control("GDPR:ART22")
Rule decide given applicant as Applicant, produce Verdict:
  If applicant.activeDefaults at least 1:
    Return Verdict.deny("active_default").
  If applicant.monthlyDebt greater than applicant.monthlyIncome times 0.45m:
    Return Verdict.deny("dti_exceeds_limit").
  If applicant.requestedAmount at least ${threshold}m:
    Return Verdict.require_approval("Credit Officer", "large_exposure").
  If applicant.creditScore at least 620 and applicant.creditScore at most 679:
    Return Verdict.escalate("borderline_credit_score").
  Return Verdict.allow().
`;
}

function zhSource(threshold: PilotThreshold): string {
  return `模块 aster.pilot.credit。

定义 Applicant 包含
  creditScore 作为 整数，
  monthlyIncome 作为 Decimal，
  monthlyDebt 作为 Decimal，
  requestedAmount 作为 Decimal，
  activeDefaults 作为 整数。

@id("CP-DECIDE")
@control("EU_AI_ACT:ART14")
@control("GDPR:ART22")
规则 decide 给定 applicant 作为 Applicant 产出 Verdict：
  如果 applicant.activeDefaults 至少 1：
    返回 Verdict.deny("active_default")。
  如果 applicant.monthlyDebt 大于 applicant.monthlyIncome 乘以 0.45m：
    返回 Verdict.deny("dti_exceeds_limit")。
  如果 applicant.requestedAmount 至少 ${threshold}m：
    返回 Verdict.require_approval("Credit Officer", "large_exposure")。
  如果 applicant.creditScore 至少 620 并且 applicant.creditScore 至多 679：
    返回 Verdict.escalate("borderline_credit_score")。
  返回 Verdict.allow()。
`;
}

function deSource(threshold: PilotThreshold): string {
  return `Modul aster.pilot.credit.

Definiere Applicant hat
  creditScore als Ganzzahl,
  monthlyIncome als Decimal,
  monthlyDebt als Decimal,
  requestedAmount als Decimal,
  activeDefaults als Ganzzahl.

@id("CP-DECIDE")
@control("EU_AI_ACT:ART14")
@control("GDPR:ART22")
Regel decide gegeben applicant als Applicant liefert Verdict:
  wenn applicant.activeDefaults mindestens 1:
    gib zurück Verdict.deny("active_default").
  wenn applicant.monthlyDebt größer als applicant.monthlyIncome mal 0.45m:
    gib zurück Verdict.deny("dti_exceeds_limit").
  wenn applicant.requestedAmount mindestens ${threshold}m:
    gib zurück Verdict.require_approval("Credit Officer", "large_exposure").
  wenn applicant.creditScore mindestens 620 und applicant.creditScore höchstens 679:
    gib zurück Verdict.escalate("borderline_credit_score").
  gib zurück Verdict.allow().
`;
}

const BUILDERS: Record<PilotLocale, (threshold: PilotThreshold) => string> = {
  en: enSource,
  zh: zhSource,
  de: deSource,
};

export function creditPilotSource(locale: PilotLocale, threshold: PilotThreshold): string {
  return BUILDERS[locale](threshold);
}

// v3 的阈值固定为 v1 的 50000，五个分支与 v1 同序同边界。
const SUGAR_THRESHOLD = 50000;

function enSugarSource(): string {
  return `Module aster.pilot.credit.
Profile "eu-ai-act-high-risk".

Define Applicant has
  creditScore as Int,
  monthlyIncome as Decimal,
  monthlyDebt as Decimal,
  requestedAmount as Decimal,
  activeDefaults as Int.

@id("CP-DECIDE")
@control("EU_AI_ACT:ART14")
@control("GDPR:ART22")
Rule decide given applicant as Applicant, produce Verdict:
  When applicant.activeDefaults at least 1, deny "active_default".
  When applicant.monthlyDebt greater than applicant.monthlyIncome times 0.45m, deny "dti_exceeds_limit".
  When applicant.requestedAmount at least ${SUGAR_THRESHOLD}m, require approval by "Credit Officer" because "large_exposure".
  When applicant.creditScore at least 620 and applicant.creditScore at most 679, escalate "borderline_credit_score".
  Otherwise allow.
`;
}

function zhSugarSource(): string {
  return `模块 aster.pilot.credit。
档案 "eu-ai-act-high-risk"。

定义 Applicant 包含
  creditScore 作为 整数，
  monthlyIncome 作为 Decimal，
  monthlyDebt 作为 Decimal，
  requestedAmount 作为 Decimal，
  activeDefaults 作为 整数。

@id("CP-DECIDE")
@control("EU_AI_ACT:ART14")
@control("GDPR:ART22")
规则 decide 给定 applicant 作为 Applicant 产出 Verdict：
  当 applicant.activeDefaults 至少 1，拒绝 "active_default"。
  当 applicant.monthlyDebt 大于 applicant.monthlyIncome 乘以 0.45m，拒绝 "dti_exceeds_limit"。
  当 applicant.requestedAmount 至少 ${SUGAR_THRESHOLD}m，需审批人 "Credit Officer" 因为 "large_exposure"。
  当 applicant.creditScore 至少 620 并且 applicant.creditScore 至多 679，升级 "borderline_credit_score"。
  否则 允许。
`;
}

function deSugarSource(): string {
  return `Modul aster.pilot.credit.
Profil "eu-ai-act-high-risk".

Definiere Applicant hat
  creditScore als Ganzzahl,
  monthlyIncome als Decimal,
  monthlyDebt als Decimal,
  requestedAmount als Decimal,
  activeDefaults als Ganzzahl.

@id("CP-DECIDE")
@control("EU_AI_ACT:ART14")
@control("GDPR:ART22")
Regel decide gegeben applicant als Applicant liefert Verdict:
  bei applicant.activeDefaults mindestens 1, ablehnen "active_default".
  bei applicant.monthlyDebt größer als applicant.monthlyIncome mal 0.45m, ablehnen "dti_exceeds_limit".
  bei applicant.requestedAmount mindestens ${SUGAR_THRESHOLD}m, Genehmigung durch "Credit Officer" weil "large_exposure".
  bei applicant.creditScore mindestens 620 und applicant.creditScore höchstens 679, eskalieren "borderline_credit_score".
  sonst erlauben.
`;
}

const SUGAR_BUILDERS: Record<PilotLocale, () => string> = {
  en: enSugarSource,
  zh: zhSugarSource,
  de: deSugarSource,
};

/** v3 源文：语法糖写法并声明档案，结论与阈值 50000 的 v1 相同。 */
export function creditPilotSugarSource(locale: PilotLocale): string {
  return SUGAR_BUILDERS[locale]();
}
