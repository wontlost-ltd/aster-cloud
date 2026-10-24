import type { ReactNode } from 'react';
import { selectDocsContentLocale } from '@/lib/docs/locale-content';
import { TranslationFallbackBanner } from './TranslationFallbackBanner';

type Props = {
  locale: string;
  contents: Record<'en' | 'zh' | 'de', ReactNode>;
  footer: ReactNode;
};

export function DocsLocaleContent({ locale, contents, footer }: Props) {
  const { contentLocale, isEnglishFallback } = selectDocsContentLocale(locale);
  return <>{isEnglishFallback && <TranslationFallbackBanner />}{contents[contentLocale]}{footer}</>;
}
