/**
 * 审批动作（ADR 0042 §5.2）：`POST /api/approvals/[tenantId]/[approvalId]/approve|reject`，
 * body `{ comment, inputSnapshotHash? }`（快照哈希为 64 位小写 hex，否则 400 invalid_approval，ADR 0042 §12 D10）。
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
import { approvalErrorResponse, belongsToTenant } from '@/lib/approvals-proxy';
import type { GuardDecision } from '@/services/policy/guard-types';
import { PolicyApiError } from '@/services/policy/policy-api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Verb = 'approve' | 'reject';

interface RouteParams {
  params: Promise<{ tenantId: string; approvalId: string; verb: string }>;
}

/** 审批人所见输入视图的快照哈希（ADR 0042 §12 D6）：sha256 hex。 */
const SNAPSHOT_HASH = /^[0-9a-f]{64}$/;

interface DecideBody {
  comment: string | undefined;
  inputSnapshotHash: string | undefined;
  /** inputSnapshotHash 存在但格式不对 */
  invalidHash: boolean;
}

async function readBody(req: Request): Promise<DecideBody> {
  const body = (await req.json().catch(() => ({}))) as { comment?: unknown; inputSnapshotHash?: unknown };
  const comment = typeof body.comment === 'string' && body.comment.trim() !== '' ? body.comment.trim() : undefined;
  const hash = body.inputSnapshotHash;
  if (hash === undefined || hash === null) return { comment, inputSnapshotHash: undefined, invalidHash: false };
  const valid = typeof hash === 'string' && SNAPSHOT_HASH.test(hash);
  return { comment, inputSnapshotHash: valid ? hash : undefined, invalidHash: !valid };
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

  const { comment, inputSnapshotHash, invalidHash } = await readBody(req);
  if (invalidHash) {
    return NextResponse.json(
      { error: 'invalid_approval', message: 'inputSnapshotHash must be a 64-character lowercase hex digest.' },
      { status: 400 },
    );
  }
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
    decision = await decide(client, verb as Verb, approvalId, comment, inputSnapshotHash);
  } catch (e) {
    if (e instanceof PolicyApiError) return approvalErrorResponse(e);
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
  comment: string | undefined,
  inputSnapshotHash: string | undefined
): Promise<GuardDecision> {
  return verb === 'approve'
    ? client.approveGuard(approvalId, comment, inputSnapshotHash)
    : client.rejectGuard(approvalId, comment ?? '', inputSnapshotHash);
}
