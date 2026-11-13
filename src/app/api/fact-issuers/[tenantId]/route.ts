/**
 * 签发方列表（ADR 0040 §11 D3）：`GET /api/fact-issuers/[tenantId]`
 * → `{ issuers, cloudIssuer: { issuer, kid, publicKey } | null, canManage }`。
 *
 * 读要求个人租户本人或团队 TEAM_VIEW；列表取自 aster-api（唯一真相源，cloud 不存签发方状态）。
 * 每行附 createdByUser（登记人的姓名 / 邮箱 / 头像）：只按本租户列表里出现的 createdBy 去重批量查询，
 * 且只解析本租户当前成员（个人租户只解析本人），与团队成员列表的可见范围一致；离队成员显示为未知用户。
 * cloudIssuer 是平台签发方的公开身份，供设置页「启用 Aster Cloud 签发方」；平台密钥未配置或自检失败时为 null。
 */
import { NextResponse } from 'next/server';
import { canManageFactIssuers, canViewFactIssuers } from '@/lib/fact-issuer-access';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { loadTenantMemberProfiles } from '@/lib/user-profiles';
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
    // 登记人资料只是展示：查库失败时降级为「未知用户」，不影响列表本身
    const profiles = await loadTenantMemberProfiles(tenantId, issuers.map((row) => row.createdBy), userId).catch((e: unknown) => {
      console.error('[fact-issuers] 登记人资料查询失败', e);
      return new Map<string, never>();
    });
    const items = issuers.map((row) => ({ ...row, createdByUser: profiles.get(row.createdBy) ?? null }));
    const cloudIssuer = signingKey
      ? { issuer: signingKey.issuer, kid: signingKey.kid, publicKey: signingKey.publicKey }
      : null;
    return NextResponse.json({ issuers: items, cloudIssuer, canManage });
  } catch (e) {
    return upstreamErrorResponse(e);
  }
}
