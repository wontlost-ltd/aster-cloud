/**
 * 从策略源码提取输入映射所需的类型信息（#626、#638、ADR 0051）。
 *
 * 直接复用引擎 `resolvePolicyTypes`：与执行端同一 locale、同一份关键词别名、同一份领域词汇
 * （已审批版本 = 冻结快照，草稿 = 作者现行词汇，由调用方选定），按位置解析出结构 / 字段 / 枚举 /
 * 函数的规范名与作者写法。解析失败时返回引擎诊断码——调用方据此拒绝执行（不能在未映射的输入上执行）。
 *
 * 结果按（源码, locale, 别名集, 词汇作用域）缓存在 isolate 内（LRU）：已发布版本的源码与冻结快照
 * 不可变；草稿源码或作者词汇一改，键就变。入口函数按请求再选，不进缓存键。
 */

import { createHash } from 'node:crypto';
import { canonicalScopesJson, parseSource, resolvePolicyTypes, type PolicyTypes } from '@aster-cloud/aster-lang-ts/browser';
import { getLexicon, type Lexicon } from '@/lib/aster-lexicon';
import { buildSpellingTable, candidatesOf, lookupSpelling, type ExecutionVocabulary, type PolicyInputTypes } from './mapper';

type AliasSet = Record<string, readonly string[]> | null | undefined;
type PolicyFunction = PolicyTypes['functions'][number];

/** 一次类型提取的输入：与执行端同一份源码、语言、别名与词汇。 */
export interface PolicyTypeSource {
  readonly source: string;
  readonly locale: string;
  /** 版本冻结的关键词别名（只用于解析源码，不参与输入映射）。 */
  readonly aliasSet: AliasSet;
  /** 执行用的领域词汇（与透传给引擎的同一份）；null / 缺省表示不带词汇解析。 */
  readonly vocabulary?: ExecutionVocabulary | null;
}

type Resolved =
  | { readonly ok: true; readonly types: PolicyTypes; /** 每个函数是否带 @entry（与 functions 同序）。 */ readonly entries: readonly boolean[] }
  | { readonly ok: false; readonly diagnostics: readonly string[] };

/** 每个 isolate 最多缓存的版本数；单条只含声明骨架，体积很小。 */
const CACHE_LIMIT = 256;
const cache = new Map<string, Resolved>();

function mutableAliases(aliasSet: AliasSet): Record<string, string[]> | undefined {
  if (!aliasSet || Object.keys(aliasSet).length === 0) return undefined;
  return Object.fromEntries(Object.entries(aliasSet).map(([k, v]) => [k, [...v]]));
}

function lexiconWithAliases(locale: string, aliasSet: AliasSet): Lexicon {
  const base = getLexicon(locale);
  const aliases = mutableAliases(aliasSet);
  if (!aliases) return base;
  const baseAliases = (base as { aliases?: Record<string, readonly string[]> }).aliases ?? {};
  return { ...base, aliases: { ...baseAliases, ...aliases } } as Lexicon;
}

function sha256(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part).update('\0');
  return hash.digest('hex');
}

function cacheKey(input: PolicyTypeSource): string {
  const aliases = input.aliasSet ? JSON.stringify(Object.entries(input.aliasSet).sort(([a], [b]) => a.localeCompare(b))) : '';
  const scopes = input.vocabulary ? canonicalScopesJson(input.vocabulary.scopes) : '';
  return sha256(input.locale, aliases, scopes, input.source);
}

/* ---------------------------------------------------------------- 解析 */

/**
 * 各函数是否带 @entry：PolicyTypes 不含注解，只在需要选入口（多于一个函数）时再解析一次 AST。
 * 词汇不影响 AST 结构（标识符保持原写法），函数声明顺序与 PolicyTypes.functions 一致。
 */
function entryFlags(input: PolicyTypeSource, functionCount: number): boolean[] {
  if (functionCount <= 1) return new Array<boolean>(functionCount).fill(false);
  const { ast } = parseSource(input.source, lexiconWithAliases(input.locale, input.aliasSet), input.vocabulary?.scopes);
  return ast.decls
    .filter((d) => d.kind === 'Func')
    .map((d) => ((d as { annotations?: ReadonlyArray<{ name?: string }> }).annotations ?? []).some((a) => a?.name === 'entry'));
}

function diagnosticCodes(diagnostics: ReadonlyArray<{ code: unknown }>): string[] {
  return [...new Set(diagnostics.map((d) => String(d.code)))];
}

function resolveTypes(input: PolicyTypeSource): Resolved {
  try {
    const result = resolvePolicyTypes(input.source, {
      // 版本记录里的 locale 可能是短码（de），引擎只认已注册的 lexicon id。
      locale: getLexicon(input.locale).id,
      ...(input.vocabulary ? { vocabulary: input.vocabulary.vocabulary } : {}),
      ...(mutableAliases(input.aliasSet) ? { aliasSet: mutableAliases(input.aliasSet) } : {}),
    });
    if (!result.ok) {
      const diagnostics = diagnosticCodes(result.diagnostics);
      console.warn('[execution-input] failed to extract policy types', { locale: input.locale, diagnostics: result.diagnostics });
      return { ok: false, diagnostics };
    }
    return { ok: true, types: result.types, entries: entryFlags(input, result.types.functions.length) };
  } catch (err) {
    console.warn('[execution-input] failed to extract policy types', err);
    return { ok: false, diagnostics: [] };
  }
}

/** LRU：命中时挪到队尾，超限淘汰最久未用的。 */
function cachedResolve(input: PolicyTypeSource): Resolved {
  const key = cacheKey(input);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const resolved = resolveTypes(input);
  cache.set(key, resolved);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return resolved;
}

/* ---------------------------------------------------------------- 入口 */

type EntryChoice = { func: PolicyFunction | undefined } | { ambiguous: readonly string[] };

/** 指定函数名：与引擎同口径匹配作者写法 / 规范名 / 词汇函数词条（精确优先，再折叠）。 */
function namedFunction(types: PolicyTypes, name: string, vocabulary: ExecutionVocabulary | null | undefined): PolicyFunction | undefined {
  const table = buildSpellingTable(types.functions, candidatesOf(vocabulary?.scopes.functions));
  const found = lookupSpelling(table, name);
  return found.kind === 'one' ? types.functions.find((f) => f.canonical === found.slot.canonical) : undefined;
}

/**
 * 入口函数，与执行端（aster-api EntryPointSelector）同一规则：
 *   - 指定了函数名：按名字找；找不到时由引擎报「函数不存在」；
 *   - 未指定：第一个带 @entry 注解的 Rule → 唯一的 Rule → 多个 Rule 时无法确定（引擎同样拒绝执行）。
 */
function pickFunction(resolved: Extract<Resolved, { ok: true }>, functionName: string | undefined, input: PolicyTypeSource): EntryChoice {
  const { functions } = resolved.types;
  if (functionName) return { func: namedFunction(resolved.types, functionName, input.vocabulary) };
  const entry = functions.find((_, i) => resolved.entries[i]);
  if (entry || functions.length <= 1) return { func: entry ?? functions[0] };
  return { ambiguous: functions.map((f) => f.written) };
}

export type PolicyTypesResult =
  | {
      readonly ok: true;
      readonly types: PolicyInputTypes;
      /** 交给引擎的函数名：找到时为规范名，找不到或未指定时原样。 */
      readonly functionName: string | undefined;
    }
  /** 引擎解析失败；diagnostics 为引擎诊断码（如 P005、E802）。 */
  | { readonly ok: false; readonly reason: 'extraction_failed'; readonly diagnostics: readonly string[] }
  /** 未指定函数名且有多个 Rule、没有 @entry：不知道引擎会执行哪条（作者写法的 Rule 名）。 */
  | { readonly ok: false; readonly reason: 'entry_ambiguous'; readonly rules: readonly string[] };

/**
 * @param input 版本源码、CNL 语言、冻结别名与执行词汇
 * @param functionName 请求指定的 Rule（作者写法或规范名）
 */
export function extractPolicyInputTypes(input: PolicyTypeSource, functionName: string | undefined): PolicyTypesResult {
  const resolved = cachedResolve(input);
  if (!resolved.ok) return { ok: false, reason: 'extraction_failed', diagnostics: resolved.diagnostics };
  const choice = pickFunction(resolved, functionName, input);
  if ('ambiguous' in choice) return { ok: false, reason: 'entry_ambiguous', rules: choice.ambiguous };
  const func = choice.func;
  return {
    ok: true,
    functionName: func && functionName ? func.canonical : functionName,
    types: {
      params: func?.params ?? [],
      ...(func?.returnType ? { result: func.returnType } : {}),
      structs: resolved.types.structs,
      enums: resolved.types.enums,
    },
  };
}

/** 仅供测试：清空缓存。 */
export function clearPolicyInputTypesCache(): void {
  cache.clear();
}
