// 档案声明检测（ADR 0046 §2）：Module 行之后紧跟 `<PROFILE 词> "<id>".`，四种语言的 PROFILE 词。
import { describe, it, expect } from 'vitest';
import { declaresProfile } from '@/lib/policy-profile-declaration';
import { creditPilotSource, creditPilotSugarSource } from '@/config/credit-pilot-source';

describe('declaresProfile', () => {
  it.each([
    ['en', 'Module a.b.\nProfile "governed".\n\nRule r given x as Int, produce Bool:\n  Return true.\n'],
    ['zh', '模块 a.b。\n档案 "eu-ai-act-high-risk"。\n'],
    ['zh 直角引号', '模块 a.b。\n档案「governed」。\n'],
    ['de', 'Modul a.b.\nProfil "governed".\n'],
    ['hi', 'मॉड्यूल a.b।\nप्रोफ़ाइल "governed"।\n'],
  ])('%s：声明了档案', (_label, source) => {
    expect(declaresProfile(source)).toBe(true);
  });

  it('hi 的 फ़ 用预组合字符 U+095E 书写时同样识别', () => {
    expect(declaresProfile('मॉड्यूल a.b।\nप्रो\u095Eाइल "governed"।\n')).toBe(true);
  });

  it('hi 的 फ़ 用分解写法（फ + 下加点）同样识别', () => {
    expect(declaresProfile('मॉड्यूल a.b।\nप्रोफ\u093Cाइल "governed"।\n')).toBe(true);
  });

  it('Module 行前后的空行与注释不影响判定', () => {
    expect(declaresProfile('// 信贷\n\nModule a.b.\n\n# 档案\nProfile "governed".\n')).toBe(true);
  });

  it.each([
    ['未声明档案', 'Module a.b.\n\nRule r given x as Int, produce Bool:\n  Return true.\n'],
    ['Profile 行不紧跟 Module 行', 'Module a.b.\nDefine A has x as Int.\nProfile "governed".\n'],
    ['Profile 作类型名出现在规则里', 'Module a.b.\n\nRule r given p as Profile, produce Bool:\n  Return true.\n'],
    ['空源码', ''],
  ])('%s → false', (_label, source) => {
    expect(declaresProfile(source)).toBe(false);
  });

  it.each(['en', 'zh', 'de'] as const)('信贷试点 %s：v3 声明档案，v1 未声明', (locale) => {
    expect(declaresProfile(creditPilotSugarSource(locale))).toBe(true);
    expect(declaresProfile(creditPilotSource(locale, 50000))).toBe(false);
  });
});
