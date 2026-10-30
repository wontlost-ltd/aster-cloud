/**
 * What-If 批次创建（ADR 0034 S4 接线）。
 *
 * <p><b>这是一层薄转发</b>：批次的表、状态机、判定逻辑与权益判定**都在 aster-api**
 * （见 ADR 0034 §3.0——执行数据虽在 cloud，但由 api 反向分页拉取后进程内直调重跑，
 * 避免 cloud 逐条调 api 的 49MB/万条往返）。
 *
 * <p>cloud 侧只做两件事：解析登录态、把请求带上内部调用凭证转给 api。
 * 走既有的 {@link createPolicyApiClient}（内部网络地址 + HMAC v2 签名），
 * <b>不是新机制</b>——策略执行、回归工具、runner-parity 都走同一个客户端。
 *
 * <p>★<b>状态码原样透传</b>：403（无权益，引导升级）与 409（并发超限，提示等待）
 * 在 aster-api 侧就是两件不同的事，cloud 不得把它们合并成一个泛化错误——
 * 那会让前端无法区分「去升级」与「等一会儿」。
 * 503 plan_check_unavailable（权益校验超时）同样原样透传，前端提示「稍后重试」而非「去升级」。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { loadPolicyForAction } from '@/lib/policy-access';
import { policyTenantId } from '@/lib/policy-tenant';
import { createPolicyApiClient, PolicyApiError } from '@/services/policy/policy-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: policyId } = await params;

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

  let body: {
    baseVersionId?: string;
    targetVersionId?: string;
    windowKind?: string;
    customFrom?: string;
    customTo?: string;
    includeToday?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body.baseVersionId || !body.targetVersionId) {
    // ★缺版本行 id 直接拒，不给默认值——前端的挂载条件本就保证了两者齐备，
    //   走到这里说明调用方绕过了 UI，不该猜一个版本替它跑。
    return NextResponse.json(
      { error: 'missing_versions', message: 'baseVersionId and targetVersionId are required' },
      { status: 400 },
    );
  }

  // 租户 = 策略租户（团队策略为 teamId，与执行落库同一口径，否则回放不到团队执行）；
  // userId = 当前用户（即创建者，属主限定已在上面校验）。创建与查询必须同一租户，aster-api 按
  // (id, tenantId, policyId, userId) 查批次。
  const client = createPolicyApiClient(policyTenantId(access.policy), session.user.id);

  try {
    const result = await client.createWhatIfBatch(policyId, {
      baseVersionId: body.baseVersionId,
      targetVersionId: body.targetVersionId,
      windowKind: body.windowKind ?? 'LAST_MONTH',
      customFrom: body.customFrom,
      customTo: body.customTo,
        // ★这层是**逐字段重建**请求体，不是透传：新增入参必须同步加在这里，
        //   否则会被静默丢弃——前端发了、后端收不到、两边都不报错。
        //   实测教训：includeToday 上线后毫无效果，根因就是漏了这一行。
        includeToday: body.includeToday,
    });
    return NextResponse.json(result, { status: 202 });
  } catch (e) {
    if (e instanceof PolicyApiError) {
      // ★原样透传 403 / 409 / 400，含 api 侧的 error code 与提示字段
      return NextResponse.json(
        { error: e.code ?? 'batch_failed', message: e.message },
        { status: e.statusCode ?? 502 },
      );
    }
    return NextResponse.json({ error: 'batch_failed' }, { status: 502 });
  }
}
