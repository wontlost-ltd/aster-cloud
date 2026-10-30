/**
 * What-If 批次查询（ADR 0034 S4 接线）。
 *
 * <p>薄转发，同 `../route.ts`。★<b>租户隔离由 aster-api 保证</b>：
 * 那边按 `userId` 查批次，不属于本用户的返回 **404 而非 403**——
 * 403 会泄露「这个批次存在」，让端点变成存在性探针。
 * cloud 侧先按策略授权（与创建批次同一口径，见 policy-access 的 whatif 动作），
 * 批次本身的归属仍由 aster-api 判定。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { loadPolicyForAction } from '@/lib/policy-access';
import { policyTenantId } from '@/lib/policy-tenant';
import { createPolicyApiClient, PolicyApiError } from '@/services/policy/policy-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; batchId: string }> },
) {
  const { id: policyId, batchId } = await params;

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // ADR 0034 §4.3：批次以策略所有者 userId 为租户、只回放所有者本人的执行，所以只有策略创建者能用；
  // 团队策略另要求创建者当前仍是有执行权限的成员（离队 / 被移除 / 降为 viewer 后立即失效，#670）。
  // 其他成员得到 403 whatif_owner_only（界面据此说明属主限定），非成员与他人个人策略 404。
  const access = await loadPolicyForAction(policyId, { userId: session.user.id }, 'whatif');
  if (!access.ok) {
    return NextResponse.json(
      { error: access.decision.code, message: access.decision.error },
      { status: access.decision.status },
    );
  }

  // 租户 = 策略租户（团队策略为 teamId，与执行落库同一口径，否则回放不到团队执行）；
  // userId = 当前用户（即创建者，属主限定已在上面校验）。创建与查询必须同一租户，aster-api 按
  // (id, tenantId, policyId, userId) 查批次。
  const client = createPolicyApiClient(policyTenantId(access.policy), session.user.id);

  try {
    const result = await client.getWhatIfBatch(policyId, batchId);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof PolicyApiError) {
      return NextResponse.json(
        { error: e.code ?? 'batch_fetch_failed', message: e.message },
        { status: e.statusCode ?? 502 },
      );
    }
    return NextResponse.json({ error: 'batch_fetch_failed' }, { status: 502 });
  }
}
