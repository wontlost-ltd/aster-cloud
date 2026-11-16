import { useTranslations } from 'next-intl';
import { setRequestLocale } from 'next-intl/server';
import { Link } from '@/i18n/navigation';

type Props = {
  params: Promise<{ locale: string }>;
};

export default async function TermsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <TermsContent />;
}

function TermsContent() {
  const t = useTranslations();

  const sections = [
    'acceptance',
    'services',
    'accounts',
    'usage',
    'payment',
    'termination',
    'liability',
    'changes',
  ] as const;

  return (
    <div className="min-h-screen bg-bg-subtle">
      {/* Navigation */}
      <nav className="border-b border-border bg-bg">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-16 items-center">
            <Link href="/" className="text-2xl font-bold text-primary">
              {t('nav.brand')}
            </Link>
            <Link
              href="/login"
              className="text-fg-muted hover:text-fg font-medium"
            >
              {t('common.signIn')}
            </Link>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <h1 className="text-3xl font-bold text-fg mb-2">
          {t('legal.terms.title')}
        </h1>
        <p className="text-fg-subtle mb-8">
          {t('legal.terms.lastUpdated', { date: 'January 1, 2026' })}
        </p>

        <div className="prose prose-indigo max-w-none">
          {sections.map((section) => (
            <section key={section} className="mb-8">
              <h2 className="text-xl font-semibold text-fg mb-3">
                {t(`legal.terms.sections.${section}.title`)}
              </h2>
              <p className="text-fg-muted leading-relaxed">
                {t(`legal.terms.sections.${section}.content`)}
              </p>
            </section>
          ))}
        </div>

        <div className="mt-12 pt-8 border-t border-border">
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
