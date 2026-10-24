import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { isAdminFromSession } from '@/lib/admin-auth';
import { localizedTitle } from '@/lib/page-metadata';
import { RevalidationContent } from './revalidation-content';

export const generateMetadata = localizedTitle('admin.nav', 'revalidation');
export const dynamic = 'force-dynamic';

export default async function RevalidationPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (!(await isAdminFromSession())) notFound();
  return <RevalidationContent />;
}
