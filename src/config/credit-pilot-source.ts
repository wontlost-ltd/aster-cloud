/**
 * 信贷试点 Verdict 策略源文（ADR 0044 §2）。
 *
 * en 版与 aster-lang-test 语料 `credit-pilot.aster` 逐字一致（仅阈值参数化）；
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
  versionIds: ['pv-credit-pilot-1', 'pv-credit-pilot-2'],
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
