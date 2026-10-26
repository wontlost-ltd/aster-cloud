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
