import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, teams, teamMembers } from '@/lib/prisma';
import { eq, and } from 'drizzle-orm';
import { checkTeamPermission, TeamPermission } from '@/lib/team-permissions';
import { refreshTeamKeySnapshots } from '@/lib/api-keys';
import { invalidatePlanCache } from '@/lib/plan-gate-client';

type RouteParams = { params: Promise<{ teamId: string }> };

// POST /api/teams/[teamId]/transfer - 转让团队所有权
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { teamId } = await params;

    // 检查转让权限（仅限 Owner）
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.TEAM_TRANSFER
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    const { newOwnerId } = await req.json();

    if (!newOwnerId || typeof newOwnerId !== 'string') {
      return NextResponse.json({ error: '请指定新的所有者' }, { status: 400 });
    }

    // 检查新所有者是否为团队成员
    const newOwnerMembership = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, newOwnerId)),
    });

    if (!newOwnerMembership) {
      return NextResponse.json({ error: '新所有者必须是团队成员' }, { status: 400 });
    }

    // 不能转让给自己
    if (newOwnerId === session.user.id) {
      return NextResponse.json({ error: '无法将所有权转让给自己' }, { status: 400 });
    }

    // 使用事务更新所有权
    await db.transaction(async (tx) => {
      // 更新团队的 ownerId
      await tx.update(teams).set({ ownerId: newOwnerId }).where(eq(teams.id, teamId));

      // 将新所有者角色更新为 owner
      await tx
        .update(teamMembers)
        .set({ role: 'owner' })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, newOwnerId)));

      // 将原所有者角色降级为 admin
      await tx
        .update(teamMembers)
        .set({ role: 'admin' })
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, session.user.id)));
    });

    // 转让改变了全队 key 的 quotaOwnerId 与新旧 owner 的角色：重推全队 key 快照，并失效团队按 owner 套餐计的 plan 缓存（ADR 0015 §5）
    await refreshTeamKeySnapshots(teamId).catch((err) =>
      console.warn('[teams] refreshTeamKeySnapshots after ownership transfer failed:', err)
    );
    await invalidatePlanCache(teamId);

    return NextResponse.json({
      success: true,
      message: '所有权转让成功',
      newOwnerId,
    });
  } catch (error) {
    console.error('Error transferring team ownership:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}
