/*
 * 团队 owner 的能力委派接口（ADR 0058 §4.6 / §4.10）。只有 Team.ownerId 本人可用，团队 admin 不行。
 *
 * GET                    额度、已用座位、委派名单（不含平台给成员的直接授权）、delegationOpen（新委派当前是否可行）
 * POST   { userId }      委派给本团队非 viewer 成员；新建 201，已存在 200
 * DELETE { grantId }     撤销本团队的一条委派（reason = manual）；别的行一律 grant_not_found
 *
 * owner 判定经 freshDb 现读；委派写服务在事务内锁团队行后再判一次，与转让所有权串行化。
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { freshDb } from '@/db/fresh-read';
import { teams } from '@/lib/prisma';
import { CapabilityError, capabilityErrorResponse, type CapabilityErrorCode } from '@/lib/capabilities/errors';
import { delegateToMember, isTeamDelegationOpen, listTeamDelegations, revokeGrant } from '@/lib/capabilities/grants';
import { isCapabilityKey, type CapabilityKey } from '@/lib/capabilities/registry';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ teamId: string; capability: string }> };

const fail = (code: CapabilityErrorCode) => capabilityErrorResponse(new CapabilityError(code));

/**
 * 会话、能力键、owner 三道检查；通过时返回上下文，否则返回错误响应。
 * 团队不存在与非 owner 同样 403 not_team_owner，不泄露团队是否存在。
 */
async function authorizeOwner(
  { params }: RouteParams,
): Promise<NextResponse | { userId: string; teamId: string; capability: CapabilityKey }> {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
  }
  const { teamId, capability } = await params;
  if (!isCapabilityKey(capability)) return fail('unknown_capability');
  const team = await freshDb.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { ownerId: true } });
  if (!team || team.ownerId !== session.user.id) return fail('not_team_owner');
  return { userId: session.user.id, teamId, capability };
}

/** CapabilityError 转成 `{ error, code }` 响应，其余错误照常抛出（500）。 */
async function handleCapabilityErrors(run: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof CapabilityError) return capabilityErrorResponse(e);
    throw e;
  }
}

async function readStringField(req: Request, field: 'userId' | 'grantId'): Promise<string | null> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const value = body?.[field];
  return typeof value === 'string' && value.trim() ? value : null;
}

export async function GET(_req: Request, ctx: RouteParams) {
  const auth = await authorizeOwner(ctx);
  if (auth instanceof NextResponse) return auth;
  const [view, delegationOpen] = await Promise.all([
    listTeamDelegations(auth.capability, auth.teamId),
    isTeamDelegationOpen(auth.capability, auth.teamId),
  ]);
  return NextResponse.json({ ...view, delegationOpen });
}

export async function POST(req: Request, ctx: RouteParams) {
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;
  const auth = await authorizeOwner(ctx);
  if (auth instanceof NextResponse) return auth;

  const userId = await readStringField(req, 'userId');
  if (!userId) return fail('invalid_payload');

  return handleCapabilityErrors(async () => {
    const { grant, created } = await delegateToMember({
      capability: auth.capability,
      teamId: auth.teamId,
      userId,
      ownerId: auth.userId,
    });
    return NextResponse.json({ grant }, { status: created ? 201 : 200 });
  });
}

export async function DELETE(req: Request, ctx: RouteParams) {
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;
  const auth = await authorizeOwner(ctx);
  if (auth instanceof NextResponse) return auth;

  const grantId = await readStringField(req, 'grantId');
  if (!grantId) return fail('invalid_payload');

  return handleCapabilityErrors(async () => {
    const grant = await revokeGrant({
      grantId,
      revokedBy: auth.userId,
      reason: 'manual',
      expectCapability: auth.capability,
      expectDelegatingTeamId: auth.teamId,
    });
    return NextResponse.json({ grant });
  });
}
