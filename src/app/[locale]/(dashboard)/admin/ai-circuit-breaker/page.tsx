import { notFound } from 'next/navigation';
import { isAdminFromSession } from '@/lib/admin-auth';
import { CircuitBreakerContent } from './circuit-breaker-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('admin.nav', 'aiBreaker');

/**
 * /admin/ai-circuit-breaker — admin-only manual override for the
 * platform-wide LLM cost kill switch.
 *
 * Non-admins get a 404 (not a redirect) so the page's existence
 * isn't leaked to non-admins — matches the /admin/risk-tier
 * convention. isAdminFromSession already short-circuits when the
 * user isn't signed in, so we don't need a separate session check.
 */
export const dynamic = 'force-dynamic';

export default async function CircuitBreakerPage() {
  const admin = await isAdminFromSession();
  if (!admin) {
    notFound();
  }
  return <CircuitBreakerContent />;
}
