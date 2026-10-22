// /admin/sso — on-prem SSO 配置展示页。
//
// 服务端解析 SSO 相关 env，传给客户端组件。SaaS build: notFound。
// admin 权限由 admin/layout.tsx 守门。

import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { isAdminFromSession } from '@/lib/admin-auth';
import { CAN_SSO } from '@/lib/deployment-mode';
import { introspectSsoConfig } from '@/lib/sso';
import { SsoConfigContent } from './sso-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('admin.nav', 'sso');

type Props = {
  params: Promise<{ locale: string }>;
};

export const dynamic = 'force-dynamic';

export default async function SsoPage({ params }: Props) {
  if (!CAN_SSO) {
    notFound();
  }

  // Defense-in-depth: 同 license/page.tsx 注释。
  const admin = await isAdminFromSession();
  if (!admin) {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  const introspection = introspectSsoConfig(process.env);

  return <SsoConfigContent introspection={introspection} />;
}
