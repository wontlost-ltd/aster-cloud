/**
 * 审批收件箱列表（ADR 0042 §5.2）：`GET /api/approvals?status=`，缺省 PENDING。
 * 聚合用户所在全部租户；单租户不可用不影响整体，返回 200 与 unavailableTenants。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { isGuardApprovalStatus, listUserApprovals } from '@/lib/approvals-inbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const status = new URL(req.url).searchParams.get('status') ?? 'PENDING';
  if (!isGuardApprovalStatus(status)) {
    return NextResponse.json({ error: 'invalid_status', message: `unknown status: ${status}` }, { status: 400 });
  }

  return NextResponse.json(await listUserApprovals(session.user.id, status));
}
