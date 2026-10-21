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
 *   - tenantId 从已认证调用方取（NextAuth session 或 AI 工作台服务签名，见 llm-caller.ts），
 *     不信任 caller-supplied X-Tenant-Id
 *   - 上游若返回非 2xx，只透传 status + body（错误也得让前端看到）
 *
 * 已知局限：与 /complete 相同 —— 没有 activeTeamId schema，tenantId
 * 固定为调用方的 userId。team 用户在 UI 切换 team 时不会切租户配额。
 */
import { NextRequest, NextResponse } from 'next/server';
import { signInternalCallerHeaders } from '@/lib/api-signing';
import { checkAiQuota, markAiUsageFailed, recordAiUsage } from '@/lib/ai-quota';
import { runAfterResponse } from '@/lib/after-response';
import { aiQuotaHttpStatus } from '@/lib/ai-quota-http';
import { resolveByokEnvelope, injectByokEnvelope } from '@/lib/byok-envelope';
import { createSseBillableWatcher } from '@/lib/sse-frame';
import { isLlmCallerError, resolveLlmCaller } from '@/lib/llm-caller';

const ASTER_API_BASE =
  process.env.ASTER_POLICY_API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL ||
  'https://policy.aster-lang.dev';

export interface SseProxyOptions {
  /** 上游 path，例如 "/api/v1/ai/generate" */
  upstreamPath: string;
  /**
   * 调用方实际发送（并签名）的原始 body。路由若在转交前改写了 body（如 assistant 注入
   * adminInstructions），须把改写前的原文传进来，供 AI 工作台服务签名校验；缺省即 req 的 body。
   */
  callerBody?: string;
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
  { upstreamPath, callerBody }: SseProxyOptions
): Promise<Response> {
  // body 只读这一次：它既是转发给上游的内容，也是 AI 工作台服务签名覆盖的内容。
  const rawBody = await req.text();

  // 调用方：浏览器会话，或 AI 工作台以服务签名代表用户（ADR 0049 §2.2）。两者此后完全同路——
  // BYOK、配额、签名转发、记账都按解析出的 userId 进行。
  const caller = await resolveLlmCaller(req, callerBody ?? rawBody);
  if (isLlmCallerError(caller)) {
    return NextResponse.json({ error: caller.error }, { status: caller.status });
  }
  const userId = caller.userId;

  // 同 /api/llm/complete：tenantId 强行从已认证的调用方派生，不读 body 也不读 X-Tenant-Id。
  // 详见 src/app/api/llm/complete/route.ts 顶部注释里的 schema 局限说明。
  const tenantId: string = userId;

  // BYOK 推理接入（Phase 2）：解析用户 active BYOK 凭证并注入 `_byok` envelope，以【实际是否注入】
  // 作为 usedByok 权威。注入后再签名（HMAC 覆盖最终 body）。解密失败 → fail-closed 503。
  let byok;
  try {
    byok = await resolveByokEnvelope(userId);
  } catch (e) {
    console.error(`[llm-sse-proxy] BYOK resolve failed for user=${userId}:`, e);
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
  const quota = await checkAiQuota(userId, { usedByok });
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
    // v3：本请求无 query、不发 X-User-Id / 业务角色，按空串签。
    signedHeaders = await signInternalCallerHeaders('POST', upstreamPath, body, tenantId, '', {
      query: '',
      userId: '',
    });
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
  // ★记账规则：请求到达了第三方 AI 就计一笔（#470），判定见 sse-frame.ts 的 isBillableEvent。
  //   - aster-api 连上 provider 时先发 upstream_reached 帧：此后 provider 报错、超时、
  //     没有内容、用户中途断开，都计费——请求已经到达第三方。
  //   - 在它之前就结束的不计：安全拒答、未配置 key、BYOK 无效、连不上 provider——
  //     aster-api 在 HTTP 200 下用单条 error 帧报告这些，第一个字节就是这条 error。
  //   - 也不是上游 2xx 响应头一到就记（issue #441）：2xx 只说明 aster-api 接受了请求，
  //     还没到 provider。
  //
  // ★记账状态：先在第一个计费帧处插一笔 success 占位（与此前一致，保证并发流也立刻计入配额/速率门，
  //   防止「19/20 时并发开几十条长流全部过门」）；流结束后若计费之后出现过 error 帧（provider 报错 /
  //   拒绝模型 / 中途失败），再按 requestId 定向 UPDATE 为 api_error。api_error 同样计入配额
  //   （见 ai-quota.ts BILLABLE_STATUSES），只是在用量记录里如实呈现为失败。
  //
  //   为什么改状态用定向 UPDATE 而不是再 upsert：recordAiUsage 的 upsert 刻意保留首次 status（#185
  //   回填契约），而 aster-api 的 token 回填恒为 success、且可能先于 error 帧到达（「LLM 未生成内容」
  //   就是先上报 usage 再发 error 帧）——upsert 改不动，只能 UPDATE。
  //   真实 token 由 aster-api 按同一 requestId 回填。
  const billableWatcher = createSseBillableWatcher();
  const callKind = upstreamPath.endsWith('/suggest') ? 'suggest' : 'generate';
  const recordPlaceholderOnce = createOnceRecorder(async () => {
    try {
      await recordAiUsage({
        userId,
        callKind,
        // ADR 0048：meta 帧回传的实际 model；旧版 api 不发 meta → 'unknown'。
        model: billableWatcher.model() ?? 'unknown',
        promptTokens: 0,
        completionTokens: 0,
        usedByok,
        // Phase 3：usedByok 时带 bindingId → stamp AiKeyBinding.lastUsedAt（dashboard 真实用量）。
        aiKeyBindingId: byok?.bindingId ?? null,
        requestId, // #185：占位一笔，aster-api SSE usage 回填真实 token 到同一 requestId
        status: 'success',
      });
    } catch (e) {
      console.warn(`[llm-sse-proxy] recordAiUsage failed for user=${userId}:`, e);
    }
  });
  // 占位插入的 Promise：首个计费帧时发起（不阻塞流），由下面的 after 任务等待其落库。
  let placeholder: Promise<void> | null = null;
  const startPlaceholder = () => {
    placeholder ??= recordPlaceholderOnce();
  };

  // 流的终点（正常结束 / 客户端断开或上游出错 / 请求中止）：多个终点可能先后触发，只结算一次。
  let markStreamEnded!: () => void;
  const streamEnded = new Promise<void>((resolve) => {
    markStreamEnded = resolve;
  });
  // 兜底：部分运行时在客户端断开时不回调 transformer.cancel；请求 signal 中止同样标记流结束，
  // 否则下面的 after 任务会一直等下去。
  req.signal?.addEventListener('abort', () => markStreamEnded(), { once: true });

  // 结算在请求作用域内交给 after()（runAfterResponse）：Cloudflare Workers 会等它跑完再回收，
  // 占位插入与状态更新都不会因响应结束而被截断。
  runAfterResponse(async () => {
    await streamEnded;
    // 最后一帧可能没有空行收尾：此时才见到的计费帧同样补记占位。
    if (billableWatcher.finish()) startPlaceholder();
    if (!placeholder) return;
    await placeholder;
    if (billableWatcher.failed()) await markAiUsageFailed(requestId);
  });

  // 透传流并在旁边解析帧；字节原样转发、不延迟。
  // cancel 是 Streams 规范的 Transformer 钩子（Node ≥ 22 支持），TS lib 尚未声明，故用交叉类型补上。
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel: () => void } = {
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (billableWatcher.push(chunk)) startPlaceholder();
    },
    flush: () => markStreamEnded(),
    // 客户端中途断开（或上游流出错）：已到达 provider 的调用照样计费。
    cancel: () => markStreamEnded(),
  };
  const metered = upstreamResp.body.pipeThrough(new TransformStream(transformer));

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
