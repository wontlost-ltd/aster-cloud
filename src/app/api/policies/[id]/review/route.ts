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

/** 引擎 `runSemanticBridge` 的返回形状（本地声明——见下方动态 import 的说明）。 */
interface BridgeShape {
  readonly summary: { verified: number; reviewRequired: number; rejected: number };
  readonly verified: readonly {
    readonly mapping: { text: string; nodeId: string;
                        span: { start: number; end: number } };
    readonly result: { verdict: string; reason: string };
    readonly contentHash?: string;
  }[];
}

/**
 * 合法的内容指纹：64 位**小写十六进制** SHA-256。
 *
 * <p>★只查长度不够：`'z'.repeat(64)` 长度合格但不是十六进制，能混进队列，
 * 用户点下去才被写入侧的同名校验以 400 拒绝。队列侧与写入侧必须同一条规则。
 */
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

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
      // ★必须有**确定性 tiebreaker**。
      //
      //   `desc(createdAt)` 单独用时，同一毫秒写入的两条 proof 之间没有
      //   定义好的顺序——Postgres 返回谁在前都合法，甚至两次查询可以不同。
      //   而前端 effectiveByNode 取的正是"首条即最新"，于是同一节点的
      //   **当前有效结论会在两次刷新之间来回翻**。
      //   这条路径很常见：撤销就是"追加一条新 proof"，更正往往紧跟原判之后。
      //
      //   加 `desc(id)` 并**不能**让并列的两条按真实先后排序（UUID 是随机的，
      //   不含时间信息）——它只保证**顺序稳定**：同样的数据每次返回同样的次序。
      //   要真正区分同毫秒的先后，需要一个单调列（如 bigserial），那是独立改动。
      orderBy: [desc(policyProofs.createdAt), desc(policyProofs.id)],
    });

    const reviewer = await loadReviewer(session.user.id, id);

    // ★队列必须在**服务端**算。
    //
    //   引擎的 NodeIdMap 依赖 `node:crypto` 求 contentHash，webpack 不会把
    //   `node:` 方案打进客户端包——放在前端跑会让页面 500。
    //   服务端没有这个约束：Worker 开了 `nodejs_compat`（wrangler.toml）。
    //   且 contentHash 是 Proof 的时效性判据，由服务端算比由客户端自报可信。
    let queue: {
      items: { text: string; span: { start: number; end: number };
               reason: string; nodeId: string; contentHash: string }[];
      counts: { verified: number; reviewRequired: number; rejected: number };
      // ★三态而非二态：`ok` 表示队列**真的算出来了**。
      //   没有它，"引擎挂了" 与 "没有待复核项" 在 UI 上完全一样——
      //   对审计工具来说这是最坏的 fail-open：用户以为"机器都证明完了"，
      //   实际机器根本没跑。
      //   `engine_outdated` 与 `engine_error` 分开是因为**运维含义不同**：
      //     前者是已知的发版时序（引擎随发版列车跟上即自愈），属预期状态；
      //     后者是真实故障，需要有人去看。合并成一个值，线上事故在日志里
      //     会长得和"还没发版"一模一样。
      queueStatus: 'ok' | 'engine_outdated' | 'engine_error';
    } = { items: [], counts: { verified: 0, reviewRequired: 0, rejected: 0 },
          queueStatus: 'engine_error' };
    try {
      // ★动态 import + 能力探测，而不是顶层静态导入。
      //
      //   原因是**版本时序**：`runSemanticBridge` 目前只存在于 aster-lang-ts 的
      //   未发布分支上，本仓 pin 的是 1.0.28（package.json），尚不含该导出。
      //   顶层静态导入会让整个仓库 typecheck 失败 —— 即「功能代码等发版」。
      //   探测式加载让本 PR 可独立合入：引擎旧版时队列为空（面板降级为
      //   "只看已落库结论"），引擎跟上后无需改代码自动生效。
      //
      //   等 pin bump 到含该导出的版本后，这里可以换回静态导入。
      const mod = (await import('@aster-cloud/aster-lang-ts')) as unknown as {
        runSemanticBridge?: (src: string) => BridgeShape;
      };
      if (!mod.runSemanticBridge) {
        // 预期状态，不是故障——不打 warn，也不与真实异常混为一谈。
        queue = { ...queue, queueStatus: 'engine_outdated' };
      } else {
      const bridge = mod.runSemanticBridge(policy.content);
      queue = {
        queueStatus: 'ok',
        counts: bridge.summary,
        items: bridge.verified
          .filter((v) => v.result.verdict === 'REVIEW_REQUIRED')
          // 缺 contentHash 的候选无法落库（POST 要求 64 位十六进制），
          // 不该出现在队列里——否则用户点了才发现签不了。
          .filter((v) => typeof v.contentHash === 'string'
                         && CONTENT_HASH_RE.test(v.contentHash))
          .map((v) => ({
            text: v.mapping.text,
            span: v.mapping.span,
            reason: v.result.reason,
            nodeId: v.mapping.nodeId,
            contentHash: v.contentHash!,
          })),
      };
      }
    } catch (e) {
      // 引擎跑不起来不该让整个面板消失——已落库的结论仍有价值。
      // queueStatus 保持 'engine_error'，UI 据此说"不可用"而非"空"。
      console.warn('[review] 队列计算失败，降级为只读结论', e);
    }

    return NextResponse.json({
      ...queue,
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
    if (!CONTENT_HASH_RE.test(contentHash)) {
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
    //   ★身份取自**授权记录**，不接受请求体覆盖。
    //     原先是 `body?.subjectKind ?? reviewer.subjectKind`：一个被授予
    //     engineer 资格的人只要传 `subjectKind: 'domain_expert'`，落库的
    //     Proof 就成了"领域专家已确认"——一个他从未持有的身份。
    //     授权记录才是身份的来源；请求体只是请求，不是凭据。
    const subjectKind = reviewer.subjectKind as ReviewerSubjectKind;
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
