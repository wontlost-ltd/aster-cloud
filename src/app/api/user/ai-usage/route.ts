// 用户 AI 用量查询（dashboard 进度条用）
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { db, users, aiUsageRecords, aiKeyBindings } from '@/lib/prisma';
import { eq, and, sum, sql, gte } from 'drizzle-orm';
import { AI_MONTHLY_QUOTA, AI_RATE_LIMIT_PER_MINUTE, countBillableCalls } from '@/lib/ai-quota';
import type { PlanType } from '@/lib/plans';

/**
 * 兼容迁移未应用的环境：捕获 Postgres undefined_table / undefined_column
 * 错误，返回 zero usage + degraded=true。dashboard 仍可渲染。
 */
function isMissingSchema(err: unknown): boolean {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: string }).code;
    return code === '42P01' || code === '42703'; // undefined_table / undefined_column
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /(relation|column) .* does not exist/i.test(msg);
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { plan: true, aiBannedUntil: true, aiBanReason: true, emailVerified: true },
  });
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const plan = user.plan as PlanType;
  const period = currentPeriod();

  let used = 0;
  let costCents = 0;
  let costTokens = 0;
  let perMinuteUsed = 0;
  let byokKeys: Array<{ provider: string; keyHint: string; lastUsedAt: Date | null }> = [];
  let degraded = false;

  try {
    // 当月已用次数（仅 平台 LLM，不含 BYOK）：与月配额门同一计费口径（含到达 provider 后失败的 api_error）。
    used = await countBillableCalls(userId, period);

    // 当月总成本（含 BYOK，给用户看真实消耗）
    const monthlyCost = await db
      .select({
        cents: sql<number>`coalesce(sum("costCents"), 0)::int`,
        tokens: sql<number>`coalesce(sum("promptTokens" + "completionTokens"), 0)::int`,
      })
      .from(aiUsageRecords)
      .where(and(eq(aiUsageRecords.userId, userId), eq(aiUsageRecords.periodMonth, period)));
    costCents = monthlyCost[0]?.cents ?? 0;
    costTokens = monthlyCost[0]?.tokens ?? 0;

    // BYOK 状态
    byokKeys = await db.query.aiKeyBindings.findMany({
      where: and(eq(aiKeyBindings.userId, userId), eq(aiKeyBindings.active, true)),
      columns: { provider: true, keyHint: true, lastUsedAt: true },
    });

    // 最近 1 分钟调用（用于显示限流警告）
    const lastMinute = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(aiUsageRecords)
      .where(
        and(
          eq(aiUsageRecords.userId, userId),
          gte(aiUsageRecords.createdAt, new Date(Date.now() - 60_000))
        )
      );
    perMinuteUsed = lastMinute[0]?.c ?? 0;
  } catch (err) {
    if (isMissingSchema(err)) {
      console.warn('[ai-usage] AiUsageRecord/AiKeyBinding schema missing; returning zero usage');
      degraded = true;
    } else {
      throw err;
    }
  }

  const monthlyLimit = AI_MONTHLY_QUOTA[plan as keyof typeof AI_MONTHLY_QUOTA] ?? 20;
  const perMinuteLimit = AI_RATE_LIMIT_PER_MINUTE[plan as keyof typeof AI_RATE_LIMIT_PER_MINUTE] ?? 5;

  return NextResponse.json({
    plan,
    period,
    monthly: {
      used,
      limit: monthlyLimit,
      remaining: monthlyLimit === -1 ? -1 : Math.max(0, monthlyLimit - used),
      percent: monthlyLimit === -1 ? 0 : Math.round((used / monthlyLimit) * 100),
    },
    cost: {
      cents: costCents,
      tokens: costTokens,
    },
    rateLimit: {
      perMinute: perMinuteLimit,
      perMinuteUsed,
    },
    byok: {
      enabled: byokKeys.length > 0,
      providers: byokKeys.map((k) => ({
        provider: k.provider,
        keyHint: k.keyHint,
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      })),
    },
    banned: user.aiBannedUntil && user.aiBannedUntil > new Date()
      ? { until: user.aiBannedUntil.toISOString(), reason: user.aiBanReason }
      : null,
    emailVerified: !!user.emailVerified,
    degraded,
  });
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

void sum; // 保留 import
