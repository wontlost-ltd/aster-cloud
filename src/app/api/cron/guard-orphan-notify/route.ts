/**
 * POST /api/cron/guard-orphan-notify（aster-api ADR 0065）
 *
 * 每 5 分钟（错开 2 分钟）：向 aster-api 拉取 critical 孤儿通知源，为租户管理员写站内通知。
 * 站内开关关闭时 fn 正常返回 ran:false（心跳照常 success）。fn 抛错（如通知源 403 / 缺 HMAC 密钥）
 * 由 runCronOnce 将租约标记失败并重抛，路由不吞异常，由 Next 返回 500。
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { runCronOnce } from '@/lib/cron-lease';
import { parseCronWindow } from '@/lib/cron-window';
import { notifyOrphansDetected } from '@/lib/guard-notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB = 'guard-orphan-notify';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = requireCronAuth(req);
  if (guard) return guard;

  const { acquiredBy, windowStart } = parseCronWindow(req, JOB);
  const outcome = await runCronOnce(JOB, () => notifyOrphansDetected(), { acquiredBy, windowStart });
  if (!outcome.ran || !outcome.result) {
    return NextResponse.json({ ok: true, ran: false, reason: outcome.skippedReason, leaseId: outcome.leaseId });
  }
  const report = outcome.result;
  if (!report.ran) {
    return NextResponse.json({ ok: true, ran: false, reason: 'disabled', leaseId: outcome.leaseId });
  }
  if (report.summaryFailed > 0) {
    console.error(`[cron:${JOB}] ${report.summaryFailed} tenant summary request(s) failed`);
  }
  return NextResponse.json({ ok: report.summaryFailed === 0, leaseId: outcome.leaseId, ...report });
}
