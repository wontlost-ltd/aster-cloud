/**
 * 全量 snapshot 拉取（aster-api warm-up + 1h 对账 cron 调用）
 *
 * GET ?cursor=<userId>&limit=1000
 *   → { users: [...], apiKeys: [...], nextCursor: <userId> | null }
 *
 * users 与 apiKeys 一并返回（按 userId 排序，cursor 是上一页最后一个 userId）。
 */
import { NextResponse } from 'next/server';
import { verifyInternalSignature } from '@/lib/api-signing';
import { db, users, apiKeys } from '@/lib/prisma';
import { gt, asc, and, inArray, isNull } from 'drizzle-orm';
import { getEffectiveLimits, type PlanType } from '@/lib/plans';
import { API_KEY_IDENTITY_COLUMNS, resolveApiKeyIdentities } from '@/lib/api-key-identity';

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
  const cursor = url.searchParams.get('cursor');
  // limit 缺省 1000；显式传入必须是 [1,5000] 的有限整数。parseInt('abc')→NaN
  // 会经 Math.min 透传成 NaN 再喂给 Drizzle limit（500 或异常 SQL），故先校验。
  const limitParam = url.searchParams.get('limit');
  let limit = 1000;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5000) {
      return NextResponse.json(
        { error: 'limit must be an integer between 1 and 5000' },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  const userRows = await db.query.users.findMany({
    where: cursor ? gt(users.id, cursor) : undefined,
    orderBy: asc(users.id),
    limit,
    columns: {
      id: true,
      plan: true,
      priceLockedAt: true,
      legacyTier: true,
      subscriptionStatus: true,
      aiBannedUntil: true,
      gracePeriodEndsAt: true,
    },
  });

  const userSnapshots = userRows.map((u) => {
    const lim = getEffectiveLimits({
      plan: u.plan as PlanType,
      priceLockedAt: u.priceLockedAt,
      legacyTier: u.legacyTier,
    });
    return {
      userId: u.id,
      plan: u.plan,
      apiCallsLimit: lim.apiCalls,
      subscriptionStatus: u.subscriptionStatus ?? null,
      aiBannedUntilEpochMs: u.aiBannedUntil?.getTime() ?? null,
      gracePeriodEndsEpochMs: u.gracePeriodEndsAt?.getTime() ?? null,
    };
  });

  // 同窗口内的所有 active apiKeys（仅 valid + 未撤销）
  const userIds = userRows.map((u) => u.id);
  let keyRows: Array<{ id: string; userId: string; teamId: string | null; key: string; revokedAt: Date | null; expiresAt: Date | null }> = [];
  if (userIds.length > 0) {
    // 把 userId 过滤下推到 SQL（inArray + ApiKey_userId_idx），而不是全表
    // 拉 active keys 再在内存里 filter——后者随 key 总量线性膨胀、与 limit
    // 无关，warmup 内存/延迟会随规模失控。
    keyRows = await db.query.apiKeys.findMany({
      where: and(isNull(apiKeys.revokedAt), inArray(apiKeys.userId, userIds)),
      columns: { ...API_KEY_IDENTITY_COLUMNS, key: true },
    });
  }

  // 身份口径与 verify 路由同源（ADR 0015 §2）；成员已被移出的团队 key 以 valid:false 下发，让 warmup 顺手失效它
  const identities = await resolveApiKeyIdentities(keyRows);
  const apiKeySnapshots = keyRows.map((k) => {
    const id = identities.get(k.id);
    if (!id || !id.valid) {
      return { keyHash: k.key, valid: false, reason: id?.reason ?? 'not_found', revokedAtEpochMs: k.revokedAt?.getTime() ?? null };
    }
    return {
      keyHash: k.key,
      valid: true,
      apiKeyId: id.apiKeyId,
      userId: id.userId,
      tenantId: id.tenantId,
      quotaOwnerId: id.quotaOwnerId,
      role: id.role,
      plan: id.plan,
      revokedAtEpochMs: null,
    };
  });

  const nextCursor = userRows.length === limit ? userRows[userRows.length - 1].id : null;

  return NextResponse.json({
    users: userSnapshots,
    apiKeys: apiKeySnapshots,
    nextCursor,
  });
}
