import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { Breadcrumbs, Container, PageHeader } from '@/components/ui';
import { FactIssuersPanel } from '@/components/guard/fact-issuers-panel';
import { getSession } from '@/lib/auth';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('factIssuers', 'title');

/**
 * /settings/fact-issuers — 个人租户的签名事实签发方（ADR 0040 §11 D3「个人租户同样可配」；ADR 0046 §11.7 裁定 14）。
 * 个人租户 id 即本人 userId；团队租户在团队设置页嵌入同一面板。
 */
export default async function FactIssuersPage() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }
  const t = await getTranslations('factIssuers');
  const tNav = await getTranslations('dashboardNav');

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('personalSubtitle')}
        breadcrumbs={<Breadcrumbs items={[{ label: tNav('settings'), href: '/settings' }, { label: t('title') }]} />}
        className="mb-6"
      />
      <FactIssuersPanel tenantId={session.user.id} />
    </Container>
  );
}
