/**
 * 领域词汇 validation_failed 消息 → 可本地化的原因码（#609/#634）。
 *
 * 服务端 validation_failed 的 message 有两类来源：路由/服务层/异步 worker 的英文前置校验
 * （"canonical is required"、"terms[3].kind must be one of …" 等）与 aster-lang-ts validateVocabulary
 * 的中文诊断（"structs[0]: 规范化名称 "x" 必须是有效的 ASCII 标识符"，多条以 "; " 或换行拼接）。
 * 界面一律不展示原文：识别为原因码 + 参数后按当前语言渲染，识别不了的回落到通用提示。
 * 单条新增/编辑、同步/异步批量的行级错误、整批请求错误、快照回滚都经过这里。
 *
 * 引擎文案若改动，src/__tests__/lib/vocabulary-validation-message.test.ts 会用真实
 * validateVocabulary 输出发现漂移，并断言 en/de/hi 下渲染结果不含中文。
 */

export type VocabularyValidationReason =
  | 'invalidCanonical'
  | 'duplicateCanonical'
  | 'duplicateLocalized'
  | 'triggerConflict'
  | 'scopeConflict'
  | 'invalidLiteral'
  | 'parentRequired'
  | 'fieldRequired'
  | 'invalidValue'
  | 'invalidRow'
  | 'invalidKind'
  | 'domainFormat'
  | 'localeFormat'
  | 'bulkEmpty'
  | 'bulkTooMany';

export interface VocabularyValidationDetail {
  readonly reason: VocabularyValidationReason;
  readonly values: Readonly<Record<string, string>>;
}

/** 批量路由的行级前缀（`terms[3].canonical …`），字段名不含它。 */
const ROW_PREFIX = String.raw`(?:terms\[\d+\]\.)?`;

/** 按顺序匹配；第一个命中的规则决定原因码。param 取第一个捕获组。 */
const RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly reason: VocabularyValidationReason;
  readonly param?: string;
}> = [
  // aster-lang-ts validateVocabulary（errors 与 warnings）
  { pattern: /规范化名称 "([^"]*)" 必须是有效的 ASCII 标识符/, reason: 'invalidCanonical', param: 'name' },
  { pattern: /规范化名称 "([^"]*)" 重复/, reason: 'duplicateCanonical', param: 'name' },
  { pattern: /本地化名称 "([^"]*)" 重复/, reason: 'duplicateLocalized', param: 'name' },
  { pattern: /触发词 "([^"]*)" 与另一条映射冲突/, reason: 'triggerConflict', param: 'trigger' },
  { pattern: /字面量宏内容/, reason: 'invalidLiteral' },
  { pattern: /字段 "[^"]*" 没有指定父结构体/, reason: 'parentRequired' },
  // 按位置解析的作用域冲突（domain-vocabulary-validation formatScopeConflict，ADR 0051）
  { pattern: /^scope conflict: "([^"]*)"/, reason: 'scopeConflict', param: 'name' },
  // 服务层 / 路由 / 异步 worker 的英文前置校验
  { pattern: new RegExp(`^${ROW_PREFIX}parentCanonical is required`), reason: 'parentRequired' },
  {
    pattern: new RegExp(`^${ROW_PREFIX}(canonical|localized|domain|locale|kind)(?:(?: and |/)\\w+)* (?:is|are) required`),
    reason: 'fieldRequired',
    param: 'field',
  },
  { pattern: new RegExp(`^${ROW_PREFIX}kind must be`), reason: 'invalidKind' },
  { pattern: new RegExp(`^${ROW_PREFIX}(\\w+) must be (?:a string|an array of strings)`), reason: 'invalidValue', param: 'field' },
  { pattern: /^(?:terms\[\d+\]|row) must be an object|^Row is not an object/i, reason: 'invalidRow' },
  { pattern: /^domain must be a lowercase identifier/, reason: 'domainFormat' },
  { pattern: /^locale must be a valid BCP-47 tag/, reason: 'localeFormat' },
  { pattern: /requires at least one term|"terms" must (?:not be empty|be a non-empty array)|must include a "terms" array/, reason: 'bulkEmpty' },
  { pattern: /accepts at most (\d+) rows/, reason: 'bulkTooMany', param: 'limit' },
];

/** 识别 validation_failed 消息；无法识别返回 null（调用方显示通用本地化提示）。 */
export function parseVocabularyValidationMessage(
  message: string | undefined | null,
): VocabularyValidationDetail | null {
  if (!message) return null;
  for (const segment of message.split(/; |\n/)) {
    const trimmed = segment.trim();
    for (const rule of RULES) {
      const match = trimmed.match(rule.pattern);
      if (!match) continue;
      const values: Record<string, string> = rule.param ? { [rule.param]: match[1] ?? '' } : {};
      return { reason: rule.reason, values };
    }
  }
  return null;
}

/** 词汇页 `domainVocabularies` 命名空间下的翻译函数（只用到 errors.validation.*）。 */
export type VocabularyValidationTranslate = (
  key: `errors.validation.${VocabularyValidationReason | 'generic'}`,
  values?: Record<string, string>,
) => string;

/** 识别得了时返回本地化的具体原因，否则 null（调用方决定显示通用提示还是只显示错误类别）。 */
export function vocabularyValidationReasonText(
  message: string | undefined | null,
  t: VocabularyValidationTranslate,
): string | null {
  const detail = parseVocabularyValidationMessage(message);
  return detail ? t(`errors.validation.${detail.reason}`, { ...detail.values }) : null;
}

/** validation_failed 的界面文案：具体原因，识别不了时为通用提示。从不返回服务端原文。 */
export function vocabularyValidationText(
  message: string | undefined | null,
  t: VocabularyValidationTranslate,
): string {
  return vocabularyValidationReasonText(message, t) ?? t('errors.validation.generic');
}
