/**
 * 设置默认版本 API 端点
 *
 * POST /api/v1/policies/{id}/versions/{version}/set-default
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';

import {
  PolicyAccessDeniedError,
  setDefaultVersion,
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

    await setDefaultVersion({
      policyId: id,
      version,
      userId: session.user.id,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    // 非所有者与「策略不存在」返回同一 404，避免泄露该 policyId 是否存在
    if (error instanceof PolicyAccessDeniedError) {
      return NextResponse.json({ error: 'Policy not found.', code: 'policy_not_found' }, { status: 404 });
    }
    console.error('[SetDefault] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not set the default version.' },
      { status: 400 }
    );
  }
}
