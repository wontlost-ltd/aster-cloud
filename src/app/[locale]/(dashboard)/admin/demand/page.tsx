/**
 * /admin/demand —— 需求验证看板（仅 SaaS、仅平台 admin）。
 *
 * 汇总第一方产品事件（周计数、模板分布、注册→首存→首跑→证据导出漏斗、落地页与来源）、
 * Guard 调用按租户计数，以及落地页试点申请列表与 CSV 导出。数据口径见 src/lib/product-events/report.ts。
 */
import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { isAdminFromSession } from '@/lib/admin-auth';
import { IS_SAAS } from '@/lib/deployment-mode';
import { loadDemandReport } from '@/lib/product-events/report';
import { listPilotApplications } from '@/lib/pilot-applications';
import { Breadcrumbs, Container, PageHeader } from '@/components/ui';
import { localizedTitle } from '@/lib/page-metadata';
import { DemandDashboard } from './demand-dashboard';

export const generateMetadata = localizedTitle('admin.demand', 'title');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ locale: string }> };

/** 页面内列表只显示最近的申请；完整数据走 CSV 导出。 */
const PAGE_APPLICATIONS = 200;

export default async function DemandPage({ params }: Props) {
  if (!IS_SAAS) notFound();
  const admin = await isAdminFromSession();
  if (!admin) notFound();

  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('admin.demand');
  const tNav = await getTranslations('dashboardNav');

  const [report, applications] = await Promise.all([
    loadDemandReport(),
    listPilotApplications(PAGE_APPLICATIONS),
  ]);

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        breadcrumbs={<Breadcrumbs items={[{ label: tNav('groupAdmin') }, { label: t('title') }]} />}
        className="mb-6"
      />
      <DemandDashboard
        report={report}
        applications={applications}
        t={(key, values) => t(key, values)}
        exportHref="/api/admin/pilot-applications/export"
      />
    </Container>
  );
}
