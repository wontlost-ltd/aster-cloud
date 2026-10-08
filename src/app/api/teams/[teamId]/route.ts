import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, teams, teamMembers, teamInvitations, policies, policyGroups } from '@/lib/prisma';
import { eq, and, isNull, not, sql } from 'drizzle-orm';
import { checkTeamPermission, TeamPermission } from '@/lib/team-permissions';
import { validateTeamName, validateSlug } from '@/lib/validation';
import { revokeTeamKeys } from '@/lib/api-keys';

type RouteParams = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId] - 获取团队详情
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { teamId } = await params;

    // 检查访问权限
    const permission = await checkTeamPermission(session.user.id, teamId, TeamPermission.TEAM_VIEW);
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
    });

    if (!team) {
      return NextResponse.json({ error: '团队不存在' }, { status: 404 });
    }

    // 获取用户角色
    const userMember = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, session.user.id)),
    });

    // 并行获取成员和策略总数
    const [memberCountResult, policyCountResult] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(policies)
        .where(and(eq(policies.teamId, teamId), isNull(policies.deletedAt))),
    ]);

    const [memberCount] = memberCountResult;
    const [policyCount] = policyCountResult;

    return NextResponse.json({
      team: {
        id: team.id,
        name: team.name,
        slug: team.slug,
        ownerId: team.ownerId,
        memberCount: memberCount.count,
        policyCount: policyCount.count,
        createdAt: team.createdAt.toISOString(),
        updatedAt: team.updatedAt.toISOString(),
      },
      role: userMember?.role,
    });
  } catch (error) {
    console.error('Error getting team:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}

// PUT /api/teams/[teamId] - 更新团队设置
export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { teamId } = await params;

    // 检查更新权限
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.TEAM_UPDATE
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    const { name, slug } = await req.json();
    const updateData: { name?: string; slug?: string } = {};

    // 验证并更新名称
    if (name !== undefined) {
      const nameValidation = validateTeamName(name);
      if (!nameValidation.valid) {
        return NextResponse.json({ error: nameValidation.error }, { status: 400 });
      }
      updateData.name = name;
    }

    // 验证并更新 slug
    if (slug !== undefined) {
      const slugValidation = validateSlug(slug);
      if (!slugValidation.valid) {
        return NextResponse.json({ error: slugValidation.error }, { status: 400 });
      }

      // 检查 slug 唯一性（排除当前团队）
      const existingTeam = await db.query.teams.findFirst({
        where: and(eq(teams.slug, slug), not(eq(teams.id, teamId))),
      });
      if (existingTeam) {
        return NextResponse.json({ error: '此 slug 已被使用' }, { status: 400 });
      }
      updateData.slug = slug;
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: '没有提供要更新的字段' }, { status: 400 });
    }

    const [team] = await db
      .update(teams)
      .set(updateData)
      .where(eq(teams.id, teamId))
      .returning();

    if (!team) {
      throw new Error('Failed to update team');
    }

    return NextResponse.json({
      team: {
        id: team.id,
        name: team.name,
        slug: team.slug,
        updatedAt: team.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('Error updating team:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}

// DELETE /api/teams/[teamId] - 删除团队
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { teamId } = await params;

    // 检查删除权限（仅限 Owner）
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.TEAM_DELETE
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    // 吊销要按 teamId 查到 key，必须在删团队之前；吊销幂等，事务失败只多一次无害吊销，失败也不阻断删除（ADR 0015 §5）
    await revokeTeamKeys(teamId).catch((err) =>
      console.warn('[teams] revokeTeamKeys before team deletion failed:', err)
    );

    // 删除团队（手动级联删除关联记录）
    await db.transaction(async (tx) => {
      // 删除团队成员
      await tx.delete(teamMembers).where(eq(teamMembers.teamId, teamId));

      // 删除团队邀请
      await tx.delete(teamInvitations).where(eq(teamInvitations.teamId, teamId));

      // 删除团队策略分组
      await tx.delete(policyGroups).where(eq(policyGroups.teamId, teamId));

      // 注意：不删除 policies，只清除 teamId（保留个人归属）
      await tx
        .update(policies)
        .set({ teamId: null })
        .where(eq(policies.teamId, teamId));

      // 最后删除团队本身
      await tx.delete(teams).where(eq(teams.id, teamId));
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting team:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}
