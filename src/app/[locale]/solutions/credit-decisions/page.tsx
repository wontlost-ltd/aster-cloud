import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { IS_SAAS } from '@/lib/deployment-mode';
import { SolutionLanding, solutionMetadata } from '@/components/marketing/solutions/solution-landing';

// 需求验证落地页：只供直链 / 分发，不进主导航；on-prem 部署不提供（试点申请只走 SaaS）。
type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return solutionMetadata('credit-decisions', locale);
}

export default async function Page({ params }: Props) {
  if (!IS_SAAS) notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  return <SolutionLanding slug="credit-decisions" locale={locale} />;
}
