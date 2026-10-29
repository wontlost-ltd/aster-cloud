/**
 * 领域词汇作用域：决定「一条策略用到了用户的哪些词汇分组」（纯叶子模块，浏览器安全）。
 *
 * 策略本身没有 domain 字段，Module 名与词汇 domain 之间也没有任何约定，因此唯一可靠、
 * 且在编辑器 / 保存编译门禁 / 审批冻结 / 执行四处都能独立算出同一结果的依据是**源码本身**：
 *   1. 语言：词条的 locale 与策略 CNL 语言（由源码关键词识别，如 de-DE）主语言相同。
 *      词条 locale 是用户自由填写的（常见 `de`），所以按主语言子标签比较，而不是全串相等。
 *   2. 用途：该 (domain, locale) 分组里至少一个本地化名或别名以完整单词出现在源码的
 *      **代码部分**（注释与字符串字面量不算引用）。
 *
 * 名称解析（ADR 0051）只把源码里实际写出的名字按所在位置匹配到词条，未被源码引用的分组
 * 没有任何名字能命中，对编译结果没有影响；因此按用途筛选既不改变执行语义，又能让审批只冻结
 * 真正相关的分组（#610），并避免无关领域的同名词串扰。
 *
 * 设计约束：只依赖 aster-lang-ts 的浏览器入口与纯类型，禁止引入 node:* / 数据库，
 * 编辑器端会直接导入本模块。
 */

import type {
  DomainVocabulary,
  IdentifierMapping,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { lex, TokenKind } from '@aster-cloud/aster-lang-ts/browser';
import { getLexicon, type Lexicon } from '@/lib/aster-lexicon';
import {
  assembleDomainVocabularyFromLinks,
  type TermLikeRow,
} from '@/lib/domain-vocabulary-assemble';

/**
 * 编辑器把选中的分组合并后注册到引擎时使用的固定 domain id。
 * 编译器按 (tenantId, domain, locale) 查找自定义词汇，固定 id 让编辑器无需知道分组名。
 */
export const USER_VOCABULARY_DOMAIN = 'user-vocabulary';

/**
 * 词条列表接口的单页上限。服务端分页（domain-vocabulary.ts）与编辑器全量拉取共用，
 * 保证两端按同一口径读完全部活跃词条。
 */
export const VOCABULARY_LIST_MAX_PAGE_SIZE = 200;

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;

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
 * 退化路径（仅编辑器 lenient 模式可达，见 ScopeOptions）：源码无法词法分析时，按 CNL 语法去掉
 * 行注释（`#`、`//`）与字符串字面量（ASCII 引号及该语言的引号对；未闭合的截到行尾），
 * 其余原样保留。
 */
export function stripCommentsAndStrings(source: string, lexicon: Lexicon): string {
  const quotes = new Map<string, string>([['"', '"']]);
  quotes.set(lexicon.punctuation.stringQuotes.open, lexicon.punctuation.stringQuotes.close);
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const isComment = ch === '#' || (ch === '/' && source[i + 1] === '/');
    const close = quotes.get(ch);
    if (isComment || close !== undefined) {
      out += ' ';
      i = skippedEnd(source, i, isComment ? undefined : close);
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** 注释/字符串从 start 起跳过到哪里：注释到行尾；字符串到闭合引号之后，未闭合则到行尾。 */
function skippedEnd(source: string, start: number, close: string | undefined): number {
  const newline = source.indexOf('\n', start + 1);
  const lineEnd = newline === -1 ? source.length : newline;
  if (close === undefined) return lineEnd;
  const end = source.indexOf(close, start + 1);
  return end === -1 || end > lineEnd ? lineEnd : end + 1;
}

/**
 * 作用域判定选项。
 *
 * `lenient` 只给编辑器用：编辑中途的源码常常无法词法分析（如字符串未闭合），此时退化为
 * stripCommentsAndStrings。服务端路径（保存编译门禁、审批冻结、执行加载）一律严格：
 * 能落库/审批/执行的源码必然可词法分析，词法分析失败直接抛错（由各路径既有的错误处理
 * 兜底），绝不用启发式剥离来决定冻结或执行用哪些词汇。
 */
export interface ScopeOptions {
  lenient?: boolean;
}

/**
 * 源码中「作为代码出现」的文本：用引擎词法分析器只保留标识符 token（注释与字符串
 * 字面量是独立 token，自然被排除），标识符以空格连接——单词边界与源码一致，CJK 子串
 * 匹配也不会跨越两个标识符。词法分析失败时：lenient 退化为 stripCommentsAndStrings，
 * 否则抛出。
 */
export function codeText(source: string, locale: string, opts: ScopeOptions = {}): string {
  const lexicon = getLexicon(locale);
  let tokens: ReturnType<typeof lex>;
  try {
    tokens = lex(source, lexicon);
  } catch (err) {
    if (!opts.lenient) throw err;
    return stripCommentsAndStrings(source, lexicon);
  }
  return tokens
    .filter((token) => token.kind === TokenKind.IDENT || token.kind === TokenKind.TYPE_IDENT)
    .map((token) => String(token.value))
    .join(' ');
}

/**
 * 判断一个词形是否以完整单词出现在代码文本中（大小写不敏感，与引擎术语翻译一致）。
 * 中日文没有词间空格，退化为（单个标识符内的）子串匹配。
 */
function containsTerm(code: string, form: string): boolean {
  const term = form.trim();
  if (term === '') return false;
  if (CJK_PATTERN.test(term)) return code.includes(term);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'iu');
  return pattern.test(code);
}

function mappingsOf(vocabulary: DomainVocabulary): IdentifierMapping[] {
  return [
    ...(vocabulary.structs ?? []),
    ...(vocabulary.fields ?? []),
    ...(vocabulary.functions ?? []),
    ...(vocabulary.enumValues ?? []),
  ];
}

/** 代码文本（见 codeText）是否引用了该词汇表中的任一本地化名或别名。 */
export function isVocabularyUsedBy(code: string, vocabulary: DomainVocabulary): boolean {
  return mappingsOf(vocabulary).some((mapping) =>
    [mapping.localized, ...(mapping.aliases ?? [])].some((form) => containsTerm(code, form)),
  );
}

/** 一条策略的词汇作用域输入：源码 + 其 CNL 语言。 */
export interface PolicyVocabularyContext {
  source: string;
  locale: string;
}

/**
 * 构造策略作用域判定器：源码只做一次词法分析，再逐个判断候选词汇表
 * （语言相同且被代码引用）。
 */
export function policyScopeMatcher(
  policy: PolicyVocabularyContext,
  opts: ScopeOptions = {},
): (vocabulary: DomainVocabulary) => boolean {
  const code = codeText(policy.source, policy.locale, opts);
  return (vocabulary) =>
    isLocaleCompatible(vocabulary.locale, policy.locale) && isVocabularyUsedBy(code, vocabulary);
}

/** 从候选词汇表中筛出该策略实际使用的那些。 */
export function selectVocabulariesForPolicy(
  vocabularies: readonly DomainVocabulary[],
  policy: PolicyVocabularyContext,
  opts: ScopeOptions = {},
): DomainVocabulary[] {
  return vocabularies.filter(policyScopeMatcher(policy, opts));
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
 * 只有一个分组时原样返回，保留其原始 id。字面量宏（literals）与其它映射一样合并去重；
 * 没有任何分组带字面量时不加该键，保持既有词汇表形状。
 */
export function mergeVocabularies(
  vocabularies: readonly DomainVocabulary[],
  opts: { id?: string; locale?: string } = {},
): DomainVocabulary | null {
  if (vocabularies.length === 0) return null;
  const first = vocabularies[0]!;
  if (vocabularies.length === 1 && !opts.id && !opts.locale) return first;
  const id = opts.id ?? first.id;
  const literals = dedupe(vocabularies.flatMap((v) => v.literals ?? []));
  return {
    ...first,
    id,
    name: opts.id ?? first.name,
    locale: opts.locale ?? first.locale,
    version: vocabularies.length === 1 ? first.version : 'merged',
    structs: dedupe(vocabularies.flatMap((v) => v.structs ?? [])),
    fields: dedupe(vocabularies.flatMap((v) => v.fields ?? [])),
    functions: dedupe(vocabularies.flatMap((v) => v.functions ?? [])),
    enumValues: dedupe(vocabularies.flatMap((v) => v.enumValues ?? [])),
    ...(literals.length > 0 ? { literals } : {}),
  };
}

/**
 * 一步到位：从用户的全部词条行算出该策略应使用的合并词汇表。
 * 编辑器与服务端编译门禁共用，保证两边看到的词汇一致。
 */
export function resolvePolicyVocabularyFromRows(
  rows: readonly TermLikeRow[],
  policy: PolicyVocabularyContext,
  opts: ScopeOptions & { id?: string } = {},
): DomainVocabulary | null {
  const selected = selectVocabulariesForPolicy(assembleVocabularyGroups(rows), policy, opts);
  return mergeVocabularies(selected, { id: opts.id, locale: policy.locale });
}
