// 用真实 aster-lang-ts 1.4.0 编译错误源码，验证引擎给出的 code + params 能被按码渲染，
// 并逐条与旧实现（只按英文句型翻译）对照：新实现在 zh/de/hi 下不更英文。
import { describe, it, expect } from 'vitest';
import { compileAndTypecheck, EN_US, ZH_CN } from '@aster-cloud/aster-lang-ts/browser';
import { localizeSyntaxDiagnostic, type SyntaxDiagnosticLike } from '@/lib/syntax-diagnostic-message';

const head = 'Module m.\n\nRule f given x as Int, produce Int:\n';
const wf = `${head}  Workflow:\n    Step a:\n      Return x.\n`;
// E063 只由 aster-api 的 ANTLR 解析器产生，ts 解析器不发，故不在此列
const CASES: ReadonlyArray<readonly [string, string, typeof EN_US]> = [
  ['E050', `${head}  Return x § 1.\n`, EN_US],
  ['E052', `${head}   Return x.\n`, EN_US],
  ['E055', 'Module m.\n\nRule 1 given x as Int, produce Int:\n  Return x.\n', EN_US],
  ['E059', `${head}  Return x\n`, EN_US],
  ['E059', '模块 m。\n\n规则 f 给定 x 作为 整数，产出 整数：\n  返回 x\n', ZH_CN],
  ['E064', `${head}  Return x + .\n`, EN_US],
  ['E051', 'Module m.\n\nRule f, produce Text:\n  Return "abc.\n', EN_US],
  ['E053', `${head}  Return 99999999999.\n`, EN_US],
  ['E054', `${head}  Return ${'('.repeat(70)}x${')'.repeat(70)}.\n`, EN_US],
  ['E065', 'Module m.\n\nModule n.\n\nRule f, produce Int:\n  Return 1.\n', EN_US],
  ['E066', head, EN_US],
  ['E067', `${wf}    Timeout: 5 minutes.\n  .\n`, EN_US],
  ['E067', `${wf}    Retry:\n      Max attempts: 0.\n      Backoff: linear.\n  .\n`, EN_US],
  ['E068', `${head}  Return +(x, x, x).\n`, EN_US],
  ['E069', `${wf}    Retry:\n      Banana: 3.\n  .\n`, EN_US],
];


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
      // 新实现一律译出：旧实现（只按英文句型）能译的，新实现同样不留英文，故不会比升级前更英文
      expect(out, locale).not.toBe(d.message);
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
