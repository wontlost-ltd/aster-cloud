/*
 * 策略复核人管理（ADR 0037 §15）。
 *
 * GET    /api/policies/:id/reviewers            → 列出复核人 + 待处理邀请（owner-only）
 * POST   /api/policies/:id/reviewers            → { email, subjectKind } 邀请复核人
 * DELETE /api/policies/:id/reviewers?userId=…   → 撤销复核资格
 *
 * 鉴权：
 *   调用者必须是策略**拥有者**——user-owned 看 policies.userId，
 *   team-owned 看 POLICY_CREATE 权限。与 shares 路由同一套
 *   `loadOwnedPolicy` 语义（此处复刻，保持两条路径行为一致）。
 *
 * ★为什么邀请走**独立**路径而不是复用 TeamInvitation：
 *   团队邀请的语义是「加入团队」，复核邀请是「复核**这一条**策略」。
 *   复用会迫使受邀人为了复核一条策略而加入整个团队，获得远超所需的
 *   权限。独立路径还允许请**外部**领域专家只复核指定策略。
 *
 * ★安全门：token + **邮箱匹配**（见 accept 路由）。token 单独不足以
 *   接受邀请——复核资格直接决定 Proof 的可信度，链接泄露不能等于资格泄露。
 */

import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import {
  db,
  policies,
  policyReviewers,
  policyReviewInvitations,
  users,
  REVIEWER_SUBJECT_KINDS,
  type ReviewerSubjectKind,
} from '@/lib/prisma';
import { checkTeamPermission, TeamPermission } from '@/lib/team-permissions';

type RouteParams = { params: Promise<{ id: string }> };

/** 邀请有效期——与团队邀请同口径。 */
const INVITATION_TTL_DAYS = 7;

/**
 * 校验调用者是该策略的拥有者。
 *
 * <p>★与 `shares/route.ts` 的 `loadOwnedPolicy` 同语义：team-owned 策略的
 * "拥有者"= 对该团队有 POLICY_CREATE 的人。两条路径必须一致，否则
 * 「谁能分享」与「谁能指派复核人」会出现权限口径分叉。
 */
async function loadOwnedPolicy(callerUserId: string, policyId: string) {
  const policy = await db.query.policies.findFirst({
    where: eq(policies.id, policyId),
  });
  if (!policy) return null;

  if (policy.teamId) {
    const perm = await checkTeamPermission(
      callerUserId,
      policy.teamId,
      TeamPermission.POLICY_CREATE,
    );
    return perm.allowed ? policy : null;
  }
  return policy.userId === callerUserId ? policy : null;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    if (!(await loadOwnedPolicy(session.user.id, id))) {
      // ★404 而非 403：不泄露"这条策略存在但你没权限"。
      return new NextResponse(null, { status: 404 });
    }

    const reviewers = await db.query.policyReviewers.findMany({
      where: eq(policyReviewers.policyId, id),
      orderBy: [desc(policyReviewers.createdAt)],
    });

    // 待处理邀请（未接受且未过期）——UI 要把它们与已生效的复核人分开展示。
    const pending = await db.query.policyReviewInvitations.findMany({
      where: and(
        eq(policyReviewInvitations.policyId, id),
        isNull(policyReviewInvitations.acceptedAt),
      ),
      orderBy: [desc(policyReviewInvitations.createdAt)],
    });

    // 补齐用户名/邮箱，省掉 UI 的第二次往返。
    const userIds = reviewers.map((r) => r.userId);
    const userRows = userIds.length
      ? await db
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const byId = new Map(userRows.map((u) => [u.id, u]));

    return NextResponse.json({
      reviewers: reviewers.map((r) => ({
        userId: r.userId,
        subjectKind: r.subjectKind,
        grantedByUserId: r.grantedByUserId,
        createdAt: r.createdAt,
        name: byId.get(r.userId)?.name ?? null,
        email: byId.get(r.userId)?.email ?? null,
      })),
      // ★不返回 token：它只应出现在发给受邀人的链接里。
      pendingInvitations: pending
        .filter((p) => p.expiresAt > new Date())
        .map((p) => ({
          id: p.id,
          email: p.email,
          subjectKind: p.subjectKind,
          expiresAt: p.expiresAt,
          createdAt: p.createdAt,
        })),
    });
  } catch (e) {
    console.error('[reviewers] GET failed', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    if (!(await loadOwnedPolicy(session.user.id, id))) {
      return new NextResponse(null, { status: 404 });
    }

    const body = (await req.json().catch(() => null)) as {
      email?: string;
      subjectKind?: string;
    } | null;

    const email = body?.email?.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: '需要有效的邮箱地址' }, { status: 400 });
    }

    const subjectKind = (body?.subjectKind ?? 'domain_expert') as ReviewerSubjectKind;
    if (!REVIEWER_SUBJECT_KINDS.includes(subjectKind)) {
      // ★不接受 'verifier' —— 那是**机器**的身份，人不得冒用，
      //   机器也不得借这条路径给自己发证书（ADR §3）。
      return NextResponse.json(
        { error: `subjectKind 必须是 ${REVIEWER_SUBJECT_KINDS.join(' 或 ')}` },
        { status: 400 },
      );
    }

    // 已是该用户？直接授予，不必走邀请。
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true },
    });

    if (existingUser) {
      const already = await db.query.policyReviewers.findFirst({
        where: and(
          eq(policyReviewers.policyId, id),
          eq(policyReviewers.userId, existingUser.id),
        ),
      });
      if (already) {
        return NextResponse.json({ error: '此用户已是本策略的复核人' }, { status: 400 });
      }
      await db.insert(policyReviewers).values({
        id: globalThis.crypto.randomUUID(),
        policyId: id,
        userId: existingUser.id,
        subjectKind,
        grantedByUserId: session.user.id,
      });
      return NextResponse.json({ granted: true, userId: existingUser.id });
    }

    // 组织外/未注册 → 发邀请。
    const dupInvite = await db.query.policyReviewInvitations.findFirst({
      where: and(
        eq(policyReviewInvitations.policyId, id),
        eq(policyReviewInvitations.email, email),
        isNull(policyReviewInvitations.acceptedAt),
      ),
    });
    if (dupInvite && dupInvite.expiresAt > new Date()) {
      return NextResponse.json({ error: '此邮箱已有待处理的邀请' }, { status: 400 });
    }

    const token = randomBytes(32).toString('hex');
    const invitationId = globalThis.crypto.randomUUID();
    await db.insert(policyReviewInvitations).values({
      id: invitationId,
      policyId: id,
      email,
      subjectKind,
      invitedByUserId: session.user.id,
      token,
      expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 86400_000),
    });

    // ★token 只在此处返回一次（供调用方拼邀请链接/发信）。
    //   后续 GET 不再返回它——避免任何能读列表的人拿到可用凭证。
    return NextResponse.json({ invited: true, invitationId, token });
  } catch (e) {
    console.error('[reviewers] POST failed', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    if (!(await loadOwnedPolicy(session.user.id, id))) {
      return new NextResponse(null, { status: 404 });
    }

    const userId = new URL(req.url).searchParams.get('userId');
    if (!userId) {
      return NextResponse.json({ error: '需要 userId' }, { status: 400 });
    }

    // ★撤销的是**未来**的复核资格。已产出的 Proof **不受影响**——
    //   它们记录的是"当时此人有资格且做出了判断"这一历史事实，
    //   删掉资格不能改写历史（与 PolicyProof 的 append-only 一致）。
    await db
      .delete(policyReviewers)
      .where(and(eq(policyReviewers.policyId, id), eq(policyReviewers.userId, userId)));

    return NextResponse.json({ revoked: true });
  } catch (e) {
    console.error('[reviewers] DELETE failed', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
