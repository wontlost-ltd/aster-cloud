/**
 * AI Guardian 演示页（仅 SaaS）：嵌入 aster-lang.dev 的剧情，并链接到可亲手操作的完整演示。
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { GuardianEmbed } from '@/components/marketing/guardian-embed';
import { Container, Stack } from '@/components/ui';
import { guardianTryItUrl } from '@/lib/guardian-embed';
import { IS_SAAS } from '@/lib/deployment-mode';

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'guardianPage.seo' });
  return {
    title: t('title'),
    description: t('description'),
    alternates: { canonical: `/${locale}/demos/guardian` },
    openGraph: { title: t('title'), description: t('description'), type: 'website' },
  };
}

export default async function GuardianDemoPage({ params }: Props) {
  if (!IS_SAAS) notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'guardianPage' });

  return (
    <main className="bg-bg">
      <Container className="py-12 sm:py-16">
        <Stack gap={8} align="center">
          <Stack gap={2} align="center" className="text-center">
            <h1 className="font-display text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              {t('title')}
            </h1>
            <p className="max-w-2xl text-lg text-fg-muted">{t('subtitle')}</p>
          </Stack>
          <div className="w-full max-w-4xl">
            <GuardianEmbed locale={locale} posterAlt={t('posterAlt')} />
          </div>
          <a
            href={guardianTryItUrl(locale)}
            className="text-sm font-medium text-primary hover:underline"
          >
            {t('tryIt')}
          </a>
        </Stack>
      </Container>
    </main>
  );
}
