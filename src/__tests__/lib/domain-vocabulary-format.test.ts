// domain / locale 格式规则（#612）：服务端与客户端共用同一份纯函数。
import { describe, expect, it } from 'vitest';
import {
  canonicalizeVocabularyLocale,
  checkVocabularyScope,
  isValidVocabularyDomain,
} from '@/lib/domain-vocabulary-format';

describe('isValidVocabularyDomain', () => {
  it.each(['finance', 'finance.loan', 'insurance.auto_claims', 'health-care', 'a1.b2'])(
    '接受小写标识符 %s',
    (domain) => {
      expect(isValidVocabularyDomain(domain)).toBe(true);
    },
  );

  it.each(['E2E 1026', 'Finance', '1finance', 'finance.', '.finance', 'fin..loan', 'fin ance', ''])(
    '拒绝 %j',
    (domain) => {
      expect(isValidVocabularyDomain(domain)).toBe(false);
    },
  );

  it('拒绝超过 64 个字符的 domain', () => {
    expect(isValidVocabularyDomain('a'.repeat(65))).toBe(false);
    expect(isValidVocabularyDomain('a'.repeat(64))).toBe(true);
  });
});

describe('canonicalizeVocabularyLocale', () => {
  it.each([
    ['en', 'en'],
    ['zh-CN', 'zh-CN'],
    ['zh-cn', 'zh-CN'],
    ['EN-us', 'en-US'],
    ['zh-Hans-CN', 'zh-Hans-CN'],
  ])('%s → %s', (input, expected) => {
    expect(canonicalizeVocabularyLocale(input)).toBe(expected);
  });

  it.each(['xx_INVALID!!', 'en_US', 'E2E', 'en-', '', 'english language'])('拒绝 %j', (input) => {
    expect(canonicalizeVocabularyLocale(input)).toBeNull();
  });
});

describe('checkVocabularyScope', () => {
  it('同时报告 domain 与 locale 的问题', () => {
    expect(checkVocabularyScope({ domain: 'E2E 1026', locale: 'xx_INVALID!!' }).issues).toEqual([
      'domain_format',
      'locale_format',
    ]);
  });

  it('合法时去空白并规范 locale', () => {
    expect(checkVocabularyScope({ domain: ' finance ', locale: ' de-de ' })).toEqual({
      domain: 'finance',
      locale: 'de-DE',
      issues: [],
    });
  });
});
