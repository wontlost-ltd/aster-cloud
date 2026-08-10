/**
 * 策略示例数据 - 多语言版本
 *
 * 支持三种语言的 CNL 策略示例：
 * - en-US: English
 * - zh-CN: 简体中文
 * - de-DE: Deutsch
 *
 * 每个示例都有三种语言的原生 CNL 源码
 */

// ============================================
// 类型定义
// ============================================

export type SupportedLocale = 'en-US' | 'zh-CN' | 'de-DE';

export type PolicyCategory = 'loan' | 'creditcard' | 'fraud' | 'healthcare' | 'auto-insurance';

export interface PolicyExampleInput {
  [key: string]: unknown;
}

export interface LocalizedMetadata {
  name: string;
  description: string;
}

export interface PolicyExample {
  id: string;
  category: PolicyCategory;
  groupId: string; // 使用 ID 而非本地化文本
  sources: Record<SupportedLocale, string>;
  metadata: Record<SupportedLocale, LocalizedMetadata>;
  /**
   * 各语种的示例输入。
   *
   * ★必须按语种分开：规则参数名与 Define 字段名都是**本地化**的
   * （en `driver.age` / zh `驾驶员.年龄` / de `fahrer.alter`），
   * 而参数映射按键名匹配、字段访问按成员名匹配。共用一份英文键的输入
   * 会让所有非英文示例在执行期失败——实测 5 示例 × zh/de 共 10 例全挂。
   */
  defaultInputs: Record<SupportedLocale, PolicyExampleInput>;
}

// ============================================
// 分组定义
// ============================================

export interface PolicyGroupDef {
  id: string;
  parentId: string | null;
  icon: string;
  names: Record<SupportedLocale, string>;
  children?: PolicyGroupDef[];
}

export const POLICY_GROUP_TREE: PolicyGroupDef[] = [
  {
    id: 'finance',
    parentId: null,
    icon: 'banknote',
    names: { 'en-US': 'Finance', 'zh-CN': '金融', 'de-DE': 'Finanzen' },
    children: [
      {
        id: 'loan',
        parentId: 'finance',
        icon: 'landmark',
        names: { 'en-US': 'Loan', 'zh-CN': '贷款', 'de-DE': 'Kredit' },
      },
      {
        id: 'creditcard',
        parentId: 'finance',
        icon: 'credit-card',
        names: { 'en-US': 'Credit Card', 'zh-CN': '信用卡', 'de-DE': 'Kreditkarte' },
      },
      {
        id: 'fraud',
        parentId: 'finance',
        icon: 'shield-alert',
        names: { 'en-US': 'Fraud Detection', 'zh-CN': '欺诈检测', 'de-DE': 'Betrugserkennung' },
      },
    ],
  },
  {
    id: 'healthcare',
    parentId: null,
    icon: 'heart-pulse',
    names: { 'en-US': 'Healthcare', 'zh-CN': '医疗', 'de-DE': 'Gesundheitswesen' },
    children: [
      {
        id: 'eligibility',
        parentId: 'healthcare',
        icon: 'clipboard-check',
        names: { 'en-US': 'Eligibility', 'zh-CN': '资格审核', 'de-DE': 'Berechtigung' },
      },
    ],
  },
  {
    id: 'insurance',
    parentId: null,
    icon: 'shield',
    names: { 'en-US': 'Insurance', 'zh-CN': '保险', 'de-DE': 'Versicherung' },
    children: [
      {
        id: 'auto',
        parentId: 'insurance',
        icon: 'car',
        names: { 'en-US': 'Auto Insurance', 'zh-CN': '汽车保险', 'de-DE': 'Kfz-Versicherung' },
      },
    ],
  },
];

// ============================================
// 策略源码 - 贷款审批
// ============================================

const LOAN_SOURCE_EN = `Module finance.loan.

Define Applicant has
  id,
  creditScore,
  income,
  age.

Define Decision has
  approved as Bool,
  reason,
  rate as Int.

Rule evaluateLoan given applicant, produce:
  If applicant.age is less than 18
    Return Decision with approved set to false, reason set to "Underage applicant", rate set to 0.
  If applicant.creditScore is less than 600
    Return Decision with approved set to false, reason set to "Credit score too low", rate set to 0.
  If applicant.creditScore is greater than 750
    Return Decision with approved set to true, reason set to "Excellent credit", rate set to 350.
  If applicant.creditScore is at least 700
    Return Decision with approved set to true, reason set to "Good credit", rate set to 450.
  Return Decision with approved set to true, reason set to "Standard approval", rate set to 550.
`;

const LOAN_SOURCE_ZH = `模块 金融.贷款。

定义 申请人 包含
  编号，
  信用评分，
  收入，
  年龄。

定义 决定 包含
  批准 as 布尔，
  理由，
  利率 as 整数。

规则 评估贷款 给定 申请人，产出：
  如果 申请人.年龄 小于 18
    返回 决定 包含 批准 将 设为 假值, 理由 将 设为 「申请人未成年」, 利率 将 设为 0。
  如果 申请人.信用评分 小于 600
    返回 决定 包含 批准 将 设为 假值, 理由 将 设为 「信用评分过低」, 利率 将 设为 0。
  如果 申请人.信用评分 大于 750
    返回 决定 包含 批准 将 设为 真值, 理由 将 设为 「信用优秀」, 利率 将 设为 350。
  如果 申请人.信用评分 大于 700
    返回 决定 包含 批准 将 设为 真值, 理由 将 设为 「信用良好」, 利率 将 设为 450。
  返回 决定 包含 批准 将 设为 真值, 理由 将 设为 「标准审批」, 利率 将 设为 550。
`;

const LOAN_SOURCE_DE = `Modul finanz.kredit.

Definiere Antragsteller hat
  kennung,
  bonitaet,
  einkommen,
  alter.

Definiere Entscheidung hat
  genehmigt as Boolesch,
  begruendung,
  zinssatz as Ganzzahl.

Regel kreditPruefen gegeben antragsteller, liefert:
  wenn antragsteller.alter kleiner als 18
    gib zurueck Entscheidung mit genehmigt setze auf falsch, begruendung setze auf "Minderjaehriger Antragsteller", zinssatz setze auf 0.
  wenn antragsteller.bonitaet kleiner als 600
    gib zurueck Entscheidung mit genehmigt setze auf falsch, begruendung setze auf "Bonitaet zu niedrig", zinssatz setze auf 0.
  wenn antragsteller.bonitaet groesser als 750
    gib zurueck Entscheidung mit genehmigt setze auf wahr, begruendung setze auf "Ausgezeichnete Bonitaet", zinssatz setze auf 350.
  wenn antragsteller.bonitaet groesser als 700
    gib zurueck Entscheidung mit genehmigt setze auf wahr, begruendung setze auf "Gute Bonitaet", zinssatz setze auf 450.
  gib zurueck Entscheidung mit genehmigt setze auf wahr, begruendung setze auf "Standardgenehmigung", zinssatz setze auf 550.
`;

// ============================================
// 策略源码 - 医疗资格
// ============================================

const HEALTHCARE_SOURCE_EN = `Module healthcare.eligibility.

Define Patient has
  id,
  age,
  hasInsurance,
  insuranceType.

Define Service has
  code,
  name,
  price as Float.

Define Result has
  eligible as Bool,
  coverage as Int,
  patientCost as Float,
  reason.

Rule checkEligibility given patient, service, produce:
  If not patient.hasInsurance
    Return Result with eligible set to false, coverage set to 0, patientCost set to service.price, reason set to "No insurance".
  If patient.age less than 18
    Return Result with eligible set to true, coverage set to 90, patientCost set to service.price times 10 divided by 100, reason set to "Minor coverage".
  If patient.age greater than 65
    Return Result with eligible set to true, coverage set to 85, patientCost set to service.price times 15 divided by 100, reason set to "Senior coverage".
  Return Result with eligible set to true, coverage set to 70, patientCost set to service.price times 30 divided by 100, reason set to "Standard coverage".
`;

const HEALTHCARE_SOURCE_ZH = `模块 医疗.资格审核。

定义 患者 包含
  编号，
  年龄，
  有保险，
  保险类型。

定义 服务 包含
  代码，
  名称，
  价格 as 小数。

定义 审核结果 包含
  合格 as 布尔，
  覆盖率 as 整数，
  患者费用 as 小数，
  理由。

规则 检查资格 给定 患者，服务，产出：
  如果 不是 患者.有保险
    返回 审核结果 包含 合格 将 设为 假值, 覆盖率 将 设为 0, 患者费用 将 设为 服务.价格, 理由 将 设为 「无保险」。
  如果 患者.年龄 小于 18
    返回 审核结果 包含 合格 将 设为 真值, 覆盖率 将 设为 90, 患者费用 将 设为 服务.价格 乘以 10 除以 100, 理由 将 设为 「未成年人覆盖」。
  如果 患者.年龄 大于 65
    返回 审核结果 包含 合格 将 设为 真值, 覆盖率 将 设为 85, 患者费用 将 设为 服务.价格 乘以 15 除以 100, 理由 将 设为 「老年人覆盖」。
  返回 审核结果 包含 合格 将 设为 真值, 覆盖率 将 设为 70, 患者费用 将 设为 服务.价格 乘以 30 除以 100, 理由 将 设为 「标准覆盖」。
`;

const HEALTHCARE_SOURCE_DE = `Modul gesundheit.berechtigung.

Definiere Patient hat
  kennung,
  alter,
  hatVersicherung,
  versicherungstyp.

Definiere Leistung hat
  code,
  name,
  preis as Dezimal.

Definiere Ergebnis hat
  berechtigt as Boolesch,
  deckung as Ganzzahl,
  patientenkosten as Dezimal,
  begruendung.

Regel berechtigungPruefen gegeben patient, leistung, liefert:
  wenn nicht patient.hatVersicherung
    gib zurueck Ergebnis mit berechtigt setze auf falsch, deckung setze auf 0, patientenkosten setze auf leistung.preis, begruendung setze auf "Keine Versicherung".
  wenn patient.alter kleiner als 18
    gib zurueck Ergebnis mit berechtigt setze auf wahr, deckung setze auf 90, patientenkosten setze auf leistung.preis mal 10 geteilt durch 100, begruendung setze auf "Minderjaehrige Deckung".
  wenn patient.alter groesser als 65
    gib zurueck Ergebnis mit berechtigt setze auf wahr, deckung setze auf 85, patientenkosten setze auf leistung.preis mal 15 geteilt durch 100, begruendung setze auf "Senioren Deckung".
  gib zurueck Ergebnis mit berechtigt setze auf wahr, deckung setze auf 70, patientenkosten setze auf leistung.preis mal 30 geteilt durch 100, begruendung setze auf "Standarddeckung".
`;

// ============================================
// 策略源码 - 汽车保险
// ============================================

const AUTO_SOURCE_EN = `Module insurance.auto.

Define Driver has
  id,
  age,
  yearsLicensed,
  accidents,
  violations.

Define Vehicle has
  vin,
  year,
  value,
  safetyRating.

Define Quote has
  approved as Bool,
  premium as Int,
  deductible as Int,
  reason.

Rule generateQuote given driver, vehicle, produce:
  If driver.age less than 18
    Return Quote with approved set to false, premium set to 0, deductible set to 0, reason set to "Driver under 18".
  If driver.accidents greater than 3
    Return Quote with approved set to false, premium set to 0, deductible set to 0, reason set to "Too many accidents".
  Let basePremium be calculateBase(driver, vehicle).
  Let riskFactor be calculateRisk(driver).
  Let finalPremium be basePremium times riskFactor divided by 100.
  Return Quote with approved set to true, premium set to finalPremium, deductible set to 500, reason set to "Approved".

Rule calculateBase given driver, vehicle, produce:
  If driver.age less than 25
    Return 300.
  If driver.age less than 65
    Return 200.
  Return 250.

Rule calculateRisk given driver, produce:
  Let base be 100.
  If driver.accidents greater than 0
    Let base be base plus driver.accidents times 20.
  If driver.violations greater than 0
    Let base be base plus driver.violations times 10.
  Return base.
`;

const AUTO_SOURCE_ZH = `模块 保险.汽车。

定义 驾驶员 包含
  编号，
  年龄，
  驾龄，
  事故数，
  违章数。

定义 车辆 包含
  车架号，
  年份，
  价值，
  安全评级。

定义 报价 包含
  批准 as 布尔，
  保费 as 整数，
  免赔额 as 整数，
  理由。

规则 生成报价 给定 驾驶员，车辆，产出：
  如果 驾驶员.年龄 小于 18
    返回 报价 包含 批准 将 设为 假值, 保费 将 设为 0, 免赔额 将 设为 0, 理由 将 设为 「驾驶员未满18岁」。
  如果 驾驶员.事故数 大于 3
    返回 报价 包含 批准 将 设为 假值, 保费 将 设为 0, 免赔额 将 设为 0, 理由 将 设为 「事故过多」。
  令 基础保费 定义为 计算基础(驾驶员, 车辆)。
  令 风险系数 定义为 计算风险(驾驶员)。
  令 最终保费 定义为 基础保费 乘以 风险系数 除以 100。
  返回 报价 包含 批准 将 设为 真值, 保费 将 设为 最终保费, 免赔额 将 设为 500, 理由 将 设为 「已批准」。

规则 计算基础 给定 驾驶员，车辆，产出：
  如果 驾驶员.年龄 小于 25
    返回 300。
  如果 驾驶员.年龄 小于 65
    返回 200。
  返回 250。

规则 计算风险 给定 驾驶员，产出：
  令 基数 定义为 100。
  如果 驾驶员.事故数 大于 0
    令 基数 定义为 基数 加上 驾驶员.事故数 乘以 20。
  如果 驾驶员.违章数 大于 0
    令 基数 定义为 基数 加上 驾驶员.违章数 乘以 10。
  返回 基数。
`;

const AUTO_SOURCE_DE = `Modul versicherung.kfz.

Definiere Fahrer hat
  kennung,
  alter,
  fuehrerscheinJahre,
  unfaelle,
  verstoesse.

Definiere Fahrzeug hat
  fahrgestellnummer,
  baujahr,
  wert,
  sicherheitsbewertung.

Definiere Angebot hat
  genehmigt as Boolesch,
  praemie as Ganzzahl,
  selbstbeteiligung as Ganzzahl,
  begruendung.

Regel angebotErstellen gegeben fahrer, fahrzeug, liefert:
  wenn fahrer.alter kleiner als 18
    gib zurueck Angebot mit genehmigt setze auf falsch, praemie setze auf 0, selbstbeteiligung setze auf 0, begruendung setze auf "Fahrer unter 18".
  wenn fahrer.unfaelle groesser als 3
    gib zurueck Angebot mit genehmigt setze auf falsch, praemie setze auf 0, selbstbeteiligung setze auf 0, begruendung setze auf "Zu viele Unfaelle".
  sei basisPraemie gleich basisBerechnen(fahrer, fahrzeug).
  sei risikoFaktor gleich risikoBerechnen(fahrer).
  sei endPraemie gleich basisPraemie mal risikoFaktor geteilt durch 100.
  gib zurueck Angebot mit genehmigt setze auf wahr, praemie setze auf endPraemie, selbstbeteiligung setze auf 500, begruendung setze auf "Genehmigt".

Regel basisBerechnen gegeben fahrer, fahrzeug, liefert:
  wenn fahrer.alter kleiner als 25
    gib zurueck 300.
  wenn fahrer.alter kleiner als 65
    gib zurueck 200.
  gib zurueck 250.

Regel risikoBerechnen gegeben fahrer, liefert:
  sei basis gleich 100.
  wenn fahrer.unfaelle groesser als 0
    sei basis gleich basis plus fahrer.unfaelle mal 20.
  wenn fahrer.verstoesse groesser als 0
    sei basis gleich basis plus fahrer.verstoesse mal 10.
  gib zurueck basis.
`;

// ============================================
// 策略源码 - 欺诈检测
// ============================================

const FRAUD_SOURCE_EN = `Module finance.fraud.

Define Transaction has
  id,
  accountId,
  amount,
  timestamp.

Define AccountHistory has
  accountId,
  averageAmount,
  suspiciousCount,
  accountAge.

Define FraudResult has
  suspicious as Bool,
  riskScore as Int,
  reason.

Rule detectFraud given transaction, history, produce:
  If transaction.amount greater than 1000000
    Return FraudResult with suspicious set to true, riskScore set to 100, reason set to "Extremely large transaction".
  If history.suspiciousCount greater than 5
    Return FraudResult with suspicious set to true, riskScore set to 85, reason set to "High suspicious activity".
  If history.accountAge less than 30
    Return FraudResult with suspicious set to true, riskScore set to 70, reason set to "New account risk".
  If transaction.amount greater than history.averageAmount times 10
    Return FraudResult with suspicious set to true, riskScore set to 60, reason set to "Unusual amount".
  Return FraudResult with suspicious set to false, riskScore set to 10, reason set to "Normal transaction".
`;

const FRAUD_SOURCE_ZH = `模块 金融.欺诈。

定义 交易 包含
  编号，
  账户号，
  金额，
  时间戳。

定义 账户历史 包含
  账户号，
  平均金额，
  可疑次数，
  账龄。

定义 欺诈结果 包含
  可疑 as 布尔，
  风险评分 as 整数，
  理由。

规则 检测欺诈 给定 交易，历史，产出：
  如果 交易.金额 大于 1000000
    返回 欺诈结果 包含 可疑 将 设为 真值, 风险评分 将 设为 100, 理由 将 设为 「超大额交易」。
  如果 历史.可疑次数 大于 5
    返回 欺诈结果 包含 可疑 将 设为 真值, 风险评分 将 设为 85, 理由 将 设为 「高度可疑活动」。
  如果 历史.账龄 小于 30
    返回 欺诈结果 包含 可疑 将 设为 真值, 风险评分 将 设为 70, 理由 将 设为 「新账户风险」。
  如果 交易.金额 大于 历史.平均金额 乘以 10
    返回 欺诈结果 包含 可疑 将 设为 真值, 风险评分 将 设为 60, 理由 将 设为 「异常金额」。
  返回 欺诈结果 包含 可疑 将 设为 假值, 风险评分 将 设为 10, 理由 将 设为 「正常交易」。
`;

const FRAUD_SOURCE_DE = `Modul finanz.betrug.

Definiere Transaktion hat
  kennung,
  kontoId,
  betrag,
  zeitstempel.

Definiere KontoHistorie hat
  kontoId,
  durchschnittsbetrag,
  verdaechtigeAnzahl,
  kontoalter.

Definiere BetrugsErgebnis hat
  verdaechtig as Boolesch,
  risikoBewertung as Ganzzahl,
  begruendung.

Regel betrugErkennen gegeben transaktion, historie, liefert:
  wenn transaktion.betrag groesser als 1000000
    gib zurueck BetrugsErgebnis mit verdaechtig setze auf wahr, risikoBewertung setze auf 100, begruendung setze auf "Extrem grosse Transaktion".
  wenn historie.verdaechtigeAnzahl groesser als 5
    gib zurueck BetrugsErgebnis mit verdaechtig setze auf wahr, risikoBewertung setze auf 85, begruendung setze auf "Hohe verdaechtige Aktivitaet".
  wenn historie.kontoalter kleiner als 30
    gib zurueck BetrugsErgebnis mit verdaechtig setze auf wahr, risikoBewertung setze auf 70, begruendung setze auf "Neues Konto Risiko".
  wenn transaktion.betrag groesser als historie.durchschnittsbetrag mal 10
    gib zurueck BetrugsErgebnis mit verdaechtig setze auf wahr, risikoBewertung setze auf 60, begruendung setze auf "Ungewoehnlicher Betrag".
  gib zurueck BetrugsErgebnis mit verdaechtig setze auf falsch, risikoBewertung setze auf 10, begruendung setze auf "Normale Transaktion".
`;

// ============================================
// 策略源码 - 信用卡审批
// ============================================

const CREDITCARD_SOURCE_EN = `Module finance.creditcard.

Define Applicant has
  id,
  age,
  income,
  creditScore,
  existingCards.

Define Application has
  requestedLimit as Int,
  cardType.

Define Decision has
  approved as Bool,
  approvedLimit as Int,
  interestRate as Int,
  reason.

Rule evaluateApplication given applicant, application, produce:
  If applicant.age less than 21
    Return Decision with approved set to false, approvedLimit set to 0, interestRate set to 0, reason set to "Age below 21".
  If applicant.creditScore less than 550
    Return Decision with approved set to false, approvedLimit set to 0, interestRate set to 0, reason set to "Credit score too low".
  If applicant.existingCards greater than 5
    Return Decision with approved set to false, approvedLimit set to 0, interestRate set to 0, reason set to "Too many existing cards".
  Let limit be determineLimit(applicant, application).
  Let rate be determineRate(applicant).
  Return Decision with approved set to true, approvedLimit set to limit, interestRate set to rate, reason set to "Approved".

Rule determineLimit given applicant, application, produce:
  If applicant.creditScore greater than 750
    Return application.requestedLimit.
  If applicant.creditScore greater than 700
    Return application.requestedLimit times 80 divided by 100.
  Return application.requestedLimit times 50 divided by 100.

Rule determineRate given applicant, produce:
  If applicant.creditScore greater than 750
    Return 1299.
  If applicant.creditScore greater than 700
    Return 1599.
  Return 1999.
`;

const CREDITCARD_SOURCE_ZH = `模块 金融.信用卡。

定义 申请人 包含
  编号，
  年龄，
  收入，
  信用评分，
  现有卡数。

定义 申请 包含
  申请额度 as 整数，
  卡类型。

定义 决定 包含
  批准 as 布尔，
  批准额度 as 整数，
  利率 as 整数，
  理由。

规则 评估申请 给定 申请人，申请，产出：
  如果 申请人.年龄 小于 21
    返回 决定 包含 批准 将 设为 假值, 批准额度 将 设为 0, 利率 将 设为 0, 理由 将 设为 「年龄未满21岁」。
  如果 申请人.信用评分 小于 550
    返回 决定 包含 批准 将 设为 假值, 批准额度 将 设为 0, 利率 将 设为 0, 理由 将 设为 「信用评分过低」。
  如果 申请人.现有卡数 大于 5
    返回 决定 包含 批准 将 设为 假值, 批准额度 将 设为 0, 利率 将 设为 0, 理由 将 设为 「现有卡数过多」。
  令 额度 定义为 确定额度(申请人, 申请)。
  令 利率值 定义为 确定利率(申请人)。
  返回 决定 包含 批准 将 设为 真值, 批准额度 将 设为 额度, 利率 将 设为 利率值, 理由 将 设为 「已批准」。

规则 确定额度 给定 申请人，申请，产出：
  如果 申请人.信用评分 大于 750
    返回 申请.申请额度。
  如果 申请人.信用评分 大于 700
    返回 申请.申请额度 乘以 80 除以 100。
  返回 申请.申请额度 乘以 50 除以 100。

规则 确定利率 给定 申请人，产出：
  如果 申请人.信用评分 大于 750
    返回 1299。
  如果 申请人.信用评分 大于 700
    返回 1599。
  返回 1999。
`;

const CREDITCARD_SOURCE_DE = `Modul finanz.kreditkarte.

Definiere Antragsteller hat
  kennung,
  alter,
  einkommen,
  bonitaet,
  vorhandeneKarten.

Definiere Antrag hat
  gewuenschtesLimit as Ganzzahl,
  kartentyp.

Definiere Entscheidung hat
  genehmigt as Boolesch,
  genehmigterLimit as Ganzzahl,
  zinssatz as Ganzzahl,
  begruendung.

Regel antragAuswerten gegeben antragsteller, antrag, liefert:
  wenn antragsteller.alter kleiner als 21
    gib zurueck Entscheidung mit genehmigt setze auf falsch, genehmigterLimit setze auf 0, zinssatz setze auf 0, begruendung setze auf "Alter unter 21".
  wenn antragsteller.bonitaet kleiner als 550
    gib zurueck Entscheidung mit genehmigt setze auf falsch, genehmigterLimit setze auf 0, zinssatz setze auf 0, begruendung setze auf "Bonitaet zu niedrig".
  wenn antragsteller.vorhandeneKarten groesser als 5
    gib zurueck Entscheidung mit genehmigt setze auf falsch, genehmigterLimit setze auf 0, zinssatz setze auf 0, begruendung setze auf "Zu viele vorhandene Karten".
  sei limit gleich limitBestimmen(antragsteller, antrag).
  sei rate gleich zinsBestimmen(antragsteller).
  gib zurueck Entscheidung mit genehmigt setze auf wahr, genehmigterLimit setze auf limit, zinssatz setze auf rate, begruendung setze auf "Genehmigt".

Regel limitBestimmen gegeben antragsteller, antrag, liefert:
  wenn antragsteller.bonitaet groesser als 750
    gib zurueck antrag.gewuenschtesLimit.
  wenn antragsteller.bonitaet groesser als 700
    gib zurueck antrag.gewuenschtesLimit mal 80 geteilt durch 100.
  gib zurueck antrag.gewuenschtesLimit mal 50 geteilt durch 100.

Regel zinsBestimmen gegeben antragsteller, liefert:
  wenn antragsteller.bonitaet groesser als 750
    gib zurueck 1299.
  wenn antragsteller.bonitaet groesser als 700
    gib zurueck 1599.
  gib zurueck 1999.
`;

// ============================================
// 策略示例定义
// ============================================

const loanExample: PolicyExample = {
  id: 'loan-evaluation',
  category: 'loan',
  groupId: 'loan',
  sources: {
    'en-US': LOAN_SOURCE_EN,
    'zh-CN': LOAN_SOURCE_ZH,
    'de-DE': LOAN_SOURCE_DE,
  },
  metadata: {
    'en-US': {
      name: 'Loan Evaluation',
      description: 'Evaluate loan applications based on credit score and age',
    },
    'zh-CN': {
      name: '贷款评估',
      description: '根据信用评分和年龄评估贷款申请',
    },
    'de-DE': {
      name: 'Kreditbewertung',
      description: 'Kreditantraege basierend auf Bonitaet und Alter bewerten',
    },
  },
  defaultInputs: {
    'en-US': {
      applicant: {
        id: 'APP-001',
        creditScore: 720,
        income: 75000,
        age: 35
      }
    },
    'zh-CN': {
      申请人: {
        编号: 'APP-001',
        信用评分: 720,
        收入: 75000,
        年龄: 35
      }
    },
    'de-DE': {
      antragsteller: {
        kennung: 'APP-001',
        bonitaet: 720,
        einkommen: 75000,
        alter: 35
      }
    },
  },
};

const healthcareExample: PolicyExample = {
  id: 'healthcare-eligibility',
  category: 'healthcare',
  groupId: 'eligibility',
  sources: {
    'en-US': HEALTHCARE_SOURCE_EN,
    'zh-CN': HEALTHCARE_SOURCE_ZH,
    'de-DE': HEALTHCARE_SOURCE_DE,
  },
  metadata: {
    'en-US': {
      name: 'Healthcare Eligibility',
      description: 'Check patient eligibility for medical services',
    },
    'zh-CN': {
      name: '医疗资格审核',
      description: '检查患者的医疗服务资格',
    },
    'de-DE': {
      name: 'Gesundheits-Berechtigung',
      description: 'Patientenberechtigung fuer medizinische Leistungen pruefen',
    },
  },
  defaultInputs: {
    'en-US': {
      patient: {
        id: 'PAT-001',
        age: 45,
        hasInsurance: true,
        insuranceType: 'Standard'
      },
      service: {
        code: 'SVC-001',
        name: 'Annual Checkup',
        price: 500
      }
    },
    'zh-CN': {
      患者: {
        编号: 'PAT-001',
        年龄: 45,
        有保险: true,
        保险类型: 'Standard'
      },
      服务: {
        代码: 'SVC-001',
        名称: 'Annual Checkup',
        价格: 500
      }
    },
    'de-DE': {
      patient: {
        kennung: 'PAT-001',
        alter: 45,
        hatVersicherung: true,
        versicherungstyp: 'Standard'
      },
      leistung: {
        code: 'SVC-001',
        name: 'Annual Checkup',
        preis: 500
      }
    },
  },
};

const autoInsuranceExample: PolicyExample = {
  id: 'auto-insurance-quote',
  category: 'auto-insurance',
  groupId: 'auto',
  sources: {
    'en-US': AUTO_SOURCE_EN,
    'zh-CN': AUTO_SOURCE_ZH,
    'de-DE': AUTO_SOURCE_DE,
  },
  metadata: {
    'en-US': {
      name: 'Auto Insurance Quote',
      description: 'Generate auto insurance quotes based on driver and vehicle information',
    },
    'zh-CN': {
      name: '汽车保险报价',
      description: '根据驾驶员和车辆信息生成汽车保险报价',
    },
    'de-DE': {
      name: 'Kfz-Versicherungsangebot',
      description: 'Kfz-Versicherungsangebote basierend auf Fahrer- und Fahrzeuginformationen erstellen',
    },
  },
  defaultInputs: {
    'en-US': {
      driver: {
        id: 'DRV-001',
        age: 35,
        yearsLicensed: 15,
        accidents: 0,
        violations: 1
      },
      vehicle: {
        vin: '1HGBH41JXMN109186',
        year: 2022,
        value: 28000,
        safetyRating: 9
      }
    },
    'zh-CN': {
      驾驶员: {
        编号: 'DRV-001',
        年龄: 35,
        驾龄: 15,
        事故数: 0,
        违章数: 1
      },
      车辆: {
        车架号: '1HGBH41JXMN109186',
        年份: 2022,
        价值: 28000,
        安全评级: 9
      }
    },
    'de-DE': {
      fahrer: {
        kennung: 'DRV-001',
        alter: 35,
        fuehrerscheinJahre: 15,
        unfaelle: 0,
        verstoesse: 1
      },
      fahrzeug: {
        fahrgestellnummer: '1HGBH41JXMN109186',
        baujahr: 2022,
        wert: 28000,
        sicherheitsbewertung: 9
      }
    },
  },
};

const fraudExample: PolicyExample = {
  id: 'fraud-detection',
  category: 'fraud',
  groupId: 'fraud',
  sources: {
    'en-US': FRAUD_SOURCE_EN,
    'zh-CN': FRAUD_SOURCE_ZH,
    'de-DE': FRAUD_SOURCE_DE,
  },
  metadata: {
    'en-US': {
      name: 'Fraud Detection',
      description: 'Detect potentially fraudulent transactions',
    },
    'zh-CN': {
      name: '欺诈检测',
      description: '检测潜在的欺诈交易',
    },
    'de-DE': {
      name: 'Betrugserkennung',
      description: 'Potenziell betruegerische Transaktionen erkennen',
    },
  },
  defaultInputs: {
    'en-US': {
      transaction: {
        id: 'TXN-001',
        accountId: 'ACC-001',
        amount: 500,
        timestamp: 1704067200
      },
      history: {
        accountId: 'ACC-001',
        averageAmount: 450,
        suspiciousCount: 0,
        accountAge: 365
      }
    },
    'zh-CN': {
      交易: {
        编号: 'TXN-001',
        账户号: 'ACC-001',
        金额: 500,
        时间戳: 1704067200
      },
      历史: {
        账户号: 'ACC-001',
        平均金额: 450,
        可疑次数: 0,
        账龄: 365
      }
    },
    'de-DE': {
      transaktion: {
        kennung: 'TXN-001',
        kontoId: 'ACC-001',
        betrag: 500,
        zeitstempel: 1704067200
      },
      historie: {
        kontoId: 'ACC-001',
        durchschnittsbetrag: 450,
        verdaechtigeAnzahl: 0,
        kontoalter: 365
      }
    },
  },
};

const creditcardExample: PolicyExample = {
  id: 'creditcard-application',
  category: 'creditcard',
  groupId: 'creditcard',
  sources: {
    'en-US': CREDITCARD_SOURCE_EN,
    'zh-CN': CREDITCARD_SOURCE_ZH,
    'de-DE': CREDITCARD_SOURCE_DE,
  },
  metadata: {
    'en-US': {
      name: 'Credit Card Application',
      description: 'Evaluate credit card applications and determine credit limits',
    },
    'zh-CN': {
      name: '信用卡申请',
      description: '评估信用卡申请并确定信用额度',
    },
    'de-DE': {
      name: 'Kreditkartenantrag',
      description: 'Kreditkartenantraege auswerten und Kreditlimits festlegen',
    },
  },
  defaultInputs: {
    'en-US': {
      applicant: {
        id: 'CCA-001',
        age: 32,
        income: 85000,
        creditScore: 740,
        existingCards: 2
      },
      application: {
        requestedLimit: 10000,
        cardType: 'Standard'
      }
    },
    'zh-CN': {
      申请人: {
        编号: 'CCA-001',
        年龄: 32,
        收入: 85000,
        信用评分: 740,
        现有卡数: 2
      },
      申请: {
        申请额度: 10000,
        卡类型: 'Standard'
      }
    },
    'de-DE': {
      antragsteller: {
        kennung: 'CCA-001',
        alter: 32,
        einkommen: 85000,
        bonitaet: 740,
        vorhandeneKarten: 2
      },
      antrag: {
        gewuenschtesLimit: 10000,
        kartentyp: 'Standard'
      }
    },
  },
};

// ============================================
// 导出
// ============================================

export const POLICY_EXAMPLES: PolicyExample[] = [
  loanExample,
  healthcareExample,
  autoInsuranceExample,
  fraudExample,
  creditcardExample,
];

// 按类别分组
export const POLICY_EXAMPLES_BY_CATEGORY: Record<PolicyCategory, PolicyExample[]> = {
  loan: POLICY_EXAMPLES.filter((e) => e.category === 'loan'),
  creditcard: POLICY_EXAMPLES.filter((e) => e.category === 'creditcard'),
  fraud: POLICY_EXAMPLES.filter((e) => e.category === 'fraud'),
  healthcare: POLICY_EXAMPLES.filter((e) => e.category === 'healthcare'),
  'auto-insurance': POLICY_EXAMPLES.filter((e) => e.category === 'auto-insurance'),
};

// ============================================
// 辅助函数
// ============================================

/**
 * 获取示例的源码（根据语言）
 */
export function getExampleSource(example: PolicyExample, locale: SupportedLocale): string {
  return example.sources[locale] || example.sources['en-US'];
}

/**
 * 获取示例名称（根据语言）
 */
export function getExampleName(example: PolicyExample, locale: SupportedLocale | string): string {
  const normalizedLocale = normalizeLocale(locale);
  return example.metadata[normalizedLocale]?.name || example.metadata['en-US'].name;
}

/**
 * 获取示例描述（根据语言）
 */
export function getExampleDescription(example: PolicyExample, locale: SupportedLocale | string): string {
  const normalizedLocale = normalizeLocale(locale);
  return example.metadata[normalizedLocale]?.description || example.metadata['en-US'].description;
}

/**
 * 获取分组名称（根据语言）
 */
export function getGroupName(group: PolicyGroupDef, locale: SupportedLocale | string): string {
  const normalizedLocale = normalizeLocale(locale);
  return group.names[normalizedLocale] || group.names['en-US'];
}

/**
 * 规范化 locale 字符串
 */
export function normalizeLocale(locale: string): SupportedLocale {
  if (locale.startsWith('zh')) return 'zh-CN';
  if (locale.startsWith('de')) return 'de-DE';
  return 'en-US';
}

/**
 * 类别标签映射
 */
export const CATEGORY_LABELS: Record<PolicyCategory, Record<SupportedLocale, string>> = {
  loan: { 'en-US': 'Loan', 'zh-CN': '贷款', 'de-DE': 'Kredit' },
  creditcard: { 'en-US': 'Credit Card', 'zh-CN': '信用卡', 'de-DE': 'Kreditkarte' },
  fraud: { 'en-US': 'Fraud Detection', 'zh-CN': '欺诈检测', 'de-DE': 'Betrugserkennung' },
  healthcare: { 'en-US': 'Healthcare', 'zh-CN': '医疗', 'de-DE': 'Gesundheitswesen' },
  'auto-insurance': { 'en-US': 'Auto Insurance', 'zh-CN': '汽车保险', 'de-DE': 'Kfz-Versicherung' },
};

/**
 * 获取类别标签
 */
export function getCategoryLabel(category: string, locale: SupportedLocale | string): string {
  const normalizedLocale = normalizeLocale(locale);
  const labels = CATEGORY_LABELS[category as PolicyCategory];
  if (!labels) return category;
  return labels[normalizedLocale] || labels['en-US'];
}

/**
 * 根据分组 ID 获取示例
 */
export function getExamplesByGroupId(groupId: string): PolicyExample[] {
  return POLICY_EXAMPLES.filter((e) => e.groupId === groupId);
}

/**
 * 查找分组定义
 */
export function findGroupById(groupId: string): PolicyGroupDef | undefined {
  function search(groups: PolicyGroupDef[]): PolicyGroupDef | undefined {
    for (const group of groups) {
      if (group.id === groupId) return group;
      if (group.children) {
        const found = search(group.children);
        if (found) return found;
      }
    }
    return undefined;
  }
  return search(POLICY_GROUP_TREE);
}
