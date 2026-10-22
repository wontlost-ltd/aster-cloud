// RevocationContent — SaaS license revocation page composition。
//
// 设计意图：
//   - current manifest、new revocation form、active revocation table 三段分离
//   - 写入后用 router.refresh() 回到 server truth，避免客户端维护影子状态

'use client';

import { useTranslations } from 'next-intl';
import { Breadcrumbs, Container, PageHeader } from '@/components/ui';
import { CurrentPublicationCard } from './components/current-publication';
import { NewRevocationForm } from './components/new-revocation-form';
import { RevokedLicensesTable } from './components/revoked-licenses-table';

export type RevocationReason =
  | 'non-payment'
  | 'security'
  | 'renewal-superseded'
  | 'contract-terminated'
  | 'fraud';

export interface RevokedLicense {
  licenseId: string;
  reason: RevocationReason;
  revokedAt: string;
  revokedBy: string;
  notes?: string;
  customerRef?: string;
  undoExpiresAt?: string;
}

export interface CurrentPublication {
  version: number | string;
  publishedAt: string;
  validUntil: string;
  revokedCount: number;
}

interface Props {
  initialRevoked: RevokedLicense[];
  currentPublication: CurrentPublication | null;
}

export function RevocationContent({
  initialRevoked,
  currentPublication,
}: Props) {
  const t = useTranslations('admin.licenseRevoke');
  const tNav = useTranslations('dashboardNav');

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={
          <Breadcrumbs items={[{ label: tNav('groupAdmin') }, { label: t('title') }]} />
        }
        className="mb-6"
      />

      <div className="space-y-6">
        <CurrentPublicationCard publication={currentPublication} />
        <NewRevocationForm />
        <RevokedLicensesTable revoked={initialRevoked} />
      </div>
    </Container>
  );
}
