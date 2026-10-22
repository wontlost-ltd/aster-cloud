/**
 * 批准版本 API
 *
 * POST /api/v1/policies/{id}/versions/{version}/approve
 *
 * PM v1.1 SOX 守护（二级）：
 * - 当 plan.approvalRequired = true 且 author === approver：
 *   - team 活跃 seats <= 1 → 403 invite_reviewer_required（引导邀请）
 *   - team 活跃 seats >= 2 → 403 segregation_of_duties（自审 SOX 违规）
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { and, eq, sql } from 'drizzle-orm';

import { db, users, teams, teamMembers, policyVersions } from '@/lib/prisma';
import {
  PolicyAccessDeniedError,
  SegregationOfDutiesError,
  approveVersion,
} from '@/services/policy/version-manager';
import { getEffectiveLimits } from '@/lib/plans';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; version: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { id: policyId, version: versionStr } = await params;
  const version = parseInt(versionStr, 10);
  if (isNaN(version)) {
    return NextResponse.json({ error: 'invalid_version' }, { status: 400 });
  }

  let body: { comment?: string } = {};
  try {
    body = await request.json();
  } catch {
    // 允许空 body
  }

  const approverId = session.user.id;

  const guard = await checkSoxGuard(approverId, policyId, version);
  if (guard) return guard;

  try {
    await approveVersion({
      policyId,
      version,
      approverId,
      decision: 'APPROVED',
      comment: body.comment,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    // 非所有者与「策略不存在」返回同一 404，避免泄露该 policyId 是否存在
    if (error instanceof PolicyAccessDeniedError) {
      return NextResponse.json({ error: '策略不存在' }, { status: 404 });
    }
    // 团队策略的作者自审：与 checkSoxGuard 同一错误码，前端据此显示本地化提示
    if (error instanceof SegregationOfDutiesError) {
      return NextResponse.json({ error: 'segregation_of_duties', message: error.message }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : '批准失败';
    return NextResponse.json({ error: 'approve_failed', message }, { status: 400 });
  }
}

/**
 * 二级 SOX 守护：在调用 approveVersion 之前判断是否可达。
 * 返回 NextResponse 表示必须拦截；返回 null 表示可以放行。
 */
async function checkSoxGuard(
  approverId: string,
  policyId: string,
  version: number
): Promise<NextResponse | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, approverId),
    columns: { plan: true, priceLockedAt: true, legacyTier: true },
  });
  if (!user) return null;

  const limits = getEffectiveLimits({
    plan: user.plan,
    priceLockedAt: user.priceLockedAt,
    legacyTier: user.legacyTier,
  });
  if (!limits.approvalRequired) return null;

  const target = await db.query.policyVersions.findFirst({
    where: and(eq(policyVersions.policyId, policyId), eq(policyVersions.version, version)),
    columns: { createdBy: true },
  });
  if (!target || target.createdBy !== approverId) return null;

  const ownedTeam = await db.query.teams.findFirst({
    where: eq(teams.ownerId, approverId),
    columns: { id: true },
  });

  if (!ownedTeam) {
    return NextResponse.json(
      {
        error: 'invite_reviewer_required',
        message: 'Approval requires a separate reviewer. Create a team workspace and invite a teammate.',
        cta: { label: 'Create workspace', href: '/teams/new' },
      },
      { status: 403 }
    );
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, ownedTeam.id));

  if (count <= 1) {
    return NextResponse.json(
      {
        error: 'invite_reviewer_required',
        message: 'Approval requires a separate reviewer. Invite a teammate to your workspace.',
        cta: { label: 'Invite a teammate', href: `/teams/${ownedTeam.id}/invite` },
      },
      { status: 403 }
    );
  }

  return NextResponse.json(
    {
      error: 'segregation_of_duties',
      message: 'SOX compliance requires the approver to be different from the submitter.',
    },
    { status: 403 }
  );
}
