import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { describe, expect, it } from 'vitest';
import rule from '../../../eslint-rules/no-stale-safe-column-read.js';
import { hasStaleCalls } from '../../../eslint-rules/no-stale-safe-column-read.js';

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
});

ruleTester.run('no-stale-safe-column-read', rule, {
  valid: [{ code: 'export const SAFE_COLUMNS: readonly string[] = [];', filename: '/project/src/lib/safe-column-read.ts' }],
  invalid: [],
});

describe('no-stale-safe-column-read detector', () => {
  it('fails when the registry is empty and a production call remains', () => {
    expect(hasStaleCalls('export const SAFE_COLUMNS: readonly string[] = [];', [{ path: '/project/src/lib/use.ts', content: 'safeColumnRead(run, fallback, "x")' }])).toBe(true);
  });

  it('passes when the registry is populated or calls only appear in tests', () => {
    expect(hasStaleCalls('export const SAFE_COLUMNS: readonly string[] = ["profile.newColumn"];', [{ path: '/project/src/lib/use.ts', content: 'safeColumnRead()' }])).toBe(false);
    expect(hasStaleCalls('export const SAFE_COLUMNS: readonly string[] = [];', [{ path: '/project/src/__tests__/use.test.ts', content: 'safeColumnRead()' }])).toBe(false);
  });
});
