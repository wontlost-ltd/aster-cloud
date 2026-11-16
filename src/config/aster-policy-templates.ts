/**
 * 新建策略的入门模板（starter），按 CNL 语种各一份。
 *
 * 用途：
 * - /policies/new 没有文档深链时，按界面语言预填（见 getStarterTemplate）；
 * - 同一份源码也是模板目录（@/data/policy-examples）里的「基础入门」条目，侧栏「模板」tab
 *   与命令面板都从那里取——入门模板与模板目录是一套数据，不另起第二套模板系统。
 *
 * 约束（由 src/__tests__/aster-policy-templates.compile.test.ts 与 policy-examples-* 测试守护）：
 * - 每个语种零诊断编译、通过类型检查、可执行，且三语语义一致；
 * - 规则参数显式带类型（编辑器里 `参数.` 才有字段补全）；
 * - 模块名不与其它内置样例重复，用户不改源码直接创建也能通过创建端点的编译门禁。
 *
 * 从 Monaco 编辑器中抽离，避免静态导入导致动态加载失效。
 */

export const ASTER_POLICY_TEMPLATES = {
  'en-US': `Module starter.loan.

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
  'zh-CN': `模块 入门.贷款。

定义 申请人 包含
  编号，
  信用评分，
  收入，
  申请金额。

规则 评估贷款 给定 申请人 作为 申请人，产出 文本：
  如果 申请人.信用评分 大于 750
    返回「批准，优惠利率」。
  否则
    如果 申请人.信用评分 大于 650
      返回「批准，标准利率」。
    否则
      返回「需要人工审核」。
`,
  'de-DE': `Modul einstieg.kredit.

Definiere Antragsteller hat
  kennung als Text,
  bonitaet als Ganzzahl,
  einkommen als Dezimal,
  kreditbetrag als Dezimal.

Regel kreditPruefen gegeben antragsteller als Antragsteller, liefert Text:
  wenn antragsteller.bonitaet größer als 750
    gib zurück "Genehmigt mit Vorzugszins".
  sonst
    wenn antragsteller.bonitaet größer als 650
      gib zurück "Genehmigt mit Standardzins".
    sonst
      gib zurück "Erfordert manuelle Prüfung".
`,
};

export type StarterTemplateLocale = keyof typeof ASTER_POLICY_TEMPLATES;

/** 入门模板在模板目录里的 id（侧栏「模板」tab 的「基础入门」条目）。 */
export const STARTER_TEMPLATE_ID = 'basic-starter';

/**
 * 界面语言 → 入门模板语种。zh / de 取本语种，其余（含 hi）回落 en-US：hi-IN 暂无内置模板与
 * 语种识别，编辑器对 hi 界面的空策略也按 en-US 处理（与 normalizeLocale 同一映射）。
 */
function starterLocaleFor(uiLocale: string): StarterTemplateLocale {
  if (uiLocale.startsWith('zh')) return 'zh-CN';
  if (uiLocale.startsWith('de')) return 'de-DE';
  return 'en-US';
}

/** 新建策略的入门模板：语种与源码。 */
export function getStarterTemplate(uiLocale: string): { locale: StarterTemplateLocale; source: string } {
  const locale = starterLocaleFor(uiLocale);
  return { locale, source: ASTER_POLICY_TEMPLATES[locale] };
}

/**
 * 根据 locale 获取对应的模板
 */
export function getTemplateForLocale(locale: string): string {
  return getStarterTemplate(locale).source;
}

/**
 * 未改动的入门模板不算用户写的源码：等于 starter 时返回空串，否则原样返回。
 * AI「生成」据此把「编辑器里只有入门模板」当作从零生成，而不是改写入门模板。
 */
export function withoutPristineStarter(source: string, starter: string | null | undefined): string {
  return starter && source === starter ? '' : source;
}
