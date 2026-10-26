/**
 * 领域词汇作用域：决定「一条策略用到了用户的哪些词汇分组」（纯叶子模块，浏览器安全）。
 *
 * 策略本身没有 domain 字段，Module 名与词汇 domain 之间也没有任何约定，因此唯一可靠、
 * 且在编辑器 / 保存编译门禁 / 审批冻结 / 执行四处都能独立算出同一结果的依据是**源码本身**：
 *   1. 语言：词条的 locale 与策略 CNL 语言（由源码关键词识别，如 de-DE）主语言相同。
 *      词条 locale 是用户自由填写的（常见 `de`），所以按主语言子标签比较，而不是全串相等。
 *   2. 用途：该 (domain, locale) 分组里至少一个本地化名或别名以完整单词出现在源码中。
 *
 * 未被源码引用的分组对规范化结果没有任何影响（规范化只翻译源码里出现的词），
 * 因此按用途筛选既不改变执行语义，又能让审批只冻结真正相关的分组（#610），
 * 并避免无关领域的同名词串扰。
 *
 * 设计约束（与 domain-vocabulary-assemble 相同）：只依赖 aster-lang-ts 的纯类型，
 * 禁止引入 node:* / 数据库，编辑器端会直接导入本模块。
 */

import type {
  DomainVocabulary,
  IdentifierMapping,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import {
  assembleDomainVocabularyFromLinks,
  type TermLikeRow,
} from '@/lib/domain-vocabulary-assemble';

/**
 * 编辑器把选中的分组合并后注册到引擎时使用的固定 domain id。
 * 编译器按 (tenantId, domain, locale) 查找自定义词汇，固定 id 让编辑器无需知道分组名。
 */
export const USER_VOCABULARY_DOMAIN = 'user-vocabulary';

const CJK_PATTERN = /[぀-ヿ㐀-鿿豈-﫿]/u;

/** 取 BCP-47 主语言子标签（`de-DE`、`de_AT`、`DE` → `de`）。 */
export function localeLanguage(locale: string | null | undefined): string {
  return (locale ?? '').trim().split(/[-_]/)[0]!.toLowerCase();
}

/** 词条 locale 是否适用于该 CNL 语言的策略。 */
export function isLocaleCompatible(termLocale: string, policyLocale: string): boolean {
  const language = localeLanguage(termLocale);
  return language !== '' && language === localeLanguage(policyLocale);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 判断一个词形是否以完整单词出现在源码中（大小写不敏感）。
 * 中日文没有词间空格，退化为子串匹配。
 */
function containsTerm(source: string, form: string): boolean {
  const term = form.trim();
  if (term === '') return false;
  if (CJK_PATTERN.test(term)) return source.includes(term);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'iu');
  return pattern.test(source);
}

function mappingsOf(vocabulary: DomainVocabulary): IdentifierMapping[] {
  return [
    ...(vocabulary.structs ?? []),
    ...(vocabulary.fields ?? []),
    ...(vocabulary.functions ?? []),
    ...(vocabulary.enumValues ?? []),
  ];
}

/** 源码是否引用了该词汇表中的任一本地化名或别名。 */
export function isVocabularyUsedBy(source: string, vocabulary: DomainVocabulary): boolean {
  return mappingsOf(vocabulary).some((mapping) =>
    [mapping.localized, ...(mapping.aliases ?? [])].some((form) => containsTerm(source, form)),
  );
}

/** 一条策略的词汇作用域输入：源码 + 其 CNL 语言。 */
export interface PolicyVocabularyContext {
  source: string;
  locale: string;
}

/** 该词汇表是否属于策略的作用域（语言相同且被源码引用）。 */
export function isVocabularyInScope(
  vocabulary: DomainVocabulary,
  policy: PolicyVocabularyContext,
): boolean {
  return (
    isLocaleCompatible(vocabulary.locale, policy.locale) &&
    isVocabularyUsedBy(policy.source, vocabulary)
  );
}

/** 从候选词汇表中筛出该策略实际使用的那些。 */
export function selectVocabulariesForPolicy(
  vocabularies: readonly DomainVocabulary[],
  policy: PolicyVocabularyContext,
): DomainVocabulary[] {
  return vocabularies.filter((vocabulary) => isVocabularyInScope(vocabulary, policy));
}

/** 按 (domain, locale) 分组词条行，key 形如 `domain|locale`。 */
export function groupTermRows<T extends TermLikeRow>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.domain}|${row.locale}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

/** 把词条行按分组组装成词汇表（每个 (domain, locale) 一个）。 */
export function assembleVocabularyGroups(rows: readonly TermLikeRow[]): DomainVocabulary[] {
  return [...groupTermRows(rows).entries()].map(([key, groupRows]) => {
    const [domain, locale] = key.split('|');
    return assembleDomainVocabularyFromLinks(groupRows, { domain, locale });
  });
}

function mappingKey(mapping: IdentifierMapping): string {
  return JSON.stringify([
    mapping.kind,
    mapping.canonical,
    mapping.localized,
    mapping.parent ?? null,
    [...(mapping.aliases ?? [])].sort(),
  ]);
}

function dedupe(mappings: readonly IdentifierMapping[]): IdentifierMapping[] {
  const seen = new Map<string, IdentifierMapping>();
  for (const mapping of mappings) {
    const key = mappingKey(mapping);
    if (!seen.has(key)) seen.set(key, mapping);
  }
  return [...seen.values()];
}

/**
 * 把多个分组合并成一个词汇表（编译器与执行端一次只接收一个词汇表）。
 * 完全相同的映射去重，避免同一词在两个分组里重复定义而被引擎判为重复。
 * 只有一个分组时原样返回，保留其原始 id。
 */
export function mergeVocabularies(
  vocabularies: readonly DomainVocabulary[],
  opts: { id?: string; locale?: string } = {},
): DomainVocabulary | null {
  if (vocabularies.length === 0) return null;
  const first = vocabularies[0]!;
  if (vocabularies.length === 1 && !opts.id && !opts.locale) return first;
  const id = opts.id ?? first.id;
  return {
    id,
    name: opts.id ?? first.name,
    locale: opts.locale ?? first.locale,
    version: vocabularies.length === 1 ? first.version : 'merged',
    structs: dedupe(vocabularies.flatMap((v) => v.structs ?? [])),
    fields: dedupe(vocabularies.flatMap((v) => v.fields ?? [])),
    functions: dedupe(vocabularies.flatMap((v) => v.functions ?? [])),
    enumValues: dedupe(vocabularies.flatMap((v) => v.enumValues ?? [])),
  };
}

/**
 * 一步到位：从用户的全部词条行算出该策略应使用的合并词汇表。
 * 编辑器与服务端编译门禁共用，保证两边看到的词汇一致。
 */
export function resolvePolicyVocabularyFromRows(
  rows: readonly TermLikeRow[],
  policy: PolicyVocabularyContext,
  opts: { id?: string } = {},
): DomainVocabulary | null {
  const selected = selectVocabulariesForPolicy(assembleVocabularyGroups(rows), policy);
  return mergeVocabularies(selected, { ...opts, locale: policy.locale });
}
