/**
 * 全局成本熔断器 cron（每 10 分钟扫一次）
 *
 * 管理员手动熔断生效期间按手动熔断（最高档）补打 ban，覆盖熔断后才进入 Free/Trial 的用户；
 * 手动熔断不由 cron 解除，只随管理员解除或 UTC 当日结束失效。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import {
  todayPlatformCostCents,
  evaluateCircuit,
  applyCircuit,
  getManualTripUntil,
} from '@/lib/ai-circuit-breaker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  // R21-Critical-2: fail-closed cron auth via shared helper
  const guard = requireCronAuth(request);
  if (guard) return guard;

  const [cents, manualUntil] = await Promise.all([todayPlatformCostCents(), getManualTripUntil()]);
  const manual = manualUntil !== null;
  // 手动熔断已是最高档，成本判定不会更严，直接按手动熔断补打即可。
  const state = manual ? 'free_trial_stopped' : evaluateCircuit(cents);
  const result = await applyCircuit(state, { manual });

  console.log(
    `[ai-circuit] today=$${(cents / 100).toFixed(2)} state=${state} manual=${manual} banned=${result.affected}`,
  );

  return NextResponse.json({
    today_cents: cents,
    today_usd: (cents / 100).toFixed(2),
    state,
    manual,
    affected: result.affected,
  });
}
