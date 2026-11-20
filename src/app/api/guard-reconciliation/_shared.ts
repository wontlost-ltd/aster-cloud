/**
 * Guard 对账 BFF（ADR 0061）共用的鉴权与上游错误映射，结构同签发方 `fact-issuers/_shared.ts`。
 *
 * 错误体 `{ error, message, requestId? }`，message 一律英文（界面按 error 码本地化，#711）：
 * - 上游 408 / 5xx / 超时 / 网络错误 → 502 `upstream_unavailable` 带 requestId；
 * - 上游 404 → 404 `orphan_not_found`（确认端点的跨租户 / 不存在 / 非数字 id 都是 404 空体）；
 * - 上游 409 `not_open` → 409 并带当前 `status`，UI 据此更新该行；
 * - 其余 4xx 按原状态与错误码透传已登记的英文文案。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { registeredUpstreamMessage } from '@/lib/upstream-error-messages';
import { PolicyApiError } from '@/services/policy/policy-api';

const UNAVAILABLE_MESSAGE = 'The reconciliation service is temporarily unavailable. Please try again later.';
const FAILED_MESSAGE = 'The reconciliation request could not be completed.';

/** 当前会话用户 id；未登录返回 null。 */
export async function sessionUserId(): Promise<string | null> {
  const session = await getSession();
  return session?.user?.id ?? null;
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'unauthorized', message: 'Sign in required.' }, { status: 401 });
}

/** view：看不到该租户的对账；ack：能看但不能确认。 */
export function forbidden(what: 'view' | 'ack'): NextResponse {
  const message = what === 'ack'
    ? 'Only workspace admins and owners can acknowledge orphan actions.'
    : 'You do not have permission to view reconciliation for this workspace.';
  return NextResponse.json({ error: 'forbidden', message }, { status: 403 });
}

export function errorResponse(status: number, code: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json(
    { error: code, message: registeredUpstreamMessage(code) ?? FAILED_MESSAGE, ...extra },
    { status },
  );
}

function upstreamUnavailable(detail: unknown): NextResponse {
  const requestId = crypto.randomUUID();
  console.error(`[guard-reconciliation] upstream unavailable requestId=${requestId}`, detail);
  return NextResponse.json(
    { error: 'upstream_unavailable', message: UNAVAILABLE_MESSAGE, requestId },
    { status: 502, headers: { 'x-request-id': requestId } },
  );
}

/** 把调用 aster-api 时抛出的任何错误映射为响应。 */
export function upstreamErrorResponse(e: unknown): NextResponse {
  if (!(e instanceof PolicyApiError)) return upstreamUnavailable(e);
  if (!e.statusCode || e.statusCode === 408 || e.statusCode >= 500) {
    return upstreamUnavailable([e.statusCode, e.code, e.message]);
  }
  if (e.statusCode === 404) return errorResponse(404, 'orphan_not_found');
  if (e.statusCode === 409 && e.code === 'not_open') {
    const status = typeof e.details?.status === 'string' ? e.details.status : undefined;
    return errorResponse(409, 'not_open', status ? { status } : {});
  }
  const code = e.code ?? `http_${e.statusCode}`;
  if (!registeredUpstreamMessage(code)) console.warn('[guard-reconciliation] upstream rejected', e.statusCode, e.code, e.message);
  return errorResponse(e.statusCode, code);
}
