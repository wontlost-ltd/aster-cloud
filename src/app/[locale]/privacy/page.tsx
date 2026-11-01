import { useTranslations } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

type Props = {
  params: Promise<{ locale: string }>;
};

export default async function PrivacyPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <PrivacyContent />;
}

function PrivacyContent() {
  const t = useTranslations();

  const sections = [
    'intro',
    'collection',
    'usage',
    'sharing',
    'telemetry',
    // 4a：落地页试点申请与第一方产品分析（文案在本地补充层 legal.privacy.sections.demandValidation）
    'demandValidation',
    'transfers',
    'subprocessors',
    'security',
    'retention',
    'rights',
    'dsar',
    'cookies',
    'contact',
  ] as const;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Navigation */}
      <nav className="border-b border-gray-200 bg-white">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <Link href="/" className="text-2xl font-bold text-primary">
              {t('nav.brand')}
            </Link>
            <Link
              href="/login"
              className="text-gray-600 hover:text-gray-900 font-medium"
            >
              {t('common.signIn')}
            </Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">
          {t('legal.privacy.title')}
        </h1>
        <p className="text-gray-500 mb-8">
          {t('legal.privacy.lastUpdated', { date: 'November 1, 2026' })}
        </p>

        <div className="prose prose-indigo max-w-none">
          {sections.map((section) => (
            <section key={section} className="mb-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-3">
                {t(`legal.privacy.sections.${section}.title`)}
              </h2>
              <p className="text-gray-600 leading-relaxed">
                {t(`legal.privacy.sections.${section}.content`)}
              </p>
            </section>
          ))}
        </div>

        <div className="mt-12 pt-8 border-t border-gray-200">
          <Link
            href="/"
            className="text-primary hover:text-primary-hover font-medium"
          >
            &larr; {t('nav.brand')}
          </Link>
        </div>
      </main>
    </div>
  );
}
