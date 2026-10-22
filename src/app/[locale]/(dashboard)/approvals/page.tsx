import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { isGuardApprovalStatus, listUserApprovals } from '@/lib/approvals-inbox';
import { listPendingVersionApprovals } from '@/lib/version-approvals-inbox';
import { ApprovalsContent } from './approvals-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('dashboardNav', 'approvals');

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ status?: string; decisionId?: string }>;
}

export default async function ApprovalsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const { status: rawStatus, decisionId } = await searchParams;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  // ?status= 非法值回退到待审批（ADR 0042 §5.2 默认 PENDING）
  const status = isGuardApprovalStatus(rawStatus) ? rawStatus : 'PENDING';
  // 两类审批互不依赖，并行加载：Action-Guard（aster-api）与策略版本（本库）
  const [initial, versionApprovals] = await Promise.all([
    listUserApprovals(session.user.id, status),
    listPendingVersionApprovals(session.user.id),
  ]);

  return (
    <ApprovalsContent
      locale={locale}
      initialStatus={status}
      initialItems={initial.items}
      initialUnavailable={initial.unavailableTenants}
      versionApprovals={versionApprovals}
      highlightDecisionId={decisionId ?? null}
    />
  );
}
