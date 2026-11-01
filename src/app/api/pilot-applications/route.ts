/**
 * POST /api/pilot-applications —— 需求验证落地页的「申请试点」表单（仅 SaaS）。
 *
 * 防灌表：
 * - 蜜罐：表单里有一个对真人隐藏的 `website` 字段，非空即判定为脚本，返回与成功同形的 200 但不落库，
 *   避免脚本据响应调整；
 * - 按 IP 分布式限流（RateLimitPresets.PILOT_APPLICATION，与注册同一套 checkRateLimitDistributed）。
 *
 * 落库后记 pilot_application_submitted 事件：只带落地页、语种、是否个人邮箱与来源归因，不带邮箱 / 公司。
 */
import { NextResponse } from 'next/server';
import { IS_SAAS } from '@/lib/deployment-mode';
import { getClientIp, RateLimitPresets } from '@/lib/rate-limit';
import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';
import { insertPilotApplication, parsePilotApplication } from '@/lib/pilot-applications';
import { recordProductEventAfterResponse } from '@/lib/product-events/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 16 * 1024;
const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' } as const;

export async function POST(request: Request): Promise<NextResponse> {
  if (!IS_SAAS) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const rate = await checkRateLimitDistributed(
    `pilot-application:${getClientIp(request)}`,
    RateLimitPresets.PILOT_APPLICATION,
  );
  if (!rate.allowed) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { ...NO_STORE, ...(rate.retryAfterSeconds ? { 'Retry-After': String(rate.retryAfterSeconds) } : {}) },
      },
    );
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers: NO_STORE });
  }

  if (typeof body?.website === 'string' && body.website.trim() !== '') {
    return NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
  }

  const parsed = parsePilotApplication(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: 'invalid_field', field: parsed.field }, { status: 400, headers: NO_STORE });
  }

  try {
    await insertPilotApplication(parsed.value);
  } catch (err) {
    console.error('[pilot-applications] insert failed', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE });
  }

  const v = parsed.value;
  recordProductEventAfterResponse('pilot_application_submitted', {
    properties: {
      page: v.landingPage,
      locale: v.locale,
      freeMailDomain: v.freeMailDomain,
      utmSource: v.utmSource ?? undefined,
      utmMedium: v.utmMedium ?? undefined,
      utmCampaign: v.utmCampaign ?? undefined,
      utmTerm: v.utmTerm ?? undefined,
      utmContent: v.utmContent ?? undefined,
      referrerHost: v.referrerHost ?? undefined,
    },
  });
  return NextResponse.json({ ok: true }, { status: 201, headers: NO_STORE });
}
