import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { db, teams, teamMembers, policies } from '@/lib/prisma';
import { and, eq, desc, isNull, sql, inArray } from 'drizzle-orm';
import { hasFeatureAccess } from '@/lib/usage';
import { TeamsContent } from './teams-content';

/**
 * /teams — server shell.
 *
 * Resolves session + access flag + pre-aggregated teams list and
 * hands them to the client. Translation strings are NOT pre-rendered
 * here anymore: NextIntlClientProvider is mounted in [locale]/layout.tsx
 * and the client content uses useTranslations() directly. Drops ~25 LOC
 * of mechanical key listing per page (see audit "prerender anti-pattern").
 */
export default async function TeamsPage() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect('/login');
  }

  const hasAccess = await hasFeatureAccess(session.user.id, 'teamFeatures');

  let teamsResult: {
    id: string;
    name: string;
    slug: string;
    role: string;
    memberCount: number;
    policyCount: number;
    createdAt: string;
  }[] = [];

  if (hasAccess) {
    const userTeamMemberships = await db.query.teamMembers.findMany({
      where: eq(teamMembers.userId, session.user.id),
      columns: { teamId: true, role: true },
    });

    if (userTeamMemberships.length > 0) {
      const teamIds = userTeamMemberships.map((m) => m.teamId);
      const teamsData = await db.query.teams.findMany({
        where: inArray(teams.id, teamIds),
        orderBy: desc(teams.updatedAt),
      });

      // Two GROUP BY queries replace the previous 2 × N pattern.
      const teamIdList = teamsData.map((t) => t.id);
      const [memberRows, policyRows] = await Promise.all([
        db
          .select({
            teamId: teamMembers.teamId,
            c: sql<number>`count(*)::int`,
          })
          .from(teamMembers)
          .where(inArray(teamMembers.teamId, teamIdList))
          .groupBy(teamMembers.teamId),
        db
          .select({
            teamId: policies.teamId,
            c: sql<number>`count(*)::int`,
          })
          .from(policies)
          // 回收站里的策略不计入（与团队策略列表同一口径，#674）
          .where(and(inArray(policies.teamId, teamIdList), isNull(policies.deletedAt)))
          .groupBy(policies.teamId),
      ]);
      const memberCountByTeam = new Map<string, number>(
        memberRows.map((r) => [r.teamId, r.c]),
      );
      const policyCountByTeam = new Map<string, number>(
        policyRows
          .filter((r): r is { teamId: string; c: number } => r.teamId !== null)
          .map((r) => [r.teamId, r.c]),
      );

      teamsResult = teamsData.map((team) => {
        const membership = userTeamMemberships.find((m) => m.teamId === team.id);
        return {
          id: team.id,
          name: team.name,
          slug: team.slug,
          role: membership?.role || 'member',
          memberCount: memberCountByTeam.get(team.id) ?? 0,
          policyCount: policyCountByTeam.get(team.id) ?? 0,
          createdAt: team.createdAt.toISOString(),
        };
      });
    }
  }

  return (
    <TeamsContent
      initialTeams={teamsResult}
      needsUpgrade={!hasAccess}
    />
  );
}
