/**
 * Structured error envelope for /api routes.
 *
 * Goal: every BFF route returns the same shape on failure, so the
 * client retry path and on-call log lookup share one contract:
 *
 *   {
 *     "error": {
 *       "code":      "service_unavailable" | "unauthorized" | …,
 *       "message":   "human-readable summary",
 *       "requestId": "uuid-v4"
 *     }
 *   }
 *
 * The same `requestId` is also emitted on the `x-request-id`
 * response header (so callers that don't parse the body — health
 * checks, log aggregators — still see the correlation key).
 *
 * Pair with admin/error.tsx and dashboard/error.tsx: those segments
 * already surface `error.digest` as the Error ID. When a server
 * throw is caught here and the response body is parsed client-side
 * via apiFetch / ApiError, the body's requestId can be displayed
 * with the same Error-ID treatment.
 *
 * Why not reuse Next.js's `error.digest`:
 *   `digest` is minted only when Next's server component machinery
 *   bubbles a throw to the boundary. A BFF route that catches its
 *   own throws (the P0-5 pattern) never produces a digest — the
 *   caller would see a generic message without a correlation ID.
 *   This envelope mints its own UUID per failure so the contract
 *   is uniform regardless of where the failure originated.
 */

import { NextResponse } from 'next/server';

export interface ErrorEnvelopeBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export interface ErrorEnvelopeOptions {
  /** HTTP status. Defaults to 500. */
  status?: number;
  /** Stable machine-parseable code (e.g. `unauthorized`, `service_unavailable`). */
  code: string;
  /** Human-readable summary. Never include stack-trace text. */
  message: string;
  /**
   * Optional request id override — e.g. when an upstream proxy
   * already minted one and we want to preserve correlation across
   * the BFF → upstream hop. When omitted, a fresh UUID is generated.
   */
  requestId?: string;
  /** Extra response headers (CORS, rate-limit, etc.) merged on top of x-request-id. */
  headers?: HeadersInit;
}

/**
 * Build a NextResponse carrying a structured error envelope.
 * Always emits an `x-request-id` header containing the same value
 * that appears in the body.
 */
export function errorEnvelope(opts: ErrorEnvelopeOptions): NextResponse {
  const requestId = opts.requestId ?? crypto.randomUUID();
  const body: ErrorEnvelopeBody = {
    error: {
      code: opts.code,
      message: opts.message,
      requestId,
    },
  };
  // Merge caller-provided headers but always override x-request-id
  // so the contract holds (envelope.body.requestId === header).
  const merged = new Headers(opts.headers);
  merged.set('x-request-id', requestId);
  merged.set('content-type', 'application/json');
  return NextResponse.json(body, {
    status: opts.status ?? 500,
    headers: merged,
  });
}

/**
 * Client-side helper: pull a human-readable string out of an error
 * response body, regardless of which envelope shape it uses.
 *
 * Three shapes exist in the wild:
 *
 *   1. Structured envelope (current contract):
 *        { "error": { "code": "...", "message": "...", "requestId": "..." } }
 *   2. Legacy flat string (older routes):
 *        { "error": "Invalid API key" }
 *   3. Free-form `message` field (a few hand-written routes):
 *        { "message": "Something failed" }
 *
 * The structured shape broke every caller that did
 *   setError(data.error || fallback)
 * because `data.error` became an object, and React refuses to render
 * objects as children (`Minified React error #31`). This helper
 * normalizes all three shapes to a string suitable for direct UI use.
 *
 * Returns `null` when no message can be extracted, so callers can
 * fall back to a localized default with `?? t('failed')`.
 */
export function extractErrorMessage(body: unknown): string | null {
  if (body == null || typeof body !== 'object') return null;
  const rec = body as Record<string, unknown>;
  const err = rec.error;

  // Shape 1: structured envelope
  if (
    err &&
    typeof err === 'object' &&
    typeof (err as Record<string, unknown>).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  // Shape 2: legacy flat string under `error`
  if (typeof err === 'string') {
    return err;
  }
  // Shape 3: top-level `message`
  if (typeof rec.message === 'string') {
    return rec.message;
  }
  return null;
}

/**
 * Companion: extract the requestId so callers can surface "Error ID:
 * abc123" alongside the user-facing message. Returns `null` if the
 * body is not in structured-envelope shape.
 */
export function extractRequestId(body: unknown): string | null {
  if (body == null || typeof body !== 'object') return null;
  const err = (body as Record<string, unknown>).error;
  if (
    err &&
    typeof err === 'object' &&
    typeof (err as Record<string, unknown>).requestId === 'string'
  ) {
    return (err as { requestId: string }).requestId;
  }
  return null;
}

/**
 * 可安全写入日志的错误标识：数据库错误码（如 pgcrypto 解密失败的 39000）优先，否则取错误类名。
 *
 * 绑定了密钥或明文 key 的查询失败时，DrizzleQueryError 的 message 会带出全部绑定参数，
 * 所以这类 catch 只能记录本函数的结果与 requestId，绝不能记录 err 本身或 err.message。
 */
export function safeErrorCode(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  if (typeof code === 'string' && code) return code;
  return err instanceof Error ? err.name : 'unknown';
}
