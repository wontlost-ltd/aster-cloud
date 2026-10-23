import { NextRequest, NextResponse } from 'next/server';
import { and, desc, eq, ilike, isNull } from 'drizzle-orm';
import { users, auditLogs } from '@/db/schema';
import { db } from '@/lib/prisma';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const searchParams = new URL(req.url).searchParams;
  const query = searchParams.get('q')?.trim();
  const requestedLimit = Number(searchParams.get('limit') ?? 100);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 100;
  const conditions = [isNull(users.deletedAt)];
  if (query) conditions.push(ilike(users.email, `%${query}%`));

  const rows = await db.query.users.findMany({
    where: and(...conditions),
    orderBy: [desc(users.aiWorkspaceEnabled), desc(users.createdAt)],
    limit,
    columns: {
      id: true,
      email: true,
      name: true,
      isAdmin: true,
      aiWorkspaceEnabled: true,
      createdAt: true,
    },
  });
  return NextResponse.json({
    users: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;

  const body = await req.json().catch(() => null) as { userId?: unknown; enabled?: unknown } | null;
  if (!body || typeof body.userId !== 'string' || !body.userId.trim() || typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }

  const [updated] = await db.update(users)
    .set({ aiWorkspaceEnabled: body.enabled })
    .where(eq(users.id, body.userId))
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      isAdmin: users.isAdmin,
      aiWorkspaceEnabled: users.aiWorkspaceEnabled,
      createdAt: users.createdAt,
    });
  if (!updated) return NextResponse.json({ error: 'user_not_found' }, { status: 404 });

  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    userId: admin.userId,
    action: body.enabled ? 'ai_workspace.access.grant' : 'ai_workspace.access.revoke',
    resource: 'user',
    resourceId: updated.id,
    metadata: { adminUserId: admin.userId },
  });

  return NextResponse.json({ user: { ...updated, createdAt: updated.createdAt.toISOString() } });
}
