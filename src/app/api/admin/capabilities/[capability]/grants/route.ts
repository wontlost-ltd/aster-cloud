/*
 * 平台管理员的能力授权接口（ADR 0058 §4.10）。
 *
 * GET    ?subject=user|team&q=&limit=   搜用户（带解析后的来源）或团队（带团队授权、额度、已用座位）
 * POST   { subjectType, subjectId, note? }  授予；新建 201，已存在 200
 * DELETE { grantId }                        撤销（reason = manual）
 *
 * 读一律经 freshDb：管理页在写后立刻重新拉取，必须读到刚写入的状态（#614）。
 */

import { NextResponse } from 'next/server';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { freshDb } from '@/db/fresh-read';
import { capabilityGrants, capabilityTeamAllotments, teams, users } from '@/lib/prisma';
import { CapabilityError, capabilityErrorResponse } from '@/lib/capabilities/errors';
import { countActiveSeats, grantToSubject, revokeGrant } from '@/lib/capabilities/grants';
import { isCapabilityKey, type CapabilityKey } from '@/lib/capabilities/registry';
import { listGrantSources } from '@/lib/capabilities/resolve';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ capability: string }> };

const NOTE_MAX = 500;

const fail = (code: 'invalid_payload' | 'unknown_capability') => capabilityErrorResponse(new CapabilityError(code));

/** CapabilityError 转成 `{ error, code }` 响应，其余错误照常抛出（500）。 */
async function handleCapabilityErrors(run: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof CapabilityError) return capabilityErrorResponse(e);
    throw e;
  }
}

function parseLimit(raw: string | null): number {
  const requested = Number(raw ?? 100);
  return Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.trunc(requested))) : 100;
}

async function listUsers(capability: CapabilityKey, q: string | undefined, limit: number) {
  const conditions = [isNull(users.deletedAt)];
  if (q) conditions.push(or(ilike(users.email, `%${q}%`), ilike(users.name, `%${q}%`))!);
  // 有该能力活跃个人行（直接或委派）的用户排在前面，便于管理页先看到已授权的人
  const hasGrant = sql<boolean>`exists (select 1 from ${capabilityGrants} where ${capabilityGrants.userId} = ${users.id} and ${capabilityGrants.capability} = ${capability} and ${capabilityGrants.revokedAt} is null)`;
  const rows = await freshDb
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(and(...conditions))
    .orderBy(desc(hasGrant), desc(users.createdAt))
    .limit(limit);
  return Promise.all(rows.map(async (row) => ({ ...row, sources: await listGrantSources(row.id, capability) })));
}

async function listTeams(capability: CapabilityKey, q: string | undefined, limit: number) {
  const g = capabilityGrants;
  const a = capabilityTeamAllotments;
  const rows = await freshDb
    .select({
      id: teams.id,
      name: teams.name,
      slug: teams.slug,
      grantId: g.id,
      seatCap: a.seatCap,
      ownerGrantingEnabled: a.ownerGrantingEnabled,
    })
    .from(teams)
    .leftJoin(g, and(eq(g.teamId, teams.id), eq(g.capability, capability), isNull(g.revokedAt)))
    .leftJoin(a, and(eq(a.teamId, teams.id), eq(a.capability, capability)))
    .where(q ? or(ilike(teams.name, `%${q}%`), ilike(teams.slug, `%${q}%`)) : undefined)
    .orderBy(sql`${g.id} is null`, sql`${a.teamId} is null`, desc(teams.createdAt))
    .limit(limit);
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      grantId: row.grantId,
      allotment:
        row.seatCap === null || row.ownerGrantingEnabled === null
          ? null
          : { seatCap: row.seatCap, ownerGrantingEnabled: row.ownerGrantingEnabled },
      seatsUsed: await countActiveSeats(freshDb, capability, row.id),
    })),
  );
}

export async function GET(req: Request, { params }: RouteParams) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { capability } = await params;
  if (!isCapabilityKey(capability)) return fail('unknown_capability');

  const searchParams = new URL(req.url).searchParams;
  const subject = searchParams.get('subject') ?? 'user';
  if (subject !== 'user' && subject !== 'team') return fail('invalid_payload');
  const q = searchParams.get('q')?.trim() || undefined;
  const limit = parseLimit(searchParams.get('limit'));

  if (subject === 'user') return NextResponse.json({ users: await listUsers(capability, q, limit) });
  return NextResponse.json({ teams: await listTeams(capability, q, limit) });
}

export async function POST(req: Request, { params }: RouteParams) {
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { capability } = await params;
  if (!isCapabilityKey(capability)) return fail('unknown_capability');

  const body = (await req.json().catch(() => null)) as
    | { subjectType?: unknown; subjectId?: unknown; note?: unknown }
    | null;
  const subjectType = body?.subjectType;
  if (
    (subjectType !== 'user' && subjectType !== 'team') ||
    typeof body?.subjectId !== 'string' ||
    !body.subjectId.trim() ||
    (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > NOTE_MAX))
  ) {
    return fail('invalid_payload');
  }
  const { subjectId, note } = body as { subjectId: string; note?: string };

  return handleCapabilityErrors(async () => {
    const { grant, created } = await grantToSubject({
      capability,
      subject: { type: subjectType, id: subjectId },
      grantedBy: admin.userId,
      ...(note ? { note } : {}),
    });
    return NextResponse.json({ grant }, { status: created ? 201 : 200 });
  });
}

export async function DELETE(req: Request, { params }: RouteParams) {
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { capability } = await params;
  if (!isCapabilityKey(capability)) return fail('unknown_capability');

  const body = (await req.json().catch(() => null)) as { grantId?: unknown } | null;
  const grantId = body?.grantId;
  if (typeof grantId !== 'string' || !grantId.trim()) return fail('invalid_payload');

  return handleCapabilityErrors(async () => {
    const grant = await revokeGrant({ grantId, revokedBy: admin.userId, reason: 'manual', expectCapability: capability });
    return NextResponse.json({ grant });
  });
}
