/**
 * POST /api/cron/telemetry-retention-gc — daily retention sweep on
 * LicenseTelemetry + TelemetryAccessAudit.
 *
 * GDPR Art 5(1)(e) storage limitation: we promise 12-month rolling
 * retention to customers; this cron makes that contract self-executing
 * (not a docs-only promise). Run nightly; idempotent — once a row is
 * past cutoff it's gone, repeat runs no-op until new rows age out.
 *
 * Defaults in DEFAULT_RETENTION:
 *   LicenseTelemetry          365 d
 *   read audit rows            90 d (lower-sensitivity, cheap to sweep)
 *   delete audit rows        7 * 365 d (legal hold; rarely reaches)
 *
 * Each tick also writes its own retention-gc audit row (in deleteTelemetryByLicense
 * style) so the audit trail has "yes the cleanup actually ran on date X
 * and reaped N rows".
 *
 * 同一个 tick 还清理需求验证数据（与隐私政策口径一致）：
 *   ProductEvent        13 个月
 *   PilotApplication    24 个月
 *
 * SaaS-only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { IS_SAAS } from '@/lib/deployment-mode';
import { runRetentionGc } from '@/lib/telemetry/access-audit';
import { runCronOnce } from '@/lib/cron-lease';
import { parseCronWindow } from '@/lib/cron-window';
import { purgeExpiredProductEvents } from '@/lib/product-events/server';
import { purgeExpiredPilotApplications } from '@/lib/pilot-applications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!IS_SAAS) return new NextResponse(null, { status: 404 });
  const guard = requireCronAuth(req);
  if (guard) return guard;

  // Optional env overrides for emergencies (e.g. shrink retention to 30d
  // for incident response). Default sticks to the privacy notice.
  const cfg = {
    telemetryMaxAgeDays: parseDays(
      process.env.TELEMETRY_RETENTION_DAYS,
      365,
    ),
    auditReadMaxAgeDays: parseDays(
      process.env.TELEMETRY_AUDIT_READ_RETENTION_DAYS,
      90,
    ),
    auditDeleteMaxAgeDays: parseDays(
      process.env.TELEMETRY_AUDIT_DELETE_RETENTION_DAYS,
      7 * 365,
    ),
  };

  const { acquiredBy, windowStart } = parseCronWindow(req, 'telemetry-retention-gc');
  const outcome = await runCronOnce(
    'telemetry-retention-gc',
    async () => ({
      ...(await runRetentionGc({ config: cfg })),
      demandValidation: {
        productEventsDeleted: await purgeExpiredProductEvents(),
        pilotApplicationsDeleted: await purgeExpiredPilotApplications(),
      },
    }),
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
    config: cfg,
    windowStart: outcome.windowStart,
    ...outcome.result,
  });
}

function parseDays(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (Number.isFinite(n) && n > 0) return n;
  return fallback;
}
