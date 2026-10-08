/**
 * 审批动作（ADR 0042 §5.2）：`POST /api/approvals/[tenantId]/[approvalId]/approve|reject`，body `{ comment }`。
 *
 * cloud 只校验「用户属于该租户」与「驳回须填 comment」；角色匹配与四眼由 aster-api 依签名身份判定，
 * 其错误（403 role_mismatch / segregation_of_duties、409 approval_not_pending 等）按原状态码透传，
 * role_mismatch 附 verifiedRoles 供 UI 提示；上游不可用（408/5xx、客户端超时/网络错误）统一 502 upstream_unavailable。
 * 成功后在响应之后（after）通知发起人。
 */
import { NextResponse } from 'next/server';
import { runAfterResponse } from '@/lib/after-response';
import { getSession } from '@/lib/auth';
import { notifyApprovalDecided } from '@/lib/guard-notifications';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { checkTeamAccess } from '@/lib/team-permissions';
import type { GuardDecision } from '@/services/policy/guard-types';
import { PolicyApiError } from '@/services/policy/policy-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Verb = 'approve' | 'reject';

interface RouteParams {
  params: Promise<{ tenantId: string; approvalId: string; verb: string }>;
}

async function readComment(req: Request): Promise<string | undefined> {
  const body = (await req.json().catch(() => ({}))) as { comment?: unknown };
  return typeof body.comment === 'string' && body.comment.trim() !== '' ? body.comment.trim() : undefined;
}

async function belongsToTenant(userId: string, tenantId: string): Promise<boolean> {
  if (tenantId === userId) return true;
  return (await checkTeamAccess(userId, tenantId)).allowed;
}

/** 上游不可用：api 超时/5xx，或客户端侧超时（408 TIMEOUT）与网络错误（500 UNKNOWN）。 */
function isUpstreamUnavailable(e: PolicyApiError): boolean {
  return e.statusCode === 408 || e.statusCode >= 500 || !e.statusCode;
}

function apiErrorResponse(e: PolicyApiError): NextResponse {
  if (isUpstreamUnavailable(e)) {
    return NextResponse.json({ error: 'upstream_unavailable', message: e.message }, { status: 502 });
  }
  const verifiedRoles = e.details?.verifiedRoles;
  return NextResponse.json(
    {
      error: e.code ?? `http_${e.statusCode}`,
      message: e.message,
      ...(Array.isArray(verifiedRoles) ? { verifiedRoles } : {}),
    },
    { status: e.statusCode }
  );
}

export async function POST(req: Request, { params }: RouteParams) {
  const { tenantId, approvalId, verb } = await params;
  if (verb !== 'approve' && verb !== 'reject') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const comment = await readComment(req);
  // 与 api 同口径的本地前置校验：驳回无理由不发请求
  if (verb === 'reject' && !comment) {
    return NextResponse.json({ error: 'comment_required', message: 'A comment is required to reject.' }, { status: 400 });
  }
  if (!(await belongsToTenant(userId, tenantId))) {
    return NextResponse.json({ error: 'forbidden', message: 'Not a member of this tenant.' }, { status: 403 });
  }

  let decision: GuardDecision;
  try {
    const client = await createPolicyApiClientForUser(tenantId, userId);
    decision = await decide(client, verb as Verb, approvalId, comment);
  } catch (e) {
    if (e instanceof PolicyApiError) return apiErrorResponse(e);
    console.error('[approvals] decide failed', { tenantId, approvalId, verb, err: e });
    return NextResponse.json({ error: 'approval_failed' }, { status: 502 });
  }

  const decided = {
    tenantId,
    decisionId: decision.decisionId,
    approvalId,
    requiredRole: decision.approval?.requiredRole ?? null,
    outcome: verb === 'approve' ? ('APPROVED' as const) : ('REJECTED' as const),
  };
  runAfterResponse(() => notifyApprovalDecided(decided));
  return NextResponse.json(decision);
}

function decide(
  client: Awaited<ReturnType<typeof createPolicyApiClientForUser>>,
  verb: Verb,
  approvalId: string,
  comment: string | undefined
): Promise<GuardDecision> {
  return verb === 'approve' ? client.approveGuard(approvalId, comment) : client.rejectGuard(approvalId, comment ?? '');
}
