import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { createApiKey, listApiKeys } from '@/lib/api-keys';
import { hasFeatureAccess } from '@/lib/usage';
import { checkTeamAccess } from '@/lib/team-permissions';
import { db, teams } from '@/lib/prisma';

// GET /api/api-keys - List user's API keys
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const keys = await listApiKeys(session.user.id);

    return NextResponse.json(keys);
  } catch (error) {
    console.error('Error listing API keys:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/api-keys - Create a new API key
// 体 { name: string; teamId?: string }：带 teamId 为团队 key，否则为个人 key
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 先读 body 才能按个人 / 团队分流
    const { name, teamId } = (await req.json()) as { name?: unknown; teamId?: unknown };

    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { error: 'Name is required' },
        { status: 400 }
      );
    }

    if (teamId !== undefined && teamId !== null && typeof teamId !== 'string') {
      return NextResponse.json({ error: 'teamId must be a string' }, { status: 400 });
    }

    if (typeof teamId === 'string') {
      // 团队 key：调用者须为活跃成员；套餐门槛看 team owner（ADR 0015 §5）
      const access = await checkTeamAccess(session.user.id, teamId);
      const team = access.allowed
        ? await db.query.teams.findFirst({ where: eq(teams.id, teamId), columns: { ownerId: true } })
        : null;
      if (!access.allowed || !team) {
        return NextResponse.json({ error: 'not_a_member' }, { status: 403 });
      }
      if (!(await hasFeatureAccess(team.ownerId, 'apiAccess'))) {
        return NextResponse.json({ error: 'plan_no_api_access', upgrade: true }, { status: 403 });
      }
      return NextResponse.json(await createApiKey(session.user.id, name, teamId), { status: 201 });
    }

    // 个人 key：套餐门槛看本人，错误体与状态码保持不变
    const hasAccess = await hasFeatureAccess(session.user.id, 'apiAccess');
    if (!hasAccess) {
      return NextResponse.json(
        {
          error: 'API access requires Pro or Team subscription',
          upgrade: true,
        },
        { status: 403 }
      );
    }

    const apiKey = await createApiKey(session.user.id, name, null);

    return NextResponse.json(apiKey, { status: 201 });
  } catch (error) {
    console.error('Error creating API key:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
