/*
 * POST /api/teams/invitations/decline
 *
 * In-app decline: removes a pending invitation matching the signed-in
 * user's email. The team owner sees the invitation disappear from
 * their /teams/[id]/members pending list on next refresh.
 *
 * Symmetric with /api/teams/invitations/accept's security model:
 * we re-verify that the caller's DB email matches the invitation's
 * email before deleting. Token-based decline (via email link) is
 * not implemented here — declining via email arguably just means
 * "do nothing and let it expire". This in-app flow is the explicit
 * affordance.
 */

import { NextResponse } from 'next/server';
import { eq, and, sql } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { db, teamInvitations, users, notifications } from '@/lib/prisma';
import { errorEnvelope } from '@/lib/api/error-envelope';
import { matchesInvitationMailbox } from '@/lib/team-invitation-email';

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { invitationId } = (await req.json()) as { invitationId?: string };
    if (!invitationId || typeof invitationId !== 'string') {
      return NextResponse.json(
        { error: 'invitationId is required' },
        { status: 400 },
      );
    }

    const me = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { email: true },
    });
    if (!me?.email) {
      return NextResponse.json({ error: 'No email on account' }, { status: 400 });
    }

    const invitation = await db.query.teamInvitations.findFirst({
      where: eq(teamInvitations.id, invitationId),
    });
    if (!invitation) {
      // Idempotent: already gone is success.
      return NextResponse.json({ ok: true });
    }

    if (!matchesInvitationMailbox(me.email, invitation.email)) {
      // Don't leak that the invitation exists for someone else —
      // 404 mirrors the accept route's "doesn't exist" path.
      return NextResponse.json(
        { error: 'Invitation not found' },
        { status: 404 },
      );
    }

    await db
      .delete(teamInvitations)
      .where(and(eq(teamInvitations.id, invitationId)));

    // Clean up the bell-feed notification too. Best-effort.
    try {
      await db
        .delete(notifications)
        .where(
          and(
            eq(notifications.userId, session.user.id),
            eq(notifications.kind, 'team.invitation_received'),
            sql`(${notifications.data} ->> 'invitationId') = ${invitationId}`,
          ),
        );
    } catch (e) {
      console.error('[invitations decline] notification cleanup failed', e);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const env = errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not decline the invitation. Please retry.',
    });
    console.error(
      '[invitations decline POST] handler failed',
      env.headers.get('x-request-id'),
      err,
    );
    return env;
  }
}
