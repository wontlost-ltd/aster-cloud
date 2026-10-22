import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { DataContent } from './data-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('settings.dataPage', 'title');

/**
 * /settings/data — GDPR access + erasure page.
 *
 * Surfaces the backend's existing Article 15 (export) +
 * Article 17 (erasure) endpoints behind a single page so the
 * "right to be forgotten" lives somewhere visible. Without a
 * UI those endpoints would only be exercisable via curl, which
 * is not a credible "we honor GDPR" story for prospective
 * customers.
 */
export default async function DataPage() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }
  return <DataContent />;
}
