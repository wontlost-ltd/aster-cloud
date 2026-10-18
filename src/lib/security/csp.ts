import { safeEnv } from '@/lib/runtime/safe-env';

/**
 * Content Security Policy + adjacent security headers.
 *
 * Phase 3D-1 / 3D-4 hardening — target: securityheaders.com A+.
 *
 * Strategy:
 *   - **CSP nonce-based** for inline scripts/styles (Next.js requires inline runtime)
 *   - **strict-dynamic** lets script-src trust transitively loaded scripts
 *   - **frame-ancestors 'none'** prevents clickjacking
 *   - **report-uri** off until Phase 3E observability lands (avoid noise)
 *
 * Dev / prod differences:
 *   - Dev: 'unsafe-eval' allowed for Next.js HMR
 *   - Prod: strict; no eval
 */

const STRIPE_DOMAINS = [
  'https://js.stripe.com',
  'https://api.stripe.com',
  'https://hooks.stripe.com',
];

const MIXPANEL_DOMAINS = [
  'https://api-js.mixpanel.com',
  'https://api.mixpanel.com',
];

// Cloudflare Turnstile（登录页 CAPTCHA，src/components/turnstile.tsx）。客户端
// 动态注入 challenges.cloudflare.com/turnstile/v0/api.js 脚本，widget 渲染在
// 该域的 iframe 里（Codex 审查 #133 时发现的既有缺口，#100）。
//   - frame-src：**必需** —— 父页面加载 Turnstile iframe，原 frame-src 缺该域
//     直接挡死 widget。
//   - script-src：CSP2 / 无 strict-dynamic 浏览器的**兼容 fallback** —— 本策略
//     script-src 含 'strict-dynamic'，CSP3 浏览器会忽略 host allowlist，由 nonce'd
//     Next.js chunk 经传播信任加载注入的 api.js；列白此域只为旧浏览器兜底，也对齐
//     Cloudflare 官方 CSP 配置示例。
// siteverify（src/lib/turnstile.ts）是服务端调用，不经浏览器，故不需 connect-src
//（connect-src 仅 pre-clearance 模式要求含 'self'，本策略已有）。
const TURNSTILE_DOMAINS = [
  'https://challenges.cloudflare.com',
];

// AI Guardian 演示：落地页与 /demos/guardian 以 iframe 嵌入 aster-lang.dev 的剧情（仅 SaaS 渲染）。
// 来源取自与嵌入组件相同的 NEXT_PUBLIC_GUARDIAN_EMBED_URL，本地验证指向本地 aster-dev 时无需改代码。
export const GUARDIAN_EMBED_ORIGIN = new URL(
  process.env.NEXT_PUBLIC_GUARDIAN_EMBED_URL || 'https://aster-lang.dev/embed/guardian',
).origin;

// aster-api 直连域名（AI generate/explain/complete SSE + lexicons stream
// 走客户端 fetch，不经 Next.js server proxy，所以必须在 connect-src 列白）。
//
// On-prem 部署通过 NEXT_PUBLIC_ASTER_POLICY_API_URL 把 aster-api 指向
// 客户内网（e.g. https://policy.internal.example.com 或
// http://localhost:58080 for local dry-run）。CSP allow-list 也必须跟着
// 走，否则浏览器拦掉 fetch — 这是 May 2026 E2E 暴露的 bug 之一。
//
// 数据流：next.config.ts 没有镜像这个 env 到 NEXT_PUBLIC_*（已经是公开
// 前缀的不需要镜像）；server-side CSP 通过 safeEnv 读取 —— middleware import
// 链跨 Node / CF Workers / Edge，裸 process.env 在无 process 全局的 runtime
// 模块加载时即 ReferenceError（codex round 9 发现的盲点）。
function computeAsterApiDomains(): string[] {
  const configured = safeEnv('NEXT_PUBLIC_ASTER_POLICY_API_URL');
  if (!configured) return ['https://policy.aster-lang.dev'];
  try {
    const u = new URL(configured);
    // CSP 只接受 scheme://host[:port]，剥掉 path / trailing slash
    return [`${u.protocol}//${u.host}`];
  } catch {
    // 配置不是合法 URL — 退回默认避免在 boot 时炸；运维会在浏览器看到
    // CORS / connect-src 报错很快意识到。
    return ['https://policy.aster-lang.dev'];
  }
}
const ASTER_API_DOMAINS = computeAsterApiDomains();

// Monaco Editor 默认从 jsDelivr 加载 worker/loader/main bundle 和 sourcemap
// （@monaco-editor/react 的运行时行为）。需要在 script/style/connect 三处都列白。
const MONACO_CDN_DOMAINS = [
  'https://cdn.jsdelivr.net',
];

// img-src 的远程图源允许清单（#98）。全站实际渲染的图片只有自托管 SVG
// （/public/*.svg、/app/*.svg，由 'self' 覆盖）。唯一的远程图源是 OAuth
// 头像 URL：GitHub/Google 登录回调把头像写进 users.image（src/auth.ts、
// src/db/adapter.ts），经 session.user.image 与 team-members API
// （route.ts:70）流转。当前 UI 尚未用 <img> 渲染它们，但 profile / 团队
// 成员列表迟早会渲染——预先列白让该特性上线时无需再改 CSP，且不放开整个
// https: 通配。Gravatar / 营销 CDN / docs 截图等均未使用，故不列入。
const AVATAR_IMAGE_DOMAINS = [
  'https://avatars.githubusercontent.com', // GitHub OAuth 头像
  'https://lh3.googleusercontent.com',     // Google OAuth 头像
];

// WebSocket origins the app legitimately connects to (connect-src). Previously
// connect-src allowed bare `wss:` — i.e. ANY wss host — which defeats the point
// of the allowlist (exfil to attacker-controlled WS). Scope to:
//   - the standalone LSP proxy:  NEXT_PUBLIC_LSP_HOST  (src/hooks/useAsterLSP.ts)
//   - the policy preview socket: NEXT_PUBLIC_ASTER_POLICY_WS_URL (src/services/policy/policy-api.ts)
// Both are read from env (so on-prem deployments that point these at customer
// infra get the matching CSP entry); fall back to the known production hosts.
//
// Same module-load-time constraint as ASTER_API_DOMAINS: read via safeEnv so the
// middleware import chain doesn't ReferenceError on no-process runtimes.
function normalizeWsOrigin(raw: string): string | null {
  // Accept either a bare host (`lsp.aster-lang.dev`) or a full ws(s)/http(s) URL.
  const value = raw.trim();
  if (!value) return null;
  if (/^wss?:\/\//.test(value) || /^https?:\/\//.test(value)) {
    try {
      const u = new URL(value);
      const scheme = u.protocol === 'http:' ? 'ws:' : 'wss:';
      return `${scheme}//${u.host}`;
    } catch {
      return null;
    }
  }
  // Bare host → assume secure (browser client uses wss: for non-localhost).
  const host = value.replace(/\/$/, '');
  const scheme = host.startsWith('localhost') ? 'ws:' : 'wss:';
  return `${scheme}//${host}`;
}

function computeWsConnectSrc(): string[] {
  const out = new Set<string>();
  const lspHost = safeEnv('NEXT_PUBLIC_LSP_HOST');
  const policyWs = safeEnv('NEXT_PUBLIC_ASTER_POLICY_WS_URL');

  const lsp = lspHost ? normalizeWsOrigin(lspHost) : 'wss://lsp.aster-lang.dev';
  const policy = policyWs ? normalizeWsOrigin(policyWs) : 'wss://policy.aster-lang.dev';
  if (lsp) out.add(lsp);
  if (policy) out.add(policy);
  return [...out];
}
const WS_CONNECT_SRC = computeWsConnectSrc();

const ALL_TRUSTED_SCRIPT_SRC = [
  ...STRIPE_DOMAINS,
  ...MIXPANEL_DOMAINS,
  ...MONACO_CDN_DOMAINS,
  ...TURNSTILE_DOMAINS,
];
const ALL_TRUSTED_CONNECT_SRC = [
  ...STRIPE_DOMAINS,
  ...MIXPANEL_DOMAINS,
  ...ASTER_API_DOMAINS,
  ...MONACO_CDN_DOMAINS,
  // SSE / WebSocket — scoped to known LSP + policy-preview hosts rather than the
  // wildcard `wss:` (which allowed exfil to any WS server). #98.
  ...WS_CONNECT_SRC,
];

/**
 * Build the `Content-Security-Policy` header value.
 *
 * @param nonce Per-request nonce (base64) attached to all <script>/<style> tags by Next.js when read via headers().get('x-nonce')
 */
export function buildCspHeader(nonce: string): string {
  const isDev = safeEnv('NODE_ENV') !== 'production';

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(isDev ? ["'unsafe-eval'"] : []),
      ...ALL_TRUSTED_SCRIPT_SRC,
    ],
    // style-src 同时有 nonce 时浏览器会忽略 'unsafe-inline'（CSP3 spec）。
    // Monaco editor 动态注入未 nonce 的 <style> 元素 → 被拒。
    // 解法：拆 style-src-elem（管 <style>/<link>，允许 inline + jsDelivr CDN）
    // 与 style-src-attr（管 style="" 行内属性，允许 inline）。
    // 老 style-src 作为不支持 -elem/-attr 浏览器的 fallback。
    'style-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'unsafe-inline'",
      ...MONACO_CDN_DOMAINS,
    ],
    'style-src-elem': [
      "'self'",
      "'unsafe-inline'",
      ...MONACO_CDN_DOMAINS,
    ],
    'style-src-attr': ["'unsafe-inline'"],
    // #98: 从通配 `https:`（允许任意 https 主机）收紧到允许清单。源清单见
    // AVATAR_IMAGE_DOMAINS 注释：全站渲染的图片仅自托管 SVG（'self' 覆盖）+
    // OAuth 头像两个主机；data:/blob: 防御性保留（base64 图标 / canvas 导出）。
    'img-src': ["'self'", 'data:', 'blob:', ...AVATAR_IMAGE_DOMAINS],
    'font-src': ["'self'", 'data:'],
    // media-src：<audio>/<video> 媒体源。仅自托管（public/audio/*.mp3，'self' 覆盖）——
    // guyong demo 的项目自有/已授权录音。无远程媒体源。
    'media-src': ["'self'"],
    'connect-src': [
      "'self'",
      ...ALL_TRUSTED_CONNECT_SRC,
      ...(isDev ? ['ws:', 'http://localhost:*'] : []),
    ],
    'frame-src': ["'self'", ...STRIPE_DOMAINS, ...TURNSTILE_DOMAINS, GUARDIAN_EMBED_ORIGIN],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
    'upgrade-insecure-requests': [],
  };

  return Object.entries(directives)
    .map(([key, values]) => (values.length > 0 ? `${key} ${values.join(' ')}` : key))
    .join('; ');
}

/**
 * Additional security headers shipped alongside CSP.
 * Target: A+ on securityheaders.com.
 */
export function securityHeadersOnly(): Record<string, string> {
  return {
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': [
      'accelerometer=()',
      'camera=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'payment=(self "https://js.stripe.com")',
      'usb=()',
      'interest-cohort=()', // FLoC opt-out
    ].join(', '),
    // Cross-Origin-Opener-Policy + COEP: defense in depth (Spectre / cross-origin isolation)
    'Cross-Origin-Opener-Policy': 'same-origin',
    'X-DNS-Prefetch-Control': 'on',
  };
}
