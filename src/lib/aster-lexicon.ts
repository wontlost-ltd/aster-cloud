/**
 * Aster Lang 词法适配层
 *
 * 从 @aster-cloud/aster-lang-ts 导入词法定义，
 * 提供 aster-cloud 所需的简化接口和 Monaco 关键词提取功能。
 */

import type { Lexicon } from '@aster-cloud/aster-lang-ts/lexicons/types';
import type { DomainVocabulary, IdentifierIndex } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { EN_US } from '@aster-cloud/aster-lang-ts/lexicons/en-US';
import { ZH_CN } from '@aster-cloud/aster-lang-ts/lexicons/zh-CN';
import { DE_DE } from '@aster-cloud/aster-lang-ts/lexicons/de-DE';
// hi-IN（Hindi/天城文，第四语种）。1.0.1 包暂未暴露 ./lexicons/hi-IN 子路径
// （只有 en/zh/de 有），但 HI_IN 已从 ./lexicons barrel 导出，故从 barrel 引入。
import { HI_IN } from '@aster-cloud/aster-lang-ts/lexicons';
import { SemanticTokenKind } from '@aster-cloud/aster-lang-ts/token-kind';
import {
  vocabularyRegistry,
  initBuiltinVocabularies,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/registry';
import { buildIdentifierIndex } from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { normalizeAliasToken } from './policy-alias-shared';

export type { Lexicon, DomainVocabulary, IdentifierIndex };
export { EN_US, ZH_CN, DE_DE, HI_IN, SemanticTokenKind };
export { vocabularyRegistry, initBuiltinVocabularies, buildIdentifierIndex };

// LSP UI 本地化文本将在 aster-lang-ts 下一版本发布后从包导入
// 目前使用内联常量替代

/**
 * 根据 locale 获取词法配置。
 */
export function getLexicon(locale: string): Lexicon {
  if (locale === 'zh' || locale === 'zh-CN') return ZH_CN;
  if (locale === 'de' || locale === 'de-DE') return DE_DE;
  if (locale === 'hi' || locale === 'hi-IN') return HI_IN;
  return EN_US;
}

/**
 * 叠加策略层关键词别名（ADR 0022）：kind → 多词别名覆盖官方同 kind 的别名表。
 * 无别名时原样返回 base，保证引用稳定（供 useMemo 依赖）。编辑器编译与模型大纲共用此口径。
 */
export function withUserAliases<L extends Lexicon>(
  base: L,
  userAliasSet: Readonly<Record<string, readonly string[]>> | null | undefined,
): L {
  if (!userAliasSet || Object.keys(userAliasSet).length === 0) return base;
  const baseAliases = (base as { aliases?: Record<string, readonly string[]> }).aliases ?? {};
  return { ...base, aliases: { ...baseAliases, ...userAliasSet } };
}

/**
 * 从 lexicon 提取用户别名校验的**占用集**（ADR 0022 关键词别名）：
 * - canonicalKeywordsLower：全部规范关键词拼写（归一小写）
 * - baseAliasesLower：官方已有别名（归一小写）
 *
 * <p>用 shared 的 {@link normalizeAliasToken} 归一（与 validateUserAliases/Java 同口径），
 * 不可随手 trim().toLowerCase()——否则占用集与校验值归一不一致（NBSP/大小写边界）。
 * vocabularyTermsLower（第三集）由服务端 buildAliasReservedFromVocabulary 从本次保存的有效词汇补齐。
 */
export function extractReservedAliasSets(lexicon: Lexicon): {
  canonicalKeywordsLower: Set<string>;
  baseAliasesLower: Set<string>;
} {
  const canonicalKeywordsLower = new Set<string>();
  for (const value of Object.values(lexicon.keywords)) {
    if (value) canonicalKeywordsLower.add(normalizeAliasToken(String(value)));
  }
  const baseAliasesLower = new Set<string>();
  const aliases = (lexicon as { aliases?: Partial<Record<string, readonly string[]>> }).aliases;
  if (aliases) {
    for (const list of Object.values(aliases)) {
      for (const a of list ?? []) {
        if (a) baseAliasesLower.add(normalizeAliasToken(String(a)));
      }
    }
  }
  return { canonicalKeywordsLower, baseAliasesLower };
}

/**
 * 从词法表提取所有单词（用于 Monaco Monarch 语法高亮）。
 *
 * 将多词关键词拆分为单词，便于 Monarch tokenizer 逐词匹配。
 */
export function extractMonarchKeywords(lexicon: Lexicon): string[] {
  const words = new Set<string>();
  for (const value of Object.values(lexicon.keywords)) {
    for (const word of String(value).split(/\s+/)) {
      if (word) words.add(word);
    }
  }
  return [...words];
}

/**
 * 获取指定领域+语言的词汇表。
 */
export function getVocabulary(domain: string, locale: string): DomainVocabulary | undefined {
  return vocabularyRegistry.get(domain, locale)?.vocabulary;
}

/**
 * 从词汇表提取所有本地化术语（用于 Monaco Monarch 高亮）。
 */
export function extractVocabularyTerms(vocabulary: DomainVocabulary): string[] {
  const terms = new Set<string>();

  for (const m of vocabulary.structs) {
    terms.add(m.localized);
    m.aliases?.forEach(a => terms.add(a));
  }
  for (const m of vocabulary.fields) {
    terms.add(m.localized);
    m.aliases?.forEach(a => terms.add(a));
  }
  for (const m of vocabulary.functions) {
    terms.add(m.localized);
    m.aliases?.forEach(a => terms.add(a));
  }
  for (const m of vocabulary.enumValues ?? []) {
    terms.add(m.localized);
    m.aliases?.forEach(a => terms.add(a));
  }

  return [...terms];
}

/**
 * 从词法表提取原语类型关键词（Text/Int/Float/Bool）和类型构造关键词
 * （Maybe/Option of/Result of）的本地化形式。用于 Monaco Monarch 的
 * typeKeywords，避免在 monaco-aster.ts 里硬编码多语言类型字面量。
 *
 * 注意：仅返回 lang-ts SemanticTokenKind 已定义的类型 token；Decimal、
 * Money、Date 等扩展类型仍由 monaco-aster 的 EXTRA_TYPE_KEYWORDS 提供，
 * 等 lang-ts 把它们加进 token-kind 后即可下沉到这里。
 */
export function extractPrimitiveTypeKeywords(lexicon: Lexicon): string[] {
  const out = new Set<string>();
  // Type tokens recognised by the lang-ts type-parser as type constructors.
  // R-fix 9 codex finding: Maybe/Option of/Result of were rendering as
  // plain keywords. They're semantically type-level and should highlight
  // as 'type' across all three locales.
  const typeKinds = [
    // primitive types
    SemanticTokenKind.TEXT,
    SemanticTokenKind.INT_TYPE,
    SemanticTokenKind.FLOAT_TYPE,
    SemanticTokenKind.BOOL_TYPE,
    // type constructors
    SemanticTokenKind.MAYBE,
    SemanticTokenKind.OPTION_OF,
    SemanticTokenKind.RESULT_OF,
  ];
  for (const kind of typeKinds) {
    const value = lexicon.keywords[kind];
    if (typeof value === 'string' && value) out.add(value);
  }
  return [...out];
}

/**
 * 跨多个词法表提取所有原语类型关键词的并集。Monaco Monarch 在加载时
 * 需要同时识别 EN/ZH/DE 三套类型字面量（因为同一文档可能含多语言注释）。
 */
export function extractPrimitiveTypeKeywordsAll(lexicons: readonly Lexicon[]): string[] {
  const out = new Set<string>();
  for (const lex of lexicons) {
    for (const kw of extractPrimitiveTypeKeywords(lex)) out.add(kw);
  }
  return [...out];
}

/**
 * 按类别获取关键词（用于 Monaco 分类着色）。
 */
export function getKeywordsByCategory(lexicon: Lexicon) {
  const kw = lexicon.keywords;
  return {
    module: [
      kw[SemanticTokenKind.MODULE_DECL],
      kw[SemanticTokenKind.IMPORT],
      kw[SemanticTokenKind.IMPORT_ALIAS],
      kw[SemanticTokenKind.IMPORT_VERSION],
    ],
    type: [
      kw[SemanticTokenKind.TYPE_DEF],
      kw[SemanticTokenKind.TYPE_WITH],
      kw[SemanticTokenKind.TYPE_HAS],
      kw[SemanticTokenKind.TYPE_ONE_OF],
      kw[SemanticTokenKind.MAYBE],
      kw[SemanticTokenKind.OPTION_OF],
      kw[SemanticTokenKind.RESULT_OF],
      kw[SemanticTokenKind.OK_OF],
      kw[SemanticTokenKind.ERR_OF],
      kw[SemanticTokenKind.SOME_OF],
    ],
    function: [
      kw[SemanticTokenKind.FUNC_TO],
      kw[SemanticTokenKind.FUNC_GIVEN],
      kw[SemanticTokenKind.FUNC_PRODUCE],
      kw[SemanticTokenKind.FUNC_PERFORMS],
      kw[SemanticTokenKind.APPLY],
    ],
    control: [
      kw[SemanticTokenKind.IF],
      kw[SemanticTokenKind.OTHERWISE],
      kw[SemanticTokenKind.MATCH],
      kw[SemanticTokenKind.WHEN],
      kw[SemanticTokenKind.RETURN],
      kw[SemanticTokenKind.RESULT_IS],
      kw[SemanticTokenKind.FOR_EACH],
      kw[SemanticTokenKind.IN],
    ],
    variable: [
      kw[SemanticTokenKind.LET],
      kw[SemanticTokenKind.BE],
      kw[SemanticTokenKind.SET],
      kw[SemanticTokenKind.TO_WORD],
    ],
    boolean: [
      kw[SemanticTokenKind.OR],
      kw[SemanticTokenKind.AND],
      kw[SemanticTokenKind.NOT],
    ],
    operator: [
      kw[SemanticTokenKind.PLUS],
      kw[SemanticTokenKind.MINUS_WORD],
      kw[SemanticTokenKind.TIMES],
      kw[SemanticTokenKind.DIVIDED_BY],
      kw[SemanticTokenKind.INTEGER_DIVIDED_BY],
      kw[SemanticTokenKind.MODULO],
      kw[SemanticTokenKind.LESS_THAN],
      kw[SemanticTokenKind.GREATER_THAN],
      kw[SemanticTokenKind.EQUALS_TO],
      kw[SemanticTokenKind.IS],
      kw[SemanticTokenKind.UNDER],
      kw[SemanticTokenKind.OVER],
      kw[SemanticTokenKind.MORE_THAN],
    ],
    literal: [
      kw[SemanticTokenKind.TRUE],
      kw[SemanticTokenKind.FALSE],
      kw[SemanticTokenKind.NULL],
      kw[SemanticTokenKind.NONE],
    ],
    primitiveType: [
      kw[SemanticTokenKind.TEXT],
      kw[SemanticTokenKind.INT_TYPE],
      kw[SemanticTokenKind.FLOAT_TYPE],
      kw[SemanticTokenKind.BOOL_TYPE],
    ],
    workflow: [
      kw[SemanticTokenKind.WORKFLOW],
      kw[SemanticTokenKind.STEP],
      kw[SemanticTokenKind.DEPENDS],
      kw[SemanticTokenKind.ON],
      kw[SemanticTokenKind.COMPENSATE],
      kw[SemanticTokenKind.RETRY],
      kw[SemanticTokenKind.TIMEOUT],
      kw[SemanticTokenKind.MAX_ATTEMPTS],
      kw[SemanticTokenKind.BACKOFF],
    ],
    async: [
      kw[SemanticTokenKind.WITHIN],
      kw[SemanticTokenKind.SCOPE],
      kw[SemanticTokenKind.START],
      kw[SemanticTokenKind.ASYNC],
      kw[SemanticTokenKind.AWAIT],
      kw[SemanticTokenKind.WAIT_FOR],
    ],
    // 效果标注（io / cpu）——tokenizer 里原有一条硬编码 /输入输出/ 规则，
    // 但从未有对应分类，故 en/de/hi 的 io/cpu 一直不高亮。
    effect: [
      kw[SemanticTokenKind.IO],
      kw[SemanticTokenKind.CPU],
    ],
    constraint: [
      kw[SemanticTokenKind.REQUIRED],
      kw[SemanticTokenKind.BETWEEN],
      kw[SemanticTokenKind.AT_LEAST],
      kw[SemanticTokenKind.AT_MOST],
      kw[SemanticTokenKind.MATCHING],
      kw[SemanticTokenKind.PATTERN],
    ],
  };
}

/** 分类名 → Monaco token 类型（与 tokenizer 的 cases 一一对应）。 */
const CATEGORY_TOKEN: Record<string, string> = {
  module: 'keyword.module',
  type: 'keyword.type',
  function: 'keyword.function',
  control: 'keyword.control',
  variable: 'keyword.variable',
  boolean: 'keyword.boolean',
  operator: 'keyword.operator',
  literal: 'constant.language',
  primitiveType: 'type',
  workflow: 'keyword.workflow',
  async: 'keyword.async',
  constraint: 'keyword.constraint',
  effect: 'keyword.effect',
};

/** 正则元字符转义（关键词里可能含 `.`/`(` 等）。 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从词表**动态生成**多词关键词的 Monarch 规则（含空格的关键词，如
 * `for each` / `als eines von` / `इनमें से एक`）。
 *
 * <p><b>为什么必须动态生成</b>：Monarch 是「自上而下、首个匹配即用」，而标识符
 * 规则 `[A-Za-z_…]+` 只吃到 `for` 就落 `@default=identifier`，后面的 `/for each/`
 * 永远轮不到——所以多词规则必须排在标识符之前。此前那份规则是**手抄硬编码**的
 * 14 条，已与词表漂移（漏了 the result is / integer divided by / more than /
 * at least / at most 等），且新增关键词不会自动进来。改为从 getKeywordsByCategory
 * 派生，词表变则规则自动跟随。
 *
 * <p>按长度降序：`integer divided by` 必须排在 `divided by` 之前，否则前者会被
 * 后者的子串先匹配掉。
 */
export function buildMultiWordRules(lexicon: Lexicon): Array<[RegExp, string]> {
  const cats = getKeywordsByCategory(lexicon) as Record<string, Array<string | undefined>>;
  const seen = new Set<string>();
  const entries: Array<{ word: string; token: string }> = [];
  for (const [cat, words] of Object.entries(cats)) {
    const token = CATEGORY_TOKEN[cat];
    if (!token) continue;
    for (const w of words) {
      if (!w || !/\s/.test(w) || seen.has(w)) continue;
      seen.add(w);
      entries.push({ word: w, token });
    }
  }
  entries.sort((a, b) => b.word.length - a.word.length);
  // 空白宽松匹配（源码里多词之间可能是多个空格/换行前的对齐空格）。
  return entries.map(({ word, token }) => [
    new RegExp(escapeRegex(word).replace(/\s+/g, '\\s+'), 'i'),
    token,
  ]);
}
