/**
 * 版本详情 API
 *
 * GET /api/v1/policies/{id}/versions/{version}
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

import {
  PolicyAccessDeniedError,
  getVersionDetail,
} from '@/services/policy/version-manager';

export async function GET(
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
    const detail = await getVersionDetail({
      policyId,
      version,
      userId: session.user.id,
    });

    if (!detail) {
      return NextResponse.json({ error: 'Version not found.', code: 'version_not_found' }, { status: 404 });
    }

    return NextResponse.json(detail);
  } catch (error) {
    // 非所有者与「策略不存在」返回同一 404，避免泄露该 policyId 是否存在
    if (error instanceof PolicyAccessDeniedError) {
      return NextResponse.json({ error: 'Version not found.', code: 'version_not_found' }, { status: 404 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not load version details.' },
      { status: 500 }
    );
  }
}
