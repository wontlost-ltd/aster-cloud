/**
 * 入门概览页（en/de/zh）的最简策略示例必须能被引擎编译并求值：示例曾用 `Number` 等两个引擎都不认的
 * 类型名与 `discounted-price` 这类非法标识符，读者照抄即报错。类型名只能用规范的 Int/Float/Text/Bool。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { compileAndTypecheck, evaluate } from '@aster-cloud/aster-lang-ts/browser';

const DIR = join(process.cwd(), 'src/app/[locale]/docs/getting-started/overview');

/** 取页面里第一个以 Module 开头的代码块。 */
function policySnippet(locale: string): string {
  const mdx = readFileSync(join(DIR, `${locale}.mdx`), 'utf8');
  const block = [...mdx.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!).find((b) => b.startsWith('Module '));
  if (!block) throw new Error(`${locale}.mdx 没有策略示例代码块`);
  return block;
}

describe('getting-started overview 策略示例', () => {
  it.each(['en', 'de', 'zh'])('%s：编译、类型检查通过并按示例语义求值', (locale) => {
    const source = policySnippet(locale);
    expect(source).not.toMatch(/\b(?:Number|Boolean|String)\b/);

    const result = compileAndTypecheck(source);
    expect(result.success, JSON.stringify(result.parseErrors ?? result.loweringErrors)).toBe(true);
    expect(result.typeErrors.filter((d) => d.severity === 'error')).toEqual([]);

    const core = result.core!;
    const fn = core.decls.find((d) => d.kind === 'Func')!.name;
    expect(evaluate(core, fn, { amount: 100, tier: 'gold' })).toMatchObject({ success: true, value: 80 });
    expect(evaluate(core, fn, { amount: 100, tier: 'silver' })).toMatchObject({ success: true, value: 100 });
  });
});
