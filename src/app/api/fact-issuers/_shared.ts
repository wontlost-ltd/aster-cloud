/**
 * 签发方代理路由（ADR 0040 §11 D3）共用的鉴权与错误映射。
 *
 * 上游错误 → 稳定 code + 英文文案（#711：上游原文可能是中文或含内部细节，只写服务端日志）：
 * - 4xx 按原状态码与 error 码透传，文案取已登记的英文；DELETE 的 404 是空体，补 `issuer_not_found`；
 * - 503 `receipt_unavailable` 原样 503（签发方已禁用、联动未完成，重试同一请求可补齐）；
 * - 其余 408 / 5xx / 客户端超时与网络错误 → 502 `upstream_unavailable` 带 requestId（同审批动作路由）。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { registeredUpstreamMessage } from '@/lib/upstream-error-messages';
import { PolicyApiError } from '@/services/policy/policy-api';

const UNAVAILABLE_MESSAGE = 'The issuer service is temporarily unavailable. Please try again later.';
const FAILED_MESSAGE = 'The issuer request could not be completed.';
const REVOCATION_INCOMPLETE_MESSAGE =
  'The issuer is disabled, but updating the approvals that depend on it did not finish. Retry to complete it.';

/** 当前会话用户 id；未登录返回 null。 */
export async function sessionUserId(): Promise<string | null> {
  const session = await getSession();
  return session?.user?.id ?? null;
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized', message: 'Sign in required.' }, { status: 401 });
}

export function forbidden(): NextResponse {
  return NextResponse.json(
    { error: 'forbidden', message: 'You do not have permission to manage issuers for this workspace.' },
    { status: 403 },
  );
}

export function badRequest(code: string): NextResponse {
  return NextResponse.json({ error: code, message: registeredUpstreamMessage(code) ?? FAILED_MESSAGE }, { status: 400 });
}

function upstreamUnavailable(detail: unknown): NextResponse {
  const requestId = crypto.randomUUID();
  console.error(`[fact-issuers] upstream unavailable requestId=${requestId}`, detail);
  return NextResponse.json(
    { error: 'upstream_unavailable', code: 'upstream_unavailable', message: UNAVAILABLE_MESSAGE, requestId },
    { status: 502, headers: { 'x-request-id': requestId } },
  );
}

/** 把调用 aster-api 时抛出的任何错误映射为响应。 */
export function upstreamErrorResponse(e: unknown): NextResponse {
  if (!(e instanceof PolicyApiError)) return upstreamUnavailable(e);
  if (e.statusCode === 503 && e.code === 'receipt_unavailable') {
    return NextResponse.json(
      { error: 'receipt_unavailable', message: REVOCATION_INCOMPLETE_MESSAGE, retryable: true },
      { status: 503 },
    );
  }
  if (!e.statusCode || e.statusCode === 408 || e.statusCode >= 500) {
    return upstreamUnavailable([e.statusCode, e.code, e.message]);
  }
  const code = e.code ?? (e.statusCode === 404 ? 'issuer_not_found' : `http_${e.statusCode}`);
  const message = registeredUpstreamMessage(code);
  if (!message) console.warn('[fact-issuers] upstream rejected', e.statusCode, e.code, e.message);
  return NextResponse.json({ error: code, message: message ?? FAILED_MESSAGE }, { status: e.statusCode });
}
