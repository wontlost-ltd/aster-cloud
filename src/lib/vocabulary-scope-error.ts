/**
 * 引擎 VocabularyScopeError（作者词汇无法构成作用域：字段/枚举成员缺 parent、字面量宏冲突）的结构化解读。
 * 保存入口的 400 vocabulary_scope_invalid 与 resolver 迁移分诊报告共用同一口径。
 */

/** 引擎错误码 → 出错词条的种类（与词条表的 kind 一致，界面据此提示该改哪类词条）。 */
const SCOPE_ERROR_KIND: Readonly<Record<string, string>> = {
  field_parent_required: 'field',
  member_parent_required: 'enum_value',
  literal_conflict: 'literal',
};

export interface VocabularyScopeErrorDetails {
  /** 引擎错误码。 */
  reason: string | undefined;
  /** 出错词条的写法（引擎消息里首个引号内容）。 */
  term: string | undefined;
  /** 出错词条的种类。 */
  kind: string | undefined;
  message: string;
}

/**
 * 是 VocabularyScopeError 时返回其原因、词条与种类，否则 null。按 name 判别而不 instanceof，
 * 不依赖引擎模块实例（打包/测试 mock 下可能不是同一个类）。
 */
export function vocabularyScopeErrorDetails(error: unknown): VocabularyScopeErrorDetails | null {
  if (!(error instanceof Error) || error.name !== 'VocabularyScopeError') return null;
  const code = (error as Error & { code?: unknown }).code;
  const reason = typeof code === 'string' ? code : undefined;
  return {
    reason,
    term: /"([^"]*)"/.exec(error.message)?.[1],
    kind: reason ? SCOPE_ERROR_KIND[reason] : undefined,
    message: error.message,
  };
}

/** 按引擎错误码生成的英文说明（{term} 处填出错词条写法）；界面另按 code/reason/term 本地化。 */
const SCOPE_ERROR_MESSAGE: Readonly<Record<string, string>> = {
  field_parent_required: 'Domain vocabulary field {term} has no parent type. Assign the type it belongs to and save again.',
  member_parent_required: 'Domain vocabulary enum value {term} has no parent enum. Assign the enum it belongs to and save again.',
  literal_conflict: 'Domain vocabulary literal trigger {term} maps to more than one value. Keep a single value and save again.',
};

const GENERIC_SCOPE_ERROR_MESSAGE =
  'The domain vocabulary cannot be applied to this policy. Fix the listed term and save again.';

/**
 * 给 API 调用方的英文消息。引擎文案是中文且不随请求 locale 变化，不直接透传；
 * 未知错误码与缺词条时退回通用说明。
 */
export function vocabularyScopeErrorMessage(details: Pick<VocabularyScopeErrorDetails, 'reason' | 'term'>): string {
  const template = details.reason ? SCOPE_ERROR_MESSAGE[details.reason] : undefined;
  if (!template) return GENERIC_SCOPE_ERROR_MESSAGE;
  return template.replace(' {term}', details.term ? ` "${details.term}"` : '');
}
