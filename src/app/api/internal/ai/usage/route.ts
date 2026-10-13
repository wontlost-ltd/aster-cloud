import { NextResponse } from 'next/server';
import { verifyInternalSignature } from '@/lib/internal-signature';
import { recordAiUsage } from '@/lib/ai-quota';

/**
 * 内部接口：aster-api 调用 LLM 完成后记录实际 token 用量
 *
 * POST /api/internal/ai/usage
 */
export async function POST(req: Request) {
  const sharedKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  // Fail-closed: without the shared HMAC key we cannot authenticate the
  // caller, so refuse to serve rather than leak data (audit #168).
  if (!sharedKey) {
    return NextResponse.json({ error: 'Internal verification unavailable' }, { status: 503 });
  }
  // ★先读原始文本再验签再解析：v2 canonical 绑定 bodyHash，而 Request body
  // 只能读一次，顺序不可颠倒。原 canonical 不绑 body，攻击者拿到一次签名
  // 即可换掉 body 无限重放（本路由 body 完全由调用方控制）。
  const rawBody = await req.text();
  const verified = await verifyInternalSignature(req, rawBody, sharedKey);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 401 });
  }

  const body = (JSON.parse(rawBody)) as Parameters<typeof recordAiUsage>[0];
  await recordAiUsage(body);
  return NextResponse.json({ ok: true });
}
