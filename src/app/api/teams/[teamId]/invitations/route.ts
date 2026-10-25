import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

import { getSession } from '@/lib/auth';
import { db, teams, teamMembers, teamInvitations, users } from '@/lib/prisma';
import { eq, and, gt, desc } from 'drizzle-orm';
import {
  checkTeamAccess,
  checkTeamPermission,
  TeamPermission,
  canInviteWithRole,
  TeamRole,
} from '@/lib/team-permissions';
import { sendTeamInvitationEmail } from '@/lib/resend';
import { getEffectiveLimits, type PlanType } from '@/lib/plans';
import { upgradeResponse, UPGRADE_HTTP_STATUS } from '@/lib/plan-quota';
import { createNotification } from '@/lib/notifications';
import { sql } from 'drizzle-orm';

type RouteParams = { params: Promise<{ teamId: string }> };

// 生成邀请令牌
function generateInvitationToken(): string {
  return randomBytes(32).toString('hex');
}

// 获取邀请过期时间（默认7天）
function getInvitationExpiryDate(days: number = 7): Date {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt;
}

// GET /api/teams/[teamId]/invitations - 列出待处理的邀请
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }

    const { teamId } = await params;

    // 检查查看邀请的权限
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.INVITATION_VIEW
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error, code: permission.code }, { status: permission.status });
    }

    // 获取未过期的邀请
    const invitations = await db.query.teamInvitations.findMany({
      where: and(eq(teamInvitations.teamId, teamId), gt(teamInvitations.expiresAt, new Date())),
      orderBy: desc(teamInvitations.createdAt),
    });

    return NextResponse.json({
      invitations: invitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        expiresAt: inv.expiresAt.toISOString(),
        createdAt: inv.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('Error listing invitations:', error);
    return NextResponse.json({ error: 'Internal server error.', code: 'internal_server_error' }, { status: 500 });
  }
}

// POST /api/teams/[teamId]/invitations - 创建邀请
export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }

    const { teamId } = await params;

    // 检查创建邀请的权限
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.INVITATION_CREATE
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error, code: permission.code }, { status: permission.status });
    }

    // 获取操作者的角色
    const access = await checkTeamAccess(session.user.id, teamId);
    if (!access.allowed) {
      return NextResponse.json({ error: access.error, code: access.code }, { status: access.status });
    }

    const { email, role } = await req.json();

    // 验证邮箱
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return NextResponse.json({ error: 'Invalid email address.', code: 'invalid_email' }, { status: 400 });
    }

    // 验证角色
    const validRoles = ['admin', 'member', 'viewer'];
    if (!role || !validRoles.includes(role)) {
      return NextResponse.json({ error: 'Invalid role.', code: 'invalid_role' }, { status: 400 });
    }

    // 检查邀请角色权限
    const inviteCheck = canInviteWithRole(access.role, role as TeamRole);
    if (!inviteCheck.allowed) {
      return NextResponse.json({ error: inviteCheck.error, code: inviteCheck.code }, { status: inviteCheck.status });
    }

    // PM v1.1：plan gate 检查 maxTeamMembers
    // Free 档 maxTeamMembers=1，邀请第二人即触发 team_member_invite reason
    const ownerTeam = await db.query.teams.findFirst({ where: eq(teams.id, teamId) });
    if (ownerTeam) {
      const owner = await db.query.users.findFirst({ where: eq(users.id, ownerTeam.ownerId) });
      if (owner) {
        const limits = getEffectiveLimits({
          plan: owner.plan as PlanType,
          priceLockedAt: owner.priceLockedAt,
          legacyTier: owner.legacyTier,
        });
        if (limits.maxTeamMembers !== -1) {
          const [{ count: memberCount }] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(teamMembers)
            .where(eq(teamMembers.teamId, teamId));
          // 已有成员数 >= 上限 → 拒绝邀请；用 reviewer_required 还是 team_member_invite
          // 取决于 plan 是否支持审批：Free 用 team_member_invite，其他档位均不应进入此分支
          if (memberCount >= limits.maxTeamMembers) {
            const reason = limits.approvalRequired ? 'team_member_invite' : 'reviewer_required';
            return NextResponse.json(
              upgradeResponse(reason, {
                usage: memberCount,
                limit: limits.maxTeamMembers,
                message: `Plan allows ${limits.maxTeamMembers} team member(s). Upgrade to invite more.`,
              }),
              { status: UPGRADE_HTTP_STATUS }
            );
          }
        }
      }
    }

    // 检查用户是否已是成员（通过 user.email 关联）
    const userWithEmail = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (userWithEmail) {
      const existingMember = await db.query.teamMembers.findFirst({
        where: and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userWithEmail.id)),
      });

      if (existingMember) {
        return NextResponse.json({ error: 'This user is already a team member.', code: 'already_team_member' }, { status: 400 });
      }
    }

    // 检查是否已有待处理的邀请
    const existingInvitation = await db.query.teamInvitations.findFirst({
      where: and(
        eq(teamInvitations.teamId, teamId),
        eq(teamInvitations.email, email),
        gt(teamInvitations.expiresAt, new Date())
      ),
    });

    if (existingInvitation) {
      return NextResponse.json({ error: 'A pending invitation already exists for this email address.', code: 'invitation_already_pending' }, { status: 400 });
    }

    // 获取团队和邀请者信息
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
      columns: { name: true },
    });

    const inviter = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { name: true },
    });

    // 创建邀请
    const token = generateInvitationToken();
    const invitationId = globalThis.crypto.randomUUID();

    const [invitation] = await db
      .insert(teamInvitations)
      .values({
        id: invitationId,
        teamId,
        email,
        role,
        token,
        expiresAt: getInvitationExpiryDate(),
      })
      .returning();

    if (!invitation) {
      throw new Error('Failed to create invitation');
    }

    // 发送邀请邮件
    const emailResult = await sendTeamInvitationEmail(
      email,
      team?.name || '未知团队',
      inviter?.name || '团队成员',
      token
    );

    // In-app notification: if the invitee already has an account
    // under this email, drop a notification into their bell feed so
    // they see it without ever opening the invitation email. Done
    // best-effort (createNotification swallows its own errors); a
    // missing notification is not a reason to fail the invite.
    if (userWithEmail) {
      await createNotification({
        userId: userWithEmail.id,
        kind: 'team.invitation_received',
        data: {
          teamId,
          teamName: team?.name ?? 'Team',
          invitationId: invitation.id,
          role,
        },
      });
    }

    return NextResponse.json(
      {
        id: invitation.id,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt.toISOString(),
        emailSent: emailResult.success,
        // 始终返回邀请链接，便于手动分享或审计
        inviteUrl: emailResult.inviteUrl,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Error creating invitation:', error);
    return NextResponse.json({ error: 'Internal server error.', code: 'internal_server_error' }, { status: 500 });
  }
}
