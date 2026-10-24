/**
 * 安全事件查询 API
 *
 * GET /api/v1/security/events - 查询安全事件列表
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getSecurityEvents } from '@/services/security/security-event-service';
import type { SecurityEventType, EventSeverity } from '@/lib/prisma';

/** 解析并夹紧分页参数；非数字/越界一律落回安全默认值。 */
function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  // 解析查询参数
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const eventTypes = searchParams.get('eventTypes');
  const severities = searchParams.get('severities');
  const policyId = searchParams.get('policyId');

  // limit/offset 需夹紧：此前直接 parseInt 透传，`?limit=10000000` 会拉取
  // 全量安全事件；NaN（非数字入参）也会一路传到 SQL。
  const limit = clampInt(searchParams.get('limit'), 50, 1, 200);
  const offset = clampInt(searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

  try {
    const { events, total } = await getSecurityEvents({
      // ★租户隔离：此前校验了登录态却丢弃 userId，任意登录用户可读取全部租户的
      // 安全事件（含 userId/policyId/ipAddress/userAgent/details）。服务层本就
      // 支持该过滤（security-event-service.ts），只是路由从未传。
      userId: session.user.id,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      eventTypes: eventTypes
        ? (eventTypes.split(',') as SecurityEventType[])
        : undefined,
      severities: severities
        ? (severities.split(',') as EventSeverity[])
        : undefined,
      policyId: policyId ?? undefined,
      limit,
      offset,
    });

    return NextResponse.json({
      events,
      total,
      page: Math.floor(offset / limit),
      pageSize: limit,
    });
  } catch (error) {
    console.error('[Security Events API] Query failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not load security events.' },
      { status: 500 }
    );
  }
}
