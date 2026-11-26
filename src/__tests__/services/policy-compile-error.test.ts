// 编译门禁错误类型单独成模块（#853）：行为与原 version-manager 内定义一致，且 version-manager 再导出的是同一个类。
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPILE_RETRY_AFTER_SECONDS,
  PolicyCompileError,
  PolicyCompileUnavailableError,
  VOCABULARY_UNAVAILABLE_CODE,
} from '@/services/policy/policy-compile-error';
import * as versionManager from '@/services/policy/version-manager';

describe('policy-compile-error', () => {
  it('PolicyCompileError：缺省文案、带诊断、不是「暂不可用」', () => {
    const diagnostics = [{ severity: 'error' as const, code: 'E057', message: 'bad', startLine: 2, startColumn: 3 }];
    const error = new PolicyCompileError(undefined, diagnostics);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PolicyCompileError');
    expect(error.message).toBe('Policy source could not be compiled.');
    expect(error.diagnostics).toEqual(diagnostics);
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.unavailableCode).toBeUndefined();
  });

  it('PolicyCompileUnavailableError：是 PolicyCompileError 子类，带重试秒数与稳定错误码', () => {
    const error = new PolicyCompileUnavailableError(DEFAULT_COMPILE_RETRY_AFTER_SECONDS);
    expect(error).toBeInstanceOf(PolicyCompileError);
    expect(error.name).toBe('PolicyCompileUnavailableError');
    expect(error.message).toBe('Policy compilation is temporarily unavailable. Try again later.');
    expect(error.retryAfterSeconds).toBe(60);
    expect(error.unavailableCode).toBe('compile_unavailable');
    expect(error.diagnostics).toBeUndefined();

    const vocab = new PolicyCompileUnavailableError(5, 'vocab down', VOCABULARY_UNAVAILABLE_CODE);
    expect(vocab.message).toBe('vocab down');
    expect(vocab.unavailableCode).toBe('vocabulary_unavailable');
  });

  it('version-manager 再导出同一批类与常量（路由的 instanceof 与既有导入路径不变）', () => {
    expect(versionManager.PolicyCompileError).toBe(PolicyCompileError);
    expect(versionManager.PolicyCompileUnavailableError).toBe(PolicyCompileUnavailableError);
    expect(versionManager.DEFAULT_COMPILE_RETRY_AFTER_SECONDS).toBe(DEFAULT_COMPILE_RETRY_AFTER_SECONDS);
    expect(versionManager.VOCABULARY_UNAVAILABLE_CODE).toBe(VOCABULARY_UNAVAILABLE_CODE);
  });
});
