import { describe, expect, it } from 'vitest';
import { nextTemplateName } from '@/components/policy/policy-form/template-name';

describe('模板替换时策略名称', () => {
  it('空名称或上个模板自动生成的名称会跟随新模板', () => {
    expect(nextTemplateName('', null, 'credit-v2')).toBe('credit-v2');
    expect(nextTemplateName('credit-v1', 'credit-v1', 'credit-v2')).toBe('credit-v2');
  });

  it('保留用户自定义名称', () => {
    expect(nextTemplateName('My policy', 'credit-v1', 'credit-v2')).toBe('My policy');
  });
});
