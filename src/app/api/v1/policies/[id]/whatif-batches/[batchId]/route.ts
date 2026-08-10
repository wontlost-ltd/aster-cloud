/**
 * What-If 批次查询（ADR 0034 S4 接线）。
 *
 * <p>薄转发，同 `../route.ts`。★<b>租户隔离由 aster-api 保证</b>：
 * 那边按 `userId` 查批次，不属于本用户的返回 **404 而非 403**——
 * 403 会泄露「这个批次存在」，让端点变成存在性探针。
 * cloud 侧不重复做归属判断，避免两套规则漂移。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
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

  const client = createPolicyApiClient(session.user.id, session.user.id);

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
