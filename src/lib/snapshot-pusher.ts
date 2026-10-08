// 出站推送：cloud → aster-api 的 user/apikey snapshot
//
// 触发场景（详见 SNAP-4 的 6 个接入点）：
//   - stripe webhook plan 变更
//   - DUN-4 auto-downgrade
//   - apiKey 创建 / 撤销
//
// fail-open：失败仅日志，aster-api 端 1h TTL + warm-up cron 兜底。

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { db, users } from '@/lib/prisma';
import { eq } from 'drizzle-orm';
import { getEffectiveLimits, type PlanType } from '@/lib/plans';
import { safeEnv } from '@/lib/runtime/safe-env';
import { resolveApiKeyIdentity, toApiKeySnapshotBody } from '@/lib/api-key-identity';
import { invalidatePlanCacheForOwner } from '@/lib/plan-gate-client';

const ASTER_API_INTERNAL_URL =
  safeEnv('ASTER_API_INTERNAL_URL') ?? 'http://aster-api:8080';
const PLAN_GATE_HMAC_KEY = safeEnv('ASTER_PLAN_GATE_HMAC_KEY');

/**
 * 推送指定 user 的最新 snapshot 到 aster-api
 *
 * 在 cloud DB 状态变更后立即调用（webhook / cron）。
 * fail-open：失败仅日志，aster-api 1h TTL 兜底。
 */
export async function pushUserSnapshot(userId: string): Promise<void> {
  if (!userId) return;
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        plan: true,
        priceLockedAt: true,
        legacyTier: true,
        subscriptionStatus: true,
        aiBannedUntil: true,
        gracePeriodEndsAt: true,
      },
    });
    if (!user) {
      // 用户不存在 → 让 aster-api 端缓存自然过期
      return;
    }

    const limits = getEffectiveLimits({
      plan: user.plan as PlanType,
      priceLockedAt: user.priceLockedAt,
      legacyTier: user.legacyTier,
    });

    const body = JSON.stringify({
      plan: user.plan,
      apiCallsLimit: limits.apiCalls,
      subscriptionStatus: user.subscriptionStatus ?? null,
      aiBannedUntilEpochMs: user.aiBannedUntil?.getTime() ?? null,
      gracePeriodEndsEpochMs: user.gracePeriodEndsAt?.getTime() ?? null,
    });

    const path = `/api/internal/snapshot/user/${userId}`;
    await callAsterApi('POST', path, body, `push-user ${userId}`);
    // 团队 key 的限速按 owner 套餐：owner 快照变化后，其名下团队的 plan 缓存一并失效（ADR 0015 §5）
    await invalidatePlanCacheForOwner(userId);
  } catch (err) {
    console.warn(`[snapshot-pusher] pushUserSnapshot ${userId} error:`, err);
  }
}

/**
 * 推送指定 keyHash 的最新 snapshot 到 aster-api
 *
 * 在 apiKey 创建 / 撤销时立即调用。身份与快照体都取自解析器模块（resolveApiKeyIdentity +
 * toApiKeySnapshotBody，ADR 0015 §2），与 verify 路由、snapshot/full 同源：
 * 团队 key 下发 tenantId=teamId、成员角色与 quotaOwnerId=团队 owner。
 * 撤销场景下 valid=false + reason='revoked'，aster-api 端立即对应拒绝。
 */
export async function pushApiKeySnapshot(keyHash: string): Promise<void> {
  // keyHash 是 SHA-256 hex；校验 hex 而非仅长度，收紧输入卫生。
  if (!/^[0-9a-f]{64}$/i.test(keyHash)) return;
  try {
    const body = toApiKeySnapshotBody(await resolveApiKeyIdentity(keyHash));
    const path = `/api/internal/snapshot/apikey/${keyHash}`;
    await callAsterApi('POST', path, JSON.stringify(body), `push-apikey ${keyHash.slice(0, 8)}`);
  } catch (err) {
    console.warn(`[snapshot-pusher] pushApiKeySnapshot error:`, err);
  }
}

async function callAsterApi(
  method: 'POST',
  path: string,
  body: string,
  label: string
): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (PLAN_GATE_HMAC_KEY) {
    // ★v2 canonical（2026-08-17 安全审计）：
    //     method \n path \n ts \n nonce \n sha256hex(body)
    //
    //   v1 只签 `method\npath\nts` —— 签名与请求体无关，也没有一次性凭证。
    //   后果：截获任意一条合法签名后，攻击者可在 5 分钟时间窗内**替换请求体**
    //   （例如把 role 改成 ADMIN、把 apiCallsLimit 改成无限）或**原样重放**，
    //   而签名依然通过。这些端点写入的正是 aster-api 鉴权决策所依赖的数据。
    //
    //   服务端在迁移窗口内同时接受 v1/v2
    //   （aster.security.snapshot.accept-legacy-signature，默认 true）；
    //   本改动发版后应把该开关置为 false 完成硬切。
    const nonce = randomUUID();
    const bodySha = createHash('sha256').update(body).digest('hex');
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodySha}`;
    headers['X-Aster-Timestamp'] = String(timestamp);
    headers['X-Aster-Nonce'] = nonce;
    headers['X-Aster-Signature'] = createHmac('sha256', PLAN_GATE_HMAC_KEY)
      .update(message)
      .digest('hex');
  }
  // OTEL-1: traceparent 透传
  const { newTraceContext } = await import('@/lib/trace-context');
  headers['traceparent'] = newTraceContext().traceparent;

  const res = await fetch(`${ASTER_API_INTERNAL_URL}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) {
    console.warn(`[snapshot-pusher] ${label} HTTP ${res.status}`);
  }
}
