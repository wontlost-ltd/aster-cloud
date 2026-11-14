/**
 * 审批输入代理（ADR 0042 §12 D10）的共用流程：登录 → 租户归属 → 以当前用户身份（v3 签名）转发 → 错误映射。
 * 输入视图不含决策以外的信息；cloud 不缓存、不改写视图（快照哈希由 api 计算，改写会让审批哈希失配）。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { approvalErrorResponse, belongsToTenant } from '@/lib/approvals-proxy';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import type { GuardApprovalInput } from '@/services/policy/guard-types';
import { PolicyApiError } from '@/services/policy/policy-api';

export type InputClient = Awaited<ReturnType<typeof createPolicyApiClientForUser>>;

/**
 * @param legacyNotFoundAsUnavailable 旧 api 没有输入端点时上游回 404（无 approval_not_found 码）：
 *                                    视为「输入不可用」，收件箱照常审批。新 api 的 404 approval_not_found 原样透传。
 */
export async function proxyApprovalInput(
  tenantId: string,
  approvalId: string,
  call: (client: InputClient) => Promise<GuardApprovalInput>,
  legacyNotFoundAsUnavailable: boolean,
): Promise<NextResponse> {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  if (!(await belongsToTenant(userId, tenantId))) {
    return NextResponse.json({ error: 'forbidden', message: 'Not a member of this tenant.' }, { status: 403 });
  }
  try {
    const client = await createPolicyApiClientForUser(tenantId, userId);
    return NextResponse.json(await call(client), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof PolicyApiError) {
      if (legacyNotFoundAsUnavailable && e.statusCode === 404 && e.code !== 'approval_not_found') {
        return NextResponse.json(
          { approvalId, status: 'unavailable', revealed: false, revealedByMe: false },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
      return approvalErrorResponse(e, '[approvals:input]');
    }
    console.error('[approvals:input] proxy failed', { tenantId, approvalId, err: e });
    return NextResponse.json({ error: 'approval_failed' }, { status: 502 });
  }
}
