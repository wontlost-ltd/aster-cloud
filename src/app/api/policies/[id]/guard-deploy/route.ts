/**
 * POST /api/policies/{id}/guard-deploy —「重新同步」Guard 部署（aster-api ADR 0054 §11 D1）
 *
 * 与 cron guard-deploy-sync 同一函数：按策略此刻的实际状态（默认版本 / 已删除）以新代际重发一次。
 * 授权同设默认版本（update）。
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { reconcileGuardDeployments } from '@/lib/guard-policy-deploy';
import { assertPolicyAction, PolicyAccessDeniedError } from '@/services/policy/version-manager';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
  }
  const { id } = await params;
  try {
    await assertPolicyAction(id, session.user.id, 'update');
  } catch (error) {
    if (error instanceof PolicyAccessDeniedError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }
  const report = await reconcileGuardDeployments({ onlyPolicyId: id });
  if (report.checked === 0) {
    return NextResponse.json({ ok: false, code: 'guard_not_deployed', message: '该策略尚无 Guard 部署记录' }, { status: 404 });
  }
  const failure = report.failed[0];
  return failure
    ? NextResponse.json({ ok: false, code: failure.error, status: failure.status }, { status: failure.status === 0 ? 503 : 502 })
    : NextResponse.json({ ok: true });
}
