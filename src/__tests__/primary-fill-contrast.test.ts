/**
 * #774 设计决策 1：主色填充上的文字必须用 text-primary-fg（浅色主题白字 5.70:1，暗色主题 zinc-950 7.31:1）。
 * 硬编码 text-white 在暗色主题的 violet-400 填充上只有 2.72:1；@aster-cloud/tokens 0.2.2 保留暗色 violet-400
 * 主色（同一 token 还要作 text-primary 落在暗底上），所以只能由 cloud 侧改用 text-primary-fg。
 * 也守住 globals.css 引用不存在的 CSS 变量（如 --fg-muted）而回落到浅色色值的错误。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function files(dir: string, ext: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    if (statSync(full).isDirectory()) return n === '__tests__' ? [] : files(full, ext);
    return n.endsWith(ext) && !n.includes('.test.') ? [full] : [];
  });
}

/** 同文件里的 const 声明与函数声明（按名字索引），className 引用它们时展开其值 / 返回值 */
interface Scope {
  consts: Map<string, ts.Expression>;
  fns: Map<string, ts.Node>;
}

function collectScope(sf: ts.SourceFile): Scope {
  const scope: Scope = { consts: new Map(), fns: new Map() };
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) scope.fns.set(n.name.text, init.body);
      else scope.consts.set(n.name.text, init);
    }
    if (ts.isFunctionDeclaration(n) && n.name && n.body) scope.fns.set(n.name.text, n.body);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return scope;
}

/** 函数体里 return 语句（或箭头函数的表达式体）的类名组合 */
function returnAlternatives(body: ts.Node, scope: Scope, seen: Set<string>): string[] {
  if (!ts.isBlock(body)) return classAlternatives(body, scope, seen);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isReturnStatement(n) && n.expression) out.push(...classAlternatives(n.expression, scope, seen));
    else if (!ts.isFunctionLike(n)) ts.forEachChild(n, visit);
  };
  visit(body);
  return out.length ? out : [''];
}

/**
 * 一个表达式可能产出的类名组合：字面量（含 cn() 参数、数组、模板拼接各段）按顺序拼起来；
 * 引用同文件的常量 / 调用同文件的函数时展开其值 / 返回值；
 * 条件表达式 a ? b : c 与 cond && x 的各分支是互斥的备选，分开展开，避免把两个分支的类当成同时生效。
 */
function classAlternatives(node: ts.Node, scope: Scope, seen = new Set<string>()): string[] {
  if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return [node.text];
  if (ts.isIdentifier(node)) {
    const init = scope.consts.get(node.text);
    if (!init || seen.has(node.text)) return [''];
    return classAlternatives(init, scope, new Set(seen).add(node.text));
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && scope.fns.has(node.expression.text) && !seen.has(node.expression.text)) {
    const name = node.expression.text;
    return returnAlternatives(scope.fns.get(name) as ts.Node, scope, new Set(seen).add(name));
  }
  if (ts.isConditionalExpression(node)) return [...classAlternatives(node.whenTrue, scope, seen), ...classAlternatives(node.whenFalse, scope, seen)];
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
    return [...classAlternatives(node.right, scope, seen), ''];
  }
  let combos = [''];
  ts.forEachChild(node, (child) => {
    const alts = classAlternatives(child, scope, seen);
    combos = combos.flatMap((c) => alts.map((x) => (x ? `${c} ${x}` : c))).slice(0, 256);
  });
  return combos;
}

/**
 * 待检单元：每个 JSX className 属性的整个表达式（类名拆在条件、数组或多段拼接里也合在一起看），
 * 以及 className 之外的每个字符串字面量（类名常量、variant 映射表等）。
 */
function classUnits(file: string): Array<{ text: string; line: number }> {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scope = collectScope(sf);
  const out: Array<{ text: string; line: number }> = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'className' && node.initializer) {
      for (const text of classAlternatives(node.initializer, scope)) out.push({ text, line: line(node) });
      return;
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push({ text: node.text, line: line(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const BG_PRIMARY = /(?<![\w:-])bg-primary(?![\w-])/;
const TEXT_WHITE = /(?<![\w:-])text-white(?![\w-])/;

describe('primary fill contrast', () => {
  it('no className puts text-white on bg-primary', () => {
    const offenders: string[] = [];
    for (const file of files(SRC, '.tsx')) {
      for (const { text, line } of classUnits(file)) {
        if (BG_PRIMARY.test(text) && TEXT_WHITE.test(text)) offenders.push(`${relative(SRC, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the scanner follows cn() arguments, same-file constants and helpers, and keeps conditional branches apart', () => {
    const alts = (code: string) => {
      const sf = ts.createSourceFile('x.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const scope = collectScope(sf);
      const found: string[] = [];
      const v = (n: ts.Node) => {
        if (ts.isJsxAttribute(n) && n.initializer) found.push(...classAlternatives(n.initializer, scope));
        ts.forEachChild(n, v);
      };
      v(sf);
      return found;
    };
    const hit = (code: string) => alts(code).some((u) => BG_PRIMARY.test(u) && TEXT_WHITE.test(u));
    expect(hit(`<a className={cn('rounded bg-primary', p.on && 'text-white')} />`)).toBe(true);
    expect(hit(`<a className={cn('rounded', p.on ? 'bg-primary text-primary-fg' : 'bg-gray-900 text-white')} />`)).toBe(false);
    expect(hit(`const classes = 'bg-primary text-white'; const X = () => <a className={classes} />;`)).toBe(true);
    expect(hit(`const base = 'bg-primary'; function cls(on: boolean) { return cn(base, on && 'text-white'); } const X = () => <a className={cls(true)} />;`)).toBe(true);
    expect(hit(`const cls = () => 'bg-primary text-primary-fg'; const X = () => <a className={cn(cls(), 'text-sm')} />;`)).toBe(false);
  });

  it('globals.css only references CSS variables that are defined', () => {
    const css = readFileSync(join(SRC, 'app/globals.css'), 'utf8');
    const require = createRequire(import.meta.url);
    const tokensCss = readFileSync(join(dirname(require.resolve('@aster-cloud/tokens/package.json')), 'dist/tokens.css'), 'utf8');
    const defined = new Set([...`${css}\n${tokensCss}`.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    // 运行时才设置的变量：next/font 注入的字体变量、组件 style 上的 --card-i、rehype-pretty-code 写在 span 上的 --shiki-*
    const runtime = /^--(aster-font-(sans|mono|display)-loaded|card-i|shiki-(light|dark)(-bg)?)$/;
    const missing = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))]
      .filter((v) => !defined.has(v) && !runtime.test(v));
    expect(missing).toEqual([]);
  });
});
