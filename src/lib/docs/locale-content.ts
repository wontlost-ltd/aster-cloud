export type DocsContentLocale = 'en' | 'zh' | 'de';

/** 将文档展示语言映射到现有内容，未翻译的语种使用英文底稿。 */
export function selectDocsContentLocale(locale: string): {
  contentLocale: DocsContentLocale;
  isEnglishFallback: boolean;
} {
  if (locale === 'zh' || locale === 'de' || locale === 'en') {
    return { contentLocale: locale, isEnglishFallback: false };
  }
  return { contentLocale: 'en', isEnglishFallback: true };
}
