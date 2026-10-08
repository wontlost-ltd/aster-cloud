import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, teamMembers } from '@/lib/prisma';
import { eq, and } from 'drizzle-orm';
import { refreshTeamKeySnapshots, revokeTeamKeys } from '@/lib/api-keys';
import {
  checkTeamAccess,
  checkTeamPermission,
  TeamPermission,
  canChangeRole,
  canRemoveMember,
  TeamRole,
} from '@/lib/team-permissions';

type RouteParams = { params: Promise<{ teamId: string; memberId: string }> };

// PUT /api/teams/[teamId]/members/[memberId] - 更新成员角色
export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { teamId, memberId } = await params;

    // 检查角色更新权限
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.MEMBER_UPDATE_ROLE
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    // 获取操作者的角色
    const access = await checkTeamAccess(session.user.id, teamId);
    if (!access.allowed) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    // 获取目标成员
    const targetMember = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.id, memberId), eq(teamMembers.teamId, teamId)),
    });

    if (!targetMember) {
      return NextResponse.json({ error: '成员不存在' }, { status: 404 });
    }

    const { role: newRole } = await req.json();

    // 验证新角色
    const validRoles = ['admin', 'member', 'viewer'];
    if (!newRole || !validRoles.includes(newRole)) {
      return NextResponse.json({ error: '无效的角色' }, { status: 400 });
    }

    // 检查角色变更权限
    const changeCheck = canChangeRole(
      access.role,
      targetMember.role as TeamRole,
      newRole as TeamRole
    );
    if (!changeCheck.allowed) {
      return NextResponse.json({ error: changeCheck.error }, { status: changeCheck.status });
    }

    // 更新角色
    await db
      .update(teamMembers)
      .set({ role: newRole })
      .where(eq(teamMembers.id, memberId));

    // 团队 key 的角色随成员角色走：重推该成员的 key 快照，aster-api 立即按新角色鉴权；失败不影响已提交的变更（ADR 0015 §5）
    await refreshTeamKeySnapshots(teamId, targetMember.userId).catch((err) =>
      console.warn('[teams] refreshTeamKeySnapshots after role change failed:', err)
    );

    // 重新查询获取完整信息
    const updatedMember = await db.query.teamMembers.findFirst({
      where: eq(teamMembers.id, memberId),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!updatedMember) {
      throw new Error('Failed to update member');
    }

    return NextResponse.json({
      id: updatedMember.id,
      userId: updatedMember.userId,
      role: updatedMember.role,
      user: updatedMember.user,
    });
  } catch (error) {
    console.error('Error updating member role:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}

// DELETE /api/teams/[teamId]/members/[memberId] - 移除成员
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { teamId, memberId } = await params;

    // 先验证操作者是否为团队成员（防止信息泄露/成员枚举）
    const access = await checkTeamAccess(session.user.id, teamId);
    if (!access.allowed) {
      // 对未授权用户统一返回 404，防止枚举攻击
      return NextResponse.json({ error: '成员不存在' }, { status: 404 });
    }

    // 获取目标成员
    const targetMember = await db.query.teamMembers.findFirst({
      where: and(eq(teamMembers.id, memberId), eq(teamMembers.teamId, teamId)),
    });

    if (!targetMember) {
      return NextResponse.json({ error: '成员不存在' }, { status: 404 });
    }

    const isSelf = targetMember.userId === session.user.id;

    // 如果是移除他人，需要检查移除权限
    if (!isSelf) {
      const permission = await checkTeamPermission(
        session.user.id,
        teamId,
        TeamPermission.MEMBER_REMOVE
      );
      if (!permission.allowed) {
        return NextResponse.json({ error: permission.error }, { status: permission.status });
      }
    }

    // 检查是否可以移除
    const removeCheck = canRemoveMember(access.role, targetMember.role as TeamRole, isSelf);
    if (!removeCheck.allowed) {
      return NextResponse.json({ error: removeCheck.error }, { status: removeCheck.status });
    }

    // 移除成员
    await db.delete(teamMembers).where(eq(teamMembers.id, memberId));

    // 被移出的成员不得再以团队身份调用：吊销其在该团队的 key（按 userId，不是 TeamMember.id）；失败不影响已提交的移除（ADR 0015 §5）
    await revokeTeamKeys(teamId, targetMember.userId).catch((err) =>
      console.warn('[teams] revokeTeamKeys after member removal failed:', err)
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error removing member:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}
