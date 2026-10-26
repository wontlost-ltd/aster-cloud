import { describe, expect, it } from 'vitest';
import { compileGateErrorResponse } from '@/lib/policy-compile-response';
import type { PolicyCompileError } from '@/services/policy/version-manager';

const diagnostic = {
  severity: 'error' as const,
  code: 'E001',
  message: 'Unexpected token',
  startLine: 4,
  startColumn: 7,
};

describe('compileGateErrorResponse', () => {
  it('returns compile diagnostics with the existing 400 compile_error response', async () => {
    const error = Object.assign(new Error('Policy source could not be compiled.'), {
      diagnostics: [diagnostic],
    }) as PolicyCompileError;

    const response = compileGateErrorResponse(error);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'compile_error',
      code: 'compile_error',
      diagnostics: [diagnostic],
    });
  });
});

describe('compileGateErrorResponse — 别名校验失败（#609）', () => {
  it('上游诊断为别名校验失败 → code alias_invalid（保留诊断）', async () => {
    const aliasDiagnostic = {
      ...diagnostic,
      message: 'CNL 解析失败: 用户自定义别名校验失败: 不允许为结构词 IF 自定义别名',
    };
    const error = Object.assign(new Error('compile failed'), {
      diagnostics: [aliasDiagnostic],
    }) as PolicyCompileError;

    const response = compileGateErrorResponse(error);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'alias_invalid',
      diagnostics: [aliasDiagnostic],
    });
  });
});

describe('aliasInvalidResponse', () => {
  it('别名校验失败 → 400 alias_invalid；其它错误 → null', async () => {
    const { aliasInvalidResponse } = await import('@/lib/policy-compile-response');
    const response = aliasInvalidResponse(new Error('用户自定义别名校验失败: x'));
    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ code: 'alias_invalid' });
    expect(aliasInvalidResponse(new Error('DB down'))).toBeNull();
    expect(aliasInvalidResponse('not an error')).toBeNull();
  });
});
