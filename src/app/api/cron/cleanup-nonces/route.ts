/**
 * /api/cron/cleanup-nonces —— UsedNonce 表的每小时回收。
 *
 * - POST：执行清理。由 worker.js scheduled() 每小时派发（cron-registry 的
 *   cleanup-nonces），并发触发（Workers cron + 外部 curl）由 `runCronOnce` 的租约去重。
 * - GET：只读健康检查，报告活跃 nonce 是否积压；`?maxActive=` 可调阈值。
 *
 * <p>为什么是每小时：/api/internal/* 每次入站调用都写一条 nonce（#480），记录只需活到
 * 签名时间戳 + 6 分钟。按天清理会让表里常驻一整天的调用量。
 *
 * <p>两种部署都要：on-prem 同样收 aster-api 的内部调用。
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { runCronOnce } from '@/lib/cron-lease';
import { parseCronWindow } from '@/lib/cron-window';
import { parsePositiveInt } from '@/lib/api/query-params';
import { cleanupNoncesJob, checkNonceHealth } from '@/cron/cleanup-nonces';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_MAX_ACTIVE = 100_000;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = requireCronAuth(req);
  if (guard) return guard;

  const { acquiredBy, windowStart } = parseCronWindow(req, 'cleanup-nonces');
  const outcome = await runCronOnce('cleanup-nonces', cleanupNoncesJob, { acquiredBy, windowStart });

  if (!outcome.ran) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: outcome.skippedReason,
      windowStart: outcome.windowStart,
    });
  }

  return NextResponse.json({
    ok: true,
    windowStart: outcome.windowStart,
    ...outcome.result,
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const guard = requireCronAuth(req);
  if (guard) return guard;

  const maxActive = parsePositiveInt(req.nextUrl.searchParams.get('maxActive'), DEFAULT_MAX_ACTIVE);
  const health = await checkNonceHealth(maxActive);
  return NextResponse.json({ ...health, timestamp: new Date().toISOString() });
}
