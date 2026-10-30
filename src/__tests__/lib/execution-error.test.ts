import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EXECUTION_FAILED_CODE,
  EXECUTION_FAILED_MESSAGE,
  executionErrorCode,
  hasInternalDetail,
  publicErrorText,
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

  it('输入缺字段：不脱敏、错误码取 missing_input_field', () => {
    const result = {
      deniedReasons: ['The input is missing the field "applicant.creditScore" that the policy reads.'],
      metadata: {},
      inputError: { code: 'missing_input_field', field: 'applicant.creditScore' },
    };
    expect(sanitizeExecutionResult(result, {})).toBe(result);
    expect(executionErrorCode(result)).toBe('missing_input_field');
  });

  it('正常拒绝理由不改动、无错误码', () => {
    const result = { deniedReasons: ['Applicant is under 18'], metadata: {} };
    expect(sanitizeExecutionResult(result, {})).toBe(result);
    expect(executionErrorCode(result)).toBeUndefined();
  });

  it('诊断里的 Java 异常/栈帧/内部路径被替换，code 与候选项保留', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = {
      deniedReasons: [RAW],
      metadata: { engineError: true },
      diagnostics: [
        { code: 'RUNTIME', message: 'java.lang.IllegalStateException: boom\n\tat io.aster.X.run(X.java:12)' },
        { code: 'INTERNAL', message: 'failed reading /opt/aster/lib/core.jar' },
        { code: 'ENTRY_AMBIGUOUS', message: 'Several rules match.', candidates: ['a', 'b'] },
      ],
    };

    const safe = sanitizeExecutionResult(result, {});

    expect(safe.diagnostics).toEqual([
      { code: 'RUNTIME', message: EXECUTION_FAILED_MESSAGE },
      { code: 'INTERNAL', message: EXECUTION_FAILED_MESSAGE },
      { code: 'ENTRY_AMBIGUOUS', message: 'Several rules match.', candidates: ['a', 'b'] },
    ]);
    expect(log).toHaveBeenCalledWith(
      '[policy-execute] engine error',
      expect.objectContaining({ diagnostics: result.diagnostics }),
    );
  });

  it('非引擎失败但诊断带内部细节：同样脱敏，拒绝理由不变', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = {
      deniedReasons: ['Applicant is under 18'],
      metadata: {},
      diagnostics: [{ code: 'W1', message: 'Polyglot value conversion failed' }],
    };
    const safe = sanitizeExecutionResult(result, {});
    expect(safe.deniedReasons).toEqual(['Applicant is under 18']);
    expect(safe.diagnostics).toEqual([{ code: 'W1', message: EXECUTION_FAILED_MESSAGE }]);
  });

  it('CNL 语法诊断（行列 + 说明）不算内部细节', () => {
    expect(hasInternalDetail('Line 3, column 7: Expected newline')).toBe(false);
    expect(hasInternalDetail('第 3 行第 7 列：缺少换行')).toBe(false);
    expect(hasInternalDetail('java.lang.RuntimeException: x')).toBe(true);
  });

  it('publicErrorText：保留 CNL 语法错误，替换内部细节', () => {
    expect(publicErrorText('Line 2: Expected newline')).toBe('Line 2: Expected newline');
    expect(publicErrorText(RAW)).toBe(EXECUTION_FAILED_MESSAGE);
  });

  it.each([
    ['相对源码路径', 'failed in src/main/java/io/aster/Foo.java:42'],
    ['jar 构件', 'cannot load aster-core-1.0.35.jar'],
    ['class 文件', 'bad bytecode in Evaluator.class'],
    ['Kotlin 源文件', 'error at Runner.kt line 3'],
    ['Windows 路径', 'cannot open C:\\aster\\lib\\core.dll'],
    ['全限定 Quarkus 类', 'io.quarkus.runtime.Startup failed'],
    ['Caused by', 'Evaluation failed. Caused by: boom'],
    ['栈帧', 'boom\n\tat Foo.bar(Unknown Source)'],
  ])('%s 视为内部细节', (_label, text) => {
    expect(hasInternalDetail(text)).toBe(true);
  });

  it.each([
    'Rule validate raises ValidationException when age is missing',
    'Line 3, column 7: Expected newline',
    'Return age at least 18.',
    'Unknown field alter. Available fields: age, name.',
  ])('普通 CNL 诊断原样通过：%s', (text) => {
    expect(hasInternalDetail(text)).toBe(false);
  });
});
