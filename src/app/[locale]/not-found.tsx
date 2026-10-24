import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { Container, Stack, buttonVariants } from '@/components/ui';

export default async function LocaleNotFound() {
  const t = await getTranslations('common');
  return (
    <>
      <title>{t('notFoundTitle')}</title>
      <Container size="xl" className="py-16">
        <Stack gap={4} align="center" className="text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-primary">404</p>
          <h1 className="font-display text-3xl font-semibold text-fg">{t('notFoundTitle')}</h1>
          <p className="max-w-md text-fg-muted">{t('notFoundBody')}</p>
          <Link href="/dashboard" className={buttonVariants({ variant: 'primary', size: 'md' })}>
            {t('backToDashboard')}
          </Link>
        </Stack>
      </Container>
    </>
  );
}
