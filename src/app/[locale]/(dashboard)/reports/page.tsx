import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { policiesVisibleTo } from '@/lib/policy-access';
import { db, policies } from '@/lib/prisma';
import { and, isNull, asc } from 'drizzle-orm';
import { listEvidenceExports } from '@/lib/evidence';
import { summarizeStoredExport } from '@/services/evidence/stored';
import { ReportsContent } from './reports-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('dashboardNav', 'reports');

interface PageProps {
  params: Promise<{ locale: string }>;
}

export default async function ReportsPage({ params }: PageProps) {
  const { locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }
  const userId = session.user.id;

  // 并行拉：用户策略（供选择器）+ 历史证据导出。
  const [policyRows, exports] = await Promise.all([
    db.query.policies.findMany({
      // 证据可导出的策略：本人的个人策略 + 本人当前可查看的团队策略（与证据导出同一范围，#673）
      where: and(policiesVisibleTo(userId, 'view'), isNull(policies.deletedAt)),
      columns: { id: true, name: true },
      orderBy: [asc(policies.name)],
    }),
    listEvidenceExports(userId),
  ]);

  const initialExports = exports.map((e) => {
    // 历史行可能是 v1–v5 manifest：经 summarizeStoredExport 按 schemaVersion 收窄，未知版本显示占位。
    const summary = summarizeStoredExport(e.data);
    return {
      id: e.id,
      title: e.title,
      status: e.status as 'generating' | 'completed' | 'failed',
      period: e.period ?? null,
      count: summary?.count ?? null,
      bundleHash: summary?.bundleHash ?? null,
      schemaVersion: summary?.schemaVersion ?? null,
      createdAt: e.createdAt.toISOString(),
      completedAt: e.completedAt?.toISOString() ?? null,
    };
  });

  return (
    <ReportsContent
      locale={locale}
      policies={policyRows.map((p) => ({ id: p.id, name: p.name }))}
      initialExports={initialExports}
    />
  );
}
