/**
 * 领域词汇 validation_failed 消息 → 可本地化的原因码。
 *
 * 服务端 validation_failed 的 message 有两类来源：路由/服务层的英文前置校验
 * （"canonical is required" 等）与 aster-lang-ts validateVocabulary 的中文诊断
 * （"structs[0]: 规范化名称 "x" 必须是有效的 ASCII 标识符"）。界面不直接展示原文，
 * 而是识别为原因码 + 参数后按当前语言渲染；识别不了的回落到通用提示。
 *
 * 引擎文案若改动，src/__tests__/lib/vocabulary-validation-message.test.ts 会用真实
 * validateVocabulary 输出发现漂移。
 */

export type VocabularyValidationReason =
  | 'invalidCanonical'
  | 'duplicateCanonical'
  | 'triggerConflict'
  | 'invalidLiteral'
  | 'parentRequired'
  | 'fieldRequired';

export interface VocabularyValidationDetail {
  readonly reason: VocabularyValidationReason;
  readonly values: Readonly<Record<string, string>>;
}

/** 按顺序匹配；第一个命中的规则决定原因码。 */
const RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly reason: VocabularyValidationReason;
  readonly param?: string;
}> = [
  { pattern: /规范化名称 "([^"]*)" 必须是有效的 ASCII 标识符/, reason: 'invalidCanonical', param: 'name' },
  { pattern: /规范化名称 "([^"]*)" 重复/, reason: 'duplicateCanonical', param: 'name' },
  { pattern: /触发词 "([^"]*)" 与另一条映射冲突/, reason: 'triggerConflict', param: 'trigger' },
  { pattern: /字面量宏内容/, reason: 'invalidLiteral' },
  { pattern: /^parentCanonical is required/, reason: 'parentRequired' },
  { pattern: /^(canonical|localized|domain|locale|kind)(?: and locale)? (?:is|are) required/, reason: 'fieldRequired', param: 'field' },
];

/** 识别 validation_failed 消息；无法识别返回 null（调用方显示通用本地化提示）。 */
export function parseVocabularyValidationMessage(
  message: string | undefined | null,
): VocabularyValidationDetail | null {
  if (!message) return null;
  for (const segment of message.split('; ')) {
    for (const rule of RULES) {
      const match = segment.match(rule.pattern);
      if (!match) continue;
      const values: Record<string, string> = rule.param ? { [rule.param]: match[1] ?? '' } : {};
      return { reason: rule.reason, values };
    }
  }
  return null;
}
