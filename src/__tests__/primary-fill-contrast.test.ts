/**
 * #774 设计决策 1：主色填充上的文字必须用 text-primary-fg（浅色主题白字 5.70:1，暗色主题 zinc-950 7.31:1）。
 * 硬编码 text-white 在暗色主题的 violet-400 填充上只有 2.72:1；@aster-cloud/tokens 0.2.2 保留暗色 violet-400
 * 主色（同一 token 还要作 text-primary 落在暗底上），所以只能由 cloud 侧改用 text-primary-fg。
 * 也守住 CSS 里引用不存在的 token（--fg-muted）这类回落到浅色色值的错误。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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

/** 用 TS 解析器取出文件里每个字符串 / 模板字面量的文本与行号（注释、JSX 文本里的引号不会干扰） */
function stringLiterals(file: string): Array<{ text: string; line: number }> {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Array<{ text: string; line: number }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push({ text: node.text, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('primary fill contrast', () => {
  it('no class string puts text-white on bg-primary', () => {
    const offenders: string[] = [];
    for (const file of files(SRC, '.tsx')) {
      for (const { text, line } of stringLiterals(file)) {
        if (/(?<![\w:-])bg-primary(?![\w-])/.test(text) && /(?<![\w:-])text-white(?![\w-])/.test(text)) {
          offenders.push(`${relative(SRC, file)}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('globals.css only references token variables that exist', () => {
    const css = readFileSync(join(SRC, 'app/globals.css'), 'utf8');
    expect(css).not.toMatch(/var\(--fg-muted\b/);
  });
});
