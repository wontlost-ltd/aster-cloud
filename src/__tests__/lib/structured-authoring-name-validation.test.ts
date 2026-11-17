// 模型标签页名字校验（ADR 0058 §8.3）：与词法器同口径，防止表单产出无法编译的源码。
import { describe, it, expect } from 'vitest';
import { DE_DE, EN_US, HI_IN, ZH_CN } from '@aster-cloud/aster-lang-ts/browser';
import { isValidFieldName, isValidTypeName } from '@/lib/structured-authoring/name-validation';

describe('isValidTypeName', () => {
  it('接受各语言的单个标识符（大小写均可）', () => {
    expect(isValidTypeName(EN_US, 'Person')).toBe(true);
    expect(isValidTypeName(EN_US, 'score')).toBe(true);
    expect(isValidTypeName(ZH_CN, '客户')).toBe(true);
    expect(isValidTypeName(DE_DE, 'Fahrer')).toBe(true);
    expect(isValidTypeName(HI_IN, 'ग्राहक')).toBe(true);
  });

  it('拒绝空白、含空格、标点与数字开头', () => {
    for (const bad of ['', '   ', 'my struct', 'a.b', 'x. Rule', '1a', '_x', 'a,b', '"s"']) {
      expect(isValidTypeName(EN_US, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('首尾空白被忽略', () => {
    expect(isValidTypeName(EN_US, '  Person ')).toBe(true);
  });
});

describe('isValidFieldName', () => {
  it('字段名在拉丁语言须是小写起首标识符（解析器只认 IDENT）', () => {
    expect(isValidFieldName(EN_US, 'income')).toBe(true);
    expect(isValidFieldName(EN_US, 'Name')).toBe(false);
    expect(isValidFieldName(ZH_CN, '姓名')).toBe(true);
    expect(isValidFieldName(HI_IN, 'नाम')).toBe(true);
  });

  it('拒绝含空格或标点', () => {
    expect(isValidFieldName(EN_US, 'my field')).toBe(false);
    expect(isValidFieldName(EN_US, 'a.b')).toBe(false);
  });
});
