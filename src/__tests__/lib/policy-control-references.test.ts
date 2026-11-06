// @control 引用（#739）：经 aster-lang-ts parseSource 取 AST 注解值（与编译器同源，含转义解码），
// 子串预筛只决定哪些版本值得解析。
import { describe, it, expect } from 'vitest';
import { mayReferenceControls, parseControlReferences } from '@/lib/policy-control-references';
import { creditPilotSource } from '@/config/credit-pilot-source';

const en = (source: string) => parseControlReferences({ source, locale: 'en-US', aliasSet: null });

describe('parseControlReferences', () => {
  it('按源码顺序去重返回控制键', () => {
    const source = [
      'Module a.b.',
      '',
      '@id("R1")',
      '@control("EU_AI_ACT:ART14")',
      '@control("GDPR:ART22")',
      'Rule r given x as Int, produce Verdict:',
      '  Return Verdict.allow().',
      '',
      '@id("R2")',
      '@control("GDPR:ART22")',
      'Rule s given x as Int, produce Verdict:',
      '  Return Verdict.allow().',
      '',
    ].join('\n');
    expect(en(source)).toEqual({ ok: true, controls: ['EU_AI_ACT:ART14', 'GDPR:ART22'] });
  });

  it('转义序列按编译器规则解码（扫描原串会得到 GDPR:ART\\u0036）', () => {
    const source = 'Module a.\n\n@control("GDPR:ART\\u0036")\nRule r given x as Int, produce Verdict:\n  Return Verdict.allow().\n';
    expect(en(source)).toEqual({ ok: true, controls: ['GDPR:ART6'] });
  });

  it.each([['en', 'en-US'], ['zh', 'zh-CN'], ['de', 'de-DE']] as const)('信贷试点源码（%s）挂接 EU_AI_ACT:ART14 与 GDPR:ART22', (pilot, locale) => {
    const source = creditPilotSource(pilot, 50000);
    expect(parseControlReferences({ source, locale, aliasSet: null })).toEqual({ ok: true, controls: ['EU_AI_ACT:ART14', 'GDPR:ART22'] });
  });

  it('版本记录里的短码 locale（de）与完整标签（de-DE）同样可解析', () => {
    const source = creditPilotSource('de', 50000);
    expect(parseControlReferences({ source, locale: 'de', aliasSet: null })).toEqual({ ok: true, controls: ['EU_AI_ACT:ART14', 'GDPR:ART22'] });
  });

  it('版本冻结的关键词别名随 lexicon 生效', () => {
    const source = 'Module a.\n\n@control("SOX:404")\nRule r given x as Int, produce Verdict:\n  Give back Verdict.allow().\n';
    expect(en(source).ok).toBe(false);
    expect(parseControlReferences({ source, locale: 'en-US', aliasSet: { RETURN: ['give back'] } })).toEqual({ ok: true, controls: ['SOX:404'] });
  });

  it.each([
    ['# 注释里的注解', 'Module a.\n# @control("GDPR:ART6")\nRule r given x as Int, produce Bool:\n  Return x at least 1.\n'],
    ['普通字符串里的注解', 'Module a.\nRule r given x as Int, produce Text:\n  Return "@control(\\"GDPR:ART6\\")".\n'],
    ['非 control 注解', 'Module a.\n@controls("GDPR:ART6")\n@id("GDPR:ART6")\nRule r given x as Int, produce Bool:\n  Return x at least 1.\n'],
    ['空白键', 'Module a.\n@control("  ")\nRule r given x as Int, produce Bool:\n  Return x at least 1.\n'],
    ['无注解', 'Module m.\n\nRule r given x as Int, produce Bool:\n  Return x at least 1.\n'],
  ])('%s：预筛可能命中但解析后无引用', (_label, source) => {
    expect(en(source)).toEqual({ ok: true, controls: [] });
  });

  it('解析失败（语法错误）如实返回诊断码，而不是空引用', () => {
    const result = en('Module a.\n@control("GDPR:ART6")\nRule r given x as Int, produce Bool:\n  Return x at least .\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('mayReferenceControls', () => {
  it('与 SQL 预筛同口径：源码含 @control 字样即为候选', () => {
    expect(mayReferenceControls('Module a.\n# @control("X:1")\n')).toBe(true);
    expect(mayReferenceControls('Module a.\n@id("X")\n')).toBe(false);
  });
});
