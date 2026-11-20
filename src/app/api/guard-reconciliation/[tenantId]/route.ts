/**
 * 单租户对账（ADR 0061 §3.7）：`GET /api/guard-reconciliation/[tenantId]?status&severity&kind&before&limit`
 * → `{ summary, page: { items, next? }, canAck }`。
 *
 * 查询非法 → 400 `invalid_query`；不可看（viewer、非成员）→ 403；两者都不调用 aster-api。客户端每请求现建
 * （现查角色）。列表总是按请求的 severity 再过滤（旧 aster-api 忽略 `severity`），见 fillFilteredPage。
 * 每行附 acknowledgedByUser：只解析本租户当前成员（个人租户只解析本人），查库失败降级为 null。
 */
import { NextResponse } from 'next/server';
import { createReconciliationClient } from '@/lib/guard-reconciliation/access';
import { fillFilteredPage } from '@/lib/guard-reconciliation/fill-page';
import { parseOrphanQuery } from '@/lib/guard-reconciliation/query';
import { loadTenantMemberProfiles, type UserProfile } from '@/lib/user-profiles';
import { errorResponse, forbidden, sessionUserId, unauthorized, upstreamErrorResponse } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ tenantId: string }>;
}

export async function GET(req: Request, { params }: RouteParams) {
  const { tenantId } = await params;
  const userId = await sessionUserId();
  if (!userId) return unauthorized();
  const query = parseOrphanQuery(new URL(req.url).searchParams);
  if (!query) return errorResponse(400, 'invalid_query');
  const rec = await createReconciliationClient(tenantId, userId);
  if (!rec) return forbidden('view');

  try {
    const [summary, page] = await Promise.all([rec.api.summary(), fillFilteredPage(rec.api, query)]);
    const ackers = page.items.flatMap((o) => (o.acknowledgedBy ? [o.acknowledgedBy] : []));
    const profiles = await loadTenantMemberProfiles(tenantId, ackers, userId).catch((e: unknown) => {
      console.error('[guard-reconciliation] 确认人资料查询失败', e);
      return new Map<string, UserProfile>();
    });
    const items = page.items.map((o) => ({
      ...o,
      acknowledgedByUser: o.acknowledgedBy ? profiles.get(o.acknowledgedBy) ?? null : null,
    }));
    return NextResponse.json({
      summary,
      page: page.next === undefined ? { items } : { items, next: page.next },
      canAck: rec.access.canAck,
    });
  } catch (e) {
    return upstreamErrorResponse(e);
  }
}
