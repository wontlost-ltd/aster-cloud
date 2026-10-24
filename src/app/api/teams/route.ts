import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, teams, teamMembers, policies } from '@/lib/prisma';
import { logSecurityAdminAction } from '@/services/security/security-event-service';
import { eq, and, isNull, desc, sql } from 'drizzle-orm';
import { hasFeatureAccess } from '@/lib/usage';
import { validateTeamName, validateSlug } from '@/lib/validation';
import { errorEnvelope } from '@/lib/api/error-envelope';


// GET /api/teams - 列出用户的团队
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    // R32 hotfix：原 `orderBy: desc(teams.updatedAt)` 在 db.query.teamMembers
    // 这个 root 上引用外表列，Drizzle 生成的 SQL 不把 Team 表加入到顶层 FROM
    // 子句，PG 抛 column-not-found / ambiguous-column，最终 catch 把 500
    // 还给浏览器（GET /api/teams 500 错误）。改成 root 表自己的列；前端
    // 期望"最近活跃的团队靠前"由 team.updatedAt 排序，在 JS 层做就行。
    const userTeams = await db.query.teamMembers.findMany({
      where: eq(teamMembers.userId, session.user.id),
      with: {
        team: {
          with: {
            members: {
              where: eq(teamMembers.userId, session.user.id),
            },
          },
        },
      },
      orderBy: desc(teamMembers.createdAt),
    });

    // 用 team.updatedAt 在 JS 层最终排序，符合"最近活跃团队靠前"的原意。
    userTeams.sort((a, b) => {
      const ta = a.team?.updatedAt ? a.team.updatedAt.getTime() : 0;
      const tb = b.team?.updatedAt ? b.team.updatedAt.getTime() : 0;
      return tb - ta;
    });

    // 并行获取每个团队的统计信息
    const teamsWithStats = await Promise.all(
      userTeams.map(async (userTeam) => {
        const team = userTeam.team;

        // 获取成员总数
        const [memberCountResult] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(teamMembers)
          .where(eq(teamMembers.teamId, team.id));

        // 获取策略总数（排除已删除）
        const [policyCountResult] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(policies)
          .where(and(eq(policies.teamId, team.id), isNull(policies.deletedAt)));

        return {
          id: team.id,
          name: team.name,
          slug: team.slug,
          role: userTeam.role,
          memberCount: memberCountResult.count,
          policyCount: policyCountResult.count,
          createdAt: team.createdAt.toISOString(),
        };
      })
    );

    return NextResponse.json({
      teams: teamsWithStats,
    });
  } catch (error) {
    // R32 hotfix：原版只 console.error("Error listing teams:") 然后吐
    // 静态 JSON，traceId 和 stack 都看不见。用 errorEnvelope 跟 POST 对齐，
    // 响应带 x-request-id，错误 stack 在日志里。
    const env = errorEnvelope({
      status: 500,
      code: 'teams_list_failed',
      message: 'Could not list your teams. Please retry; the failure has been logged.',
    });
    console.error(
      '[teams GET] handler failed',
      env.headers.get('x-request-id'),
      error,
    );
    return env;
  }
}

// POST /api/teams - 创建新团队
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    // 检查团队功能访问权限
    const hasAccess = await hasFeatureAccess(session.user.id, 'teamFeatures');
    if (!hasAccess) {
      return NextResponse.json(
        { error: '团队功能需要 Team 或 Enterprise 订阅', upgrade: true },
        { status: 403 }
      );
    }

    const { name, slug } = await req.json();

    // 验证名称
    const nameValidation = validateTeamName(name);
    if (!nameValidation.valid) {
      return NextResponse.json({ error: nameValidation.error }, { status: 400 });
    }

    // 验证 slug
    const slugValidation = validateSlug(slug);
    if (!slugValidation.valid) {
      return NextResponse.json({ error: slugValidation.error }, { status: 400 });
    }

    // 检查 slug 唯一性
    const existingTeam = await db.query.teams.findFirst({
      where: eq(teams.slug, slug),
    });
    if (existingTeam) {
      return NextResponse.json({ error: '此 slug 已被使用' }, { status: 400 });
    }

    // 创建团队和所有者成员关系（使用事务）
    const teamId = globalThis.crypto.randomUUID();
    const memberId = globalThis.crypto.randomUUID();

    // Defensive: pass createdAt + updatedAt explicitly. The schema
    // declares defaultNow() but some historic migrations shipped
    // without the PG `DEFAULT now()` clause — same root cause as the
    // policy-groups POST fix. Passing them is a no-op when the
    // default exists.
    const nowTs = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(teams).values({
        id: teamId,
        name,
        slug,
        ownerId: session.user.id,
        createdAt: nowTs,
        updatedAt: nowTs,
      });

      await tx.insert(teamMembers).values({
        id: memberId,
        teamId,
        userId: session.user.id,
        role: 'owner',
        createdAt: nowTs,
      });
    });

    // 查询新创建的团队
    const team = await db.query.teams.findFirst({
      where: eq(teams.id, teamId),
    });

    if (!team) {
      throw new Error('Failed to create team');
    }

    await logSecurityAdminAction(session.user.id, 'TEAM_CREATED', { teamId, teamName: team.name });

    return NextResponse.json(
      {
        id: team.id,
        name: team.name,
        slug: team.slug,
        ownerId: team.ownerId,
        createdAt: team.createdAt.toISOString(),
      },
      { status: 201 }
    );
  } catch (err) {
    const env = errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not create the team. Please retry; the failure has been logged.',
    });
    console.error(
      '[teams POST] handler failed',
      env.headers.get('x-request-id'),
      err,
    );
    return env;
  }
}
