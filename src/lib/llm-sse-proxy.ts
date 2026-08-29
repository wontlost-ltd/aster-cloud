/**
 * SSE 流式代理：浏览器 → aster-cloud Route Handler → aster-api。
 *
 * 背景：R23-Critical-2 把 aster-api 的 /api/v1/ai/* 全部加了 HMAC 鉴权。
 * /complete 已通过 src/app/api/llm/complete/route.ts 转签代理走通；
 * /generate /explain /suggest 三个 SSE 端点之前一直是浏览器直连，
 * R23 上线后就回 403。本模块是 SSE 版的等价物。
 *
 * 关键点：
 *   - SSE 必须保持 chunked transfer，绝不能 await resp.text()
 *   - 用 fetch 默认的 ReadableStream + NextResponse 直接转发 body
 *   - tenantId 从 NextAuth session 取，不信任 caller-supplied X-Tenant-Id
 *   - 上游若返回非 2xx，只透传 status + body（错误也得让前端看到）
 *
 * 已知局限：与 /complete 相同 —— 没有 activeTeamId schema，tenantId
 * 固定为 session.user.id。team 用户在 UI 切换 team 时不会切租户配额。
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { signInternalCallerHeaders } from '@/lib/api-signing';
import { checkAiQuota, recordAiUsage } from '@/lib/ai-quota';
import { aiQuotaHttpStatus } from '@/lib/ai-quota-http';
import { resolveByokEnvelope, injectByokEnvelope } from '@/lib/byok-envelope';

const ASTER_API_BASE =
  process.env.ASTER_POLICY_API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL ||
  'https://policy.aster-lang.dev';

export interface SseProxyOptions {
  /** 上游 path，例如 "/api/v1/ai/generate" */
  upstreamPath: string;
}

/**
 * 把一个副作用包成「至多执行一次」。
 *
 * <p>★必需，因为 TransformStream 的 transform 对**每个 chunk** 都会调用——
 * 而一次 SSE 回答有成百上千个 chunk，不去重会把一次调用记成上千笔用量，
 * 比原来的「乐观多记一笔」严重得多。
 *
 * <p>用同步置位的布尔而非 Promise 判空：transform 之间可能没有 await 间隙，
 * 若等异步结果回来再置位，前几个 chunk 会同时通过检查。
 */
function createOnceRecorder(fn: () => Promise<void>): () => Promise<void> {
  let started = false;
  return async () => {
    if (started) return;
    started = true;   // 同步置位，杜绝并发 chunk 重复触发
    await fn();
  };
}

export async function proxyLlmSse(
  req: NextRequest,
  { upstreamPath }: SseProxyOptions
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 同 /api/llm/complete：tenantId 强行从 session 派生，不读 body 也不读 header。
  // 详见 src/app/api/llm/complete/route.ts 顶部注释里的 schema 局限说明。
  const tenantId: string = session.user.id;

  const rawBody = await req.text();

  // BYOK 推理接入（Phase 2）：解析用户 active BYOK 凭证并注入 `_byok` envelope，以【实际是否注入】
  // 作为 usedByok 权威。注入后再签名（HMAC 覆盖最终 body）。解密失败 → fail-closed 503。
  let byok;
  try {
    byok = await resolveByokEnvelope(session.user.id);
  } catch (e) {
    console.error(`[llm-sse-proxy] BYOK resolve failed for user=${session.user.id}:`, e);
    return NextResponse.json(
      { error: 'byok_unavailable', message: 'BYOK key decryption failed; try again later.' },
      { status: 503 }
    );
  }
  // issue #185：生成 requestId 关联本次调用（SSE 也回填真实 token，含 repair 多 attempt 累加）。
  const requestId = crypto.randomUUID();
  const { body, injected: usedByok } = injectByokEnvelope(rawBody, byok, requestId);

  // AI 配额前置门控。此前 LLM 代理路径【完全不检查配额】—— checkAiQuota 是死代码
  // （只有 /api/internal/ai/quota route 调它，而无人 fetch 该 route），导致任何登录用户
  // 都能无限烧平台 LLM 预算。BYOK 用本次用了用户 key → 跳过平台月配额，保留 ban/风险/邮箱/速率。
  const quota = await checkAiQuota(session.user.id, { usedByok });
  if (!quota.allowed) {
    const { status, headers } = aiQuotaHttpStatus(quota);
    return NextResponse.json(
      { error: quota.reason, message: quota.message },
      { status, headers }
    );
  }

  let signedHeaders: Awaited<ReturnType<typeof signInternalCallerHeaders>>;
  try {
    // 红队 P0-C：绑定 body + tenant 进签名。
    signedHeaders = await signInternalCallerHeaders('POST', upstreamPath, body, tenantId, '');
  } catch {
    return NextResponse.json(
      {
        error: 'cloud_misconfigured',
        message: 'ASTER_PLAN_GATE_HMAC_KEY missing on cloud server',
      },
      { status: 503 }
    );
  }

  const upstreamResp = await fetch(`${ASTER_API_BASE}${upstreamPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Tenant-Id': tenantId,
      ...signedHeaders,
    },
    body,
    // Cloudflare Workers + OpenNext：fetch 默认会 stream，无需特殊 cache opt
  });

  // 上游错了就把错误透传，让前端 SSE 客户端能拿到 status code 决定下一步。
  // 注意：错误响应是 JSON / text，不是 SSE，所以走非流式路径。
  if (!upstreamResp.ok) {
    const errText = await upstreamResp.text();
    return new NextResponse(errText, {
      status: upstreamResp.status,
      headers: {
        'Content-Type':
          upstreamResp.headers.get('content-type') || 'application/json',
      },
    });
  }

  // 成功路径：直接转发 ReadableStream，保持 SSE 帧不解包。
  if (!upstreamResp.body) {
    return NextResponse.json(
      { error: 'upstream_no_body', message: 'Upstream returned 2xx but empty body' },
      { status: 502 }
    );
  }

  // 成功记账：驱动 checkAiQuota 的月配额与速率计数（否则计数永不递增、配额门虚设）。
  // callKind 从 upstreamPath 末段派生（/api/v1/ai/generate → generate）。
  //
  // ★记账时机改为「流真正产出第一个字节之后」，而不是上游 2xx 响应头一到就记（issue #441）。
  //   此前是后者——但 2xx 只说明**上游接受了请求**，流尚未转发也未产出任何内容。
  //   用户秒取消、或流建立后中途网络错误，都会让一次**零产出**的调用计入成功配额。
  //
  //   为什么不是「记完再按结果撤销」：recordAiUsage 的 upsert 刻意保留首次 status
  //   （见 ai-quota.ts 的 onConflictDoUpdate——createdAt/status 不被占位/回填改写），
  //   那是 #185 回填契约的一部分。所以无法事后把 success 改成 error，
  //   只能把「记」这个动作推迟到确实有产出之后。
  //
  //   仍然是**乐观**的（首字节 ≠ 完整回答），但把「零产出也计费」这一类整体消除了。
  //   token 精确计量与按真实完成计费仍在 Phase 3（aster-api 成功路径回填同一 requestId）。
  const callKind = upstreamPath.endsWith('/suggest') ? 'suggest' : 'generate';
  const recordUsageOnce = createOnceRecorder(async () => {
    try {
      await recordAiUsage({
        userId: session.user.id,
        callKind,
        model: 'unknown',
        promptTokens: 0,
        completionTokens: 0,
        usedByok,
        // Phase 3：usedByok 时带 bindingId → stamp AiKeyBinding.lastUsedAt（dashboard 真实用量）。
        aiKeyBindingId: byok?.bindingId ?? null,
        requestId, // #185：占位一笔，aster-api SSE usage 回填真实 token 到同一 requestId
        status: 'success',
      });
    } catch (e) {
      console.warn(`[llm-sse-proxy] recordAiUsage failed for user=${session.user.id}:`, e);
    }
  });

  // 透传流并在**第一个 chunk** 到达时记账。不缓冲、不改内容——只在中间插一个观察点。
  const metered = upstreamResp.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // 记账是 fire-and-forget：绝不能让计费 IO 阻塞或中断用户的流。
        void recordUsageOnce();
        controller.enqueue(chunk);
      },
    })
  );

  return new NextResponse(metered, {
    status: upstreamResp.status,
    headers: {
      'Content-Type':
        upstreamResp.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // SSE 反向代理必备：禁止中间层缓冲（Cloudflare / Nginx）
      'X-Accel-Buffering': 'no',
    },
  });
}
