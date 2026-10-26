/** 执行页结果展示与表单提示的纯逻辑（#633 #634）。 */
import { describe, expect, it } from 'vitest';
import {
  EXECUTE_ERROR_KEYS,
  formatResultValue,
  formUnavailableKey,
} from '@/app/[locale]/(dashboard)/policies/[id]/execute/execute-input';

const enumValue = (name: string, member: string) => ({ __type: '?', _enum: name, value: member, variant: member, args: [] });

describe('formatResultValue（#633）', () => {
  it('枚举值对象只显示成员名；字符串原样', () => {
    expect(formatResultValue(enumValue('Stufe', 'Hoch'))).toBe('Hoch');
    expect(formatResultValue('Hoch')).toBe('Hoch');
  });

  it('结构 / 列表里嵌套的枚举值对象显示为成员名，其余字段原样', () => {
    const shown = JSON.parse(formatResultValue({ __type: 'Fahrer', alter: 35, niveau: enumValue('Stufe', 'Niedrig'), stufen: [enumValue('Stufe', 'Hoch')] }));
    expect(shown).toEqual({ __type: 'Fahrer', alter: 35, niveau: 'Niedrig', stufen: ['Hoch'] });
  });

  it('没有 _enum 标签的业务对象不当作枚举', () => {
    expect(JSON.parse(formatResultValue({ value: 'x', variant: 'y' }))).toEqual({ value: 'x', variant: 'y' });
  });
});

describe('formUnavailableKey（#634）', () => {
  it('不可解析 → invalidJson；合法但不是对象 → nonObjectInputInForm', () => {
    expect(formUnavailableKey('{"person":')).toBe('invalidJson');
    for (const text of ['[1,2]', '"x"', '42', 'null']) expect(formUnavailableKey(text)).toBe('nonObjectInputInForm');
  });
});

describe('EXECUTE_ERROR_KEYS', () => {
  it('服务端稳定错误码都有文案键', () => {
    expect(EXECUTE_ERROR_KEYS).toMatchObject({
      execution_failed: 'engineErrorDetail',
      invalid_input_object: 'invalidInputObject',
      input_type_extraction_failed: 'inputTypeExtractionFailed',
    });
  });
});
