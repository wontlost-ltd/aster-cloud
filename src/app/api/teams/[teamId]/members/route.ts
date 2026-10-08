import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, teamMembers } from '@/lib/prisma';
import { eq, asc, sql } from 'drizzle-orm';
import { checkTeamPermission, TeamPermission } from '@/lib/team-permissions';

type RouteParams = { params: Promise<{ teamId: string }> };

// GET /api/teams/[teamId]/members - 列出团队成员（支持分页）
export async function GET(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const { teamId } = await params;

    // 解析分页参数（防护 NaN 和负值）
    const url = new URL(req.url);
    const rawLimit = parseInt(url.searchParams.get('limit') || '50');
    const rawOffset = parseInt(url.searchParams.get('offset') || '0');
    const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), 100);
    const offset = Math.max(isNaN(rawOffset) ? 0 : rawOffset, 0);

    // 检查访问权限
    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.MEMBER_VIEW
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    // 并行查询成员列表和总数
    const [members, totalResult] = await Promise.all([
      db.query.teamMembers.findMany({
        where: eq(teamMembers.teamId, teamId),
        with: {
          user: {
            columns: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
        orderBy: [asc(teamMembers.role), asc(teamMembers.createdAt)],
        limit,
        offset,
      }),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(teamMembers)
        .where(eq(teamMembers.teamId, teamId)),
    ]);

    const [{ count: total }] = totalResult;

    return NextResponse.json({
      members: members.map((member) => ({
        id: member.id,
        userId: member.userId,
        user: {
          id: member.user.id,
          name: member.user.name,
          email: member.user.email,
          image: member.user.image,
        },
        role: member.role,
        businessRoles: member.businessRoles,
        joinedAt: member.createdAt.toISOString(),
      })),
      currentUserId: session.user.id,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + members.length < total,
      },
    });
  } catch (error) {
    console.error('Error listing team members:', error);
    return NextResponse.json({ error: '服务器内部错误' }, { status: 500 });
  }
}
