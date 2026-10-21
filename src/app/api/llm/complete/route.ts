/**
 * R23-Critical-2 + R25-Major-2: AI complete server-side proxy.
 *
 * <p>背景：浏览器直连 aster-api `/api/v1/ai/complete` 之前是匿名调用（依赖 caller
 * 提交的 X-Tenant-Id 自报身份）。任何人都能匿名烧 LLM token / 假冒任意 tenant。
 *
 * <p>本路由是 aster-cloud server-side proxy：
 *   1. resolveLlmCaller 校验调用方：NextAuth 会话，或 AI 工作台服务签名（ADR 0049）
 *   2. tenantId = 调用方 userId（详见 in-body comment 解释为什么不走 team activeTenantId）
 *   3. signInternalCallerHeaders(method, path) 生成 X-Internal-Caller + HMAC
 *   4. 转发到 aster-api，把 ASTER_PLAN_GATE_HMAC_KEY 签名头带过去
 *
 * <p>aster-api 端 InternalCallerFilter (R23-Critical-2) 拒绝任何未签名的请求。
 *
 * <p>对应浏览器端调用从直接 fetch(`policy.aster-lang.dev/api/v1/ai/complete`) 改为
 * fetch(`/api/llm/complete`)，由 Next.js server 转发。
 */
import { NextRequest, NextResponse } from 'next/server';
import { signInternalCallerHeaders } from '@/lib/api-signing';
import { checkAiQuota, recordAiUsage } from '@/lib/ai-quota';
import { aiQuotaHttpStatus } from '@/lib/ai-quota-http';
import { resolveByokEnvelope, injectByokEnvelope } from '@/lib/byok-envelope';
import { isLlmCallerError, resolveLlmCaller } from '@/lib/llm-caller';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ASTER_API_BASE =
  process.env.ASTER_POLICY_API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL ||
  'https://policy.aster-lang.dev';

const UPSTREAM_PATH = '/api/v1/ai/complete';

export async function POST(req: NextRequest) {
  // body 只读这一次：既用于转发，也是 AI 工作台服务签名覆盖的内容。
  const rawBody = await req.text();

  // 调用方：浏览器会话，或 AI 工作台以服务签名代表用户（ADR 0049 §2.2，见 llm-caller.ts）。
  const caller = await resolveLlmCaller(req, rawBody);
  if (isLlmCallerError(caller)) {
    return NextResponse.json({ error: caller.error }, { status: caller.status });
  }
  const userId = caller.userId;

  // BYOK 推理接入（Phase 2）：解析用户 active BYOK 凭证并注入 `_byok` envelope。以【实际是否注入】
  // 作为 usedByok 权威（body 非 JSON 时注入会失败，避免"以为用了 BYOK"的偏差，Codex 审查）。
  // 解密失败=密钥系统/配置问题 → fail-closed 503（不静默回退平台，防偷烧平台预算）。
  let byok;
  try {
    byok = await resolveByokEnvelope(userId);
  } catch (e) {
    console.error(`[llm/complete] BYOK resolve failed for user=${userId}:`, e);
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
  const quota = await checkAiQuota(userId, { usedByok });
  if (!quota.allowed) {
    const { status, headers } = aiQuotaHttpStatus(quota);
    return NextResponse.json(
      { error: quota.reason, message: quota.message },
      { status, headers }
    );
  }

  // R25-Major-2: 从已认证调用方（会话或 AI 工作台服务签名）派生 tenantId —— caller-supplied X-Tenant-Id 不再被信任。
  //
  // 当前实现：固定使用调用方 userId。
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
  const tenantId: string = userId;

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

  // 记账：checkAiQuota 的月配额/速率计数依赖 AiUsageRecord。请求到达了第三方 AI 才记一笔
  // （#470 / #518）：aster-api 在 2xx 下用 upstreamReached=false 报告未配置 key、连不上 provider
  // 时返回的空补全，这些不计费；provider 报错、超时等已到达的失败照样计费。
  // token 精确计量由 aster-api 按同一 requestId 回填；这里 0/0 只驱动次数/速率门控。
  // Phase 3：usedByok 时带上 bindingId → recordAiUsage 内 stamp AiKeyBinding.lastUsedAt
  // （dashboard "最近使用" 真实反映 BYOK 推理用量）。
  //
  // 失败但已到达 provider：aster-api 对 provider 4xx 回 400 provider_auth_failed /
  // provider_rejected_model / provider_bad_request（旧版把任意 400 标成 provider_rejected_model）。
  // 发出的 model 取 byok.model（未指定则 unknown）。这类调用同样计费，
  // 记 api_error 以便在用量里如实呈现失败；其余非 2xx 未到达 provider，不记。
  const outcome = usageOutcome(upstreamResp, text, byok?.model ?? null);
  if (outcome) {
    try {
      await recordAiUsage({
        userId,
        callKind: 'complete',
        model: outcome.model,
        promptTokens: 0,
        completionTokens: 0,
        usedByok,
        aiKeyBindingId: byok?.bindingId ?? null,
        requestId, // #185：占位一笔，aster-api 回填真实 token 到同一 requestId
        status: outcome.status,
      });
    } catch (e) {
      console.warn(`[llm/complete] recordAiUsage failed for user=${userId}:`, e);
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

/**
 * 本次补全要不要记账、记什么状态；null = 未到达 provider，不记。
 * 2xx：按 upstreamReached 判断（success）；400 + provider_* 码：已到达 provider（api_error）。
 */
function usageOutcome(
  resp: Response,
  responseText: string,
  byokModel: string | null,
): { status: 'success' | 'api_error'; model: string } | null {
  if (resp.ok) {
    return reachedUpstream(responseText) ? { status: 'success', model: responseModel(responseText) } : null;
  }
  if (resp.status === 400 && PROVIDER_CLIENT_ERROR_CODES.has(errorCode(responseText) ?? '')) {
    return { status: 'api_error', model: byokModel ?? 'unknown' };
  }
  return null;
}

/** provider 4xx 客户端错误码（鉴权失败 / 拒绝模型 / 其他请求错误）：请求都已到达 provider。 */
const PROVIDER_CLIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'provider_auth_failed',
  'provider_rejected_model',
  'provider_bad_request',
]);

/** aster-api 错误体里的机器可读 error 码；非 JSON / 无该字段 → null。 */
function errorCode(responseText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(responseText);
    const e = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
    return typeof e === 'string' ? e : null;
  } catch {
    return null;
  }
}

/**
 * aster-api 的补全响应是否表示请求已到达第三方 AI。
 *
 * <p>只有明确的 `upstreamReached: false` 才算没到达；字段缺省（尚未发出该字段的旧版 aster-api）
 * 或响应不是 JSON 时按已到达处理，保持原有计费口径，两仓可任意顺序部署。
 */
function reachedUpstream(responseText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(responseText);
    return !(typeof parsed === 'object' && parsed !== null
      && (parsed as { upstreamReached?: unknown }).upstreamReached === false);
  } catch {
    return true;
  }
}

/** aster-api 响应里的实际发出 model（ADR 0048）；旧版/非 JSON → 'unknown'。 */
function responseModel(responseText: string): string {
  try {
    const parsed: unknown = JSON.parse(responseText);
    const m = typeof parsed === 'object' && parsed !== null ? (parsed as { model?: unknown }).model : undefined;
    return typeof m === 'string' && m ? m : 'unknown';
  } catch {
    return 'unknown';
  }
}
