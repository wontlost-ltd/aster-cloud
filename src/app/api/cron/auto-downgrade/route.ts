/**
 * 自动降级 cron（每天 07:00 UTC）
 *
 * 找出 grace period 已到期且仍未付款的用户，执行降级到 Free：
 *   - plan = 'free'
 *   - subscriptionStatus = 'canceled'
 *   - downgradedAt = now（30 天恢复窗口起点）
 *   - 吊销其个人 apiKeys（revokedAt = now）；团队 key 不动——其门槛随团队 owner 的套餐，
 *     由身份解析器 / precheck 判定，成员本人降级不能把它永久吊销（ADR 0015 §5）
 *   - 写 audit log + 发降级邮件
 *
 * 数据保留：已发布 policy 不删，30 天内重新付款可恢复（GDPR cleanup cron 60 天后才动手）
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { CAN_BILLING } from '@/lib/deployment-mode';
import { db, users, apiKeys, auditLogs } from '@/lib/prisma';
import { and, eq, lt, inArray, isNull } from 'drizzle-orm';
import { getResend } from '@/lib/resend';
import { invalidatePlanCache, invalidateApiKeyCache } from '@/lib/plan-gate-client';
import { pushUserSnapshot } from '@/lib/snapshot-pusher';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DowngradeResult {
  userId: string;
  email: string;
  plan: string;
  /** 本次吊销的个人 key 数（teamId IS NULL）；团队 key 不在其内 */
  apiKeysDisabled: number;
  notified: boolean;
}

export async function GET(request: NextRequest) {
  // On-prem 没有 Stripe 订阅 → 没有 grace period → 没有自动降级。
  if (!CAN_BILLING) {
    return new NextResponse(null, { status: 404 });
  }

  // R21-Critical-2: fail-closed cron auth via shared helper
  const guard = requireCronAuth(request);
  if (guard) return guard;

  const now = new Date();
  // 找出 grace 已过期 + 仍欠费的用户
  const expired = await db.query.users.findMany({
    where: and(
      inArray(users.subscriptionStatus, ['past_due', 'unpaid']),
      lt(users.gracePeriodEndsAt, now)
    ),
    columns: {
      id: true,
      email: true,
      name: true,
      plan: true,
      gracePeriodEndsAt: true,
    },
  });

  const results: DowngradeResult[] = [];

  for (const u of expired) {
    if (u.plan === 'free') continue; // 已经是 free，跳过

    // 1. 降级 user
    await db
      .update(users)
      .set({
        plan: 'free',
        subscriptionStatus: 'canceled',
        downgradedAt: now,
      })
      .where(eq(users.id, u.id));

    // 2. 撤销该用户未撤销的个人 apiKeys（revokedAt = now）。团队 key 计入团队 owner 的池、
    //    门槛随 owner 套餐，成员个人套餐到期不影响它（ADR 0015 §5）
    const disabledKeys = await db
      .update(apiKeys)
      .set({ revokedAt: now })
      .where(and(eq(apiKeys.userId, u.id), isNull(apiKeys.revokedAt), isNull(apiKeys.teamId)))
      .returning({ id: apiKeys.id });

    // 3. audit log
    await db.insert(auditLogs).values({
      id: globalThis.crypto.randomUUID(),
      userId: u.id,
      action: 'subscription.auto_downgraded',
      resource: 'user',
      resourceId: u.id,
      metadata: {
        previous_plan: u.plan,
        // 被吊销的个人 key 数（团队 key 不吊销，不计入）
        api_keys_disabled: disabledKeys.length,
        grace_period_ends_at: u.gracePeriodEndsAt?.toISOString(),
      },
    });

    // 4. 邀失效 plan-gate 缓存（aster-api 立即生效新档位）
    try {
      await invalidatePlanCache(u.id);
    } catch {
      // 失败不阻塞——cache TTL 短，最多几分钟后自然刷新
    }

    // 5. 邀失效 aster-api 端的 apikey 缓存
    // DB 已把 revokedAt 写入；让 aster-api 的 60 s verify 本地缓存立即放弃旧值
    try {
      await invalidateApiKeyCache(u.id);
    } catch {
      // 同 plan-cache fail-open
    }

    // 5.5 SNAP-4: 推送降级后的 user snapshot（aster-api 本地 redis）
    try {
      await pushUserSnapshot(u.id);
    } catch {
      // fail-open
    }

    // 6. 通知邮件
    let notified = false;
    const resend = await getResend();
    if (u.email && resend) {
      try {
        await resend.emails.send({
          from: `Aster Cloud <${process.env.RESEND_FROM_EMAIL || 'noreply@aster-lang.cloud'}>`,
          to: u.email,
          subject: '[Aster] Your account has been downgraded to Free',
          text:
            `Hi ${u.name || 'there'},\n\n` +
            `Despite multiple retry attempts, payment for your ${u.plan} plan was not resolved. ` +
            `Your account has been automatically downgraded to Free.\n\n` +
            `What this means:\n` +
            `• Personal API access has been disabled\n` +
            `• AI features now run on Free quota\n` +
            `• Your policies and data are preserved (read-only) for 30 days\n` +
            `• Outstanding invoices remain due (Stripe may continue collection)\n\n` +
            `Reactivate within 30 days to restore everything:\n` +
            `${process.env.NEXT_PUBLIC_APP_URL || 'https://aster-lang.cloud'}/billing\n\n` +
            `— Aster Team`,
        });
        notified = true;
      } catch (err) {
        console.warn(`[auto-downgrade] notify failed for ${u.email}:`, (err as Error).message);
      }
    }

    results.push({
      userId: u.id,
      email: u.email ?? '',
      plan: u.plan,
      apiKeysDisabled: disabledKeys.length,
      notified,
    });
  }

  return NextResponse.json({
    scanned: expired.length,
    downgraded: results.length,
    results,
  });
}
