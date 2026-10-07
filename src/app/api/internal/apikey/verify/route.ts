/**
 * 内部接口：API key 验证（HMAC 签名）
 *
 * POST { keyHash: "<sha256-hex>" } → {
 *   valid, apiKeyId?, userId?, tenantId?, quotaOwnerId?, plan?, subscriptionStatus?, role?,
 *   reason?, revokedAt?, expiredAt?
 * }
 *
 * 由 aster-api ApiKeyVerifierService 调用（5min Caffeine 缓存）。
 * 身份（tenantId / role / quotaOwnerId / plan）一律取自 resolveApiKeyIdentity；
 * 个人 key 与团队 key 的映射见 ADR 0015 §2。
 */
import { NextResponse } from 'next/server';
import { verifyInternalSignature } from '@/lib/api-signing';
import { resolveApiKeyIdentity } from '@/lib/api-key-identity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // HMAC 验签（与 plan-gate 同一套密钥）
  const sharedKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  // Fail-closed: without the shared HMAC key we cannot authenticate the
  // caller, so refuse to serve rather than leak data (audit #168).
  if (!sharedKey) {
    return NextResponse.json({ error: 'Internal verification unavailable' }, { status: 503 });
  }
  // ★body 必须先以文本读出：v2 canonical 绑定 bodyHash，而 Request body 只能读一次。
  // 先 text() 再 JSON.parse，顺序不可颠倒。
  const rawBody = await req.text();

  const verified = await verifyInternalSignature(req, rawBody, sharedKey);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 401 });
  }

  let body: { keyHash?: string };
  try {
    body = JSON.parse(rawBody) as { keyHash?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (typeof body.keyHash !== 'string' || !/^[0-9a-f]{64}$/i.test(body.keyHash)) {
    return NextResponse.json({ error: 'Missing or invalid keyHash (expect 64 hex chars)' }, { status: 400 });
  }

  const identity = await resolveApiKeyIdentity(body.keyHash);
  if (!identity.valid) {
    return NextResponse.json({
      valid: false,
      reason: identity.reason,
      ...(identity.revokedAt ? { revokedAt: identity.revokedAt.toISOString() } : {}),
      ...(identity.expiredAt ? { expiredAt: identity.expiredAt.toISOString() } : {}),
    });
  }
  // 字段顺序与旧响应一致，仅追加 quotaOwnerId；aster-api 按键读取，顺序无关
  return NextResponse.json({
    valid: true,
    apiKeyId: identity.apiKeyId,
    userId: identity.userId,
    tenantId: identity.tenantId,
    quotaOwnerId: identity.quotaOwnerId,
    plan: identity.plan,
    subscriptionStatus: identity.subscriptionStatus,
    role: identity.role,
  });
}
