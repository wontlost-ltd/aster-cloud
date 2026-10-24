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
