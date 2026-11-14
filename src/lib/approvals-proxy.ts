/**
 * 审批代理路由共用的租户归属校验与上游错误映射（ADR 0042 §5.2、§12 D10）。
 *
 * `/api/approvals/[tenantId]/[approvalId]/[verb]`、`…/input`、`…/input/reveal` 共用：cloud 只校验「用户属于该租户」，
 * 角色、四眼与解除权限由 aster-api 依签名身份判定，其错误按原状态码透传；上游不可用统一 502 upstream_unavailable。
 */
import { NextResponse } from 'next/server';
import { checkTeamAccess } from '@/lib/team-permissions';
import { registeredUpstreamMessage } from '@/lib/upstream-error-messages';
import type { PolicyApiError } from '@/services/policy/policy-api';

/** 个人租户即用户本人；团队租户须为成员。 */
export async function belongsToTenant(userId: string, tenantId: string): Promise<boolean> {
  if (tenantId === userId) return true;
  return (await checkTeamAccess(userId, tenantId)).allowed;
}

/** 上游不可用：api 超时/5xx，或客户端侧超时（408 TIMEOUT）与网络错误（500 UNKNOWN）。 */
export function isUpstreamUnavailable(e: PolicyApiError): boolean {
  return e.statusCode === 408 || e.statusCode >= 500 || !e.statusCode;
}

const UNAVAILABLE_MESSAGE = 'The approval service is temporarily unavailable. Please try again later.';
const FAILED_MESSAGE = 'The approval action could not be completed.';

/**
 * 上游错误 → 稳定 code + 英文文案（#711）：上游原文可能含内部主机 / IP / 端口或中文、内部类名，
 * 只写服务端日志；不可用时附 requestId 供排查。界面按 code 本地化。
 * 503 receipt_unavailable（审计链写入失败）是有意义的业务码，按原状态码透传，不并入 upstream_unavailable。
 */
export function approvalErrorResponse(e: PolicyApiError, logTag = '[approvals]'): NextResponse {
  if (isUpstreamUnavailable(e) && e.code !== 'receipt_unavailable') {
    const requestId = crypto.randomUUID();
    console.error(`${logTag} upstream unavailable requestId=${requestId}`, e.statusCode, e.code, e.message);
    return NextResponse.json(
      { error: 'upstream_unavailable', code: 'upstream_unavailable', message: UNAVAILABLE_MESSAGE, requestId },
      { status: 502, headers: { 'x-request-id': requestId } },
    );
  }
  const message = registeredUpstreamMessage(e.code);
  if (!message) console.warn(`${logTag} upstream rejected`, e.statusCode, e.code, e.message);
  const verifiedRoles = e.details?.verifiedRoles;
  return NextResponse.json(
    {
      error: e.code ?? `http_${e.statusCode}`,
      message: message ?? FAILED_MESSAGE,
      ...(Array.isArray(verifiedRoles) ? { verifiedRoles } : {}),
    },
    { status: e.statusCode },
  );
}
