/**
 * 一次 RTT 完成 plan + usage + ban 检查（合并 AKA-8）
 *
 * 替代之前的两次调用：
 *   1. /api/internal/tenant/{userId}/plan
 *   2. /api/internal/api/usage?userId=...
 *
 * 返回 aster-api ApiQuotaGuard.check() 需要的所有字段。
 *
 * `userId` 参数语义是配额 owner（ADR 0015 §4）：团队 key 由 aster-api 传团队 owner，
 * 个人 key 传本人；套餐、封禁与月度用量都按该 owner 取，用量走 owner 共享池。
 */
import { NextResponse } from 'next/server';
import { verifyInternalSignature } from '@/lib/api-signing';
import { db, users } from '@/lib/prisma';
import { eq } from 'drizzle-orm';
import { getEffectiveLimits, type PlanType } from '@/lib/plans';
import { countOwnerPoolUsage, currentPeriodMonth } from '@/lib/api-quota-pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const sharedKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  // Fail-closed: without the shared HMAC key we cannot authenticate the
  // caller, so refuse to serve rather than leak data (audit #168).
  if (!sharedKey) {
    return NextResponse.json({ error: 'Internal verification unavailable' }, { status: 503 });
  }
  // 入站验签收敛到 verifyInternalSignature（2026-07-29 审计修复）：原 canonical
  // 只有 method/path/timestamp 三段——不绑定 body 与 query、无 nonce，一次签名
  // 可在 300s 窗口内重放。共享实现优先按 v2（绑定 bodyHash + nonce）校验，
  // 并在迁移窗口内兼容 v1；待 aster-api 全部切换后由 env 关掉 v1。
  const verified = await verifyInternalSignature(req, '', sharedKey);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 401 });
  }

  const url = new URL(req.url);
  const userId = url.searchParams.get('userId');
  if (!userId) {
    return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      plan: true,
      priceLockedAt: true,
      legacyTier: true,
      subscriptionStatus: true,
      gracePeriodEndsAt: true,
      aiBannedUntil: true,
    },
  });
  if (!user) {
    // 未知用户：plan-gate fail-open 默认按 free 处理
    return NextResponse.json({
      plan: 'free',
      apiCallsLimit: 0,
      monthlyUsed: 0,
      banned: false,
    });
  }

  const limits = getEffectiveLimits({
    plan: user.plan as PlanType,
    priceLockedAt: user.priceLockedAt,
    legacyTier: user.legacyTier,
  });

  const period = currentPeriodMonth();
  const monthlyUsed = await countOwnerPoolUsage(userId, period);

  return NextResponse.json({
    plan: user.plan,
    legacyTier: user.legacyTier ?? null,
    subscriptionStatus: user.subscriptionStatus ?? null,
    apiCallsLimit: limits.apiCalls,
    monthlyUsed,
    period,
    banned: !!user.aiBannedUntil && user.aiBannedUntil > new Date(),
    gracePeriodEndsAt: user.gracePeriodEndsAt?.toISOString() ?? null,
  });
}
