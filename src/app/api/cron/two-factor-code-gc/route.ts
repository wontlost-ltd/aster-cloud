/**
 * POST /api/cron/two-factor-code-gc —— 二次验证码表的每日回收（issue #400）。
 *
 * <p>★为什么需要这条 cron：`purgeExpiredCodes` 此前**零调用方**。这与 issue #396
 * 里 `cleanupOldExecutionLogs` 的情形完全同构——函数写好了、测试也绿，但没人调，
 * 于是「过期即清理」只是注释里的承诺。安全审查在复审二次验证时点出了这一点。
 *
 * <p>回收条件是**码过期 且 限次窗口也过期**（见 `two-factor.ts` 的
 * `purgeExpiredCodes`）。这一点很关键：窗口计数就寄生在码行上，若按「码过期」
 * 就删，等于给攻击者一条「等 cron 跑一次就重置限次」的通路——那正是本轮
 * 修掉的 High。所以本 cron 删的都是**窗口已自然失效**的行，删掉不影响限次。
 *
 * <p>幂等：删过的行重跑即 no-op。并发触发（Workers cron + 外部 curl）由
 * `runCronOnce` 的 Postgres 租约去重。
 *
 * <p>容量上本来就无风险（email 有 UNIQUE 索引，至多一行一邮箱），这条 cron
 * 的真实目的是**留存合规**：不让登录邮箱在表里无限期留存。
 *
 * <p>SaaS-only：on-prem 的留存由客户自己的 DB 策略管。
 */

import { NextRequest, NextResponse } from 'next/server';

import { requireCronAuth } from '@/lib/cron-auth';
import { runCronOnce } from '@/lib/cron-lease';
import { parseCronWindow } from '@/lib/cron-window';
import { IS_SAAS } from '@/lib/deployment-mode';
import { purgeExpiredCodes } from '@/lib/two-factor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!IS_SAAS) return new NextResponse(null, { status: 404 });
  const guard = requireCronAuth(req);
  if (guard) return guard;

  const { acquiredBy, windowStart } = parseCronWindow(req, 'two-factor-code-gc');
  const outcome = await runCronOnce(
    'two-factor-code-gc',
    async () => ({ deletedCount: await purgeExpiredCodes() }),
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
