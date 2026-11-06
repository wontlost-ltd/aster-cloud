// @control 引用扫描（#739）：从版本源码取出规则挂接的控制键，跳过注释与普通字符串字面量。
import { describe, it, expect } from 'vitest';
import { extractControlReferences } from '@/lib/policy-control-references';
import { creditPilotSource } from '@/config/credit-pilot-source';

describe('extractControlReferences', () => {
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
    expect(extractControlReferences(source)).toEqual(['EU_AI_ACT:ART14', 'GDPR:ART22']);
  });

  it('信贷试点源码挂接 EU_AI_ACT:ART14 与 GDPR:ART22', () => {
    expect(extractControlReferences(creditPilotSource('en', 50000))).toEqual(['EU_AI_ACT:ART14', 'GDPR:ART22']);
  });

  it.each([
    ['zh 直角引号', '模块 a。\n@control(「GDPR:ART6」)\n规则 r：\n', ['GDPR:ART6']],
    ['弯引号', 'Module a.\n@control(“SOX:404”)\nRule r:\n', ['SOX:404']],
    ['括号内空白', 'Module a.\n@control( "GDPR:ART17" )\nRule r:\n', ['GDPR:ART17']],
    ['CRLF', 'Module a.\r\n@control("GDPR:ART17")\r\nRule r:\r\n', ['GDPR:ART17']],
  ])('%s', (_label, source, expected) => {
    expect(extractControlReferences(source)).toEqual(expected);
  });

  it.each([
    ['# 注释里的注解', 'Module a.\n# @control("GDPR:ART6")\nRule r:\n'],
    ['// 注释里的注解', 'Module a.\n// @control("GDPR:ART6")\nRule r:\n'],
    ['普通字符串里的注解', 'Module a.\nRule r:\n  Return "@control(\\"GDPR:ART6\\")".\n'],
    ['非 control 注解', 'Module a.\n@controls("GDPR:ART6")\n@id("GDPR:ART6")\nRule r:\n'],
    ['无参数', 'Module a.\n@control\n@control()\nRule r:\n'],
    ['空白键', 'Module a.\n@control("  ")\nRule r:\n'],
    ['无注解', 'Module m.\n\nRule r given x as Int, produce Bool:\n  Return x at least 1.\n'],
  ])('%s：不计入', (_label, source) => {
    expect(extractControlReferences(source)).toEqual([]);
  });

  it('行尾注释不吞掉下一行的注解', () => {
    expect(extractControlReferences('Module a. # note\n@control("GDPR:ART6")\nRule r:\n')).toEqual(['GDPR:ART6']);
  });
});
