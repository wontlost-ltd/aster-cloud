/**
 * POST /api/cron/policy-trash-cleanup（#623）
 *
 * 每日一次：永久删除回收站里超过 30 天保留期的策略（连同回收站行、访问授权与词汇快照引用，
 * 见 policy-lifecycle purgePolicy），并回收策略已不存在的孤儿共享 / 审阅人 / 待处理审阅邀请。
 * 由 worker.js scheduled() 按 cron-registry 的 policy-trash-cleanup 派发；并发触发
 * （Workers cron + 外部 curl）由 runCronOnce 的租约去重。
 *
 * 单项失败不中断其余项：错误详情（含策略 id 与数据库消息）只写服务端日志，响应只给错误数。
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { runCronOnce } from '@/lib/cron-lease';
import { parseCronWindow } from '@/lib/cron-window';
import { cleanupExpiredTrashItems, purgeOrphanPolicyAccessRows } from '@/lib/policy-lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB = 'policy-trash-cleanup';

async function runCleanup() {
  const trash = await cleanupExpiredTrashItems();
  if (trash.errors.length > 0) {
    console.error(`[cron:${JOB}] ${trash.errors.length} item(s) failed`, trash.errors);
  }
  const orphans = await purgeOrphanPolicyAccessRows();
  return { deletedCount: trash.deletedCount, errorCount: trash.errors.length, orphans };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = requireCronAuth(req);
  if (guard) return guard;

  const { acquiredBy, windowStart } = parseCronWindow(req, JOB);
  const outcome = await runCronOnce(JOB, runCleanup, { acquiredBy, windowStart });

  if (!outcome.ran || !outcome.result) {
    return NextResponse.json({
      ok: true,
      ran: false,
      reason: outcome.skippedReason,
      leaseId: outcome.leaseId,
    });
  }

  return NextResponse.json({
    ok: outcome.result.errorCount === 0,
    ran: true,
    leaseId: outcome.leaseId,
    ...outcome.result,
  });
}
