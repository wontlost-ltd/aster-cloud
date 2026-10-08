// aster-cloud → aster-api Plan 缓存失效客户端
// 详见 aster-deploy/docs/pm/06-cross-service-plan-gate.md
//
// webhook 处理 plan 升级 / 降级 / grandfather 切换后立即调用，
// 让 aster-api 端 5 min Caffeine 缓存立即失效，缩短生效延迟。

import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, teams } from '@/lib/prisma';
import { safeEnv } from '@/lib/runtime/safe-env';

const ASTER_API_INTERNAL_URL = safeEnv('ASTER_API_INTERNAL_URL') ?? 'http://aster-api:8080';
const PLAN_GATE_HMAC_KEY = safeEnv('ASTER_PLAN_GATE_HMAC_KEY');

/**
 * 通知 aster-api 让指定 tenant 的 plan 缓存立即失效
 *
 * 失败永远不抛异常给业务路径——5 min 自动 TTL 会兜底。
 */
export async function invalidatePlanCache(tenantId: string): Promise<void> {
  await callInvalidate(`/api/internal/plan-cache/${tenantId}`, 'plan-cache', tenantId);
}

/**
 * owner 套餐变化时，其名下每个团队在 aster-api 的 plan 缓存都要失效
 * （团队 key 的限速按 owner 套餐，ADR 0015 §5）。
 *
 * 与单租户失效同样 fail-open：查库失败也只记日志，5 min TTL 兜底。
 */
export async function invalidatePlanCacheForOwner(ownerId: string): Promise<void> {
  if (!ownerId) return;
  try {
    const owned = await db.query.teams.findMany({ where: eq(teams.ownerId, ownerId), columns: { id: true } });
    await Promise.all(owned.map((team) => invalidatePlanCache(team.id)));
  } catch (err) {
    console.warn(`[plan-gate-client] invalidate owner teams ${ownerId} error:`, err);
  }
}

/**
 * 通知 aster-api 让指定 user 的 API key 缓存全部失效
 *
 * 触发场景：
 *   - DUN-4 auto-downgrade 把 apiKeys.revokedAt 写入后
 *   - 用户主动撤销 key（API key DELETE）
 *   - subscription 被 Stripe 删除
 *
 * 与 plan-cache 同样的 fail-open 策略：失败由 aster-api verify 本地缓存的 60 s TTL 兜底。
 */
export async function invalidateApiKeyCache(userId: string): Promise<void> {
  await callInvalidate(`/api/internal/apikey-cache/${userId}`, 'apikey-cache', userId);
}

async function callInvalidate(path: string, label: string, id: string): Promise<void> {
  if (!id) return;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {};
    if (PLAN_GATE_HMAC_KEY) {
      const message = `DELETE\n${path}\n${timestamp}`;
      headers['X-Aster-Timestamp'] = String(timestamp);
      headers['X-Aster-Signature'] = createHmac('sha256', PLAN_GATE_HMAC_KEY)
        .update(message)
        .digest('hex');
    }
    // 透传或新建 W3C traceparent，让 aster-api 端的 OTel span 能串起来
    const { newTraceContext } = await import('@/lib/trace-context');
    headers['traceparent'] = newTraceContext().traceparent;

    const res = await fetch(`${ASTER_API_INTERNAL_URL}${path}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      console.warn(
        `[plan-gate-client] invalidate ${label} ${id} failed: HTTP ${res.status} traceparent=${headers['traceparent']}`
      );
    }
  } catch (err) {
    console.warn(`[plan-gate-client] invalidate ${label} ${id} error:`, err);
  }
}
