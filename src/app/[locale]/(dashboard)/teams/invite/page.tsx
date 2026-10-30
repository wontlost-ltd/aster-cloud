import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { db, teamInvitations, users } from '@/lib/prisma';
import { matchesInvitationMailbox } from '@/lib/team-invitation-email';
import { AcceptInviteContent, type InvitationSummary } from './invite-content';

/**
 * 按 token 读出邀请摘要（团队名、角色、是否已过期、是否发给当前账号的邮箱），
 * 让接受页显示「加入 X 团队」并在账号邮箱不符时提前说明（#681）。查不到返回 null。
 */
async function loadInvitationSummary(token: string, userId: string): Promise<InvitationSummary | null> {
  const invitation = await db.query.teamInvitations.findFirst({
    where: eq(teamInvitations.token, token),
    columns: { email: true, role: true, expiresAt: true },
    with: { team: { columns: { name: true } } },
  });
  if (!invitation) return null;
  const me = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { email: true } });
  return {
    teamName: invitation.team.name,
    role: invitation.role,
    expired: invitation.expiresAt < new Date(),
    invitedEmail: invitation.email,
    emailMatches: matchesInvitationMailbox(me?.email, invitation.email),
  };
}

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * 接受团队邀请。未登录时先去登录，并把带 token 的原地址作为 callbackUrl 带上——
 * 邀请邮件里的链接在登录后仍能直接接受（#589：此前未登录也渲染工作台外壳，点接受才 401）。
 */
export default async function AcceptInvitePage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const session = await getSession();
  const token = (await searchParams).token;
  if (!session?.user?.id) {
    const query = typeof token === 'string' && token ? `?token=${encodeURIComponent(token)}` : '';
    redirect(`/${locale}/login?callbackUrl=${encodeURIComponent(`/${locale}/teams/invite${query}`)}`);
  }
  const invitation = typeof token === 'string' && token ? await loadInvitationSummary(token, session.user.id) : null;
  return <AcceptInviteContent invitation={invitation} />;
}
