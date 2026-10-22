/**
 * GET /api/user/aha-status
 *
 * 返回当前用户的 AHA-moment 状态。供 dashboard tile 展示：
 *   - 用户已达成 AHA → 显示 "🎉 First policy published! (X hours after signup)"
 *   - 用户尚未达成 → 显示 "Tip: publish your first policy within 24 hours to hit the AHA milestone"
 *     （hasPolicies=true 时卡片不渲染：其行动入口是「创建策略」，对已有策略的用户是噪音）
 *
 * PM 02 north-star (WAADR) leading indicator.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, users, auditLogs, policies } from '@/lib/prisma';
import { and, eq, isNull } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

const AHA_WINDOW_HOURS = 24;

export async function GET() {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  const [user, ahaEvent, anyPolicy] = await Promise.all([
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { createdAt: true },
    }),
    db.query.auditLogs.findFirst({
      where: and(
        eq(auditLogs.userId, userId),
        eq(auditLogs.action, 'aha.first_policy_published'),
      ),
      columns: { createdAt: true, metadata: true },
    }),
    // 未达成时卡片的唯一行动是「创建策略」：已有（未删除）策略的用户不该再被引导去建第一条
    db.query.policies.findFirst({
      where: and(eq(policies.userId, userId), isNull(policies.deletedAt)),
      columns: { id: true },
    }),
  ]);

  if (!user) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  if (ahaEvent) {
    const meta = (ahaEvent.metadata ?? {}) as Record<string, unknown>;
    return NextResponse.json({
      achieved: true,
      achievedAt: ahaEvent.createdAt,
      hoursToFirst: typeof meta.hoursToFirst === 'number' ? meta.hoursToFirst : null,
      withinAhaWindow: typeof meta.withinAhaWindow === 'boolean' ? meta.withinAhaWindow : null,
      ahaWindowHours: AHA_WINDOW_HOURS,
    });
  }

  // Not yet achieved — compute time remaining in AHA window
  const hoursSinceSignup =
    (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60);
  const hoursRemaining = Math.max(0, AHA_WINDOW_HOURS - hoursSinceSignup);

  return NextResponse.json({
    achieved: false,
    hoursSinceSignup: Math.round(hoursSinceSignup * 100) / 100,
    hoursRemaining: Math.round(hoursRemaining * 100) / 100,
    ahaWindowHours: AHA_WINDOW_HOURS,
    expired: hoursSinceSignup > AHA_WINDOW_HOURS,
    hasPolicies: anyPolicy !== undefined,
  });
}
