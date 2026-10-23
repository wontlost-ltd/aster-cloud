import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getEffectiveRole } from '@/lib/effective-role';
import {
  AI_WORKSPACE_NEXT_PATTERN,
  isAiWorkspaceEnabledFor,
  resolveAiWorkspaceBase,
  toWorkspaceTheme,
} from '@/lib/ai-workspace';
import { signHandoffToken } from '@/lib/ai-workspace-handoff';
import { safeEnv } from '@/lib/runtime/safe-env';
import { db } from '@/lib/prisma';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

const LOCALES = new Set(['en', 'zh', 'de', 'hi']);

/** 把当前登录用户交接给 AI 工作台（ADR 0049 §2.6）：签发一次性令牌后 302 过去。 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const base = resolveAiWorkspaceBase(safeEnv('NEXT_PUBLIC_AI_WORKSPACE_URL'));
  const next = req.nextUrl.searchParams.get('next') ?? '/';
  const localeParam = req.nextUrl.searchParams.get('locale') ?? 'en';
  const locale = LOCALES.has(localeParam) ? localeParam : 'en';
  // 只接受 dark/light，其余值（含 system）丢弃，工作台按默认主题显示。
  const theme = toWorkspaceTheme(req.nextUrl.searchParams.get('theme'));
  // next 必须落在白名单内，防止令牌被带到工作台任意路径
  if (!AI_WORKSPACE_NEXT_PATTERN.test(next)) return NextResponse.json({ error: 'invalid_next' }, { status: 400 });

  const session = await auth();
  const userId = session?.user?.id;
  if (!session || !userId) {
    // 未登录：先登录，登录后回到本路由继续交接
    const login = new URL(`/${locale}/login`, req.nextUrl.origin);
    login.searchParams.set('callbackUrl', req.nextUrl.toString());
    return NextResponse.redirect(login, 302);
  }
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, isAdmin: true, aiWorkspaceEnabled: true },
  });
  if (!base || !user || !isAiWorkspaceEnabledFor(user, base, safeEnv('AI_WORKSPACE_ENABLED_FOR'))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const privateKey = safeEnv('AI_WORKSPACE_HANDOFF_PRIVATE_KEY');
  if (!privateKey) {
    // 配置缺失时工作台会陷入交接失败，记一行便于排查（不含用户信息）
    console.warn('[ai-workspace] handoff unavailable: AI_WORKSPACE_HANDOFF_PRIVATE_KEY is not set');
    return NextResponse.json({ error: 'ai_workspace_unconfigured' }, { status: 503 });
  }

  const token = await signHandoffToken(
    {
      sub: userId,
      name: session.user?.name ?? null,
      email: session.user?.email ?? null,
      locale,
      role: await getEffectiveRole(userId),
    },
    privateKey,
  );
  const target = new URL(`${base}/handoff`);
  target.searchParams.set('token', token);
  target.searchParams.set('next', next);
  if (theme) target.searchParams.set('theme', theme);
  return NextResponse.redirect(target, 302);
}
