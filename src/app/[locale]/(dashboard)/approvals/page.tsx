import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { isGuardApprovalStatus, listUserApprovals } from '@/lib/approvals-inbox';
import { ApprovalsContent } from './approvals-content';

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
  const initial = await listUserApprovals(session.user.id, status);

  return (
    <ApprovalsContent
      locale={locale}
      initialStatus={status}
      initialItems={initial.items}
      initialUnavailable={initial.unavailableTenants}
      highlightDecisionId={decisionId ?? null}
    />
  );
}
