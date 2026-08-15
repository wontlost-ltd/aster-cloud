import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import { hashPassword, verifyPassword } from '@/auth';
import { db, users } from '@/lib/prisma';

/**
 * POST /api/user/change-password
 *
 * Body: { currentPassword, newPassword }
 *
 * The user must prove possession of the CURRENT password before we
 * set a new one — session cookie alone is not sufficient. This
 * matters for the forced-rotation flow: an attacker with a session
 * cookie still can't lock the legitimate user out of the account
 * unless they also know the temporary the operator handed over.
 *
 * Clears `mustChangePassword` on success so the dashboard layout
 * gate stops redirecting here.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
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
    return NextResponse.json(
      { error: 'Request body must be a valid object' },
      { status: 400 },
    );
  }
  const { currentPassword, newPassword } = body as {
    currentPassword?: string;
    newPassword?: string;
  };
  if (
    typeof currentPassword !== 'string' ||
    typeof newPassword !== 'string'
  ) {
    return NextResponse.json(
      { error: 'currentPassword and newPassword are required' },
      { status: 400 },
    );
  }
  if (newPassword.length < 8) {
    return NextResponse.json(
      { error: 'New password must be at least 8 characters' },
      { status: 400 },
    );
  }
  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: 'New password must differ from the current one' },
      { status: 400 },
    );
  }

  const userId = session.user.id;
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { id: true, passwordHash: true },
  });
  if (!row || !row.passwordHash) {
    // OAuth-only accounts have no password to change here. They
    // should hit /forgot-password to *set* a credential password.
    return NextResponse.json(
      { error: 'No password set on this account' },
      { status: 400 },
    );
  }

  const ok = await verifyPassword(currentPassword, row.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: 'Current password is incorrect' },
      { status: 401 },
    );
  }

  const newHash = await hashPassword(newPassword);
  await db
    .update(users)
    .set({ passwordHash: newHash, mustChangePassword: false })
    .where(eq(users.id, userId));

  // ★吊销该用户全部「可信设备」（issue #400）：改密后旧密码不应再能
  //   配合已记住的设备登录。失败不阻断——密码已改，记日志供排查。
  try {
    const { revokeAllTrustedDevices } = await import('@/lib/trusted-device');
    const revoked = await revokeAllTrustedDevices(userId);
    if (revoked > 0) {
      console.warn(`[auth] 改密后吊销 ${revoked} 台可信设备: user=${userId}`);
    }
  } catch (err) {
    console.error('[auth] 改密后吊销可信设备失败:', err);
  }

  return NextResponse.json({ ok: true });
}
