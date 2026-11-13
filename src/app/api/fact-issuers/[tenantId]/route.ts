/**
 * 签发方列表（ADR 0040 §11 D3）：`GET /api/fact-issuers/[tenantId]`
 * → `{ issuers, cloudIssuer: { issuer, kid, publicKey } | null, canManage }`。
 *
 * 读要求个人租户本人或团队 TEAM_VIEW；列表取自 aster-api（唯一真相源，cloud 不存签发方状态）。
 * cloudIssuer 是平台签发方的公开身份，供设置页「启用 Aster Cloud 签发方」；平台密钥未配置或自检失败时为 null。
 */
import { NextResponse } from 'next/server';
import { canManageFactIssuers, canViewFactIssuers } from '@/lib/fact-issuer-access';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { loadFactSigningKey } from '@/services/guard/fact-signing-key';
import { forbidden, sessionUserId, unauthorized, upstreamErrorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ tenantId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { tenantId } = await params;
  const userId = await sessionUserId();
  if (!userId) return unauthorized();
  if (!(await canViewFactIssuers(userId, tenantId))) return forbidden();

  try {
    const client = await createPolicyApiClientForUser(tenantId, userId);
    const [{ issuers }, signingKey, canManage] = await Promise.all([
      client.listFactIssuers(),
      loadFactSigningKey(),
      canManageFactIssuers(userId, tenantId),
    ]);
    const cloudIssuer = signingKey
      ? { issuer: signingKey.issuer, kid: signingKey.kid, publicKey: signingKey.publicKey }
      : null;
    return NextResponse.json({ issuers, cloudIssuer, canManage });
  } catch (e) {
    return upstreamErrorResponse(e);
  }
}
