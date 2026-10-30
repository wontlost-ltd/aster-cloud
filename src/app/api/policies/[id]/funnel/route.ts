/**
 * 条件漏斗（Phase 1）：GET /api/policies/:id/funnel
 *
 * <p>基于 `Execution.traceSkeletonJson` 聚合出「这条策略实际怎么走的」——
 * 每个条件被求值/命中的次数，以及**从未命中过的条件**（死分支）。
 *
 * <p><b>零 PII</b>：骨架只含条件原文（策略源码片段）与布尔判定，聚合只做计数。
 * 故本端点不受 `replayRetentionEnabled`（默认关）限制，对全部租户可用。
 *
 * <p><b>★样本口径</b>：分母是「平台记录到的执行」，**不是客户全量业务数据**。
 * 响应里的 `sampleNote` 必须被 UI 常驻展示（见 condition-funnel.ts 注释）。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, executions } from '@/lib/prisma';
import { and, eq, gte, lte, desc, count } from 'drizzle-orm';
import { executionAggregateScope, loadPolicyForAction } from '@/lib/policy-access';
import {
  aggregateConditionFunnel,
  type TraceSkeletonLike,
} from '@/lib/analytics/condition-funnel';
import { errorEnvelope } from '@/lib/api/error-envelope';

export const dynamic = 'force-dynamic';

/** 单次查询最多扫描的执行条数——防止大租户把 Worker 打爆。 */
const MAX_SAMPLE = 2000;
const DEFAULT_SAMPLE = 500;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session?.user?.id) {
    return errorEnvelope({ code: 'UNAUTHORIZED', message: 'Not authenticated.', status: 401 });
  }
  const { id } = await params;
  const url = new URL(request.url);

  // ★租户隔离：先按策略授权（团队策略看当前成员角色，个人策略只认所有者），
  //   执行再按执行人范围收窄。只按 policyId 查会让任何登录用户读到别人的策略执行统计
  //   （本仓历史上出现过多次同类跨租户读，见 audit-crosstenant-2026-07）。
  const access = await loadPolicyForAction(id, { userId: session.user.id }, 'view');
  if (!access.ok) {
    // 非成员 / 他人个人策略 404：不泄露「该 id 存在但不属于你」。
    return errorEnvelope({ code: 'NOT_FOUND', message: 'Policy not found.', status: 404 });
  }
  // 漏斗只输出计数：团队策略计入全部执行，个人策略只计所有者本人的执行
  const scope = executionAggregateScope(access.policy);

  const limit = Math.min(
    Math.max(Number(url.searchParams.get('limit')) || DEFAULT_SAMPLE, 1),
    MAX_SAMPLE,
  );
  // ★from/to/version 必须在入口校验：非法值直接进 Drizzle/PG 会变成
  //   Invalid Date 或 NaN，产出一个语义不明的查询而不是明确的 400。
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const version = url.searchParams.get('version');

  for (const [name, raw] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (raw !== null && Number.isNaN(new Date(raw).getTime())) {
      return errorEnvelope({
        code: 'INVALID_PARAM',
        message: `${name} must be a valid time.`,
        status: 400,
      });
    }
  }
  // ★除了形状还要判范围：policyVersion 列是 PG int4，
  //   "999999999999999999999" 能过 /^\d+$/，但 Number() 会变成 1e+21，
  //   传给 PG 报 22P02（invalid input syntax）→ 500 而不是 400。
  const PG_INT4_MAX = 2147483647;
  if (version !== null && (!/^\d+$/.test(version) || Number(version) > PG_INT4_MAX)) {
    return errorEnvelope({
      code: 'INVALID_PARAM',
      message: `version must be an integer from 0 to ${PG_INT4_MAX}.`,
      status: 400,
    });
  }

  // 团队策略统计全部成员的执行（#673），个人策略只统计所有者本人的执行
  const conds = [eq(executions.policyId, id), ...(scope.kind === 'user' ? [eq(executions.userId, scope.userId)] : [])];
  if (from) conds.push(gte(executions.createdAt, new Date(from)));
  if (to) conds.push(lte(executions.createdAt, new Date(to)));
  // 按具体版本筛：改策略后想只看新版本的走向
  if (version) conds.push(eq(executions.policyVersion, Number(version)));

  const rows = await db
    .select({ skeleton: executions.traceSkeletonJson })
    .from(executions)
    .where(and(...conds))
    .orderBy(desc(executions.createdAt))
    .limit(limit);

  // ★同时查符合条件的**总数**：只有知道总数才能说清「这是最近 N 条的样本」
  // 还是「这就是全部」。没有它，UI 无从区分「条件从未命中」和「样本太小没赶上」——
  // 而这两者对业务人员的含义完全相反（前者要改规则，后者什么都不该做）。
  const [{ value: total }] = await db
    .select({ value: count() })
    .from(executions)
    .where(and(...conds));

  const funnel = aggregateConditionFunnel(
    rows.map((r) => r.skeleton as TraceSkeletonLike | null),
    { total },
  );

  // 诚实回报覆盖率：withSkeleton < sampleSize 说明部分执行没采集到骨架
  // （Phase 0 已知局限：trace collector 仅在 trace/replayCapture 时 arm）。
  // 不静默——UI 据此提示，避免用户以为漏斗覆盖了全部执行。
  return NextResponse.json({
    policyId: id,
    ...funnel,
    coverage: funnel.sampleSize > 0 ? funnel.withSkeleton / funnel.sampleSize : null,
    limit,
  });
}
