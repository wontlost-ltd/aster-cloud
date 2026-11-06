// 用真实 aster-lang-ts 1.3.0 编译错误源码，验证引擎给出的 code + params 能被按码渲染，
// 并逐条与旧实现（只按英文句型翻译）对照：新实现在 zh/de/hi 下不更英文。
import { describe, it, expect } from 'vitest';
import { compileAndTypecheck, EN_US, ZH_CN } from '@aster-cloud/aster-lang-ts/browser';
import { localizeSyntaxDiagnostic, type SyntaxDiagnosticLike } from '@/lib/syntax-diagnostic-message';
import { localizeParseMessage } from '@/lib/parse-diagnostic-l10n';

const head = 'Module m.\n\nRule f given x as Int, produce Int:\n';
// E063 只由 aster-api 的 ANTLR 解析器产生，ts 解析器不发，故不在此列
const CASES: ReadonlyArray<readonly [string, string, typeof EN_US]> = [
  ['E050', `${head}  Return x § 1.\n`, EN_US],
  ['E052', `${head}   Return x.\n`, EN_US],
  ['E055', 'Module m.\n\nRule 1 given x as Int, produce Int:\n  Return x.\n', EN_US],
  ['E059', `${head}  Return x\n`, EN_US],
  ['E059', '模块 m。\n\n规则 f 给定 x 作为 整数，产出 整数：\n  返回 x\n', ZH_CN],
  ['E064', `${head}  Return x + .\n`, EN_US],
];

/** 旧实现（origin/main 的 parse-diagnostic-l10n）对这些码的英文原句不认识，只能显示英文。 */
const OLD_ENGLISH = new Set(['E050', 'E052']);

function firstParseError(source: string, lexicon: typeof EN_US): SyntaxDiagnosticLike {
  const errors = (compileAndTypecheck(source, { lexicon }).parseErrors ?? []) as SyntaxDiagnosticLike[];
  expect(errors.length).toBeGreaterThan(0);
  return errors[0]!;
}

describe('真实引擎诊断按码渲染（zh / de / hi）', () => {
  it.each(CASES)('%s', (code, source, lexicon) => {
    const d = firstParseError(source, lexicon);
    expect(d.code).toBe(code);
    for (const locale of ['zh-CN', 'de-DE', 'hi-IN']) {
      const out = localizeSyntaxDiagnostic(d, locale);
      // 新实现一律译出；与旧实现（按英文句型）对照，记录旧实现留英文的码
      expect(out, locale).not.toBe(d.message);
      expect(localizeParseMessage(d.message, locale) === d.message, `${code} ${locale} 旧实现留英文`).toBe(OLD_ENGLISH.has(code));
    }
  });

  it('E050 在三种语言下都保留具体字符', () => {
    const d = firstParseError(`${head}  Return x § 1.\n`, EN_US);
    for (const locale of ['zh-CN', 'de-DE', 'hi-IN']) expect(localizeSyntaxDiagnostic(d, locale), locale).toContain("'§'");
  });

  it('E052 在三种语言下都写明 2 空格', () => {
    const d = firstParseError(`${head}   Return x.\n`, EN_US);
    for (const locale of ['zh-CN', 'de-DE', 'hi-IN']) expect(localizeSyntaxDiagnostic(d, locale), locale).toMatch(/2|२/);
  });
});
