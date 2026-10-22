/**
 * 管理员手动控制 AI 熔断器
 *
 * POST { action: "trip" }     → 手动熔断（停 Free + Trial，含之后才注册/降级进来的用户，至今日 UTC 结束或手动解除）
 * POST { action: "release" }  → 立即解除全局熔断（自动与手动熔断一并解除）
 * GET                          → 查看当前状态（与管理员概览卡片同一来源 getCircuitStatus）
 *
 * 两个写操作都写审计日志（ai-circuit.trip / ai-circuit.release）。
 *
 * 仅 User.isAdmin=true 用户可访问（与套餐 plan 解耦，见 lib/admin-auth.ts）
 */
import { NextResponse } from 'next/server';
import {
  getCircuitStatus,
  releaseCircuit,
  tripCircuitManually,
  CIRCUIT_BREAKER_THRESHOLDS,
} from '@/lib/ai-circuit-breaker';
import { extractClientInfo, logAuditEvent } from '@/lib/audit-log';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { errorEnvelope, safeErrorCode } from '@/lib/api/error-envelope';

const ensureAdmin = requireAdmin;

/**
 * 熔断 / 解除已经生效后再写审计：审计写入失败只记日志，不能把已成功的操作报成 503
 * （管理员会误以为没生效而反复操作）。
 */
async function auditAfterSuccess(entry: Parameters<typeof logAuditEvent>[0]): Promise<void> {
  try {
    await logAuditEvent(entry);
  } catch (err) {
    console.error(`[ai-circuit] audit write failed for ${entry.action}`, safeErrorCode(err));
  }
}

export async function GET() {
  // Try/catch wrap so any throw from auth() / todayPlatformCostCents()
  // / evaluateCircuit() returns a JSON 503 envelope rather than Next's
  // default HTML 500 page. The admin UI now has an error boundary, but
  // we still want the response to be machine-parseable for client
  // retry. See admin-UI audit punch list P0-5.
  try {
    const check = await ensureAdmin();
    if (check instanceof NextResponse) return check;

    const status = await getCircuitStatus();

    return NextResponse.json({
      today_cents: status.todayCents,
      today_usd: (status.todayCents / 100).toFixed(2),
      state: status.state,
      cost_state: status.costState,
      ban_state: status.banState,
      manual: status.manual,
      banned_users: status.bannedUsers,
      thresholds: {
        free_stop_usd: CIRCUIT_BREAKER_THRESHOLDS.freeStop / 100,
        trial_stop_usd: CIRCUIT_BREAKER_THRESHOLDS.trialStop / 100,
      },
    });
  } catch (err) {
    const env = errorEnvelope({
      status: 503,
      code: 'service_unavailable',
      message: 'AI circuit state is currently unavailable. Please retry.',
    });
    console.error(
      '[ai-circuit-breaker GET] handler failed',
      env.headers.get('x-request-id'),
      err,
    );
    return env;
  }
}

export async function POST(req: Request) {
  // On-prem read-only mode（grace-expired / revoked / expired / malformed / missing）
  // 禁止 admin mutate；release circuit 是 mutate 操作。SaaS 永远 noop。
  // Stays at top-level (not inside try/catch) to satisfy the
  // deployment-mode/require-license-write-gate lint rule.
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;

  try {
    const check = await ensureAdmin();
    if (check instanceof NextResponse) return check;

    const body = (await req.json()) as { action: string };
    const client = extractClientInfo(req);
    if (body.action === 'release') {
      const result = await releaseCircuit(check.userId);
      console.warn(`[ai-circuit] manual release by ${check.userId}, released ${result.released} users`);
      await auditAfterSuccess({
        userId: check.userId,
        action: 'ai-circuit.release',
        resource: 'ai-circuit-breaker',
        metadata: { released: result.released },
        ...client,
      });
      return NextResponse.json({ ok: true, released: result.released });
    }
    if (body.action === 'trip') {
      const result = await tripCircuitManually(check.userId);
      console.warn(`[ai-circuit] manual trip by ${check.userId}, affected ${result.affected} users`);
      await auditAfterSuccess({
        userId: check.userId,
        action: 'ai-circuit.trip',
        resource: 'ai-circuit-breaker',
        metadata: { affected: result.affected, level: 'free_trial_stopped' },
        ...client,
      });
      return NextResponse.json({ ok: true, affected: result.affected });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    const env = errorEnvelope({
      status: 503,
      code: 'service_unavailable',
      message: 'AI circuit update failed. Please retry; the failure has been logged.',
    });
    console.error(
      '[ai-circuit-breaker POST] handler failed',
      env.headers.get('x-request-id'),
      err,
    );
    return env;
  }
}
