import { setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { isAdminFromSession } from '@/lib/admin-auth';
import { localizedTitle } from '@/lib/page-metadata';
import { CapabilityGrantsContent } from '@/components/admin/capability-grants-content';

export const generateMetadata = localizedTitle('admin.nav', 'structuredAuthoring');
export const dynamic = 'force-dynamic';

export default async function StructuredAuthoringAdminPage({ params }: { params: Promise<{ locale: string }> }) {
  const admin = await isAdminFromSession();
  if (!admin) notFound();
  const { locale } = await params;
  setRequestLocale(locale);
  return <CapabilityGrantsContent />;
}
