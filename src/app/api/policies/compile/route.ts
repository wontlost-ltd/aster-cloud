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

// 详情页档案徽标（purpose=profile）走独立限流桶：浏览详情不消耗编辑器的编译额度，限额相同。
function rateLimitKey(purpose: unknown, userId: string): string {
  return purpose === 'profile' ? `policy-profile:${userId}` : `policy-compile:${userId}`;
}

// aliasSet 须为「kind → 短语数组」；缺省或 null 视为无别名，其余形状判为非法
function isAliasSet(value: unknown): value is Record<string, string[]> | null | undefined {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((v) => Array.isArray(v) && v.every((s) => typeof s === 'string'));
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 限流桶取决于请求体里的 purpose，故先解析请求体；非法 JSON 不触达上游，也不计入额度。
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json(
      { error: 'Request body must be a valid object' },
      { status: 400 },
    );
  }

  const { source, locale, aliasSet, purpose } = body as {
    source?: string;
    locale?: string;
    aliasSet?: unknown;
    purpose?: unknown;
  };

  // Rate-limit keyed by user — IP is read for telemetry only, never
  // used as a primary key (would punish corporate NATs).
  void getClientIp(req);
  const result = checkRateLimit(rateLimitKey(purpose, session.user.id), RateLimitPresets.EVALUATE_SOURCE);
  const headers = getRateLimitHeaders(result, RateLimitPresets.EVALUATE_SOURCE);
  if (!result.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfter: result.retryAfterSeconds },
      { status: 429, headers },
    );
  }

  if (!source || typeof source !== 'string') {
    return NextResponse.json(
      { error: 'Source code is required' },
      { status: 400, headers },
    );
  }

  if (!isAliasSet(aliasSet)) {
    return NextResponse.json(
      { error: 'aliasSet must map keyword kinds to string arrays' },
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
      // 与保存校验、执行同一 aliasSet：依赖别名的源码不会被误判为解析错误。
      aliasSet: aliasSet ?? null,
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
