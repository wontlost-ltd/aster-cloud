/**
 * POST /api/cron/guard-deploy-sync（aster-api ADR 0054 §11 D1）
 *
 * 每 5 分钟：对 appliedGeneration 落后、或期望状态与实际默认版本不符的策略，以 generation+1 重发实际状态
 * （部署默认版本 / 撤回）。与「重新同步」按钮共用 reconcileGuardDeployments。并发触发由 runCronOnce 租约去重。
 *
 * `?backfill=dry-run|apply`：上线时的一次性回填（每个有已批准默认版本但从未部署的策略部署一次），同样要求 cron 鉴权；
 * 在应用运行时内执行（引擎依赖只在 Next 运行时可解析），由 `pnpm guard:backfill` 调用。
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { runCronOnce } from '@/lib/cron-lease';
import { parseCronWindow } from '@/lib/cron-window';
import { backfillGuardDeployments, reconcileGuardDeployments } from '@/lib/guard-policy-deploy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB = 'guard-deploy-sync';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = requireCronAuth(req);
  if (guard) return guard;

  const backfill = req.nextUrl.searchParams.get('backfill');
  if (backfill !== null) {
    if (backfill !== 'dry-run' && backfill !== 'apply') {
      return NextResponse.json({ ok: false, error: 'backfill 须为 dry-run 或 apply' }, { status: 400 });
    }
    const results = await backfillGuardDeployments({ apply: backfill === 'apply' });
    const failed = results.filter((r) => r.result !== 'dry-run' && !r.result.ok).length;
    return NextResponse.json({ ok: failed === 0, mode: backfill, failed, results });
  }

  const { acquiredBy, windowStart } = parseCronWindow(req, JOB);
  const outcome = await runCronOnce(JOB, () => reconcileGuardDeployments(), { acquiredBy, windowStart });
  if (!outcome.ran || !outcome.result) {
    return NextResponse.json({ ok: true, ran: false, reason: outcome.skippedReason, leaseId: outcome.leaseId });
  }
  const { checked, pushed, failed } = outcome.result;
  if (failed.length > 0) console.error(`[cron:${JOB}] ${failed.length} policy deployment(s) failed`, failed);
  return NextResponse.json({ ok: failed.length === 0, ran: true, leaseId: outcome.leaseId, checked, pushed, failed: failed.length });
}
