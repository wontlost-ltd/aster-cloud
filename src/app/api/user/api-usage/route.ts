// 用户 Policy Execution API 用量查询（dashboard 卡片用）
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, users } from '@/lib/prisma';
import { eq, gte, sql } from 'drizzle-orm';
import { getEffectiveLimits, type PlanType } from '@/lib/plans';
import { countOwnerPoolUsage, currentPeriodMonth } from '@/lib/api-quota-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Postgres "undefined_table" 错误码。当 ApiCallRecord 迁移尚未应用时，
 * 查询会抛此错误。我们 catch + 返回空 payload，dashboard 卡片显示 0 调用，
 * 而不是整张卡片 500。一旦 0007_api_call_record_and_ai_audit_columns
 * 迁移落地，错误自然消失。
 */
const PG_UNDEFINED_TABLE = '42P01';

function isUndefinedTable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code?: string }).code === PG_UNDEFINED_TABLE;
  }
  // 兜底：某些 driver 不暴露 code，只能看 message
  const msg = err instanceof Error ? err.message : String(err);
  return /relation .* does not exist/i.test(msg);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { plan: true, priceLockedAt: true, legacyTier: true },
  });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const limits = getEffectiveLimits({
    plan: user.plan as PlanType,
    priceLockedAt: user.priceLockedAt,
    legacyTier: user.legacyTier,
  });
  const limit = limits.apiCalls;
  const period = currentPeriodMonth();

  let usedCount = 0;
  let latRow: { p50: number | null; p95: number | null; sample_count: number } = {
    p50: 0,
    p95: 0,
    sample_count: 0,
  };
  let trend: Array<{ day: string; calls: number }> = [];
  let degraded = false;

  try {
    // 月度用量口径与 precheck 一致：本人即配额 owner，计入其名下团队 key 的调用（ADR 0015 §4）。
    usedCount = await countOwnerPoolUsage(userId, period);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const latencyResult = await db.execute(sql`
      SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY "latencyMs")::int AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs")::int AS p95,
        count(*)::int AS sample_count
      FROM "ApiCallRecord"
      WHERE "userId" = ${userId}
        AND "createdAt" >= ${sevenDaysAgo.toISOString()}::timestamp
        AND status = 'success'
    `);
    latRow =
      (latencyResult as unknown as Array<typeof latRow>)[0] ?? latRow;

    const trendResult = await db.execute(sql`
      SELECT
        date_trunc('day', "createdAt")::date::text AS day,
        count(*)::int AS calls
      FROM "ApiCallRecord"
      WHERE "userId" = ${userId}
        AND "createdAt" >= ${sevenDaysAgo.toISOString()}::timestamp
        AND status = 'success'
      GROUP BY 1
      ORDER BY 1
    `);
    trend = trendResult as unknown as Array<{ day: string; calls: number }>;
  } catch (err) {
    if (isUndefinedTable(err)) {
      // 迁移未应用，dashboard 仍可用：返回 0 调用 + degraded 标记。
      console.warn('[api-usage] ApiCallRecord table missing; returning zero usage');
      degraded = true;
    } else {
      throw err;
    }
  }
  void gte;

  return NextResponse.json({
    plan: user.plan,
    period,
    monthly: {
      used: usedCount,
      limit,
      remaining: limit === -1 ? -1 : Math.max(0, limit - usedCount),
      percent: limit === -1 ? 0 : Math.min(999, Math.round((usedCount / Math.max(limit, 1)) * 100)),
    },
    latency: {
      p50: latRow.p50 ?? 0,
      p95: latRow.p95 ?? 0,
      sampleCount: latRow.sample_count,
    },
    trend,
    degraded,
  });
}
