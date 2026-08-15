/**
 * POST /api/cron/execution-retention-gc — 执行日志与决策骨架的每日留存清理（issue #396）。
 *
 * <p>`plans.ts` 里 `audit7days`（free）/ `audit90days`（pro 等）此前**只是定价页上的
 * 标签**：`cleanupOldExecutionLogs` 零调用方，所有档位实际留存都是永久。本路由把它
 * 变成自执行的合约——与 `telemetry-retention-gc` 同构，那条链路的注释说得最准：
 * 「makes that contract self-executing (not a docs-only promise)」。
 *
 * <p>幂等：过了 cutoff 的行删掉后重跑即 no-op。并发触发（Workers cron + 外部 curl）
 * 由 `runCronOnce` 的 Postgres 租约去重。
 *
 * <p>★enterprise 档在 `plans.ts` 里没有任何 audit featureKey，故**跳过不删**并把
 * 原因放进响应的 `skipped` 里。删除不可逆，宁可不删也不猜——详见
 * `lib/retention/execution-retention.ts` 的文件头。
 *
 * <p>SaaS-only：on-prem 的留存由客户自己的 DB 策略管。
 */

import { NextRequest, NextResponse } from 'next/server';

import { requireCronAuth } from '@/lib/cron-auth';
import { runCronOnce } from '@/lib/cron-lease';
import { parseCronWindow } from '@/lib/cron-window';
import { IS_SAAS } from '@/lib/deployment-mode';
import { runExecutionRetentionGc } from '@/lib/retention/execution-retention-gc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!IS_SAAS) return new NextResponse(null, { status: 404 });
  const guard = requireCronAuth(req);
  if (guard) return guard;

  const { acquiredBy, windowStart } = parseCronWindow(req, 'execution-retention-gc');
  const outcome = await runCronOnce(
    'execution-retention-gc',
    () => runExecutionRetentionGc(),
    { acquiredBy, windowStart },
  );

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
