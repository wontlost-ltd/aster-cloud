/**
 * 解除审批输入原值（ADR 0042 §12 D5 / D10）：`POST /api/approvals/[tenantId]/[approvalId]/input/reveal`。
 * 解除权限（PENDING + 已验证业务角色包含所需角色）与按人入链由 aster-api 判定；
 * 403 reveal_not_permitted、409 input_not_available、503 receipt_unavailable 原样透传（不含原值）。
 */
import { proxyApprovalInput } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ tenantId: string; approvalId: string }>;
}

export async function POST(_req: Request, { params }: RouteParams) {
  const { tenantId, approvalId } = await params;
  return proxyApprovalInput(tenantId, approvalId, (client) => client.revealGuardApprovalInput(approvalId), false);
}
