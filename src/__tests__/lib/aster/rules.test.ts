import { describe, expect, it } from 'vitest';
import { chooseDefaultRule, reconcileSelectedRule, extractRuleSymbols } from '@/lib/aster/rules';

describe('extractRuleSymbols', () => {
  it('extracts a single Rule and selects it by default', () => {
    const rules = extractRuleSymbols('Module demo.\n\nRule approve given applicant as Applicant:');

    expect(rules).toEqual([
      {
        name: 'approve',
        isEntry: false,
        range: {
          startLineNumber: 3,
          startColumn: 6,
          endLineNumber: 3,
          endColumn: 13,
        },
      },
    ]);
    expect(chooseDefaultRule(rules)).toBe('approve');
  });

  it('returns null for multiple rules without @entry', () => {
    const rules = extractRuleSymbols('Rule first:\nRule second:');

    expect(rules.map((rule) => rule.name)).toEqual(['first', 'second']);
    expect(chooseDefaultRule(rules)).toBeNull();
  });

  it('marks same-line @entry Rule and selects it', () => {
    const rules = extractRuleSymbols('Rule helper:\n@entry Rule main given input as Input:');

    expect(rules).toHaveLength(2);
    expect(rules[1]).toMatchObject({ name: 'main', isEntry: true });
    expect(chooseDefaultRule(rules)).toBe('main');
  });

  it('treats standalone @entry on the previous line as an entry rule (aster-lang-core#9)', () => {
    // grammar (annotation NEWLINE*)* RULE 支持 @entry 独立成行
    const rules = extractRuleSymbols('@entry\nRule main:\nRule fallback:');

    expect(rules.map((rule) => ({ name: rule.name, isEntry: rule.isEntry }))).toEqual([
      { name: 'main', isEntry: true },
      { name: 'fallback', isEntry: false },
    ]);
    expect(chooseDefaultRule(rules)).toBe('main');
  });

  it('does not leak standalone @entry past an intervening non-annotation line', () => {
    // @entry 后若隔着非注解内容行，不应误标后续 Rule
    const rules = extractRuleSymbols('@entry\nDefine X has a.\nRule main:\nRule fallback:');

    expect(rules.map((rule) => ({ name: rule.name, isEntry: rule.isEntry }))).toEqual([
      { name: 'main', isEntry: false },
      { name: 'fallback', isEntry: false },
    ]);
  });

  it('skips comment lines', () => {
    const rules = extractRuleSymbols('// Rule ignored:\n# @entry Rule alsoIgnored:\n@entry Rule active:');

    expect(rules.map((rule) => rule.name)).toEqual(['active']);
    expect(rules[0].isEntry).toBe(true);
  });

  it('supports English, Chinese, and German rule keywords with Latin and CJK names', () => {
    const rules = extractRuleSymbols('Rule latinName:\n规则 中文规则:\nRegel pruefen:\n@entry Regel haupt_regel:');

    expect(rules.map((rule) => rule.name)).toEqual(['latinName', '中文规则', 'pruefen', 'haupt_regel']);
    expect(chooseDefaultRule(rules)).toBe('haupt_regel');
  });
});

describe('reconcileSelectedRule', () => {
  const rules = [
    { name: 'power', isEntry: false },
    { name: 'factorial', isEntry: false },
    { name: 'calculate', isEntry: false },
  ];

  it('★用户已选且仍存在的规则保留（无条件回落默认值时，加载后立即切换的选择会被覆盖）', () => {
    expect(reconcileSelectedRule('calculate', rules)).toBe('calculate');
  });

  it('已选规则不在新列表里时回落到默认规则', () => {
    expect(reconcileSelectedRule('gone', [{ name: 'only', isEntry: false }])).toBe('only');
    expect(reconcileSelectedRule('gone', rules)).toBeNull();
  });

  it('尚未选择时取默认规则（@entry 优先）', () => {
    expect(reconcileSelectedRule(null, [...rules, { name: 'main', isEntry: true }])).toBe('main');
    expect(reconcileSelectedRule(null, rules)).toBeNull();
  });
});
