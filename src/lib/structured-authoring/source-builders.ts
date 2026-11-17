/**
 * 模型标签页表单 → 本地化 CNL 源码（ADR 0058 §8.3）。
 *
 * 关键词一律取自 lexicon（`Define` / `with` / `and` / 字段与别名共用的 `as` / 语句结束符），
 * 作者不手写关键词。例外是类型别名的引导词：3.0.0 的 lexicon 没有对应的 SemanticTokenKind，
 * 解析器在所有语言里都按规范关键词 `KW.TYPE` 识别它，故取包内规范拼写（首字母大写）。
 */
import { KW, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';
import { SemanticTokenKind } from '@/lib/aster-lexicon';

export interface FieldInput {
  name: string;
  type: string;
}

/** 按 lexicon 本地化的内置类型名（文本、整数、小数、布尔），供类型下拉使用。 */
export function builtinTypeNames(lexicon: Lexicon): string[] {
  return [
    SemanticTokenKind.TEXT,
    SemanticTokenKind.INT_TYPE,
    SemanticTokenKind.FLOAT_TYPE,
    SemanticTokenKind.BOOL_TYPE,
  ].map((kind) => lexicon.keywords[kind]);
}

/** 内置类型的规范名 → 本地化写法（大纲显示推断类型时用）。 */
export function localizeBuiltinType(lexicon: Lexicon, canonical: string): string {
  const kind = BUILTIN_CANONICAL[canonical];
  return kind ? lexicon.keywords[kind] : canonical;
}

const BUILTIN_CANONICAL: Record<string, SemanticTokenKind> = {
  Text: SemanticTokenKind.TEXT,
  Int: SemanticTokenKind.INT_TYPE,
  Float: SemanticTokenKind.FLOAT_TYPE,
  Bool: SemanticTokenKind.BOOL_TYPE,
};

/** 单个字段子句：`name as Type`（不含连接词与句点）。 */
export function buildFieldClause(lexicon: Lexicon, field: FieldInput): string {
  return `${field.name.trim()} ${lexicon.keywords[SemanticTokenKind.IMPORT_ALIAS]} ${field.type.trim()}`;
}

/** 结构体声明：`Define Name with a as T and b as U.` */
export function buildStructSource(lexicon: Lexicon, input: { name: string; fields: FieldInput[] }): string {
  const k = lexicon.keywords;
  const fields = input.fields.map((f) => buildFieldClause(lexicon, f)).join(` ${k[SemanticTokenKind.AND]} `);
  return `${k[SemanticTokenKind.TYPE_DEF]} ${input.name.trim()} ${k[SemanticTokenKind.TYPE_WITH]} ${fields}${lexicon.punctuation.statementEnd}`;
}

/** 类型别名声明：`Type Name as Target.` */
export function buildTypeAliasSource(lexicon: Lexicon, input: { name: string; target: string }): string {
  const lead = KW.TYPE.charAt(0).toUpperCase() + KW.TYPE.slice(1);
  return `${lead} ${input.name.trim()} ${lexicon.keywords[SemanticTokenKind.IMPORT_ALIAS]} ${input.target.trim()}${lexicon.punctuation.statementEnd}`;
}
