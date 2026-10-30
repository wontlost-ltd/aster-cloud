/**
 * 拒绝版本 API
 *
 * POST /api/v1/policies/{id}/versions/{version}/reject
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { versionActionErrorResponse } from '@/lib/api/version-action-error';
import { runAfterResponse } from '@/lib/after-response';
import { notifyVersionDecided } from '@/lib/version-notifications';

import {
  PolicyAccessDeniedError,
  SegregationOfDutiesError,
  approveVersion,
} from '@/services/policy/version-manager';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; version: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
  }

  const { id: policyId, version: versionStr } = await params;
  const version = parseInt(versionStr, 10);
  if (isNaN(version)) {
    return NextResponse.json({ error: 'Invalid version number.', code: 'invalid_version' }, { status: 400 });
  }

  let body: { comment?: string } = {};
  try {
    body = await request.json();
  } catch {
    // comment 是必填的，但允许解析失败后再报错
  }

  if (!body.comment?.trim()) {
    return NextResponse.json({ error: 'A rejection reason is required.', code: 'rejection_reason_required' }, { status: 400 });
  }

  try {
    await approveVersion({
      policyId,
      version,
      approverId: session.user.id,
      decision: 'REJECTED',
      comment: body.comment,
    });

    // 通知版本作者并带驳回理由（#678）
    const reviewerId = session.user.id;
    const comment = body.comment;
    runAfterResponse(() => notifyVersionDecided({ policyId, version, reviewerId, outcome: 'REJECTED', comment }));
    return NextResponse.json({ success: true });
  } catch (error) {
    // 非所有者与「策略不存在」返回同一 404，避免泄露该 policyId 是否存在
    if (error instanceof PolicyAccessDeniedError) {
      // 团队角色不够 → 403（成员知道策略存在）；非成员 / 不存在 → 404
      return error.status === 403
        ? NextResponse.json({ error: error.message, code: error.code }, { status: 403 })
        : NextResponse.json({ error: 'Policy not found.', code: 'policy_not_found' }, { status: 404 });
    }
    if (error instanceof SegregationOfDutiesError) {
      return NextResponse.json({ error: 'segregation_of_duties', message: error.message }, { status: 403 });
    }
    return versionActionErrorResponse('Reject', error, 'Could not reject version.');
  }
}
