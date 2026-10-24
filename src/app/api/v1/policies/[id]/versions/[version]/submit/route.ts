/**
 * 提交版本审批 API
 *
 * POST /api/v1/policies/{id}/versions/{version}/submit
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

import {
  PolicyAccessDeniedError,
  submitForApproval,
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

  try {
    const body = await request.json().catch(() => ({})) as { releaseNote?: unknown };
    const releaseNote = typeof body.releaseNote === 'string' ? body.releaseNote.trim() : '';
    await submitForApproval({
      policyId,
      version,
      userId: session.user.id,
      releaseNote: releaseNote || undefined,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    // 非所有者与「策略不存在」返回同一 404，避免泄露该 policyId 是否存在
    if (error instanceof PolicyAccessDeniedError) {
      return NextResponse.json({ error: 'Policy not found.', code: 'policy_not_found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not submit version for approval.' },
      { status: 400 }
    );
  }
}
