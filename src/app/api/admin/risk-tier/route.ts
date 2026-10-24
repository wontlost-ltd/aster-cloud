/**
 * GET  /api/admin/risk-tier              — list users with riskTier > 0
 * POST /api/admin/risk-tier               — override one user's tier
 *
 * 仅 admin（plan=enterprise）。详见 lib/admin-auth.ts。
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/prisma';
import { users, auditLogs } from '@/db/schema';
import { and, desc, eq, gt, gte, sql } from 'drizzle-orm';
import { requireAdmin } from '@/lib/admin-auth';
import { CAN_RISKTIER } from '@/lib/deployment-mode';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { policyForTier, type RiskTier } from '@/lib/risk-tier';
import { errorEnvelope } from '@/lib/api/error-envelope';

export const runtime = 'nodejs';

interface RiskRow {
  id: string;
  email: string | null;
  emailNormalized: string | null;
  plan: string;
  riskTier: number;
  riskTierReason: string | null;
  priorPurgeCount: number;
  reactivationCount: number;
  createdAt: string;
  deletedAt: string | null;
}

export async function GET(req: NextRequest) {
  // On-prem 不使用注册风险评分；优先于 admin 检查返回 404，避免 admin
  // 通过端点试探得知功能存在与否。
  if (!CAN_RISKTIER) return new NextResponse(null, { status: 404 });

  // Structured try/catch covers the whole handler so any unexpected
  // throw (Hyperdrive cold start, drizzle schema drift, missing env,
  // …) lands as a 503 JSON envelope rather than Next.js's default
  // text "Internal Server Error" page. The admin UI now has an error
  // boundary to handle this, but we still want the response to be
  // machine-parseable for the client retry path.
  try {
    const check = await requireAdmin();
    if (check instanceof NextResponse) return check;

    const url = new URL(req.url);
    const minTier = Math.max(1, Math.min(4, Number(url.searchParams.get('minTier') ?? 1)));
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 100)));

    const rows = await db.query.users.findMany({
      where: gte(users.riskTier, minTier),
      orderBy: [desc(users.riskTier), desc(users.createdAt)],
      limit,
      columns: {
        id: true,
        email: true,
        emailNormalized: true,
        plan: true,
        riskTier: true,
        riskTierReason: true,
        priorPurgeCount: true,
        reactivationCount: true,
        createdAt: true,
        deletedAt: true,
      },
    });

    const data: RiskRow[] = rows.map((r) => ({
      id: r.id,
      email: r.email,
      emailNormalized: r.emailNormalized,
      plan: r.plan,
      riskTier: r.riskTier,
      riskTierReason: r.riskTierReason,
      priorPurgeCount: r.priorPurgeCount,
      reactivationCount: r.reactivationCount,
      createdAt: r.createdAt.toISOString(),
      deletedAt: r.deletedAt?.toISOString() ?? null,
    }));

    return NextResponse.json({ users: data });
  } catch (err) {
    const env = errorEnvelope({
      status: 503,
      code: 'service_unavailable',
      message: 'Risk-tier lookup failed. Please retry; the failure has been logged.',
    });
    // Log with the same requestId so on-call can correlate the user-
    // visible Error ID back to this exception.
    console.error(
      '[risk-tier GET] handler failed',
      env.headers.get('x-request-id'),
      err,
    );
    return env;
  }
}

interface OverridePayload {
  userId: string;
  newTier: number;           // 0..4
  ticketId?: string;         // support 工单号（写 audit）
  note?: string;             // 决策说明
}

export async function POST(req: NextRequest) {
  if (!CAN_RISKTIER) return new NextResponse(null, { status: 404 });

  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;
  const adminUserId = check.userId;

  // 当前 CAN_RISKTIER === IS_SAAS，gate 永远 noop；保留调用是防御性纵深 +
  // 满足 ESLint require-license-write-gate 规则，未来若 risk-tier 扩展到
  // on-prem 自动获得 read-only 软降级。
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;

  let body: OverridePayload;
  try {
    body = (await req.json()) as OverridePayload;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!body.userId || typeof body.userId !== 'string') {
    return NextResponse.json({ error: 'userId_required' }, { status: 400 });
  }
  if (![0, 1, 2, 3, 4].includes(body.newTier)) {
    return NextResponse.json({ error: 'newTier_must_be_0_to_4' }, { status: 400 });
  }
  if (body.userId === adminUserId) {
    return NextResponse.json(
      { error: 'cannot_override_self', message: 'An admin cannot change their own riskTier.' },
      { status: 400 },
    );
  }

  const target = await db.query.users.findFirst({
    where: eq(users.id, body.userId),
    columns: { id: true, riskTier: true, riskTierReason: true, email: true },
  });
  if (!target) {
    return NextResponse.json({ error: 'user_not_found' }, { status: 404 });
  }

  const newReason = `manual_override:${body.ticketId ?? 'no-ticket'}:was=${target.riskTier}${body.note ? ':note=' + body.note : ''}`;

  // 1) update tier
  await db.update(users)
    .set({
      riskTier: body.newTier,
      riskTierReason: newReason,
      updatedAt: new Date(),
    })
    .where(eq(users.id, body.userId));

  // 2) audit log（永久保留，撤销也只能新增 override 行）
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    userId: body.userId,
    action: 'user.risk_tier_overridden',
    resource: 'user',
    resourceId: body.userId,
    metadata: {
      adminUserId,
      previousTier: target.riskTier,
      previousReason: target.riskTierReason,
      newTier: body.newTier,
      newReason,
      ticketId: body.ticketId ?? null,
      note: body.note ?? null,
    },
    createdAt: new Date(),
  });

  const newPolicy = policyForTier(body.newTier as RiskTier);
  return NextResponse.json({
    success: true,
    previousTier: target.riskTier,
    newTier: body.newTier,
    newReason,
    effectivePolicy: newPolicy,
  });
}

/**
 * 顺手暴露 tier 分布统计供面板用（GET ?stats=1）。
 * 单独写一个 endpoint 也行，但保持路由聚合更易理解。
 */
export async function HEAD() {
  if (!CAN_RISKTIER) return new NextResponse(null, { status: 404 });

  const check = await requireAdmin();
  if (check instanceof NextResponse) return check;

  const rows = await db
    .select({
      tier: users.riskTier,
      n: sql<number>`count(*)::int`,
    })
    .from(users)
    .where(and(gt(users.riskTier, 0)))
    .groupBy(users.riskTier);

  const distribution = Object.fromEntries(rows.map((r) => [r.tier, r.n]));
  return new NextResponse(null, {
    status: 200,
    headers: { 'X-Risk-Tier-Distribution': JSON.stringify(distribution) },
  });
}
