import { NextResponse } from 'next/server';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { db, structuralAliasGrants, users } from '@/lib/prisma';
import { bypassQueryCache } from '@/db/fresh-read';

export async function GET() {
  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      grantId: structuralAliasGrants.id,
      grantedBy: structuralAliasGrants.grantedBy,
      grantedAt: structuralAliasGrants.grantedAt,
    })
    .from(users)
    .leftJoin(
      structuralAliasGrants,
      and(
        eq(structuralAliasGrants.userId, users.id),
        isNull(structuralAliasGrants.revokedAt),
      ),
    )
    // 管理卡在授予 / 撤销后立刻重新拉取，必须读到刚写入的状态。此前这条无参数的固定 SQL
    // 被 Hyperdrive 缓存，授予后约 100 秒仍显示未授权（#614）。
    .where(bypassQueryCache())
    .orderBy(desc(users.createdAt));

  return NextResponse.json({
    users: rows.map((row) => ({
      userId: row.userId,
      email: row.email,
      name: row.name,
      granted: Boolean(row.grantId),
      grantId: row.grantId,
      grantedBy: row.grantedBy,
      grantedAt: row.grantedAt,
    })),
  });
}

export async function POST(req: Request) {
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;

  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  const body = (await req.json()) as { userId?: unknown };
  if (typeof body.userId !== 'string' || !body.userId.trim()) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  // 幂等授予：直接插入，由 partial UNIQUE(userId) WHERE revokedAt IS NULL 兜住「至多一条活跃」，
  // 已有活跃授权时 ON CONFLICT DO NOTHING，重复 / 并发请求都返回成功。
  // 不再先查后插：先查那一步是普通 SELECT，会被 Hyperdrive 缓存——撤销后窗口内再授予，
  // 缓存里的旧「已授权」结果会让插入被跳过，授予静默丢失（#614）。
  await db
    .insert(structuralAliasGrants)
    .values({
      id: crypto.randomUUID(),
      userId: body.userId,
      grantedBy: check.userId,
    })
    .onConflictDoNothing();

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;

  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  const body = (await req.json()) as { userId?: unknown };
  if (typeof body.userId !== 'string' || !body.userId.trim()) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  await db
    .update(structuralAliasGrants)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(structuralAliasGrants.userId, body.userId),
      isNull(structuralAliasGrants.revokedAt),
    ));

  return NextResponse.json({ ok: true });
}
