/**
 * 从策略源码提取输入映射所需的类型信息（#626）。
 *
 * 用该版本的 CNL 语言 lexicon（并入冻结的关键词别名，否则别名写的源码无法解析）编译源码，
 * **不带**领域词汇——得到的结构/字段/枚举名就是作者所写的策略语言名字，与执行页「生成示例」
 * 和表单模式（同样只用 lexicon 提取 schema）一致。编译失败时返回 null，映射器把输入原样透传。
 *
 * 编译结果按（源码哈希, locale, 别名集）缓存在 isolate 内（LRU）：已发布版本的源码不可变，
 * 草稿源码一改哈希就变，不会读到旧结果；入口函数按请求再选，不进缓存键。
 */

import { createHash } from 'node:crypto';
import { compile } from '@aster-cloud/aster-lang-ts/browser';
import { getLexicon, type Lexicon } from '@/lib/aster-lexicon';
import type { PolicyDataDecl, PolicyEnumDecl, PolicyInputTypes, PolicyTypeNode } from './mapper';

interface CoreDecl {
  kind: string;
  name: string;
  fields?: Array<{ name: string; type: PolicyTypeNode }>;
  variants?: string[];
  params?: Array<{ name: string; type: PolicyTypeNode }>;
  ret?: PolicyTypeNode;
}

interface CompiledTypes {
  readonly funcs: readonly CoreDecl[];
  readonly decls: ReadonlyArray<PolicyDataDecl | PolicyEnumDecl>;
}

type NameNormalizer = (name: string) => string;
type AliasSet = Record<string, readonly string[]> | null | undefined;

/** 每个 isolate 最多缓存的版本数；单条只含声明骨架，体积很小。 */
const CACHE_LIMIT = 256;
const cache = new Map<string, CompiledTypes | null>();

function lexiconWithAliases(locale: string, aliasSet: AliasSet): Lexicon {
  const base = getLexicon(locale);
  if (!aliasSet || Object.keys(aliasSet).length === 0) return base;
  const baseAliases = (base as { aliases?: Record<string, readonly string[]> }).aliases ?? {};
  return { ...base, aliases: { ...baseAliases, ...aliasSet } } as Lexicon;
}

function toTypeDecl(decl: CoreDecl): PolicyDataDecl | PolicyEnumDecl | null {
  if (decl.kind === 'Data') return { kind: 'Data', name: decl.name, fields: decl.fields ?? [] };
  if (decl.kind === 'Enum') return { kind: 'Enum', name: decl.name, variants: decl.variants ?? [] };
  return null;
}

function cacheKey(source: string, locale: string, aliasSet: AliasSet): string {
  const aliases = aliasSet ? JSON.stringify(Object.entries(aliasSet).sort(([a], [b]) => a.localeCompare(b))) : '';
  return createHash('sha256').update(locale).update('\0').update(aliases).update('\0').update(source).digest('hex');
}

function compileTypes(source: string, locale: string, aliasSet: AliasSet): CompiledTypes | null {
  try {
    const result = compile(source, { lexicon: lexiconWithAliases(locale, aliasSet) } as Parameters<typeof compile>[1]);
    const decls = (result as { core?: { decls?: CoreDecl[] } }).core?.decls ?? [];
    if (decls.length === 0) return null;
    return {
      funcs: decls.filter((d) => d.kind === 'Func'),
      decls: decls.map(toTypeDecl).filter((d): d is PolicyDataDecl | PolicyEnumDecl => d !== null),
    };
  } catch (err) {
    console.warn('[execution-input] failed to extract policy types; input passed through unchanged', err);
    return null;
  }
}

/** LRU：命中时挪到队尾，超限淘汰最久未用的。 */
function cachedCompile(source: string, locale: string, aliasSet: AliasSet): CompiledTypes | null {
  const key = cacheKey(source, locale, aliasSet);
  if (cache.has(key)) {
    const hit = cache.get(key)!;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const compiled = compileTypes(source, locale, aliasSet);
  cache.set(key, compiled);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return compiled;
}

/** 入口函数：指定了函数名就按规范化后的名字找（作者写法与规范名都能命中），否则取第一个函数。 */
function pickFunction(funcs: readonly CoreDecl[], functionName: string | undefined, normalize: NameNormalizer) {
  if (!functionName) return funcs[0];
  const wanted = normalize(functionName).toLowerCase();
  return funcs.find((f) => normalize(f.name).toLowerCase() === wanted);
}

/**
 * @param source 版本源码
 * @param locale 该版本的 CNL 语言
 * @param aliasSet 版本冻结的关键词别名（只用于解析源码，不参与输入映射）
 * @param functionName 请求指定的 Rule（策略语言写法或规范名）
 * @param normalize 名字规范化（按执行词汇），用于匹配函数名
 */
export function extractPolicyInputTypes(
  source: string,
  locale: string,
  aliasSet: AliasSet,
  functionName: string | undefined,
  normalize: NameNormalizer = (name) => name,
): PolicyInputTypes | null {
  const compiled = cachedCompile(source, locale, aliasSet);
  if (!compiled) return null;
  const func = pickFunction(compiled.funcs, functionName, normalize);
  return {
    params: func?.params ?? [],
    ...(func?.ret ? { result: func.ret } : {}),
    decls: compiled.decls,
  };
}

/** 仅供测试：清空缓存。 */
export function clearPolicyInputTypesCache(): void {
  cache.clear();
}
