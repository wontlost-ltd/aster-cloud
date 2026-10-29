import { describe, expect, it } from 'vitest';
import { buildVocabularyScopes, IdentifierKind } from '@aster-cloud/aster-lang-ts/browser';
import { compileGateErrorResponse, vocabularyScopeInvalidResponse } from '@/lib/policy-compile-response';
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

describe('vocabularyScopeInvalidResponse — 指出出错词条（ADR 0051）', () => {
  function scopeError(vocab: Partial<Parameters<typeof buildVocabularyScopes>[0]>): unknown {
    try {
      buildVocabularyScopes({ id: 'v', name: 'v', locale: 'de-DE', version: '1', structs: [], fields: [], functions: [], ...vocab });
    } catch (err) {
      return err;
    }
    throw new Error('expected VocabularyScopeError');
  }

  it('字段缺 parent → 400，带 term 与 kind', async () => {
    const error = scopeError({ fields: [{ canonical: 'age', localized: 'alter', kind: IdentifierKind.FIELD }] });
    const response = vocabularyScopeInvalidResponse(error)!;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'vocabulary_scope_invalid', reason: 'field_parent_required', term: 'alter', kind: 'field',
    });
  });

  it('枚举成员缺 parent → kind=enum_value', async () => {
    const error = scopeError({ enumValues: [{ canonical: 'High', localized: 'Hoch', kind: IdentifierKind.ENUM_VALUE }] });
    expect(await vocabularyScopeInvalidResponse(error)!.json()).toMatchObject({
      reason: 'member_parent_required', term: 'Hoch', kind: 'enum_value',
    });
  });

  it('非 VocabularyScopeError → null', () => {
    expect(vocabularyScopeInvalidResponse(new Error('x'))).toBeNull();
  });
});

describe('compileGateErrorResponse — 词汇加载失败', () => {
  it('unavailableCode=vocabulary_unavailable → 503 且码与 compile_unavailable 区分', async () => {
    const error = Object.assign(new Error('Domain vocabulary could not be loaded.'), {
      retryAfterSeconds: 60,
      unavailableCode: 'vocabulary_unavailable',
    }) as PolicyCompileError;
    const response = compileGateErrorResponse(error);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toMatchObject({ code: 'vocabulary_unavailable', error: 'vocabulary_unavailable' });
  });
});
