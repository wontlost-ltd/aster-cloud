/**
 * POST /api/product-events —— 浏览器侧产品分析事件上报（落地页访问、模板选择、审批收件箱访问）。
 *
 * - 只接受 CLIENT_PRODUCT_EVENTS 内的事件；注册、首次保存 / 执行、证据导出等只能由服务端记录，
 *   不给客户端伪造漏斗的入口。
 * - actor 只取会话用户（假名化后落库），body 里的任何身份字段都被忽略；匿名访问 actor 为空。
 * - 属性由 recordProductEvent 按事件白名单过滤；这里只做大小与形状的前置拦截。
 * - 按 IP 走分布式限流（与登录 / 注册同一套 checkRateLimitDistributed）；常见爬虫 UA 不记录；仅 SaaS。
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getClientIp, RateLimitPresets } from '@/lib/rate-limit';
import { checkRateLimitDistributed } from '@/lib/rate-limit-distributed';
import { CLIENT_PRODUCT_EVENTS, isProductEventName } from '@/lib/product-events/definitions';
import { recordProductEventAfterResponse } from '@/lib/product-events/server';
import { isBotUserAgent } from '@/lib/product-events/bot-filter';
import { IS_SAAS } from '@/lib/deployment-mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 8 * 1024;
const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' } as const;

async function sessionUserId(): Promise<string | null> {
  try {
    const session = await auth();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // 需求验证只在 SaaS 进行；on-prem 部署不提供上报入口。
  if (!IS_SAAS) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const rate = await checkRateLimitDistributed(
    `product-events:${getClientIp(request)}`,
    RateLimitPresets.API_RELAXED,
  );
  if (!rate.allowed) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: NO_STORE });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413, headers: NO_STORE });
  }
  let body: { name?: unknown; properties?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400, headers: NO_STORE });
  }
  const name = body?.name;
  if (!isProductEventName(name) || !CLIENT_PRODUCT_EVENTS.includes(name)) {
    return NextResponse.json({ error: 'unknown_event' }, { status: 400, headers: NO_STORE });
  }

  // 爬虫 / 预览 / 自动化客户端：同形 202 但不记录，避免把机器访问算进需求指标。
  if (isBotUserAgent(request.headers.get('user-agent'))) {
    return NextResponse.json({ ok: true }, { status: 202, headers: NO_STORE });
  }

  recordProductEventAfterResponse(name, { userId: await sessionUserId(), properties: body.properties });
  return NextResponse.json({ ok: true }, { status: 202, headers: NO_STORE });
}
