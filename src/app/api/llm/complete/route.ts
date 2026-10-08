/**
 * R23-Critical-2 + R25-Major-2: AI complete server-side proxy.
 *
 * <p>背景：浏览器直连 aster-api `/api/v1/ai/complete` 之前是匿名调用（依赖 caller
 * 提交的 X-Tenant-Id 自报身份）。任何人都能匿名烧 LLM token / 假冒任意 tenant。
 *
 * <p>本路由是 aster-cloud server-side proxy：
 *   1. NextAuth `auth()` 校验调用者已登录
 *   2. tenantId = session.user.id（详见 in-body comment 解释为什么不走 team activeTenantId）
 *   3. signInternalCallerHeaders(method, path) 生成 X-Internal-Caller + HMAC
 *   4. 转发到 aster-api，把 ASTER_PLAN_GATE_HMAC_KEY 签名头带过去
 *
 * <p>aster-api 端 InternalCallerFilter (R23-Critical-2) 拒绝任何未签名的请求。
 *
 * <p>对应浏览器端调用从直接 fetch(`policy.aster-lang.dev/api/v1/ai/complete`) 改为
 * fetch(`/api/llm/complete`)，由 Next.js server 转发。
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { signInternalCallerHeaders } from '@/lib/api-signing';
import { checkAiQuota, recordAiUsage } from '@/lib/ai-quota';
import { aiQuotaHttpStatus } from '@/lib/ai-quota-http';
import { resolveByokEnvelope, injectByokEnvelope } from '@/lib/byok-envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ASTER_API_BASE =
  process.env.ASTER_POLICY_API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL ||
  'https://policy.aster-lang.dev';

const UPSTREAM_PATH = '/api/v1/ai/complete';

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rawBody = await req.text();

  // BYOK 推理接入（Phase 2）：解析用户 active BYOK 凭证并注入 `_byok` envelope。以【实际是否注入】
  // 作为 usedByok 权威（body 非 JSON 时注入会失败，避免"以为用了 BYOK"的偏差，Codex 审查）。
  // 解密失败=密钥系统/配置问题 → fail-closed 503（不静默回退平台，防偷烧平台预算）。
  let byok;
  try {
    byok = await resolveByokEnvelope(session.user.id);
  } catch (e) {
    console.error(`[llm/complete] BYOK resolve failed for user=${session.user.id}:`, e);
    return NextResponse.json(
      { error: 'byok_unavailable', message: 'BYOK key decryption failed; try again later.' },
      { status: 503 }
    );
  }
  // issue #185：生成 requestId 关联本次调用——注入 `_usage` 传给 aster-api，aster-api 成功后
  // 带同一 requestId 回填真实 token，cloud upsert 同一笔 usage（不双记账）。
  const requestId = crypto.randomUUID();
  const { body, injected: usedByok } = injectByokEnvelope(rawBody, byok, requestId);

  // AI 配额前置门控（同 proxyLlmSse）：此前 complete 路径不检查配额，任何登录用户都能
  // 无限烧平台 LLM 预算。BYOK 用了用户 key → 跳过平台月配额，保留 ban/风险/邮箱/速率。
  const quota = await checkAiQuota(session.user.id, { usedByok });
  if (!quota.allowed) {
    const { status, headers } = aiQuotaHttpStatus(quota);
    return NextResponse.json(
      { error: quota.reason, message: quota.message },
      { status, headers }
    );
  }

  // R25-Major-2: 从 session 派生 tenantId —— caller-supplied X-Tenant-Id 不再被信任。
  //
  // 当前实现：固定使用 session.user.id。
  //
  // 已知局限（schema 限制）：aster-cloud schema 有 teams + teamMembers 但
  // **没有 users.activeTeamId 列**，因此 server 端无法知道用户当前选中了哪个
  // team。所有 AI 调用都按 user.id 归账，团队配额 / 计费需团队管理员手动协调。
  //
  // 修复路径（独立 PR）：
  //   1. db schema 加 users.activeTeamId（migration）
  //   2. 在 dashboard "switch team" UI 触发时更新 session
  //   3. 此处改成 session.user.activeTeamId ?? session.user.id
  //
  // 直到 schema 落地，"activeTenantId" 不存在；用 user.id 是诚实的回退，
  // **绝对不要**在没有 schema 支持的情况下读 `session.user.activeTenantId` ——
  // 那个字段不存在，会永远 undefined。
  const tenantId: string = session.user.id;

  // body 已在上方注入 envelope。必须在注入【之后】再签名——HMAC 覆盖含 envelope 的最终 body。
  let signedHeaders: Awaited<ReturnType<typeof signInternalCallerHeaders>>;
  try {
    // 红队 P0-C：绑定 body + tenant 进签名（防换 LLM model 烧预算 / 改租户）。
    // v3：本请求无 query、不发 X-User-Id / 业务角色，按空串签。
    signedHeaders = await signInternalCallerHeaders('POST', UPSTREAM_PATH, body, tenantId, '', {
      query: '',
      userId: '',
    });
  } catch {
    // ASTER_PLAN_GATE_HMAC_KEY 未配置 —— 生产应当配齐
    return NextResponse.json(
      {
        error: 'cloud_misconfigured',
        message: 'ASTER_PLAN_GATE_HMAC_KEY missing on cloud server',
      },
      { status: 503 }
    );
  }

  const upstreamResp = await fetch(`${ASTER_API_BASE}${UPSTREAM_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': tenantId,
      ...signedHeaders,
    },
    body,
  });

  const text = await upstreamResp.text();

  // 成功记账：checkAiQuota 的月配额/速率计数依赖 AiUsageRecord。对 2xx 调用记一笔 success，
  // 让配额随使用消耗。token 精确计量（aster-api 上报）留后续；这里 0/0 只驱动次数/速率门控。
  // Phase 3：usedByok 时带上 bindingId → recordAiUsage 内 stamp AiKeyBinding.lastUsedAt
  // （dashboard "最近使用" 真实反映 BYOK 推理用量）。
  if (upstreamResp.ok) {
    try {
      await recordAiUsage({
        userId: session.user.id,
        callKind: 'complete',
        model: 'unknown',
        promptTokens: 0,
        completionTokens: 0,
        usedByok,
        aiKeyBindingId: byok?.bindingId ?? null,
        requestId, // #185：占位一笔，aster-api 回填真实 token 到同一 requestId
        status: 'success',
      });
    } catch (e) {
      console.warn(`[llm/complete] recordAiUsage failed for user=${session.user.id}:`, e);
    }
  }

  return new NextResponse(text, {
    status: upstreamResp.status,
    headers: {
      'Content-Type':
        upstreamResp.headers.get('content-type') || 'application/json',
    },
  });
}
