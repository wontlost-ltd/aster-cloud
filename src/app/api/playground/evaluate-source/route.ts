/*
 * POST /api/playground/evaluate-source
 *
 * Cloud-side BFF that brokers the marketing playground's "Run on backend"
 * button. The flow:
 *
 *   marketing-site fetch
 *     ↓ HTTPS, anonymous, browser Origin header
 *   /api/playground/evaluate-source (this route)
 *     ↓ Origin allowlist
 *     ↓ body-size cap (32 KiB)
 *     ↓ per-IP rate limit (preset EVALUATE_SOURCE = 20/min)
 *     ↓ HMAC sign via signInternalCallerHeaders('POST', ...)
 *   aster-api internal service DNS (ASTER_POLICY_API_INTERNAL_URL)
 *     ↓ InternalCallerFilter verifies cloud-bff caller
 *   /api/v1/policies/evaluate-source
 *
 * Public ingress to aster-api's /evaluate-source is blocked by the
 * traefik middleware `block-evaluate-source` (see
 * k3s/apps/aster-lang/cloud/ingress-deny-evaluate-source.yaml). The
 * cloud BFF reaches aster-api via internal service DNS, bypassing
 * that ingress block — so the anonymous endpoint stays anonymous from
 * the marketing site's point of view while aster-api's evaluate-source
 * remains strictly internal.
 *
 * Why not lean on aster-api's TrialEndpointGuard:
 *   - The ingress block fires before TrialEndpointGuard sees the
 *     request, so even an enabled trial flag wouldn't help.
 *   - Putting the gating on the cloud BFF keeps a single source of
 *     truth for "what an anonymous marketing visitor can do" and lets
 *     us swap the upstream (e.g. point at a future managed runtime)
 *     without touching the marketing site or aster-api config.
 *
 * Trial metrics: every terminal outcome (accept + each rejection
 * reason) is recorded to aster_trial_evaluate_source_total{outcome};
 * accept-path upstream latency is observed into the histogram. See
 * src/lib/trial-metrics.ts for label semantics.
 */

import { NextRequest, NextResponse } from 'next/server';
import { signInternalCallerHeaders } from '@/lib/api-signing';
import {
  checkRateLimit,
  getClientIp,
  getRateLimitHeaders,
  RateLimitPresets,
} from '@/lib/rate-limit';
import {
  observeTrialLatency,
  recordTrialOutcome,
  recordTrialUpstreamStatus,
} from '@/lib/trial-metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ASTER_API_BASE =
  process.env.ASTER_POLICY_API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL ||
  'https://policy.aster-lang.dev';

const UPSTREAM_PATH = '/api/v1/policies/evaluate-source';

// Origin allowlist mirrors aster-api's TrialEndpointGuard default
// (apps that share the brand). Configurable via env so a staging
// deployment can add its own preview origin without a code change.
const DEFAULT_ALLOWED_ORIGINS = [
  'https://aster-lang.dev',
  'https://www.aster-lang.dev',
  'https://aster-lang.cloud',
  'https://www.aster-lang.cloud',
];

const ALLOWED_ORIGINS = (() => {
  const env = process.env.ASTER_PLAYGROUND_ALLOWED_ORIGINS;
  if (!env || !env.trim()) return new Set(DEFAULT_ALLOWED_ORIGINS);
  return new Set(env.split(',').map((s) => s.trim()).filter(Boolean));
})();

// Body size cap mirrors TrialEndpointGuard's default. Marketing
// playground sources are tiny (a few rules) — 32 KiB is room enough
// for any realistic demo and stops drive-by abuse.
const MAX_BODY_BYTES = 32 * 1024;

function corsHeadersFor(origin: string | null): HeadersInit {
  // Only echo back Origin if it's in the allowlist — anything else
  // gets an empty ACAO so the browser refuses the response. Same
  // posture as aster-api's CorsFilter.
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Vary': 'Origin',
    };
  }
  return { 'Vary': 'Origin' };
}

/**
 * aster-api evaluate-source 链路登记过的稳定错误码（TrialEndpointGuard、PolicyEvaluationResource、
 * ModuleResolutionException.Code、入口诊断）。只透传这些；未登记的（含把句子放进 error 字段的）用 http_<status>。
 */
const UPSTREAM_CODES: ReadonlySet<string> = new Set([
  // TrialEndpointGuard
  'origin_not_allowed', 'transfer_encoding_not_allowed', 'content_length_required', 'invalid_content_length',
  'payload_too_large', 'turnstile_failed', 'too_many_concurrent', 'too_many_requests',
  // PolicyEvaluationResource
  'evaluate_source_busy', 'alias_set_too_large', 'vocabulary_too_large', 'invalid_agent', 'missing_input_field',
  'api_access_denied', 'rate_limit_exceeded', 'api_quota_hard_exceeded',
  // 入口 / 模块诊断
  'ENTRY_AMBIGUOUS', 'IMPORT_VERSION_REQUIRED', 'MODULE_VERSION_NOT_FOUND', 'MODULE_NOT_VISIBLE', 'MODULE_CYCLE',
]);

const MAX_DIAGNOSTICS = 20;
const MAX_CANDIDATES = 50;
const MAX_TEXT = 500;

type PlaygroundDiagnostic = { code: string; message: string; candidates: string[] };

const shortText = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= MAX_TEXT ? v : undefined;

/** 诊断条目只保留 code / message / candidates（审查 Medium-1）；code 未登记的整条丢弃。 */
function allowlistedDiagnostics(raw: unknown): PlaygroundDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_DIAGNOSTICS).flatMap((d) => {
    if (!d || typeof d !== 'object') return [];
    const { code, message, candidates } = d as Record<string, unknown>;
    if (typeof code !== 'string' || !UPSTREAM_CODES.has(code)) return [];
    const list = Array.isArray(candidates)
      ? candidates.filter((c): c is string => typeof c === 'string' && c.length <= 200).slice(0, MAX_CANDIDATES)
      : [];
    return [{ code, message: shortText(message) ?? '', candidates: list }];
  });
}

function registeredCode(v: unknown): string | undefined {
  return typeof v === 'string' && UPSTREAM_CODES.has(v) ? v : undefined;
}

/**
 * 上游非 2xx（#711）：业务原文只写服务端日志，响应给稳定 code、英文文案与 requestId。
 * 4xx 保留状态码，并按字段白名单透传面向用户的结构化诊断（code / message / candidates，及缺字段的 field），
 * 429 透传 Retry-After；5xx 统一 502 upstream_error。
 */
async function upstreamFailure(upstream: Response, headers: HeadersInit): Promise<NextResponse> {
  const requestId = crypto.randomUUID();
  const text = await upstream.text().catch(() => '');
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // 非 JSON 错误体：按无结构处理
  }
  const responseHeaders = new Headers(headers);
  responseHeaders.set('x-request-id', requestId);
  if (upstream.status >= 500) {
    console.error(`[playground/evaluate-source] upstream ${upstream.status} requestId=${requestId}`, text.slice(0, 2000));
    return NextResponse.json(
      {
        error: 'upstream_error',
        code: 'upstream_error',
        message: 'The policy engine failed to evaluate this request. Please try again later.',
        requestId,
      },
      { status: 502, headers: responseHeaders },
    );
  }
  const diagnostics = allowlistedDiagnostics(parsed.diagnostics);
  const code = registeredCode(parsed.code) ?? registeredCode(parsed.error) ?? diagnostics[0]?.code ?? `http_${upstream.status}`;
  const field = typeof parsed.field === 'string' && parsed.field.length <= 200 ? parsed.field : undefined;
  const retryAfter = upstream.headers.get('retry-after');
  if (upstream.status === 429 && retryAfter && /^\d{1,6}$/.test(retryAfter)) responseHeaders.set('Retry-After', retryAfter);
  console.warn(`[playground/evaluate-source] upstream ${upstream.status} ${code} requestId=${requestId}`, text.slice(0, 2000));
  return NextResponse.json(
    {
      error: code,
      code,
      message: 'The policy engine rejected this trial request.',
      requestId,
      ...(field ? { field } : {}),
      ...(diagnostics.length > 0 ? { diagnostics } : {}),
    },
    { status: upstream.status, headers: responseHeaders },
  );
}

export function OPTIONS(req: NextRequest) {
  // CORS preflight: marketing site (different origin) does this before POST.
  const origin = req.headers.get('origin');
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...corsHeadersFor(origin),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '600',
    },
  });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  const baseCors = corsHeadersFor(origin);

  // 1) Origin allowlist. Anonymous endpoint relies on the browser-set
  // Origin header — non-browser callers can forge it, so this is a
  // best-effort gate. The downstream rate-limit + body-size caps are
  // the real defense against scripted abuse.
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    recordTrialOutcome('origin_rejected');
    return NextResponse.json(
      {
        error: 'origin_not_allowed',
        message:
          'Trial endpoint only accepts requests from the marketing-site allowlist.',
      },
      { status: 403, headers: baseCors },
    );
  }

  // 2) Body size — read Content-Length up front so we can reject before
  // touching the body stream. Anonymous endpoints must cap memory.
  const contentLength = req.headers.get('content-length');
  if (!contentLength) {
    recordTrialOutcome('length_required');
    return NextResponse.json(
      {
        error: 'content_length_required',
        message: 'Trial endpoint requires a Content-Length header.',
      },
      { status: 411, headers: baseCors },
    );
  }
  const bytes = Number.parseInt(contentLength, 10);
  if (!Number.isFinite(bytes) || bytes < 0 || bytes > MAX_BODY_BYTES) {
    recordTrialOutcome('body_too_large');
    return NextResponse.json(
      {
        error: 'payload_too_large',
        limit: MAX_BODY_BYTES,
        received: Number.isFinite(bytes) ? bytes : null,
        message: `Trial endpoint caps request body at ${MAX_BODY_BYTES} bytes.`,
      },
      { status: 413, headers: baseCors },
    );
  }

  // 3) Per-IP rate limit. Anonymous = per-IP is the only bucket key we
  // have. EVALUATE_SOURCE preset = 20 req/min, which is generous for a
  // human poking at the playground and tight enough to make scripted
  // abuse hit the wall quickly.
  const ip = getClientIp(req);
  const rl = checkRateLimit(`playground:evaluate-source:${ip}`,
    RateLimitPresets.EVALUATE_SOURCE);
  const rlHeaders = getRateLimitHeaders(rl, RateLimitPresets.EVALUATE_SOURCE);
  if (!rl.allowed) {
    recordTrialOutcome('rate_limit_minute');
    return NextResponse.json(
      {
        error: 'too_many_requests',
        retryAfter: rl.retryAfterSeconds,
        message:
          'Trial endpoint rate limit exceeded. Wait a minute and try again, ' +
          'or run the demo in-browser instead.',
      },
      {
        status: 429,
        headers: { ...baseCors, ...rlHeaders },
      },
    );
  }

  // 4) R31-4 Turnstile token pass-through. aster-api's TurnstileVerifier
  // does the actual cf siteverify call; here we just forward the header.
  // When ASTER_SECURITY_TRIAL_TURNSTILE_ENABLED=false on the api side
  // (default), the header is ignored and the request proceeds — keeps
  // the playground working before keys are provisioned end-to-end.
  const turnstileToken = req.headers.get('x-trial-turnstile-token') ?? '';

  // 5) Sign + forward. signInternalCallerHeaders throws when the HMAC
  // key isn't configured — surface that as 503 so the caller knows it's
  // a deploy-side issue, not their input.
  // 红队 P0-C：body/tenant/role 现在都进签名，故必须**先读 body 再签名**，
  // 且签名参数与下方 fetch 实际发送的 X-Tenant-Id/X-User-Role 逐字一致。
  const body = await req.text();
  const trialTenant = 'trial-playground';
  const trialRole = 'MEMBER';
  let signedHeaders: Awaited<ReturnType<typeof signInternalCallerHeaders>>;
  try {
    signedHeaders = await signInternalCallerHeaders(
      'POST', UPSTREAM_PATH, body, trialTenant, trialRole,
      // v3：匿名试用无 query、不发 X-User-Id / 业务角色，按空串签。
      { query: '', userId: '' },
    );
  } catch (err) {
    recordTrialOutcome('upstream_misconfigured');
    // 匿名端点：不向调用方暴露环境变量名等部署细节（#711），原因只写服务端日志
    const requestId = crypto.randomUUID();
    console.error(`[playground/evaluate-source] signing failed requestId=${requestId}`, err);
    return NextResponse.json(
      {
        error: 'cloud_misconfigured',
        code: 'cloud_misconfigured',
        message: 'The trial service is not available right now. Please try again later.',
        requestId,
      },
      { status: 503, headers: { ...baseCors, ...rlHeaders, 'x-request-id': requestId } },
    );
  }

  const t0 = Date.now();
  let upstream: Response;
  try {
    // X-Tenant-Id: TenantFilter requires this header on non-bypass
    // paths (evaluate-source is not in the bypass list). All anonymous
    // trial traffic shares the synthetic "trial-playground" tenant so
    // metrics / quota lines up under one bucket.
    //
    // X-User-Role: PolicyEvaluationResource is annotated @RequireRole(MEMBER).
    // The BFF asserts MEMBER on behalf of the anonymous caller — this
    // is safe because aster-api's InternalCallerFilter has already
    // verified the call came from the trusted cloud-bff (via HMAC),
    // and the public ingress strips any client-supplied X-User-Role
    // (RequestSignatureFilter rejects mismatched headers).
    upstream = await fetch(`${ASTER_API_BASE}${UPSTREAM_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Tenant-Id': trialTenant,
        'X-User-Role': trialRole,
        // Forward the (already-allowlist-validated) browser Origin so aster-api's
        // TrialEndpointGuard Origin check passes. The server→server fetch otherwise
        // sends no Origin → guard returns origin_not_allowed once the trial guard is
        // enabled. We only reach here after `origin` cleared the BFF allowlist above,
        // and aster-api's own allowlist mirrors it (aster-lang.dev / .cloud).
        ...(origin ? { Origin: origin } : {}),
        // R31-4: forward Turnstile token (may be empty in dev / pre-rollout)
        ...(turnstileToken ? { 'X-Trial-Turnstile-Token': turnstileToken } : {}),
        ...signedHeaders,
      },
      body,
    });
  } catch (err) {
    recordTrialOutcome('upstream_error');
    // 匿名端点：fetch 异常原文可能含内部主机名 / IP / 端口（如 connect ECONNREFUSED 10.x.x.x:8080），
    // 只写服务端日志并以 requestId 关联；响应只给稳定 code、通用文案与 requestId（#688）。
    const requestId = crypto.randomUUID();
    console.error(`[playground/evaluate-source] upstream unreachable requestId=${requestId}`, err);
    return NextResponse.json(
      {
        error: 'upstream_unreachable',
        code: 'upstream_unreachable',
        message: 'The policy engine could not be reached. Please try again later.',
        requestId,
      },
      { status: 502, headers: { ...baseCors, ...rlHeaders, 'x-request-id': requestId } },
    );
  }

  const elapsedSec = (Date.now() - t0) / 1000;
  observeTrialLatency(elapsedSec);
  recordTrialUpstreamStatus(upstream.status);
  recordTrialOutcome('accept');

  if (!upstream.ok) {
    return upstreamFailure(upstream, { ...baseCors, ...rlHeaders });
  }

  // Stream the upstream response body straight through. Content-Type
  // is mirrored so the marketing client gets the same JSON shape it
  // would have received from a direct call.
  const respBody = await upstream.text();
  return new NextResponse(respBody, {
    status: upstream.status,
    headers: {
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/json',
      ...baseCors,
      ...rlHeaders,
    },
  });
}
