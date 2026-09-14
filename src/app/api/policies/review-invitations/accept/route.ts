/*
 * 接受复核邀请（ADR 0037 §15）。
 *
 * POST /api/policies/review-invitations/accept
 *   Body: { token: "<hex>" }  或  { invitationId: "<uuid>" }
 *
 * ★安全门：**token 单独不足以接受邀请** —— 调用者 session 的邮箱必须与
 * 邀请的 `email` 列一致。这是从团队邀请的 accept 路由照搬的模型
 * （那里写明 "the token alone is not enough"）。
 *
 * 在复核场景里这条更要紧：**复核资格直接决定 Proof 的可信度**。
 * 邮件链接一旦泄露，若没有邮箱匹配，任何拿到链接的人都能冒领复核资格，
 * 进而对策略签出"已由领域专家确认"的结论——那等于伪造审计证据。
 *
 * ★接受后**不删邀请行**，只置 acceptedAt：保留"谁在何时邀请了谁"的历史
 * （与 PolicyProof 的 append-only 取向一致）。
 */

import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import {
  db,
  policyReviewers,
  policyReviewInvitations,
  users,
} from '@/lib/prisma';

export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: '未授权' }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as {
      token?: string;
      invitationId?: string;
    } | null;

    const token = body?.token;
    const invitationId = body?.invitationId;
    if (
      (!token || typeof token !== 'string') &&
      (!invitationId || typeof invitationId !== 'string')
    ) {
      return NextResponse.json(
        { error: '需要 token 或 invitationId' },
        { status: 400 },
      );
    }

    const invitation = await db.query.policyReviewInvitations.findFirst({
      where: token
        ? eq(policyReviewInvitations.token, token)
        : eq(policyReviewInvitations.id, invitationId!),
    });
    if (!invitation) {
      return NextResponse.json({ error: '邀请不存在' }, { status: 404 });
    }
    if (invitation.acceptedAt) {
      return NextResponse.json({ error: '此邀请已被接受' }, { status: 400 });
    }
    if (invitation.expiresAt < new Date()) {
      return NextResponse.json({ error: '邀请已过期' }, { status: 400 });
    }

    // ★★安全门：session 邮箱必须匹配邀请邮箱。
    //   没有这一步，token 就成了可转让的"复核资格凭证"。
    const currentUser = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { email: true },
    });
    if (
      !currentUser?.email ||
      currentUser.email.toLowerCase() !== invitation.email.toLowerCase()
    ) {
      // ★403 而非 404：邀请确实存在，只是不属于当前登录者。
      //   此处不泄露邀请的目标邮箱。
      return NextResponse.json(
        { error: '此邀请不属于当前登录账号' },
        { status: 403 },
      );
    }

    // 幂等：已是复核人就只标记邀请，不重复插入（唯一索引也会拦，
    // 但提前判断能给出更清晰的语义）。
    const already = await db.query.policyReviewers.findFirst({
      where: and(
        eq(policyReviewers.policyId, invitation.policyId),
        eq(policyReviewers.userId, session.user.id),
      ),
    });
    if (!already) {
      await db.insert(policyReviewers).values({
        id: globalThis.crypto.randomUUID(),
        policyId: invitation.policyId,
        userId: session.user.id,
        subjectKind: invitation.subjectKind,
        grantedByUserId: invitation.invitedByUserId,
      });
    }

    // ★只置 acceptedAt，不删行——保留邀请历史供审计。
    await db
      .update(policyReviewInvitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(policyReviewInvitations.id, invitation.id),
          isNull(policyReviewInvitations.acceptedAt),
        ),
      );

    return NextResponse.json({
      accepted: true,
      policyId: invitation.policyId,
      subjectKind: invitation.subjectKind,
    });
  } catch (e) {
    console.error('[review-invitations/accept] failed', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
