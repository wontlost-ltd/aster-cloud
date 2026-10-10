import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createPolicyApiClient } from '@/services/policy/policy-api';
import {
  checkRateLimit,
  getClientIp,
  getRateLimitHeaders,
  RateLimitPresets,
} from '@/lib/rate-limit';

/**
 * POST /api/policies/compile
 *
 * Thin wrapper over the upstream Policy API's compile endpoint. The
 * underlying call validates CNL syntax and returns structured
 * diagnostics (severity + line/column ranges + codes) without
 * executing anything — perfect for the IDE-style "compile on type"
 * feedback the policy editor needs.
 *
 * Reuses the EVALUATE_SOURCE rate-limit preset rather than minting a
 * new one — compile is roughly the same shape of work (single-source
 * round-trip to the Java backend) and the editor is expected to
 * debounce client-side, so traffic profile is similar.
 */

export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Rate-limit keyed by user — IP is read for telemetry only, never
  // used as a primary key (would punish corporate NATs).
  void getClientIp(req);
  const rateLimitKey = `policy-compile:${session.user.id}`;
  const result = checkRateLimit(rateLimitKey, RateLimitPresets.EVALUATE_SOURCE);
  const headers = getRateLimitHeaders(result, RateLimitPresets.EVALUATE_SOURCE);
  if (!result.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfter: result.retryAfterSeconds },
      { status: 429, headers },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400, headers },
    );
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Request body must be a valid object' },
      { status: 400, headers },
    );
  }

  const { source, locale } = body as { source?: string; locale?: string };
  if (!source || typeof source !== 'string') {
    return NextResponse.json(
      { error: 'Source code is required' },
      { status: 400, headers },
    );
  }

  // Empty source is a no-op success — saves a round-trip on the very
  // first keystroke after the editor mounts.
  if (source.trim().length === 0) {
    return NextResponse.json(
      { success: true, diagnostics: [] },
      { headers },
    );
  }

  try {
    const client = createPolicyApiClient(session.user.id, session.user.id);
    const response = await client.compile({
      source,
      locale: locale || 'en-US',
    });
    // Pass diagnostics through verbatim — the client maps them to
    // Monaco markers.
    return NextResponse.json(response, { headers });
  } catch (error) {
    console.error('[api/policies/compile] upstream error', error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to compile policy',
      },
      { status: 502, headers },
    );
  }
}
