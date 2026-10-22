import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { SecurityDashboard } from '@/components/security';
import { Container, PageHeader } from '@/components/ui';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('dashboardNav', 'security');

export default async function SecurityPage() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const t = await getTranslations('security');

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        className="mb-6"
      />

      <SecurityDashboard />
    </Container>
  );
}
