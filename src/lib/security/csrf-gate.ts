import { NextResponse } from 'next/server';
import { checkCsrf } from '@/lib/security/csrf';

/**
 * 集中式 CSRF 网关（审计 #168），供 middleware 在 /api 变更请求上调用。
 *
 * 抽成独立纯函数（不依赖 next-intl / lexicon-availability），使其可在 vitest 中直接单测——
 * 完整 middleware 因 next-intl 的 next/server 解析在测试环境难以加载（与 fetchAvailable 抽离
 * 的动机一致，保持 middleware 薄）。
 *
 * 语义：仅对 /api 下的**变更方法**（非 GET/HEAD/OPTIONS）、**非豁免前缀**的请求跑 checkCsrf；
 * checkCsrf 自身放行 Bearer-token（v1 API-key / cron CRON_SECRET）作深度防御。返回 403
 * NextResponse 表示拒绝，null 表示放行（middleware 继续）。
 */

/**
 * CSRF 豁免前缀——这些路径**不是** cookie-session 认证或自带 CSRF/签名防护，
 * 浏览器 Origin/Referer 校验会误伤（S2S 无 Origin）：
 *   - /api/auth        NextAuth 自带 CSRF；pre-auth 路由（forgot/reset/verify）无 session
 *   - /api/internal    全 HMAC（ASTER_PLAN_GATE_HMAC_KEY），S2S，无 Origin
 *   - /api/cron        requireCronAuth 的 Bearer CRON_SECRET，S2S
 *   - /api/stripe/webhook  Stripe 签名（非 checkout/portal——那俩 cookie-auth 需 CSRF）
 *   - /api/v1/telemetry, /api/v1/dsar  per-license HMAC（x-aster-signature，无 Bearer/Origin）
 *   - /api/csp-report, /api/playground, /api/renew  公开/匿名/URL-token，无 cookie session
 *
 * ★不整体豁免 /api/v1——大部分 v1（domain-vocabularies、policy versions）是
 *   cookie-session、**需要** CSRF；仅 /api/v1/policies(root POST) + /api/v1/policies/[id]/execute
 *   走 Bearer，由 checkCsrf 内置 Bearer 豁免透明放行，无需列前缀。
 */
export const CSRF_EXEMPT_PREFIXES: readonly string[] = [
  '/api/auth',
  '/api/internal',
  '/api/cron',
  '/api/stripe/webhook',
  '/api/v1/telemetry',
  '/api/v1/dsar',
  '/api/csp-report',
  '/api/playground',
  '/api/renew',
];

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * AI 工作台服务以签名代表用户调用 /api/llm/*（ADR 0049 §2.2）：S2S、无 Origin，需绕开 Origin 校验。
 *
 * <p>只看头、不验签——验签在路由里（src/lib/llm-caller.ts），带了这个头却验签失败一律 401、
 * 不回落 cookie 会话，所以伪造这个头拿不到任何会话权限。浏览器跨站也设不了自定义头：
 * 自定义头会触发 CORS 预检，而 cloud 从不对其放行。
 * ★此处不读 env、不 import llm-caller（middleware import 链须保持轻量且无 process.env）。
 * 取值须与 llm-caller.ts 的 AI_WORKSPACE_CALLER 一致。
 */
function isAiWorkspaceLlmCall(request: Request, pathname: string): boolean {
  return pathname.startsWith('/api/llm/')
    && request.headers.get('x-internal-caller') === 'ai-workspace';
}

/** 精确前缀匹配：等于该前缀，或以「前缀 + /」开头（避免 /api/authz 命中 /api/auth）。 */
export function isCsrfExempt(pathname: string): boolean {
  return CSRF_EXEMPT_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );
}

/**
 * 对一个 /api 请求应用 CSRF 网关。
 * @returns 403 NextResponse（拒绝）或 null（放行，middleware 继续）。
 */
export function applyCsrfGate(request: Request): NextResponse | null {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith('/api/')) return null;
  if (CSRF_SAFE_METHODS.has(request.method.toUpperCase())) return null;
  if (isCsrfExempt(pathname)) return null;
  if (isAiWorkspaceLlmCall(request, pathname)) return null;

  const csrf = checkCsrf(request);
  if (csrf.allowed) return null;
  return NextResponse.json(
    { error: { code: 'csrf_forbidden', message: 'CSRF check failed', reason: csrf.reason } },
    { status: 403 },
  );
}
