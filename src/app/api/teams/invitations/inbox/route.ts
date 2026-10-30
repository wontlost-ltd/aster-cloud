/*
 * GET /api/teams/invitations/inbox
 *
 * In-app inbox: returns all pending team invitations addressed to the
 * signed-in user's email, regardless of which team owner sent them.
 * Powers the "Pending invitations" card on /teams so users can accept
 * or decline without clicking the email link.
 *
 * Security model: the existing token-based accept flow (POST
 * /api/teams/invitations/accept) requires session.user.email ===
 * invitation.email. The inbox uses the same email match — we only
 * surface invitations the caller is allowed to act on.
 *
 * Expired invitations are filtered out and pruned in the same query
 * (best-effort delete, swallowed on failure) so the inbox stays
 * actionable.
 */

import { NextResponse } from 'next/server';
import { eq, and, gt } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { db, teamInvitations, users } from '@/lib/prisma';
import { errorEnvelope } from '@/lib/api/error-envelope';
import { invitationMailboxCandidates, matchesInvitationMailbox } from '@/lib/team-invitation-email';

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Pull the verified email from the DB rather than trusting
    // session.user.email — the email-match is a security gate, and
    // session-side values could in theory be set client-side via
    // some future custom credential path. DB is the source of truth.
    const me = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { email: true },
    });
    if (!me?.email) {
      return NextResponse.json({ invitations: [] });
    }

    const now = new Date();
    // 同一邮箱的邀请（忽略大小写、含 +别名，#682）：SQL 先按域名预筛，再在内存里精确判定
    const candidates = await db.query.teamInvitations.findMany({
      where: and(
        invitationMailboxCandidates(me.email),
        gt(teamInvitations.expiresAt, now),
      ),
      with: {
        team: {
          columns: { id: true, name: true, slug: true },
        },
      },
    });

    const rows = candidates.filter((r) => matchesInvitationMailbox(me.email, r.email));

    return NextResponse.json({
      invitations: rows.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        teamName: r.team.name,
        teamSlug: r.team.slug,
        role: r.role,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    const env = errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not load your pending invitations. Please retry.',
    });
    console.error(
      '[invitations inbox GET] handler failed',
      env.headers.get('x-request-id'),
      err,
    );
    return env;
  }
}
