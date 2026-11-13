/**
 * 登记 / 吊销签发方（ADR 0040 §11 D3/D4）：
 * - `PUT /api/fact-issuers/[tenantId]/[issuer]/[kid]` body `{ publicKey, enabled?, notAfter? }` → 200 签发方视图；
 * - `DELETE …` → 204（软删即吊销，aster-api 同步拒绝依赖该签发方的待审批）。
 *
 * 写要求个人租户本人或团队 MEMBER_UPDATE_ROLE。issuer / kid 先过 isFactIssuerSegment（400 invalid_issuer_name），
 * 请求体在本地按 api 同口径校验（400 invalid_issuer），只转发已知字段；校验不过都不发请求。
 */
import { NextResponse } from 'next/server';
import { canManageFactIssuers } from '@/lib/fact-issuer-access';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import type { GuardFactIssuerPut } from '@/services/policy/guard-types';
import { FACT_ISSUER_MAX_LENGTH, FACT_KID_MAX_LENGTH, isFactIssuerSegment } from '@/services/policy/policy-api';
import { badRequest, forbidden, sessionUserId, unauthorized, upstreamErrorResponse } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ tenantId: string; issuer: string; kid: string }>;
}

// 32 字节 Ed25519 原始公钥的 base64url：43 字符，api 容忍一个填充 `=`
const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}=?$/;
// ISO-8601 时刻，须带 Z 或偏移（api 以 Instant.parse 解析）
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** 鉴权 + 路径段校验；通过时返回装配好的 api 客户端参数。 */
async function authorize(
  params: RouteParams['params'],
): Promise<{ tenantId: string; userId: string; issuer: string; kid: string } | NextResponse> {
  const { tenantId, issuer, kid } = await params;
  const userId = await sessionUserId();
  if (!userId) return unauthorized();
  if (!(await canManageFactIssuers(userId, tenantId))) return forbidden();
  if (!isFactIssuerSegment(issuer, FACT_ISSUER_MAX_LENGTH) || !isFactIssuerSegment(kid, FACT_KID_MAX_LENGTH)) {
    return badRequest('invalid_issuer_name');
  }
  return { tenantId, userId, issuer, kid };
}

/** 请求体 → GuardFactIssuerPut；不合法返回 null。 */
function readBody(value: unknown): GuardFactIssuerPut | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { publicKey, enabled, notAfter } = value as Record<string, unknown>;
  if (typeof publicKey !== 'string' || !PUBLIC_KEY_RE.test(publicKey)) return null;
  if (enabled !== undefined && typeof enabled !== 'boolean') return null;
  if (notAfter !== undefined && (typeof notAfter !== 'string' || !INSTANT_RE.test(notAfter) || Number.isNaN(Date.parse(notAfter)))) {
    return null;
  }
  return {
    publicKey,
    ...(enabled === undefined ? {} : { enabled }),
    ...(notAfter === undefined ? {} : { notAfter }),
  };
}

export async function PUT(req: Request, { params }: RouteParams) {
  const auth = await authorize(params);
  if (auth instanceof NextResponse) return auth;

  const body = readBody(await req.json().catch(() => undefined));
  if (!body) return badRequest('invalid_issuer');

  try {
    const client = await createPolicyApiClientForUser(auth.tenantId, auth.userId);
    return NextResponse.json(await client.putFactIssuer(auth.issuer, auth.kid, body));
  } catch (e) {
    return upstreamErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  const auth = await authorize(params);
  if (auth instanceof NextResponse) return auth;

  try {
    const client = await createPolicyApiClientForUser(auth.tenantId, auth.userId);
    await client.deleteFactIssuer(auth.issuer, auth.kid);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return upstreamErrorResponse(e);
  }
}
