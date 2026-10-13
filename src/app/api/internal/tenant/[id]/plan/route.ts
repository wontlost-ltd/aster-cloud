import { NextResponse } from 'next/server';
import { verifyInternalSignature } from '@/lib/internal-signature';
import { db, users, teams } from '@/lib/prisma';
import { eq } from 'drizzle-orm';
import { getEffectiveLimits, type PlanType } from '@/lib/plans';

/**
 * 内部接口：返回租户当前 plan 信息
 *
 * 由 aster-api 的 PlanGateService 调用，做审批流 plan gate 等场景。
 *
 * 安全：
 *   - HMAC 签名验证（生产强制；dev 缺省共享密钥时跳过）
 *   - 仅返回最小必要字段（plan / legacyTier / approvalRequired / maxTeamMembers / evaluationsLimit）
 *
 * tenantId 解析规则（与 aster-api 调用方约定一致）：
 *   1. 先匹配 teams.id（teamId 即 tenant）
 *   2. 否则按 userId 兜底（个人账户即 tenant）
 *
 * 详见 aster-deploy/docs/pm/06-cross-service-plan-gate.md
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tenantId = (await params).id;
  if (!tenantId) {
    return NextResponse.json({ error: 'Missing tenant id' }, { status: 400 });
  }

  // HMAC 验签：dev 可缺省 ASTER_PLAN_GATE_HMAC_KEY；生产强制
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

  // 解析 tenantId：先 team，否则 user
  let user: typeof users.$inferSelect | null = null;

  const team = await db.query.teams.findFirst({ where: eq(teams.id, tenantId) });
  if (team) {
    // 用 team owner 的 plan 表示 team 档位。
    //
    // ★此前这里查的是 teamMembers（只按 teamId 过滤、无 role 条件、无排序），
    // Postgres 返回哪一行是任意的——于是「owner 是 Enterprise、首个返回的成员是
    // Free」的团队会被判成 free，且**同一租户多次调用可能得到不同结果**。
    // aster-api 的 PlanGateService 据此做审批门禁与用量上限，档位取错即整队被
    // 错误限流或错误放行。
    //
    // teams.ownerId 是 notNull 的权威字段，直接用它，不必绕经成员表。
    user = await db.query.users.findFirst({ where: eq(users.id, team.ownerId) }) ?? null;
  }

  if (!user) {
    user = await db.query.users.findFirst({ where: eq(users.id, tenantId) }) ?? null;
  }

  if (!user) {
    // 找不到的 tenant 按 free 处理；plan-gate fail-open=true 时业务侧继续
    return NextResponse.json({
      plan: 'free',
      legacyTier: null,
      allowsApproval: false,
      maxTeamMembers: 1,
      evaluationsLimit: 1000,
      apiCallsLimit: 0,
      // 找不到租户按 free 处理：What-If 不提供（ADR 0034 §7.2）
      concurrentReplayBatches: 0,
    });
  }

  const limits = getEffectiveLimits({
    plan: user.plan as PlanType,
    priceLockedAt: user.priceLockedAt,
    legacyTier: user.legacyTier,
  });

  return NextResponse.json({
    plan: user.plan,
    legacyTier: user.legacyTier ?? null,
    allowsApproval: limits.approvalRequired,
    maxTeamMembers: limits.maxTeamMembers,
    evaluationsLimit: limits.evaluations,
    apiCallsLimit: limits.apiCalls,
    // What-If 并发批次上限（ADR 0034 §7.2）：0=无此功能，-1=不限
    concurrentReplayBatches: limits.concurrentReplayBatches,
  });
}
