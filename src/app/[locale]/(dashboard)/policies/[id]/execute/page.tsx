import { getSession } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { db, policies } from '@/lib/prisma';
import { eq, and } from 'drizzle-orm';
import { isPolicyFrozen } from '@/lib/policy-freeze';
import { ExecutePolicyContent } from './execute-policy-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('pageTitles', 'policyExecute');

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

export default async function ExecutePolicyPage({ params }: PageProps) {
  const { id, locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  // 验证策略存在且属于当前用户
  const policy = await db.query.policies.findFirst({
    where: and(eq(policies.id, id), eq(policies.userId, session.user.id)),
    columns: { id: true },
  });

  if (!policy) {
    notFound();
  }

  // 冻结策略只读：套餐降级超限后该策略被冻结，不可执行。
  // 在入口处服务端拦截，避免用户进到执行页填表后才在 API 被 403 拒绝。
  // 详情页会展示冻结横幅 + 升级引导。
  const freeze = await isPolicyFrozen(session.user.id, id);
  if (freeze.isFrozen) {
    redirect(`/${locale}/policies/${id}?frozen=1`);
  }

  return <ExecutePolicyContent policyId={id} locale={locale} />;
}
