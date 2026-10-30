/**
 * 领域词汇 domain / locale 的格式规则（#612）。
 *
 * 纯函数、无 Node 依赖：服务端写路径（单条增改、同步/异步批量）与客户端表单
 * 共用同一份规则，避免两端口径漂移。只约束新写入；库里已有的历史脏数据
 * 读取时照常返回，不在这里迁移。
 */

/** domain 最长长度：足够容纳 `insurance.auto.claims` 这类分段标识。 */
export const VOCAB_DOMAIN_MAX_LENGTH = 64;

/**
 * domain = 小写标识符，可用 `.` 分段（如 `finance`、`finance.loan`）。
 * 每段以小写字母开头，后续允许小写字母、数字、`_`、`-`。
 */
const DOMAIN_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;

/** 仅允许 BCP-47 的字符集；`_`、空格、标点在交给 Intl 之前就直接拒绝。 */
const LOCALE_CHARSET = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

export function isValidVocabularyDomain(domain: string): boolean {
  return domain.length <= VOCAB_DOMAIN_MAX_LENGTH && DOMAIN_PATTERN.test(domain);
}

/**
 * 校验并规范化 BCP-47 语言标签：合法时返回规范大小写形式（`zh-cn` → `zh-CN`），
 * 不合法返回 null。规范化保证同一语言不会因大小写不同而分裂成两套词汇。
 */
export function canonicalizeVocabularyLocale(locale: string): string | null {
  if (!LOCALE_CHARSET.test(locale)) return null;
  try {
    const [canonical] = Intl.getCanonicalLocales(locale);
    return canonical ?? null;
  } catch {
    return null;
  }
}

/** 格式错误的稳定标识，客户端据此取本地化文案，服务端据此拼英文消息。 */
export type VocabularyFormatIssue = 'domain_format' | 'locale_format';

export const VOCAB_FORMAT_MESSAGES: Record<VocabularyFormatIssue, string> = {
  domain_format:
    'domain must be a lowercase identifier (letters, digits, "_" or "-", dot-separated segments), e.g. finance or finance.loan',
  locale_format: 'locale must be a valid BCP-47 tag, e.g. en, zh-CN, de',
};

/**
 * 一次性检查 domain + locale。返回规范化后的值与发现的问题列表；
 * 调用方决定如何呈现（服务端抛 validation_failed，客户端标红字段）。
 */
export function checkVocabularyScope(input: { domain: string; locale: string }): {
  domain: string;
  locale: string;
  issues: VocabularyFormatIssue[];
} {
  const domain = input.domain.trim();
  const rawLocale = input.locale.trim();
  const canonicalLocale = canonicalizeVocabularyLocale(rawLocale);
  const issues: VocabularyFormatIssue[] = [];
  if (!isValidVocabularyDomain(domain)) issues.push('domain_format');
  if (!canonicalLocale) issues.push('locale_format');
  return { domain, locale: canonicalLocale ?? rawLocale, issues };
}

/**
 * 单词条上限，与 aster-api `VocabularyBounds` 一致（#621）：映射内数组（aliases）最多 256 项，
 * 任一字符串最多 16384 个字符（按 UTF-16 码元计，与 Java String.length 同口径）。
 * cloud 的列是 text/jsonb，不设上限时超限词条能保存成功，却在之后每次编译、执行时被 aster-api
 * 以 400 vocabulary_too_large 拒绝；故在保存入口（单条增改、同步/异步批量）就拒绝。
 */
export const VOCAB_TERM_MAX_ALIASES = 256;
export const VOCAB_TERM_MAX_TEXT_LENGTH = 16_384;

/** 受长度上限约束的词条字段。 */
export type VocabularyTermTextField = 'canonical' | 'localized' | 'parentCanonical' | 'description' | 'aliases';

export type VocabularyTermBoundsIssue =
  | { issue: 'aliases_too_many' }
  | { issue: 'text_too_long'; field: VocabularyTermTextField };

/** 检查单个词条是否在上限内；返回发现的问题（无问题为空数组）。 */
export function checkTermBounds(term: {
  canonical: string;
  localized: string;
  parentCanonical?: string | null;
  description?: string | null;
  aliases?: readonly string[] | null;
}): VocabularyTermBoundsIssue[] {
  const issues: VocabularyTermBoundsIssue[] = [];
  const aliases = term.aliases ?? [];
  if (aliases.length > VOCAB_TERM_MAX_ALIASES) issues.push({ issue: 'aliases_too_many' });
  const tooLong = (value: string | null | undefined) => (value?.length ?? 0) > VOCAB_TERM_MAX_TEXT_LENGTH;
  const scalars = ['canonical', 'localized', 'parentCanonical', 'description'] as const;
  for (const field of scalars) {
    if (tooLong(term[field])) issues.push({ issue: 'text_too_long', field });
  }
  if (aliases.some(tooLong)) issues.push({ issue: 'text_too_long', field: 'aliases' });
  return issues;
}

/** 上限问题的英文消息（稳定格式：界面经 vocabulary-validation-message 识别为原因码后本地化）。 */
export function termBoundsMessage(issue: VocabularyTermBoundsIssue): string {
  return issue.issue === 'aliases_too_many'
    ? `aliases must contain at most ${VOCAB_TERM_MAX_ALIASES} entries`
    : `${issue.field} must be at most ${VOCAB_TERM_MAX_TEXT_LENGTH} characters`;
}
