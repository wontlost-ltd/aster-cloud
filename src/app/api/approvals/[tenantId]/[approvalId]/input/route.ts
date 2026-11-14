/**
 * 审批输入视图（ADR 0042 §12 D10）：`GET /api/approvals/[tenantId]/[approvalId]/input`。
 * 以当前用户身份转发到 aster-api（永远是打码视图、无副作用）；旧 api 的 404 → 200 `{ status: 'unavailable' }`。
 */
import { proxyApprovalInput } from './_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ tenantId: string; approvalId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { tenantId, approvalId } = await params;
  return proxyApprovalInput(tenantId, approvalId, (client) => client.getGuardApprovalInput(approvalId), true);
}
