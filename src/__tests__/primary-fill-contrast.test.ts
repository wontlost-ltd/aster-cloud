/**
 * #774 设计决策 1：主色填充上的文字必须用 text-primary-fg（浅色主题白字 5.70:1，暗色主题 zinc-950 7.31:1）。
 * 硬编码 text-white 在暗色主题的 violet-400 填充上只有 2.72:1；@aster-cloud/tokens 0.2.2 保留暗色 violet-400
 * 主色（同一 token 还要作 text-primary 落在暗底上），所以只能由 cloud 侧改用 text-primary-fg。
 * 也守住 globals.css 引用不存在的 CSS 变量（如 --fg-muted）而回落到浅色色值的错误。
 */
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const PRIMARY_FILL = /(?<![\w:-])(bg|from|via|to)-primary(?![\w-])/;
// 别的实色底会盖住主色；半透明叠色（bg-bg/20 之类）仍透出主色，不算换底
const OTHER_FILL = /(?<![\w:-])(bg|from)-(?!primary(?![\w-]))(?!gradient)[\w-]+(?![\w-]|\/)/;
const TEXT_WHITE = /(?<![\w:-])text-white(?![\w-])/;
// 只认无前缀的 text-primary-fg（hover: / data-[...]: 等状态变体跟着对应状态的底色走，不在静态检查范围）
const TEXT_PRIMARY_FG = /(?<![\w:\]-])text-primary-fg(?![\w-])/;

/**
 * 找出把白字放在主色填充上的位置：同一 className 里既有主色填充（bg-primary / 渐变 from|via|to-primary）又有 text-white，
 * 或元素本身没有别的底色、但某个祖先 JSX 元素是主色填充（白字写在子元素上，如统计卡片里的数值）。
 * className 外的字符串字面量（类名常量、variant 映射表等）单独检查同串组合。
 */
function offendersIn(file: string): number[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scope = collectScope(sf);
  const lines: number[] = [];
  const line = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const classAttr = (el: ts.JsxOpeningLikeElement) => el.attributes.properties.find(
    (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === 'className' && !!a.initializer,
  );
  const visit = (node: ts.Node, inFill: boolean) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
    if (opening) {
      const attr = classAttr(opening);
      const alts = attr?.initializer ? classAlternatives(attr.initializer, scope) : [''];
      const onPrimary = (c: string) => PRIMARY_FILL.test(c) || (inFill && !OTHER_FILL.test(c));
      // 白字压在主色填充上；或 text-primary-fg 用在主色填充之外（暗色主题 primary-fg 是 zinc-950，落在别的深色底上看不见）
      const bad = alts.some((c) => (TEXT_WHITE.test(c) && onPrimary(c)) || (TEXT_PRIMARY_FG.test(c) && !onPrimary(c)));
      if (bad && attr) lines.push(line(attr));
      // 子元素继承：本元素是主色填充则进入填充区；本元素换了别的底色则退出
      const next = alts.some((c) => PRIMARY_FILL.test(c)) || (inFill && !alts.every((c) => OTHER_FILL.test(c)));
      ts.forEachChild(node, (child) => {
        if (child === attr) return;
        visit(child, next);
      });
      return;
    }
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'className') return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (PRIMARY_FILL.test(node.text) && TEXT_WHITE.test(node.text)) lines.push(line(node));
    }
    ts.forEachChild(node, (child) => visit(child, inFill));
  };
  visit(sf, false);
  return [...new Set(lines)];
}


describe('primary fill contrast', () => {
  it('text-white never sits on a primary fill, and text-primary-fg only sits on one (itself or an ancestor)', () => {
    const offenders: string[] = [];
    for (const file of files(SRC, '.tsx')) {
      for (const line of offendersIn(file)) offenders.push(`${relative(SRC, file)}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the scanner follows cn() arguments, same-file helpers, gradients and child elements, and keeps branches apart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'primary-fill-'));
    const hit = (code: string) => {
      const f = join(dir, 'x.tsx');
      writeFileSync(f, code);
      return offendersIn(f).length > 0;
    };
    expect(hit(`const X = (p: any) => <a className={cn('rounded bg-primary', p.on && 'text-white')} />;`)).toBe(true);
    expect(hit(`const X = (p: any) => <a className={cn('rounded', p.on ? 'bg-primary text-primary-fg' : 'bg-gray-900 text-white')} />;`)).toBe(false);
    expect(hit(`const classes = 'bg-primary text-white'; const X = () => <a className={classes} />;`)).toBe(true);
    expect(hit(`const base = 'bg-primary'; function cls(on: boolean) { return cn(base, on && 'text-white'); } const X = () => <a className={cls(true)} />;`)).toBe(true);
    expect(hit(`const X = () => <div className="bg-gradient-to-br from-primary to-primary"><p className="text-3xl text-white">1</p></div>;`)).toBe(true);
    expect(hit(`const X = () => <div className="bg-primary"><span className="bg-bg text-white">x</span></div>;`)).toBe(false);
    expect(hit(`const X = () => <div className="bg-primary text-primary-fg"><p className="text-sm">1</p></div>;`)).toBe(false);
    expect(hit(`const X = () => <div className="bg-primary"><p className="text-primary-fg">1</p></div>;`)).toBe(false);
    expect(hit(`const X = (p: any) => <a className={p.on ? 'bg-primary text-primary-fg' : 'bg-gray-900 text-primary-fg'} />;`)).toBe(true);
    expect(hit(`const X = () => <p className="text-primary-fg">1</p>;`)).toBe(true);
    expect(hit(`const X = () => <div className="bg-primary"><span className="bg-bg/20"><i className="text-primary-fg" /></span></div>;`)).toBe(false);
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
