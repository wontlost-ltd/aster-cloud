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
import { AI_WORKSPACE_CALLER } from '@/lib/llm-caller';
import { NO_RESULTS_UI_NOTE, retrieveServerGrounding } from '@/lib/assistant/server-grounding';
import { safeEnv } from '@/lib/runtime/safe-env';

/**
 * 给工作台的站内链接要指向对外公开的站点：取配置的 NEXT_PUBLIC_APP_URL（生产必填），
 * 不跟随请求 Host——工作台若经 workers.dev 或内部路由调用，链接也不能指向那些地址。
 * 只有未配置（本地开发）或配置非法时才退回请求来源。
 */
function publicOrigin(requestOrigin: string): string {
  const configured = safeEnv('NEXT_PUBLIC_APP_URL');
  if (!configured) return requestOrigin;
  try {
    return new URL(configured).origin;
  } catch {
    return requestOrigin;
  }
}

/** 合并管理员指令与调用方说明，总长不超过 aster-api 的上限（超限会被 400 拒绝）。 */
function composeInstructions(admin: string, note: string | null): string | null {
  if (!note) return admin.length > 0 ? admin : null;
  const room = ASSISTANT_INSTRUCTIONS_MAX_LEN - note.length - 2;
  const head = admin.slice(0, Math.max(0, room));
  return head.length > 0 ? `${head}\n\n${note}` : note;
}

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
  const fields = body as Record<string, unknown>;
  // 仅凭请求头判断调用方界面形态：签名由下游 proxyLlmSse 校验，伪造头的请求在那里被 401，
  // 这里的判断只影响措辞与链接形式，不涉及身份。
  const fromWorkspace = req.headers.get('x-internal-caller') === AI_WORKSPACE_CALLER;
  const hasHits = Array.isArray(fields.groundingHits) && fields.groundingHits.length > 0;
  const groundingHits =
    !hasHits && typeof fields.query === 'string' && fields.query.trim()
      ? retrieveServerGrounding(fields.query, fields.locale, {
          absoluteOrigin: fromWorkspace ? publicOrigin(req.nextUrl.origin) : undefined,
        })
      : fields.groundingHits;
  const patched = {
    ...fields,
    ...(groundingHits !== undefined ? { groundingHits } : {}),
    adminInstructions: composeInstructions(instructions, fromWorkspace ? NO_RESULTS_UI_NOTE : null),
    // 工作台界面没有「答案下方的搜索结果」列表：让 aster-api 从系统提示中去掉引导查看搜索结果的那句。
    // 浏览器调用方由服务端决定（不发此字段，aster-api 默认 true），不采信客户端自带的值；
    // 旧版 aster-api 忽略未知字段，可先于其发布。
    resultsUi: fromWorkspace ? false : undefined,
  };

  // 用改写后的 body 构造新请求交给共享代理（它会再叠加 BYOK envelope）。
  const forwarded = new NextRequest(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(patched),
  });
  return proxyLlmSse(forwarded, { upstreamPath: '/api/v1/ai/assistant', callerBody: rawBody });
}
