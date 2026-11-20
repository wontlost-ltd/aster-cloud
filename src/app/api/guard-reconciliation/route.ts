/**
 * 跨租户对账摘要（ADR 0061 §3.7）：`GET /api/guard-reconciliation` → `{ tenants, unavailableTenants }`。
 * 治理页摘要卡在客户端调用，`/governance` 的 SSR 不因此增加任何 aster-api 调用。
 */
import { NextResponse } from 'next/server';
import { listReconciliationOverview } from '@/lib/guard-reconciliation/overview';
import { sessionUserId, unauthorized } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const userId = await sessionUserId();
  if (!userId) return unauthorized();
  return NextResponse.json(await listReconciliationOverview(userId));
}
