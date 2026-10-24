import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { checkTeamPermission, TeamPermission } from '@/lib/team-permissions';
import { getTeamEnabledLocales, setTeamEnabledLocales } from '@/lib/team-locales';
import { locales, defaultLocale, type Locale } from '@/i18n/config';

type RouteParams = { params: Promise<{ teamId: string }> };

/**
 * GET /api/teams/[teamId]/locales — 读取团队语言白名单。
 *
 * 返回：
 *  - `compiled`: 平台编译支持的全部 locale（i18n/config）
 *  - `selectable`: 团队**可勾选**的 locale = 编译支持全集。
 *    真实可用性由语言切换器的编译集 ∩ 后端 lexicon 注册表决定。
 *  - `enabled`: 当前团队白名单；`null` = 未配置 = 全部开放
 *  - `defaultLocale`: 不可关闭的默认语言
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }
    const { teamId } = await params;

    // 读取需 TEAM_VIEW；写入才需 TEAM_UPDATE_LOCALES。
    const permission = await checkTeamPermission(session.user.id, teamId, TeamPermission.TEAM_VIEW);
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    const enabled = await getTeamEnabledLocales(teamId);
    return NextResponse.json({
      compiled: [...locales],
      selectable: [...locales],
      enabled,
      defaultLocale,
    });
  } catch (error) {
    console.error('Error reading team locales:', error);
    return NextResponse.json({ error: 'Internal server error.', code: 'internal_server_error' }, { status: 500 });
  }
}

/**
 * PUT /api/teams/[teamId]/locales — 更新团队语言白名单。
 *
 * Body: `{ enabled: string[] }` — 期望开放的 locale 列表。
 * 经 normalizeEnabledLocales 处理（去重 + 仅留编译支持 + 强制含 defaultLocale，
 * 全集时存 null）。需 TEAM_UPDATE_LOCALES（owner/admin）。
 */
export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized', code: 'unauthorized' }, { status: 401 });
    }
    const { teamId } = await params;

    const permission = await checkTeamPermission(
      session.user.id,
      teamId,
      TeamPermission.TEAM_UPDATE_LOCALES,
    );
    if (!permission.allowed) {
      return NextResponse.json({ error: permission.error }, { status: permission.status });
    }

    const body = (await req.json()) as { enabled?: unknown };
    if (!Array.isArray(body.enabled) || !body.enabled.every((l) => typeof l === 'string')) {
      return NextResponse.json(
        { error: 'enabled must be an array of locale strings.', code: 'invalid_locale_list' },
        { status: 400 },
      );
    }
    // 仅接受编译支持的 locale，拒绝未知值（防止存入垃圾）。
    const unknown = body.enabled.filter((l) => !(locales as readonly string[]).includes(l));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: `Unsupported locales: ${unknown.join(', ')}.`, code: 'unsupported_locales' },
        { status: 400 },
      );
    }

    await setTeamEnabledLocales(teamId, body.enabled as Locale[]);
    const enabled = await getTeamEnabledLocales(teamId);
    return NextResponse.json({ enabled, defaultLocale });
  } catch (error) {
    console.error('Error updating team locales:', error);
    return NextResponse.json({ error: 'Internal server error.', code: 'internal_server_error' }, { status: 500 });
  }
}
