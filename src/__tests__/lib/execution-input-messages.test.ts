// #650：执行输入歧义 / 入口不唯一的 API 英文说明，与界面已审定文案（demo-supplement execute.*）同一口径：
// 陈述事实（同一字段出现两次 / 一个写法对应多个字段 / 多条规则无 @entry），再给出可操作的修正。
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { ambiguousInputFieldMessage, ENTRY_RULE_REQUIRED_MESSAGE } from '@/lib/execution-input';

describe('执行输入错误说明', () => {
  it('一个写法对应多个字段：列出候选并要求改用规范字段名', () => {
    expect(ambiguousInputFieldMessage({ field: 'alter', fields: ['alter'], policyName: 'alter', candidates: ['age', 'oldAge'] }))
      .toBe('The input field "alter" matches several fields in this policy\'s vocabulary (age, oldAge). Use the canonical field name instead.');
  });

  it('两个键指向同一策略字段：说明重复原因并要求只保留一个', () => {
    expect(ambiguousInputFieldMessage({ field: 'person.age', fields: ['person.alter', 'person.age'], policyName: 'alter' }))
      .toBe('The input contains the policy field "alter" twice ("person.alter" and "person.age": its policy-language name '
        + 'and its canonical name, or two synonyms). Keep only one of them.');
  });

  it('多条规则且无 @entry：说明如何指定入口', () => {
    expect(ENTRY_RULE_REQUIRED_MESSAGE)
      .toBe('This policy has several rules and none is marked @entry. Choose the rule to run with functionName.');
  });
});
