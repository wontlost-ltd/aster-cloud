// 输入缺少规则读取的字段（生产复测第 6 轮第 4 项）：aster-api 回 400 + code=missing_input_field + field，
// 执行结果须带可操作的 inputError（字段路径），不能混成引擎失败（engineError）并被替换成通用文案。
import { describe, it, expect, vi } from 'vitest';
import { buildCNLErrorResult, deriveExecutionDecision } from '@/services/policy/cnl-executor';
import { PolicyApiError } from '@/services/policy/policy-api';
import type { Policy } from '@/lib/prisma';

const policy = { id: 'p1', name: 'P' } as Policy;

function missingFieldError(details: Record<string, unknown>) {
  return new PolicyApiError(
    "Input is missing field 'applicant.creditScore' that the policy reads. Add it to the input and try again.",
    400,
    'missing_input_field',
    undefined,
    details,
  );
}

describe('buildCNLErrorResult — 输入缺字段', () => {
  it('带 inputError（码 + 字段路径），不标 engineError，决策仍按失败（error）落库', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = buildCNLErrorResult(policy, missingFieldError({
      code: 'missing_input_field', field: 'applicant.creditScore', error: 'x',
    }));

    expect(r.inputError).toEqual({ code: 'missing_input_field', field: 'applicant.creditScore' });
    expect(r.metadata.engineError).toBeUndefined();
    expect(r.allowed).toBe(false);
    expect(r.deniedReasons[0]).toContain('applicant.creditScore');
    expect(deriveExecutionDecision(r)).toBe('error');
  });

  it('错误体缺 field 时不算输入缺字段，按引擎失败处理（不猜路径）', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = buildCNLErrorResult(policy, missingFieldError({ code: 'missing_input_field' }));

    expect(r.inputError).toBeUndefined();
    expect(r.metadata.engineError).toBe(true);
  });

  it('其它 4xx（如 input_too_deep）仍是引擎失败，不带 inputError', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = buildCNLErrorResult(policy, new PolicyApiError('too deep', 400, 'input_too_deep', undefined, {
      code: 'input_too_deep',
    }));

    expect(r.inputError).toBeUndefined();
    expect(r.metadata.engineError).toBe(true);
  });
});
