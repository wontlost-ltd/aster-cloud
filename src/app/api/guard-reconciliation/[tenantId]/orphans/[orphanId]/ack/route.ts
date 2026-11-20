/**
 * 确认孤儿（ADR 0061 §3.3）：`POST /api/guard-reconciliation/[tenantId]/orphans/[orphanId]/ack`，体 `{ comment }`
 * → 200 确认后的孤儿行。
 *
 * 唯一写操作：OPEN → ACKNOWLEDGED，不可撤销，aster-api 在同一事务内入链（GUARD_ORPHAN_ACKNOWLEDGED）。
 * 判定顺序：未登录 401 → 现查角色，不可看 / 不是 admin·owner 403 → 非法 id 404 → 说明去首尾空白后不在
 * 1–1000 字符 400 `invalid_ack`；以上都不调用 aster-api。aster-api 再以签名内的真实角色做 ADMIN 判定（第二道边界）。
 */
import { NextResponse } from 'next/server';
import { createReconciliationClient } from '@/lib/guard-reconciliation/access';
import { errorResponse, forbidden, sessionUserId, unauthorized, upstreamErrorResponse } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ACK_COMMENT = 1000;
const ORPHAN_ID_RE = /^[1-9][0-9]{0,15}$/;

interface RouteParams {
  params: Promise<{ tenantId: string; orphanId: string }>;
}

async function readComment(req: Request): Promise<string | null> {
  const body: unknown = await req.json().catch(() => null);
  const raw = body && typeof body === 'object' ? (body as { comment?: unknown }).comment : undefined;
  if (typeof raw !== 'string') return null;
  const comment = raw.trim();
  return comment.length >= 1 && comment.length <= MAX_ACK_COMMENT ? comment : null;
}

export async function POST(req: Request, { params }: RouteParams) {
  const { tenantId, orphanId } = await params;
  const userId = await sessionUserId();
  if (!userId) return unauthorized();
  const rec = await createReconciliationClient(tenantId, userId);
  if (!rec) return forbidden('view');
  if (!rec.access.canAck) return forbidden('ack');
  const id = ORPHAN_ID_RE.test(orphanId) ? Number(orphanId) : NaN;
  if (!Number.isSafeInteger(id)) return errorResponse(404, 'orphan_not_found');
  const comment = await readComment(req);
  if (comment === null) return errorResponse(400, 'invalid_ack');

  try {
    return NextResponse.json(await rec.api.ackOrphan(id, comment));
  } catch (e) {
    return upstreamErrorResponse(e);
  }
}
