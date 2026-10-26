/**
 * 从策略源码提取输入映射所需的类型信息（#626）。
 *
 * 用该版本的 CNL 语言 lexicon（并入冻结的关键词别名，否则别名写的源码无法解析）编译源码，
 * **不带**领域词汇——得到的结构/字段/枚举名就是作者所写的策略语言名字，与执行页「生成示例」
 * 和表单模式（同样只用 lexicon 提取 schema）一致。映射器据此知道哪些字段是枚举、列表元素是什么结构。
 * 编译失败时返回 null，映射器退化为只映射字段键与类型标签。
 */

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

function lexiconWithAliases(locale: string, aliasSet: Record<string, readonly string[]> | null | undefined): Lexicon {
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

type NameNormalizer = (name: string) => string;

/** 入口函数：指定了函数名就按规范化后的名字找（作者写法与规范名都能命中），否则取第一个函数。 */
function pickFunction(funcs: CoreDecl[], functionName: string | undefined, normalize: NameNormalizer): CoreDecl | undefined {
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
  aliasSet: Record<string, readonly string[]> | null | undefined,
  functionName: string | undefined,
  normalize: NameNormalizer = (name) => name,
): PolicyInputTypes | null {
  try {
    const result = compile(source, { lexicon: lexiconWithAliases(locale, aliasSet) } as Parameters<typeof compile>[1]);
    const decls = ((result as { core?: { decls?: CoreDecl[] } }).core?.decls ?? []);
    if (decls.length === 0) return null;
    const func = pickFunction(decls.filter((d) => d.kind === 'Func'), functionName, normalize);
    return {
      params: func?.params ?? [],
      ...(func?.ret ? { result: func.ret } : {}),
      decls: decls.map(toTypeDecl).filter((d): d is PolicyDataDecl | PolicyEnumDecl => d !== null),
    };
  } catch (err) {
    console.warn('[execution-input] failed to extract policy types; mapping keys only', err);
    return null;
  }
}
