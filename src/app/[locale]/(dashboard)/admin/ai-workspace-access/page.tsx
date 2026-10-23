import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { isAdminFromSession } from '@/lib/admin-auth';
import { localizedTitle } from '@/lib/page-metadata';
import { AiWorkspaceAccessContent } from './ai-workspace-access-content';

export const generateMetadata = localizedTitle('admin.nav', 'aiWorkspaceAccess');
export const dynamic = 'force-dynamic';

export default async function AiWorkspaceAccessPage({ params }: { params: Promise<{ locale: string }> }) {
  const admin = await isAdminFromSession();
  if (!admin) notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  return <AiWorkspaceAccessContent />;
}
