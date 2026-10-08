import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, teamMembers } from '@/lib/prisma';
import { eq, and } from 'drizzle-orm';
import { refreshTeamKeySnapshots, revokeTeamKeys } from '@/lib/api-keys';
import { BusinessRoleError, normalizeBusinessRoles } from '@/lib/business-roles';
import {
  checkTeamAccess,
  checkTeamPermission,
  TeamPermission,
  canChangeRole,
  canRemoveMember,
  TeamRole,
} from '@/lib/team-permissions';

type RouteParams = { params: Promise<{ teamId: string; memberId: string }> };

const VALID_ROLES = ['admin', 'member', 'viewer'];
type MemberUpdate = { role?: TeamRole; businessRoles?: string[] };
type ParsedUpdate = { ok: true; set: MemberUpdate } | { ok: false; error: string };

/**
 * 解析成员更新体：`role` 与 `businessRoles`（ADR 0042 §2.1）至少给一个；只校验形状，
 * 角色变更的层级约束（canChangeRole）由调用方结合操作者角色判断。
 */
function parseMemberUpdate(body: unknown): ParsedUpdate {
  const { role, businessRoles } = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (role === undefined && businessRoles === undefined) return { ok: false, error: '无效的角色' };
  const set: MemberUpdate = {};
  if (role !== undefined) {
    if (typeof role !== 'string' || !VALID_ROLES.includes(role)) return { ok: false, error: '无效的角色' };
    set.role = role as TeamRole;
  }
  if (businessRoles !== undefined) {
    try {
      set.businessRoles = normalizeBusinessRoles(businessRoles);
    } catch (err) {
      if (err instanceof BusinessRoleError) return { ok: false, error: err.message };
      throw err;
    }
  }
  return { ok: true, set };
}

// PUT /api/teams/[teamId]/members/[memberId] - 更新成员角色和/或业务角色
export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { teamId, memberId } = await params;

    // 检查角色更新权限（业务角色沿用同一权限，不新增常量，ADR 0042 §2.1）
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

    const parsed = parseMemberUpdate(await req.json().catch(() => null));
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // 检查角色变更权限；只改业务角色时不涉及成员层级，owner 行也可被授予业务角色
    if (parsed.set.role) {
      const changeCheck = canChangeRole(access.role, targetMember.role as TeamRole, parsed.set.role);
      if (!changeCheck.allowed) {
        return NextResponse.json({ error: changeCheck.error }, { status: changeCheck.status });
      }
    }

    await db
      .update(teamMembers)
      .set(parsed.set)
      .where(eq(teamMembers.id, memberId));

    // 团队 key 的角色与业务角色随成员行走：重推该成员的 key 快照，aster-api 立即按新身份鉴权；失败不影响已提交的变更（ADR 0015 §5）
    await refreshTeamKeySnapshots(teamId, targetMember.userId).catch((err) =>
      console.warn('[teams] refreshTeamKeySnapshots after member update failed:', err)
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
      businessRoles: updatedMember.businessRoles,
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
