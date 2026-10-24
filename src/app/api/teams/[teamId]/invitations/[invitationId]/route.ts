import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, teamInvitations } from '@/lib/prisma';
import { eq, and } from 'drizzle-orm';
import { checkTeamPermission, TeamPermission } from '@/lib/team-permissions';

type RouteParams = { params: Promise<{ teamId: string; invitationId: string }> };

// DELETE /api/teams/[teamId]/invitations/[invitationId] - 撤销邀请
export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }

    const { teamId, invitationId } = await params;

    // 检查撤销邀请的权限
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.INVITATION_REVOKE
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    // 获取邀请
    const invitation = await db.query.teamInvitations.findFirst({
      where: and(eq(teamInvitations.id, invitationId), eq(teamInvitations.teamId, teamId)),
    });

    if (!invitation) {
      return NextResponse.json({ error: 'Invitation not found.', code: 'invitation_not_found' }, { status: 404 });
    }

    // 删除邀请
    await db.delete(teamInvitations).where(eq(teamInvitations.id, invitationId));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error revoking invitation:', error);
    return NextResponse.json({ error: 'Internal server error.', code: 'internal_server_error' }, { status: 500 });
  }
}
