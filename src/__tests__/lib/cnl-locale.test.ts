/** 策略 CNL 语言的受支持集合与保存入口 locale 解析（#602 复审）。 */
import { describe, it, expect } from 'vitest';
import { CNL_LOCALES, normalizeCnlLocale, parseCompileLocale } from '@/lib/cnl-locale';
import { DE_DE, EN_US, HI_IN, ZH_CN } from '@/lib/aster-lexicon';

describe('CNL_LOCALES', () => {
  it('derives from the editor/compiler lexicons', () => {
    expect(CNL_LOCALES).toEqual([EN_US.id, ZH_CN.id, DE_DE.id, HI_IN.id]);
    expect(CNL_LOCALES).toEqual(['en-US', 'zh-CN', 'de-DE', 'hi-IN']);
  });
});

describe('normalizeCnlLocale', () => {
  it.each([
    ['en-US', 'en-US'], ['de-de', 'de-DE'], ['ZH_cn', 'zh-CN'], ['de', 'de-DE'], ['hi', 'hi-IN'], [' en ', 'en-US'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeCnlLocale(raw)).toBe(expected);
  });

  it.each(['en-GB', 'fr-FR', 'fr', 'de-AT', 'xx_INVALID!!'])('rejects %s', (raw) => {
    expect(normalizeCnlLocale(raw)).toBeNull();
  });
});

describe('parseCompileLocale', () => {
  it('defaults missing/blank to en-US', () => {
    expect(parseCompileLocale(undefined)).toEqual({ ok: true, locale: 'en-US' });
    expect(parseCompileLocale('  ')).toEqual({ ok: true, locale: 'en-US' });
  });

  it('returns a stable unsupported_locale error body', () => {
    const result = parseCompileLocale('en-GB');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unsupported_locale');
      expect(result.error.supportedLocales).toEqual(CNL_LOCALES);
    }
    expect(parseCompileLocale(42).ok).toBe(false);
  });
});
