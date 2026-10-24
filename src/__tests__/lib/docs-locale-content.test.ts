import { describe, expect, it } from 'vitest';
import { selectDocsContentLocale } from '@/lib/docs/locale-content';

describe('selectDocsContentLocale', () => {
  it('uses English with a fallback marker for Hindi', () => {
    expect(selectDocsContentLocale('hi')).toEqual({ contentLocale: 'en', isEnglishFallback: true });
  });

  it('keeps supported translations without a fallback marker', () => {
    expect(selectDocsContentLocale('zh')).toEqual({ contentLocale: 'zh', isEnglishFallback: false });
    expect(selectDocsContentLocale('de')).toEqual({ contentLocale: 'de', isEnglishFallback: false });
    expect(selectDocsContentLocale('en')).toEqual({ contentLocale: 'en', isEnglishFallback: false });
  });
});
