/**
 * 归档版本 API 端点
 *
 * POST /api/v1/policies/{id}/versions/{version}/archive
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { versionActionErrorResponse } from '@/lib/api/version-action-error';

import {
  PolicyAccessDeniedError,
  archiveVersion,
} from '@/services/policy/version-manager';

interface RouteParams {
  params: Promise<{ id: string; version: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }

    const { id, version: versionStr } = await params;
    const version = parseInt(versionStr, 10);

    if (isNaN(version)) {
      return NextResponse.json({ error: 'Invalid version number.', code: 'invalid_version' }, { status: 400 });
    }

    // 解析可选的 reason 字段
    let reason: string | undefined;
    try {
      const body = await request.json();
      if (body && typeof body === 'object' && typeof body.reason === 'string') {
        reason = body.reason;
      }
    } catch {
      // 忽略 JSON 解析错误，reason 为可选
    }

    await archiveVersion({
      policyId: id,
      version,
      userId: session.user.id,
      reason,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    // 非所有者与「策略不存在」返回同一 404，避免泄露该 policyId 是否存在
    if (error instanceof PolicyAccessDeniedError) {
      return NextResponse.json({ error: 'Policy not found.', code: 'policy_not_found' }, { status: 404 });
    }
    return versionActionErrorResponse('Archive', error, 'Could not archive version.');
  }
}
