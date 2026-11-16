/*
 * 平台管理员设定团队的能力委派额度（ADR 0058 §4.6 / §4.10）。
 *
 * PUT { seatCap: 0–10000 整数, ownerGrantingEnabled: boolean } → 200 { allotment }
 * 低于当前已用座位 409 seat_cap_below_active；能力不允许委派 400 delegation_not_supported。
 */

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { CapabilityError, capabilityErrorResponse } from '@/lib/capabilities/errors';
import { setTeamAllotment } from '@/lib/capabilities/grants';
import { isCapabilityKey } from '@/lib/capabilities/registry';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ capability: string; teamId: string }> };

const SEAT_CAP_MAX = 10000;

export async function PUT(req: Request, { params }: RouteParams) {
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { capability, teamId } = await params;
  if (!isCapabilityKey(capability)) return capabilityErrorResponse(new CapabilityError('unknown_capability'));

  const body = (await req.json().catch(() => null)) as { seatCap?: unknown; ownerGrantingEnabled?: unknown } | null;
  const seatCap = body?.seatCap;
  const ownerGrantingEnabled = body?.ownerGrantingEnabled;
  if (
    typeof seatCap !== 'number' ||
    !Number.isInteger(seatCap) ||
    seatCap < 0 ||
    seatCap > SEAT_CAP_MAX ||
    typeof ownerGrantingEnabled !== 'boolean'
  ) {
    return capabilityErrorResponse(new CapabilityError('invalid_payload'));
  }

  try {
    const allotment = await setTeamAllotment({
      capability,
      teamId,
      seatCap,
      ownerGrantingEnabled,
      updatedBy: admin.userId,
    });
    return NextResponse.json({ allotment });
  } catch (e) {
    if (e instanceof CapabilityError) return capabilityErrorResponse(e);
    throw e;
  }
}
