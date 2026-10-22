/**
 * Admin tool: 列出 riskTier > 0 用户，支持手动覆盖。
 *
 * 路由保护：server-side admin 判定不通过 → notFound（不暴露页面存在）。
 */
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { isAdminFromSession } from '@/lib/admin-auth';
import { CAN_RISKTIER } from '@/lib/deployment-mode';
import { RiskTierAdminContent } from './risk-tier-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('admin.nav', 'riskTier');

type Props = {
  params: Promise<{ locale: string }>;
};

export const dynamic = 'force-dynamic';

export default async function RiskTierAdminPage({ params }: Props) {
  // On-prem 不使用注册风险评分系统。优先于 admin 检查 —— 即使是 admin
  // 在 on-prem 部署也不应看到此页面。
  if (!CAN_RISKTIER) {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  const admin = await isAdminFromSession();
  if (!admin) {
    notFound();
  }

  return <RiskTierAdminContent />;
}
