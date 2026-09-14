/*
 * 策略复核队列与结论（ADR 0037 §14/§15）。
 *
 * GET  /api/policies/:id/review   → 复核队列（待复核项 + 计数 + 已有结论）
 * POST /api/policies/:id/review   → 记录一条**人工**复核结论（产出 Proof）
 *
 * 三段式（ADR §3）：
 *   ① 提出   确定性生成器 / LLM  → 候选（**没有判定力**）
 *   ② 判定   确定性 verifier     → VERIFIED / REVIEW_REQUIRED / REJECTED
 *   ③ 复核   **人**              → Proof（本路由的 POST）
 *
 * ★写入层强制四条，缺一条这套证据链就不可信：
 *   1. 调用者必须在 PolicyReviewer 里（**非授权人不得提交**）
 *   2. subjectKind 只能是 domain_expert / engineer —— **机器不得代签**
 *   3. 理由非空 —— 没有理由的批准等于没有复核
 *   4. 只 INSERT，永不 UPDATE/DELETE —— 撤销＝追加新 Proof 覆盖
 */

import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { getSession } from '@/lib/auth';
import {
  db,
  policies,
  policyReviewers,
  policyProofs,
  REVIEWER_SUBJECT_KINDS,
  type ReviewerSubjectKind,
} from '@/lib/prisma';
import { checkTeamPermission, TeamPermission } from '@/lib/team-permissions';

type RouteParams = { params: Promise<{ id: string }> };

/** 复核结论只有两种——与 ADR 的 VerificationVerdict 对齐（机器那档不在此列）。 */
const HUMAN_VERDICTS = ['VERIFIED', 'REJECTED'] as const;
type HumanVerdict = (typeof HUMAN_VERDICTS)[number];

/**
 * 能否**看**这条策略的复核队列：拥有者或已授权的复核人。
 *
 * <p>★复核人必须能看到队列，否则他无从复核；但看得到 ≠ 能提交结论，
 * 后者另有 {@link loadReviewer} 把关。
 */
async function canViewReview(callerUserId: string, policyId: string) {
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
    if (perm.allowed) return policy;
  } else if (policy.userId === callerUserId) {
    return policy;
  }

  const reviewer = await db.query.policyReviewers.findFirst({
    where: and(
      eq(policyReviewers.policyId, policyId),
      eq(policyReviewers.userId, callerUserId),
    ),
  });
  return reviewer ? policy : null;
}

/** 调用者是否有**提交结论**的资格。★仅凭拥有者身份**不够**。 */
async function loadReviewer(callerUserId: string, policyId: string) {
  return db.query.policyReviewers.findFirst({
    where: and(
      eq(policyReviewers.policyId, policyId),
      eq(policyReviewers.userId, callerUserId),
    ),
  });
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;
    const policy = await canViewReview(session.user.id, id);
    if (!policy) return new NextResponse(null, { status: 404 });

    // 已有结论，按 (nodeId, createdAt desc) 排——UI 取每个节点的第一条
    // 即"当前有效结论"（ADR 的 resolveEffective 语义）。
    const proofs = await db.query.policyProofs.findMany({
      where: eq(policyProofs.policyId, id),
      orderBy: [desc(policyProofs.createdAt)],
    });

    const reviewer = await loadReviewer(session.user.id, id);

    return NextResponse.json({
      // ★队列本身由**前端调用引擎**计算（runSemanticBridge），不在此处跑：
      //   引擎是纯函数，放在边缘运行时跑既快又省一次往返；
      //   本路由只负责"谁能看/谁能签"与已落库的结论。
      canReview: reviewer !== undefined && reviewer !== null,
      subjectKind: reviewer?.subjectKind ?? null,
      proofs: proofs.map((p) => ({
        id: p.id,
        nodeId: p.nodeId,
        contentHash: p.contentHash,
        verdict: p.verdict,
        reason: p.reason,
        subjectKind: p.subjectKind,
        subjectUserId: p.subjectUserId,
        text: p.text,
        span: { start: p.spanStart, end: p.spanEnd },
        recordedAt: p.createdAt,
      })),
    });
  } catch (e) {
    console.error('[review] GET failed', e);
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

    // ★约束 1：**非授权人不得提交**。注意这里用的是 loadReviewer 而不是
    //   canViewReview——策略拥有者能看队列，但除非他也被授予了复核资格，
    //   否则**不能签字**。这防的是"自己写策略、自己签字确认"。
    const reviewer = await loadReviewer(session.user.id, id);
    if (!reviewer) {
      return NextResponse.json(
        { error: '你不是本策略的复核人，无法提交复核结论' },
        { status: 403 },
      );
    }

    const body = (await req.json().catch(() => null)) as {
      nodeId?: string;
      contentHash?: string;
      verdict?: string;
      reason?: string;
      text?: string;
      span?: { start?: number; end?: number };
      policyVersionId?: string;
      subjectKind?: string;
    } | null;

    const nodeId = body?.nodeId?.trim();
    const contentHash = body?.contentHash?.trim();
    const text = body?.text;
    const start = body?.span?.start;
    const end = body?.span?.end;

    if (!nodeId || !contentHash || typeof text !== 'string'
        || typeof start !== 'number' || typeof end !== 'number') {
      return NextResponse.json(
        { error: '需要 nodeId / contentHash / text / span' },
        { status: 400 },
      );
    }
    if (!/^[0-9a-f]{64}$/.test(contentHash)) {
      // ★contentHash 是时效性判据：内容一变，旧 proof 即算作
      //   CONTENT_CHANGED。格式不对说明调用方没拿到真实指纹。
      return NextResponse.json(
        { error: 'contentHash 必须是 64 位十六进制 SHA-256' },
        { status: 400 },
      );
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
      return NextResponse.json({ error: 'span 非法' }, { status: 400 });
    }
    if (text.length !== end - start) {
      // 区间宽度与文本长度必须自洽，否则 span 指向的根本不是这段文本。
      return NextResponse.json(
        { error: `text 长度 ${text.length} 与 span 宽度 ${end - start} 不符` },
        { status: 400 },
      );
    }

    const verdict = body?.verdict as HumanVerdict | undefined;
    if (!verdict || !HUMAN_VERDICTS.includes(verdict)) {
      return NextResponse.json(
        { error: `verdict 必须是 ${HUMAN_VERDICTS.join(' 或 ')}` },
        { status: 400 },
      );
    }

    // ★约束 3：理由非空。空壳 proof 没有任何审计价值。
    const reason = body?.reason?.trim();
    if (!reason) {
      return NextResponse.json(
        { error: '复核理由不得为空：没有理由的批准等于没有复核' },
        { status: 400 },
      );
    }

    // ★约束 2：subjectKind 只能是人。**机器不得代签**（ADR §3）。
    //   即使调用方传了 'verifier' 也一律拒绝——那是 verifier 的身份，
    //   而 verifier 的结论由引擎产出，不经过这条路径。
    const subjectKind = (body?.subjectKind ?? reviewer.subjectKind) as ReviewerSubjectKind;
    if (!REVIEWER_SUBJECT_KINDS.includes(subjectKind)) {
      return NextResponse.json(
        { error: `subjectKind 必须是 ${REVIEWER_SUBJECT_KINDS.join(' 或 ')}——机器不得代签` },
        { status: 400 },
      );
    }

    // ★约束 4：只 INSERT。撤销＝再追加一条，由 resolveEffective 取最新。
    const proofId = globalThis.crypto.randomUUID();
    await db.insert(policyProofs).values({
      id: proofId,
      policyId: id,
      policyVersionId: body?.policyVersionId ?? null,
      nodeId,
      contentHash,
      verdict,
      reason,
      subjectKind,
      subjectUserId: session.user.id,
      text,
      spanStart: start,
      spanEnd: end,
    });

    return NextResponse.json({ recorded: true, proofId });
  } catch (e) {
    console.error('[review] POST failed', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
