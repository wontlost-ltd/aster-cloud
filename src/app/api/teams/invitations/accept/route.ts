import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, teams, teamInvitations, teamMembers, users, notifications } from '@/lib/prisma';
import { eq, and, sql } from 'drizzle-orm';
import { IS_SAAS } from '@/lib/deployment-mode';
import { getStripe } from '@/lib/stripe';
import { createNotification } from '@/lib/notifications';


// POST /api/teams/invitations/accept - 接受邀请
//
// Body accepts EITHER:
//   { token: "<hex-from-email-link>" }       — legacy email-click flow
//   { invitationId: "<uuid>" }               — in-app inbox flow
// Both routes converge on the same invitation record, then run the
// identical email-match + member-create transaction. Email-match is
// the security gate either way: the token alone is not enough — the
// caller's session email must match the invitation's email column.
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as {
      token?: string;
      invitationId?: string;
    };
    const { token, invitationId } = body;

    if (
      (!token || typeof token !== 'string') &&
      (!invitationId || typeof invitationId !== 'string')
    ) {
      return NextResponse.json(
        { error: 'token or invitationId is required' },
        { status: 400 },
      );
    }

    // 查找邀请 — by token (email-link) or by id (in-app inbox).
    const invitation = await db.query.teamInvitations.findFirst({
      where: token
        ? eq(teamInvitations.token, token)
        : eq(teamInvitations.id, invitationId!),
      with: {
        team: {
          columns: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    if (!invitation) {
      return NextResponse.json({ error: 'Invitation not found or no longer valid.', code: 'invitation_not_found' }, { status: 404 });
    }

    // 检查邀请是否过期
    if (invitation.expiresAt < new Date()) {
      // 删除过期邀请
      await db.delete(teamInvitations).where(eq(teamInvitations.id, invitation.id));
      return NextResponse.json({ error: 'Invitation has expired.', code: 'invitation_expired' }, { status: 400 });
    }

    // 获取当前用户的邮箱
    const currentUser = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { email: true },
    });

    // 检查邀请邮箱是否匹配（安全要求：必须严格匹配）
    if (
      !currentUser?.email ||
      currentUser.email.toLowerCase() !== invitation.email.toLowerCase()
    ) {
      return NextResponse.json({ error: 'This invitation is restricted to the specified email address.', code: 'invitation_email_mismatch' }, { status: 403 });
    }

    // 检查用户是否已是成员
    const existingMember = await db.query.teamMembers.findFirst({
      where: and(
        eq(teamMembers.teamId, invitation.teamId),
        eq(teamMembers.userId, session.user.id)
      ),
    });

    if (existingMember) {
      // 删除邀请
      await db.delete(teamInvitations).where(eq(teamInvitations.id, invitation.id));
      return NextResponse.json({ error: 'You are already a member of this team.', code: 'already_team_member' }, { status: 400 });
    }

    // 使用事务创建成员并删除邀请
    await db.transaction(async (tx) => {
      await tx.insert(teamMembers).values({
        id: globalThis.crypto.randomUUID(),
        teamId: invitation.teamId,
        userId: session.user.id,
        role: invitation.role,
      });

      await tx.delete(teamInvitations).where(eq(teamInvitations.id, invitation.id));
    });

    // Tidy the originating "team.invitation_received" notification
    // for this user so the bell drops the row immediately, instead
    // of waiting for the user to dismiss it manually. Best-effort —
    // a leftover row is harmless (clicking through it just lands on
    // /teams where the invitation is already gone) so we don't fail
    // the accept on a delete error.
    try {
      await db
        .delete(notifications)
        .where(
          and(
            eq(notifications.userId, session.user.id),
            eq(notifications.kind, 'team.invitation_received'),
            sql`(${notifications.data} ->> 'invitationId') = ${invitation.id}`,
          ),
        );
    } catch (e) {
      console.error('[invitation-accept] notification cleanup failed', e);
    }

    // On-prem 不接 Stripe；跳过 seat sync。SaaS 模式才走这一步。
    if (IS_SAAS) {
      await syncStripeSeats(invitation.teamId).catch((err) => {
        console.error('[invitation-accept] Stripe seat sync failed', err);
      });
    }

    // Notify the team owner that someone joined. Best-effort —
    // notification failures don't block the success response.
    // We look up the owner + the new member's display name here
    // rather than at write time so the inviter's bell shows the
    // current (possibly post-rename) member name.
    try {
      const team = await db.query.teams.findFirst({
        where: eq(teams.id, invitation.teamId),
        columns: { ownerId: true, name: true },
      });
      const newMember = await db.query.users.findFirst({
        where: eq(users.id, session.user.id),
        columns: { name: true, email: true },
      });
      if (team && team.ownerId !== session.user.id) {
        await createNotification({
          userId: team.ownerId,
          kind: 'team.invitation_accepted',
          data: {
            teamId: invitation.teamId,
            teamName: team.name,
            memberName:
              newMember?.name ?? newMember?.email ?? 'A teammate',
          },
        });
      }
    } catch (notifErr) {
      console.error(
        '[invitation-accept] notify owner failed (non-fatal)',
        notifErr,
      );
    }

    return NextResponse.json({
      success: true,
      team: {
        id: invitation.team.id,
        name: invitation.team.name,
        slug: invitation.team.slug,
      },
      role: invitation.role,
    });
  } catch (error) {
    console.error('Error accepting invitation:', error);
    return NextResponse.json({ error: 'Internal server error.', code: 'internal_server_error' }, { status: 500 });
  }
}

/**
 * 接受邀请后同步 Stripe 订阅 seats 到团队当前成员数。
 * - 只对 owner 已订阅 Pro/Enterprise 的团队生效（其他情况静默跳过）
 * - 失败不阻塞用户加入团队（最坏由 reconcile cron 兜底）
 */
async function syncStripeSeats(teamId: string): Promise<void> {
  const team = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
    columns: { ownerId: true },
  });
  if (!team) return;

  const owner = await db.query.users.findFirst({
    where: eq(users.id, team.ownerId),
    columns: { subscriptionId: true, subscriptionStatus: true },
  });
  if (!owner?.subscriptionId || owner.subscriptionStatus !== 'active') return;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));

  const stripe = await getStripe();
  const subscription = await stripe.subscriptions.retrieve(owner.subscriptionId);
  const item = subscription.items.data[0];
  if (!item) return;
  if (item.quantity === count) return;

  await stripe.subscriptionItems.update(item.id, {
    quantity: count,
    proration_behavior: 'create_prorations',
  });
}
