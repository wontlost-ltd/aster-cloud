// #609：别名校验、词汇 validation_failed、执行失败的提示文案在 en/zh/de/hi 都有本地化版本
// （包内文案 ⊕ DEMO_SUPPLEMENT 合并后），占位符与 en 对齐，非中文界面不出现中文。

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

const ROOT = path.resolve(__dirname, '../../..');
const LOCALES = ['en', 'zh', 'de', 'hi'] as const;
const PACKAGE_FILES = {
  en: 'ui-messages/en-US.json',
  zh: 'ui-messages/zh-CN.json',
  de: 'ui-messages/de-DE.json',
  hi: 'ui-messages-hi/hi-IN.json',
} as const;

const ALIAS_ISSUE_CODES = [
  'tooManyKinds', 'kindNotAllowed', 'structuralNotGranted', 'tooManyAliases', 'empty', 'tooLong',
  'nonCanonical', 'singleWord', 'shadowsKeyword', 'shadowsBaseAlias', 'collidesVocabulary', 'duplicate',
];
const VOCAB_REASONS = [
  'generic', 'invalidCanonical', 'duplicateCanonical', 'triggerConflict', 'scopeConflict', 'invalidLiteral',
  'parentRequired', 'fieldRequired',
];
const KEYS = [
  ...ALIAS_ISSUE_CODES.map((c) => `policies.form.aliases.errors.${c}`),
  'policies.form.aliasesInvalidBeforeSaving',
  'policies.form.saveErrorCodes.alias_invalid',
  'policies.form.saveErrorCodes.vocabulary_scope_invalid',
  'policies.execute.engineErrorDetail',
  'policies.execute.ambiguousInputField',
  'policies.execute.ambiguousInputSpelling',
  ...VOCAB_REASONS.map((r) => `domainVocabularies.errors.validation.${r}`),
];

function getNested(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dotPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function loadPackage(loc: (typeof LOCALES)[number]): Record<string, unknown> {
  const file = path.join(ROOT, 'node_modules', '@aster-cloud', PACKAGE_FILES[loc]);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

const merged = Object.fromEntries(
  LOCALES.map((loc) => [loc, deepMergeMessages(loadPackage(loc), DEMO_SUPPLEMENT[loc])]),
) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

const placeholdersOf = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const CJK = /[一-鿿]/;

describe('#609 别名/词汇/执行错误文案本地化', () => {
  for (const loc of LOCALES) {
    it(`[${loc}] 所有键存在且占位符与 en 一致`, () => {
      for (const key of KEYS) {
        const value = getNested(merged[loc], key);
        expect(typeof value, `${loc}:${key}`).toBe('string');
        expect((value as string).trim(), `${loc}:${key}`).not.toBe('');
        const en = getNested(merged.en, key) as string;
        expect(placeholdersOf(value as string), `${loc}:${key}`).toEqual(placeholdersOf(en));
      }
    });
  }

  for (const loc of ['zh', 'de', 'hi'] as const) {
    it(`[${loc}] 已翻译（不与 en 相同）`, () => {
      for (const key of KEYS) {
        expect(getNested(merged[loc], key), `${loc}:${key}`).not.toBe(getNested(merged.en, key));
      }
    });
  }

  for (const loc of ['en', 'de', 'hi'] as const) {
    it(`[${loc}] 不含中文`, () => {
      for (const key of KEYS) {
        expect(CJK.test(getNested(merged[loc], key) as string), `${loc}:${key}`).toBe(false);
      }
    });
  }
});
