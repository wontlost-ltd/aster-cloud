/**
 * 拒绝版本 API
 *
 * POST /api/v1/policies/{id}/versions/{version}/reject
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

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

    return NextResponse.json({ success: true });
  } catch (error) {
    // 非所有者与「策略不存在」返回同一 404，避免泄露该 policyId 是否存在
    if (error instanceof PolicyAccessDeniedError) {
      return NextResponse.json({ error: 'Policy not found.', code: 'policy_not_found' }, { status: 404 });
    }
    if (error instanceof SegregationOfDutiesError) {
      return NextResponse.json({ error: 'segregation_of_duties', message: error.message }, { status: 403 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not reject version.' },
      { status: 400 }
    );
  }
}
