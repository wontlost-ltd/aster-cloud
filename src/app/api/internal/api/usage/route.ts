/**
 * Policy Execution API 配额查询 + 记录
 *
 * GET ?userId=xxx&periodMonth=YYYY-MM   → 当月已用次数（userId 为配额 owner，按 owner 共享池统计）
 * POST { userId, tenantId, quotaOwnerId?, endpointPath, status, latencyMs }  → 记录一次调用
 *
 * 由 aster-api PolicyEvaluationResource 调用（HMAC 验签）。
 */
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { verifyInternalSignature } from '@/lib/api-signing';
import { db, apiCallRecords, apiKeys } from '@/lib/prisma';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { countOwnerPoolUsage, currentPeriodMonth } from '@/lib/api-quota-pool';

/**
 * 入站验签，收敛到 verifyInternalSignature（2026-07-29 审计修复）。
 *
 * 原实现 canonical 只有 `method\npath\ntimestamp` —— 不绑定 body、无 nonce，
 * 攻击者拿到一次签名即可在 300s 内**换掉 body 无限重放**。本路由的 body
 * 完全由调用方控制，重放可为任意 userId 伪造用量记录、篡改计费归属。
 *
 * rawBody 由调用方先 text() 读出后传入：v2 canonical 绑定 bodyHash，
 * 而 Request body 只能读一次。GET 传空串。
 */
async function verifyHmac(req: Request, rawBody: string): Promise<NextResponse | null> {
  const sharedKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  // Fail-closed: without the shared HMAC key we cannot authenticate the
  // caller, so refuse to serve rather than leak/mutate data (audit #168).
  if (!sharedKey) {
    return NextResponse.json({ error: 'Internal verification unavailable' }, { status: 503 });
  }
  const verified = await verifyInternalSignature(req, rawBody, sharedKey);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 401 });
  }
  return null;
}

export async function GET(req: Request) {
  const err = await verifyHmac(req, '');
  if (err) return err;

  const url = new URL(req.url);
  const userId = url.searchParams.get('userId');
  const periodMonth = url.searchParams.get('periodMonth') ?? currentPeriodMonth();
  if (!userId) {
    return NextResponse.json({ error: 'Missing userId' }, { status: 400 });
  }

  const used = await countOwnerPoolUsage(userId, periodMonth);

  return NextResponse.json({
    userId,
    periodMonth,
    used,
  });
}

export async function POST(req: Request) {
  // ★先读原始文本再验签再解析：v2 绑定 bodyHash，body 只能读一次
  const rawBody = await req.text();
  const err = await verifyHmac(req, rawBody);
  if (err) return err;

  const body = JSON.parse(rawBody) as {
    userId: string;
    tenantId?: string;
    apiKeyId?: string;
    /** 配额 owner（ADR 0015 §4）：团队 key 为团队 owner；旧版 aster-api 不传（或传 null）时按调用者本人归池。 */
    quotaOwnerId?: string | null;
    endpointPath: string;
    status: 'success' | 'quota_exhausted' | 'rate_limited' | 'api_error';
    latencyMs?: number;
  };

  if (!body.userId || !body.endpointPath || !body.status) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // quotaOwnerId 决定这次调用计入哪个 owner 池。TS 类型只是断言，JSON 里可能是空串、纯空白、数字或对象：
  // 原样落库会形成不属于任何真实 owner 的池（非 NULL、无外键），调用就此逃逸配额，故必须拒绝。
  const quotaOwnerId: unknown = body.quotaOwnerId;
  if (quotaOwnerId != null && (typeof quotaOwnerId !== 'string' || quotaOwnerId.trim() === '')) {
    return NextResponse.json({ error: 'Invalid quotaOwnerId' }, { status: 400 });
  }

  // insert 与 lastUsedAt 更新共用同一时刻，保证事实记录与派生展示字段一致。
  const usedAt = new Date();

  await db.insert(apiCallRecords).values({
    id: randomUUID(),
    userId: body.userId,
    tenantId: body.tenantId ?? null,
    apiKeyId: body.apiKeyId ?? null,
    quotaOwnerId: body.quotaOwnerId ?? body.userId,
    periodMonth: currentPeriodMonth(),
    endpointPath: body.endpointPath,
    status: body.status,
    latencyMs: body.latencyMs ?? 0,
    createdAt: usedAt,
  });

  // 更新 API key 的"最后使用"时间戳。此前 apiKeys.lastUsedAt 仅由 cloud 侧
  // validateApiKey 更新（key 打 aster-cloud BFF 时），而打 aster-api 后端
  // （policy.aster-lang.dev）的调用只写 apiCallRecords、不碰 lastUsedAt →
  // dashboard 对纯 API 后端用量的 key 永远显示"从未使用"。aster-api 已对每次
  // 调用上报 cloud 的 apiKeys.id（经 /api/internal/apikey/verify 解析），故在此
  // 补齐派生字段即可闭合该展示缺口，无需改动 aster-api。
  //
  // 语义：与 validateApiKey 一致，"最后使用"=最后一次以该 key 发起调用（不区分
  // success / api_error / rate_limited / quota_exhausted），故不按 status 过滤。
  // best-effort：lastUsedAt 是派生展示字段，更新失败不应回滚上面的 apiCallRecords
  // 事实写入，也不影响响应。单调 where 守卫（lastUsedAt IS NULL OR < usedAt）避免
  // 高并发下旧请求晚到把时间戳往回退。
  if (body.apiKeyId) {
    try {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: usedAt })
        .where(
          and(
            eq(apiKeys.id, body.apiKeyId),
            or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, usedAt))
          )
        );
    } catch (e) {
      // body.apiKeyId 直接来自请求 body（用户可控）——不拼进 console.warn 首参（会被当
      // 格式串解析 %s/%d/%o 等）；改用 %s 占位参数化传入，规避格式串注入。
      console.warn(
        '[usage] failed to update apiKeys.lastUsedAt for apiKeyId=%s:',
        body.apiKeyId,
        e
      );
    }
  }

  return NextResponse.json({ ok: true });
}
