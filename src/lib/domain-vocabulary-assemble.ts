/**
 * Domain vocabulary 组装层（纯叶子模块，无 Node 依赖）
 *
 * 把 user_domain_term 行组装成 aster-lang-ts 的 DomainVocabulary。该逻辑
 * 同时被服务端（domain-vocabulary-validation.ts，依赖 node:crypto 做 dedup
 * 键）和客户端（编辑器按作者词汇编译与高亮）复用，因此抽到
 * 这个不触碰 `node:*` 的叶子模块里，保证浏览器可安全导入。
 *
 * 设计约束（见 ADR 0009 跨运行时边界）：本文件只能 import
 * aster-lang-ts 的纯类型/纯函数，禁止引入 node:crypto / fs 等 Node API。
 */

import {
  IdentifierKind,
  type DomainVocabulary,
  type IdentifierMapping,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';

/** 词汇类型字面量（与 DB kind 列一致）。 */
export type TermKind = 'struct' | 'field' | 'function' | 'enum_value';

/**
 * 组装所需的最小行结构。服务端 join 行与客户端 API 返回的 TermLink
 * 都满足此结构（字段名一致）。
 */
export interface TermLikeRow {
  domainTermId: string;
  domain: string;
  locale: string;
  kind: TermKind | string;
  canonical: string;
  localized: string;
  parentCanonical?: string | null;
  aliases?: readonly string[] | null;
  description?: string | null;
}

/** 需要父类型的词条种类：字段挂在结构下，枚举成员挂在枚举下（ADR 0051 §14 第 3 条）。 */
export function requiresParent(kind: string): boolean {
  return kind === 'field' || kind === 'enum_value';
}

export interface AssembleVocabularyOptions {
  domain?: string;
  locale?: string;
  name?: string;
  version?: string;
}

function toIdentifierKind(kind: string): IdentifierKind {
  switch (kind) {
    case 'struct':
      return IdentifierKind.STRUCT;
    case 'field':
      return IdentifierKind.FIELD;
    case 'function':
      return IdentifierKind.FUNCTION;
    case 'enum_value':
      return IdentifierKind.ENUM_VALUE;
    default:
      throw new Error(`Unsupported vocabulary kind: ${kind}`);
  }
}

function mappingFromRow(row: TermLikeRow): IdentifierMapping {
  return {
    canonical: row.canonical,
    localized: row.localized,
    kind: toIdentifierKind(row.kind),
    ...(row.parentCanonical ? { parent: row.parentCanonical } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.aliases && row.aliases.length > 0 ? { aliases: [...row.aliases] } : {}),
  };
}

/**
 * 按 kind 分组，把词汇行组装成 DomainVocabulary，供引擎 buildVocabularyScopes、
 * 编译与 Monaco 高亮复用。
 */
export function assembleDomainVocabularyFromLinks(
  termRows: readonly TermLikeRow[],
  opts: AssembleVocabularyOptions = {},
): DomainVocabulary {
  const first = termRows[0];
  const domain = opts.domain ?? first?.domain ?? 'custom';
  const locale = opts.locale ?? first?.locale ?? 'en-US';
  const structs: IdentifierMapping[] = [];
  const fields: IdentifierMapping[] = [];
  const functions: IdentifierMapping[] = [];
  const enumValues: IdentifierMapping[] = [];

  for (const row of termRows) {
    const mapping = mappingFromRow(row);
    switch (mapping.kind) {
      case IdentifierKind.STRUCT:
        structs.push(mapping);
        break;
      case IdentifierKind.FIELD:
        fields.push(mapping);
        break;
      case IdentifierKind.FUNCTION:
        functions.push(mapping);
        break;
      case IdentifierKind.ENUM_VALUE:
        enumValues.push(mapping);
        break;
    }
  }

  return {
    id: domain,
    name: opts.name ?? domain,
    locale,
    version: opts.version ?? 'user',
    structs,
    fields,
    functions,
    enumValues,
  };
}
