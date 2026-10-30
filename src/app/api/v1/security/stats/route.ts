/**
 * 安全事件统计 API
 *
 * GET /api/v1/security/stats - 获取安全事件统计信息
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { internalErrorResponse } from '@/lib/api/version-action-error';

import { getSecurityEventStats } from '@/services/security/security-event-service';

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  // 解析查询参数
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const policyId = searchParams.get('policyId');

  // 默认查询最近 24 小时
  const end = endDate ? new Date(endDate) : new Date();
  const start = startDate
    ? new Date(startDate)
    : new Date(end.getTime() - 24 * 60 * 60 * 1000);

  try {
    const stats = await getSecurityEventStats({
      // ★租户隔离：此前校验了登录态却丢弃 userId，任意登录用户可读取全平台的
      // 安全事件统计（总数 + 按 severity/type 分布 + 错误率）。与兄弟端点
      // events/route.ts 是同一缺陷，那边已修、这边漏修。
      userId: session.user.id,
      startDate: start,
      endDate: end,
      policyId: policyId ?? undefined,
    });

    return NextResponse.json({
      ...stats,
      period: {
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
    });
  } catch (error) {
    return internalErrorResponse('Security Stats API', error, 'Could not load security statistics.');
  }
}
