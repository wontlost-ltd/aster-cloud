import { setRequestLocale } from 'next-intl/server';
import { redirectToFirstChild } from '@/lib/docs/section-redirect';

/**
 * /docs/guides — section-parent 308 redirect to the section's first child,
 * same as /docs/getting-started. Without it the breadcrumb's "Guides" crumb
 * (and its hover RSC prefetch) on /docs/guides/credit-pilot 404'd (#591).
 */
type Props = {
  params: Promise<{ locale: string }>;
};

export default async function GuidesIndex({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  redirectToFirstChild(locale, 'guides/credit-pilot');
}
