import { describe, it, expect } from 'vitest';
import { parseDateParam, parseEnumParam, parsePositiveInt } from '@/lib/api/query-params';

describe('parsePositiveInt', () => {
  it('缺省、非数字、0、负数都回落默认值', () => {
    for (const v of [null, '', 'abc', 'NaN', '0', '-3']) {
      expect(parsePositiveInt(v, 7), String(v)).toBe(7);
    }
  });
  it('合法正整数原样返回；给了上限时截到上限', () => {
    expect(parsePositiveInt('3', 1)).toBe(3);
    expect(parsePositiveInt('1000', 20, 100)).toBe(100);
    expect(parsePositiveInt('100', 20, 100)).toBe(100);
    expect(parsePositiveInt('99', 20, 100)).toBe(99);
  });
});

describe('parseDateParam', () => {
  it('无效日期返回 undefined，有效日期返回 Date', () => {
    expect(parseDateParam(null)).toBeUndefined();
    expect(parseDateParam('abc')).toBeUndefined();
    expect(parseDateParam('2026-13-45')).toBeUndefined();
    expect(parseDateParam('2026-01-02')?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });
});

describe('parseEnumParam', () => {
  const allowed = ['dashboard', 'api'] as const;
  it('只接受白名单内的值', () => {
    expect(parseEnumParam('api', allowed)).toBe('api');
    expect(parseEnumParam('API', allowed)).toBeUndefined();
    expect(parseEnumParam('bogus', allowed)).toBeUndefined();
    expect(parseEnumParam(null, allowed)).toBeUndefined();
  });
});
