/**
 * SSE 代理：浏览器 → aster-api `/api/v1/ai/assistant`（站内助手 RAG 问答）。
 *
 * <p>与 suggest/generate 走同一个 {@link proxyLlmSse}——auth、配额校验、
 * BYOK 透传都在那里，**不要**为助手另开裸通路。
 *
 * <p>本路由额外做两件平台设置相关的事（见 lib/platform-settings.ts）：
 * <ul>
 *   <li><b>总开关</b>：`assistant.enabled` 关闭时直接 503，浏览器端降级为
 *       纯站内检索。出问题时能立刻止血而不必回滚发版。</li>
 *   <li><b>附加指令</b>：把 `assistant.extra_instructions` 注入请求体的
 *       `adminInstructions` 字段。★服务端注入、并**覆盖**客户端同名字段——
 *       否则任何人都能自带一段指令冒充管理员配置。</li>
 * </ul>
 */
import { NextRequest } from 'next/server';
import { proxyLlmSse } from '@/lib/llm-sse-proxy';
import {
  PLATFORM_SETTING_KEYS,
  ASSISTANT_INSTRUCTIONS_MAX_LEN,
  getSetting,
} from '@/lib/platform-settings';
import { errorEnvelope } from '@/lib/api/error-envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<Response> {
  const enabled = await getSetting(PLATFORM_SETTING_KEYS.ASSISTANT_ENABLED);
  if (enabled === false) {
    // 503 而非 403：这是"服务被管理员临时关闭"，不是权限问题。
    // 浏览器端把非 2xx 一律当降级信号，会保留检索结果并提示。
    return errorEnvelope({
      code: 'ASSISTANT_DISABLED',
      message: '站内助手已被管理员关闭',
      status: 503,
    });
  }

  const extra = await getSetting(PLATFORM_SETTING_KEYS.ASSISTANT_EXTRA_INSTRUCTIONS);
  const instructions =
    typeof extra === 'string' ? extra.trim().slice(0, ASSISTANT_INSTRUCTIONS_MAX_LEN) : '';

  // 重写请求体：始终显式写 adminInstructions（有值则注入，无值则置 null），
  // ★绝不保留客户端传来的同名字段——否则等于给所有人开了个 prompt 注入口。
  // 原文留着：AI 工作台的服务签名覆盖的是改写前的 body，代理要按它验签。
  const rawBody = await req.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorEnvelope({ code: 'INVALID_JSON', message: '请求体不是合法 JSON', status: 400 });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return errorEnvelope({ code: 'INVALID_JSON', message: '请求体必须是 JSON 对象', status: 400 });
  }
  const patched = {
    ...(body as Record<string, unknown>),
    adminInstructions: instructions.length > 0 ? instructions : null,
  };

  // 用改写后的 body 构造新请求交给共享代理（它会再叠加 BYOK envelope）。
  const forwarded = new NextRequest(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(patched),
  });
  return proxyLlmSse(forwarded, { upstreamPath: '/api/v1/ai/assistant', callerBody: rawBody });
}
