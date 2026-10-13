import { NextResponse } from 'next/server';
import { verifyInternalSignature } from '@/lib/internal-signature';
import { checkAiQuota } from '@/lib/ai-quota';

/**
 * 内部接口：aster-api 调用此端点检查用户的 AI 配额
 *
 * GET /api/internal/ai/quota?userId=...
 *   {allowed: true, remaining: 7, limit: 20, usedByok: false}
 *
 * 失败时返回 402 + 标准 upgrade response 形态。
 */
export async function GET(req: Request) {
  // HMAC 验签（与 PlanGate 共用 ASTER_PLAN_GATE_HMAC_KEY）
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

  const result = await checkAiQuota(userId);
  return NextResponse.json(result);
}
