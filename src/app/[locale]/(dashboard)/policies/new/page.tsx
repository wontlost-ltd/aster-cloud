import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { NewPolicyContent } from './new-policy-content';
import { getStructuralAliasGrant } from '@/lib/structural-alias-grants';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

import { buildPoliciesNewCallback } from './build-callback';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('policies', 'newPolicy');

export default async function NewPolicyPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const session = await getSession();
  const sp = await searchParams;

  if (!session?.user?.id) {
    const callback = buildPoliciesNewCallback(locale, sp);
    redirect(`/${locale}/login?callbackUrl=${encodeURIComponent(callback)}`);
  }

  const allowStructuralAliases = await getStructuralAliasGrant(session.user.id);

  return (
    <NewPolicyContent
      locale={locale}
      allowStructuralAliases={allowStructuralAliases}
    />
  );
}
