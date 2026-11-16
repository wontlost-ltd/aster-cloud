/**
 * 模型标签页的大纲（ADR 0058 §8.3）：从浏览器编译的 AST 取结构体（含字段）、类型别名与导入别名。
 *
 * 位置一律取 AST span（1 起始行列，end 不含），与 Monaco 行列一致。类型按作者源码原文截取，
 * 因此本地化写法（如「整数」「Ganzzahl」）原样显示；推断类型的字段没有类型原文，显示本地化内置名。
 */
import { compile, type Lexicon, type Span, type Type } from '@aster-cloud/aster-lang-ts/browser';
import { localizeBuiltinType } from './source-builders';

export type { Span };

export interface ModelOutline {
  structs: Array<{ name: string; span: Span; fields: Array<{ name: string; type: string; span: Span }> }>;
  typeAliases: Array<{ name: string; target: string; span: Span }>;
  imports: Array<{ alias: string; module: string; span: Span }>;
}

/** 解析失败（有语法错误或没有 AST）返回 null，界面提示先修复语法。 */
export function buildModelOutline(source: string, lexicon: Lexicon): ModelOutline | null {
  let result: ReturnType<typeof compile>;
  try {
    result = compile(source, { lexicon, includeIntermediates: true });
  } catch {
    return null;
  }
  const ast = result.ast;
  if (!ast || (result.parseErrors?.length ?? 0) > 0) return null;

  const lines = source.split('\n');
  const typeText = (type: Type, inferred: boolean): string => {
    if (!inferred && type.span) return sliceSpan(lines, type.span);
    return type.kind === 'TypeName' ? localizeBuiltinType(lexicon, type.name) : type.kind;
  };

  const outline: ModelOutline = { structs: [], typeAliases: [], imports: [] };
  for (const decl of ast.decls) {
    if (decl.kind === 'Data') {
      outline.structs.push({
        name: decl.name,
        span: decl.span,
        fields: decl.fields.map((f) => ({ name: f.name, type: typeText(f.type, f.typeInferred === true), span: f.span })),
      });
    } else if (decl.kind === 'Import' && decl.asName) {
      // 只列导入别名（ADR 0058 D4）；无 `as` 的导入不是别名
      outline.imports.push({ alias: decl.asName, module: decl.name, span: decl.span });
    }
  }
  for (const alias of ast.typeAliasDecls ?? []) {
    outline.typeAliases.push({ name: alias.name, target: typeText(alias.type, false), span: alias.span });
  }
  return outline;
}

/** 按 1 起始、end 不含的行列截取源码原文；跨行时以单个空格连接各行片段。 */
function sliceSpan(lines: readonly string[], span: Span): string {
  const { start, end } = span;
  if (start.line === end.line) return (lines[start.line - 1] ?? '').slice(start.col - 1, end.col - 1);
  const parts = [(lines[start.line - 1] ?? '').slice(start.col - 1)];
  for (let line = start.line + 1; line < end.line; line++) parts.push(lines[line - 1] ?? '');
  parts.push((lines[end.line - 1] ?? '').slice(0, end.col - 1));
  return parts.map((p) => p.trim()).filter(Boolean).join(' ');
}
