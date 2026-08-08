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
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
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

  let body: {
    baseVersionId?: string;
    targetVersionId?: string;
    windowKind?: string;
    customFrom?: string;
    customTo?: string;
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

  // tenantId 用 userId：本仓 solo-tenant 语义（同 runner-parity 等既有调用方）
  const client = createPolicyApiClient(session.user.id, session.user.id);

  try {
    const result = await client.createWhatIfBatch(policyId, {
      baseVersionId: body.baseVersionId,
      targetVersionId: body.targetVersionId,
      windowKind: body.windowKind ?? 'LAST_MONTH',
      customFrom: body.customFrom,
      customTo: body.customTo,
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
