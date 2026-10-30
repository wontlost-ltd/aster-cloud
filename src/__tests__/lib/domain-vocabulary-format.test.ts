// domain / locale 格式规则（#612）：服务端与客户端共用同一份纯函数。
import { describe, expect, it } from 'vitest';
import {
  canonicalizeVocabularyLocale,
  checkTermBounds,
  checkVocabularyScope,
  isValidVocabularyDomain,
  VOCAB_TERM_MAX_ALIASES,
  VOCAB_TERM_MAX_TEXT_LENGTH,
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

// 单词条上限与 aster-api VocabularyBounds 一致（#621）：超限词条保存成功却在编译/执行时被
// 400 vocabulary_too_large 拒绝，必须在保存时就拒绝。
describe('checkTermBounds', () => {
  const term = {
    canonical: 'Driver',
    localized: 'Fahrer',
    parentCanonical: undefined as string | undefined,
    description: undefined as string | undefined,
    aliases: [] as string[],
  };

  it('上限与 aster-api VocabularyBounds 相同', () => {
    expect(VOCAB_TERM_MAX_ALIASES).toBe(256);
    expect(VOCAB_TERM_MAX_TEXT_LENGTH).toBe(16_384);
  });

  it('恰好在上限内 → 无问题', () => {
    expect(
      checkTermBounds({
        ...term,
        aliases: Array.from({ length: 256 }, (_, i) => `a${i}`),
        description: 'x'.repeat(16_384),
      }),
    ).toEqual([]);
  });

  it('别名超过 256 个 → aliases_too_many', () => {
    expect(checkTermBounds({ ...term, aliases: Array.from({ length: 257 }, (_, i) => `a${i}`) })).toEqual([
      { issue: 'aliases_too_many' },
    ]);
  });

  it.each(['canonical', 'localized', 'parentCanonical', 'description'] as const)(
    '%s 超过 16384 字符 → text_too_long',
    (field) => {
      expect(checkTermBounds({ ...term, [field]: 'x'.repeat(16_385) })).toEqual([
        { issue: 'text_too_long', field },
      ]);
    },
  );

  it('单个别名超过 16384 字符 → text_too_long(aliases)', () => {
    expect(checkTermBounds({ ...term, aliases: ['ok', 'x'.repeat(16_385)] })).toEqual([
      { issue: 'text_too_long', field: 'aliases' },
    ]);
  });

  it('按 UTF-16 码元计长度（与 Java String.length 一致）', () => {
    // 8193 个补充平面字符 = 16386 个 UTF-16 码元
    expect(checkTermBounds({ ...term, description: '😀'.repeat(8193) })).toEqual([
      { issue: 'text_too_long', field: 'description' },
    ]);
  });
});
