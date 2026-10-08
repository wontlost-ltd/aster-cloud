import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { db, users } from '@/lib/prisma';
import { refreshPersonalKeySnapshots } from '@/lib/api-keys';
import { BusinessRoleError, normalizeBusinessRoles } from '@/lib/business-roles';

/**
 * PUT /api/user/business-roles
 *
 * Body: { businessRoles: string[] }
 *
 * 个人租户的业务角色（ADR 0042 §2.1）：整体替换，入库前经 normalizeBusinessRoles；
 * 写入后重推本人个人 key 的快照，使 aster-api 按新角色判定审批资格（团队角色走成员路由）。
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(req: Request) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be a valid object' }, { status: 400 });
  }

  let businessRoles: string[];
  try {
    businessRoles = normalizeBusinessRoles((body as { businessRoles?: unknown }).businessRoles);
  } catch (err) {
    if (err instanceof BusinessRoleError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const userId = session.user.id;
  await db.update(users).set({ businessRoles }).where(eq(users.id, userId));

  // 快照重推失败不影响已提交的写入：verify 缓存过期后 aster-api 仍会读到新角色（ADR 0042 §2.4）
  await refreshPersonalKeySnapshots(userId).catch((err) =>
    console.warn('[user] refreshPersonalKeySnapshots after business role change failed:', err)
  );

  return NextResponse.json({ businessRoles });
}
