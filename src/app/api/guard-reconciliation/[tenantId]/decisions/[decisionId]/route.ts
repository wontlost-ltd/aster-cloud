/**
 * 孤儿的决策上下文（ADR 0061 §3.5）：`GET /api/guard-reconciliation/[tenantId]/decisions/[decisionId]`
 * → DecisionContext（决策、链收据、执行链接、审批链接，三个来源各自降级）。
 *
 * 非 UUID → 400 `invalid_decision_id`；不可看 → 403；两者都不调用 aster-api。只在本租户内查。
 */
import { NextResponse } from 'next/server';
import { createReconciliationClient } from '@/lib/guard-reconciliation/access';
import { DECISION_ID_RE, loadDecisionContext } from '@/lib/guard-reconciliation/decision-context';
import { errorResponse, forbidden, sessionUserId, unauthorized } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ tenantId: string; decisionId: string }>;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const { tenantId, decisionId } = await params;
  const userId = await sessionUserId();
  if (!userId) return unauthorized();
  if (!DECISION_ID_RE.test(decisionId)) return errorResponse(400, 'invalid_decision_id');
  const rec = await createReconciliationClient(tenantId, userId);
  if (!rec) return forbidden('view');
  return NextResponse.json(await loadDecisionContext(tenantId, rec.api, decisionId));
}
