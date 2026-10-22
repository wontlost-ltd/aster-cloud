/**
 * Admin 工具：规则集升级回归报告查看（ADR 0030 M1）。
 *
 * 只读视图——列出某策略的回归报告（四态 + 覆盖）+ 冻结 golden case 概览，供 CCO 审阅。
 * freeze/run 由管理 API / 流水线触发（ADR §5 v1 只管理员/流水线触发）。
 *
 * 路由保护：server-side admin 判定不通过 → notFound（不暴露页面存在）。
 */
import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { isAdminFromSession } from '@/lib/admin-auth';
import { RuleRegressionContent } from './rule-regression-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('ruleRegression', 'title');

type Props = {
  params: Promise<{ locale: string }>;
};

export const dynamic = 'force-dynamic';

export default async function RuleRegressionAdminPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const admin = await isAdminFromSession();
  if (!admin) {
    notFound();
  }

  return <RuleRegressionContent />;
}
