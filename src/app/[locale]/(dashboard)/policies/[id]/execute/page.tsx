import { getSession } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { loadPolicyForAction } from '@/lib/policy-access';
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

  // 与执行 API 同一授权：团队策略 owner/admin/member 可执行（含他人创建的，#669），
  // viewer 与非成员（含已离队的创建者，#670）看不到执行页；个人策略只认所有者
  const access = await loadPolicyForAction(id, { userId: session.user.id }, 'execute');
  if (!access.ok) {
    notFound();
  }

  // 冻结策略只读：套餐降级超限后该策略被冻结，不可执行。
  // 在入口处服务端拦截，避免用户进到执行页填表后才在 API 被 403 拒绝。
  // 详情页会展示冻结横幅 + 升级引导。
  // 冻结取决于策略所有者（创建者）的套餐
  const freeze = await isPolicyFrozen(access.policy.userId, id);
  if (freeze.isFrozen) {
    redirect(`/${locale}/policies/${id}?frozen=1`);
  }

  return <ExecutePolicyContent policyId={id} locale={locale} />;
}
