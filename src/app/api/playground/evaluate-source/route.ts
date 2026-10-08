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
  } catch {
    recordTrialOutcome('upstream_misconfigured');
    return NextResponse.json(
      {
        error: 'cloud_misconfigured',
        message: 'ASTER_PLAN_GATE_HMAC_KEY missing on cloud server',
      },
      { status: 503, headers: { ...baseCors, ...rlHeaders } },
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
    return NextResponse.json(
      {
        error: 'upstream_unreachable',
        message: 'aster-api could not be reached',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502, headers: { ...baseCors, ...rlHeaders } },
    );
  }

  const elapsedSec = (Date.now() - t0) / 1000;
  observeTrialLatency(elapsedSec);
  recordTrialUpstreamStatus(upstream.status);
  recordTrialOutcome('accept');

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
