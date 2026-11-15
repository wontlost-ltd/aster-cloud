/**
 * Aster Policy 示例模板
 * 
 * 从 Monaco 编辑器中抽离，避免静态导入导致动态加载失效
 */

export const ASTER_POLICY_TEMPLATES = {
  'en-US': `Module finance.loan.

Define Applicant has
  id as Text,
  creditScore as Int,
  income as Float,
  requestedAmount as Float.

Rule evaluateLoan given applicant as Applicant, produce Text:
  If applicant.creditScore greater than 750
    Return "Approved with premium rate".
  Otherwise
    If applicant.creditScore greater than 650
      Return "Approved with standard rate".
    Otherwise
      Return "Requires manual review".
`,
  'zh-CN': `模块 金融.贷款。

定义 申请人 包含
  编号，
  信用评分，
  收入，
  申请金额。

规则 评估贷款 给定 申请人：
  如果 申请人.信用评分 大于 750
    返回「批准，优惠利率」。
  否则
    如果 申请人.信用评分 大于 650
      返回「批准，标准利率」。
    否则
      返回「需要人工审核」。
`,
  'de-DE': `Modul finanz.kredit.

Definiere Antragsteller hat
  kennung als Text,
  bonitaet als Ganzzahl,
  einkommen als Dezimal,
  kreditbetrag als Dezimal.

Regel kreditPruefen gegeben antragsteller als Antragsteller liefert Text:
  wenn antragsteller.bonitaet größer als 750
    gib zurück "Genehmigt mit Vorzugszins".
  sonst
    wenn antragsteller.bonitaet größer als 650
      gib zurück "Genehmigt mit Standardzins".
    sonst
      gib zurück "Erfordert manuelle Prüfung".
`,
};

/**
 * 根据 locale 获取对应的模板
 */
export function getTemplateForLocale(locale: string): string {
  if (locale.startsWith('zh')) {
    return ASTER_POLICY_TEMPLATES['zh-CN'];
  }
  if (locale.startsWith('de')) {
    return ASTER_POLICY_TEMPLATES['de-DE'];
  }
  return ASTER_POLICY_TEMPLATES['en-US'];
}
