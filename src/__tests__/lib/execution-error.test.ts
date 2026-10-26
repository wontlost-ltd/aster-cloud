import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EXECUTION_FAILED_CODE,
  EXECUTION_FAILED_MESSAGE,
  executionErrorCode,
  sanitizeExecutionResult,
} from '@/lib/execution-error';

const RAW =
  'CNL 动态执行失败: Polyglot 执行失败: java.lang.RuntimeException: 无法访问成员：alter。该对象的可用成员为 [age]';

describe('sanitizeExecutionResult（#609）', () => {
  afterEach(() => vi.restoreAllMocks());

  it('引擎失败：对外只留通用说明，原文写服务端日志', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = { deniedReasons: [RAW], metadata: { engineError: true }, allowed: false };

    const safe = sanitizeExecutionResult(raw, { policyId: 'p1' });

    expect(safe.deniedReasons).toEqual([EXECUTION_FAILED_MESSAGE]);
    expect(JSON.stringify(safe)).not.toMatch(/java\.lang|Polyglot|无法访问/);
    expect(safe.allowed).toBe(false);
    expect(raw.deniedReasons).toEqual([RAW]);
    expect(log).toHaveBeenCalledWith(
      '[policy-execute] engine error',
      expect.objectContaining({ policyId: 'p1', reasons: [RAW] }),
    );
    expect(executionErrorCode(safe)).toBe(EXECUTION_FAILED_CODE);
  });

  it('正常拒绝理由不改动、无错误码', () => {
    const result = { deniedReasons: ['Applicant is under 18'], metadata: {} };
    expect(sanitizeExecutionResult(result, {})).toBe(result);
    expect(executionErrorCode(result)).toBeUndefined();
  });
});
