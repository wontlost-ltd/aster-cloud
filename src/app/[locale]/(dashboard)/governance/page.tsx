import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { loadGovernanceOverview } from '@/lib/governance-impact';
import { GovernanceContent } from './governance-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('dashboardNav', 'governance');

interface PageProps {
  params: Promise<{ locale: string }>;
}

// 治理视图（#739）：框架 → 控制项 → 引用它的策略；无 @control 的策略单列「未关联」。
export default async function GovernancePage({ params }: PageProps) {
  const { locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  const overview = await loadGovernanceOverview(session.user.id);
  return <GovernanceContent locale={locale} overview={overview} />;
}
