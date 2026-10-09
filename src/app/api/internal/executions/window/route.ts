/**
 * What-If 批次的执行窗口拉取（ADR 0034 §3.0）。
 *
 * `GET ?policyId=&userId=&from=&to=&cursor=&limit=`
 *   → `{ executions: [...], nextCursor: <id> | null }`
 *
 * <p><b>为什么这个端点在 cloud 而重跑在 api</b>：`Execution` 表属于本仓，
 * 但重跑能力在 api。若让 cloud 逐条调 api 重跑，万条批次约 49MB / 10000 次往返，
 * 其中 38MB 是同一份目标版本源码的重复传输——设计缺陷而非规模问题。
 * 改由 api 一次性分页拉走输入、进程内直调重跑：万条 ≈13 秒、零往返、零重传。
 *
 * <p>本端点是 `/api/internal/snapshot/full` 的同构复制（cursor 分页 +
 * `verifyInternalSignature` fail-closed 验签），不是新机制。
 *
 * <p><b>只返回 REPLAYABLE 行</b>：NON_REPLAYABLE 缺 freeze 所需字段，
 * 重跑必然失败。把它们算进 `plannedCount` 会让批次注定拒答——
 * 而 §1.1 要求「窗口内全量成功」，故窗口定义本身就应排除它们。
 */
import { NextResponse } from 'next/server';
import { verifyInternalSignature } from '@/lib/api-signing';
import { db, executions } from '@/lib/prisma';
import { and, eq, gt, gte, lt, asc } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单页上限。与 snapshot/full 一致，避免单次响应体过大。 */
const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 1000;

export async function GET(req: Request) {
  const sharedKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
  // Fail-closed：没有共享密钥就无法认证调用方，拒绝服务而非泄露数据（审计 #168）
  if (!sharedKey) {
    return NextResponse.json({ error: 'Internal verification unavailable' }, { status: 503 });
  }
  const verified = await verifyInternalSignature(req, '', sharedKey);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.reason }, { status: 401 });
  }

  const url = new URL(req.url);
  const policyId = url.searchParams.get('policyId');
  const userId = url.searchParams.get('userId');
  const fromParamRaw = url.searchParams.get('from');
  const toParamRaw = url.searchParams.get('to');

  if (!policyId || !userId) {
    return NextResponse.json({ error: 'policyId and userId are required' }, { status: 400 });
  }

  // ★userId 必填且参与查询条件：这是**租户隔离**，不是可选的过滤器。
  //   即便调用方是可信的内部服务，也不能让它「忘了传 userId 就拿到全量」。
  if (!fromParamRaw || !toParamRaw) {
    return NextResponse.json({ error: 'from and to are required' }, { status: 400 });
  }

  const from = new Date(fromParamRaw);
  const to = new Date(toParamRaw);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: 'from/to must be valid ISO timestamps' }, { status: 400 });
  }
  if (from >= to) {
    // 窗口左闭右开，from == to 是空窗口，也是调用方算错了边界的信号
    return NextResponse.json({ error: 'from must be strictly before to' }, { status: 400 });
  }

  const limitParam = url.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return NextResponse.json(
        { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
        { status: 400 },
      );
    }
    limit = parsed;
  }

  const cursor = url.searchParams.get('cursor');

  const rows = await db.query.executions.findMany({
    where: and(
      eq(executions.policyId, policyId),
      // 租户隔离：一律带 userId
      eq(executions.userId, userId),
      // 窗口左闭右开 [from, to)——右边界不含，与 ADR 0034 §3.3 一致
      gte(executions.createdAt, from),
      lt(executions.createdAt, to),
      // ★只要 REPLAYABLE：NON_REPLAYABLE 重跑必然失败，
      //   算进 plannedCount 会让批次注定拒答
      eq(executions.replayabilityStatus, 'REPLAYABLE'),
      cursor ? gt(executions.id, cursor) : undefined,
    ),
    orderBy: asc(executions.id),
    limit,
    columns: {
      id: true,
      input: true,
      decision: true,
      // 四态基线（ADR 0043 §5）：旧行为 null，由 api 侧回退到布尔 decision
      outcome: true,
      success: true,
      functionName: true,
      locale: true,
      aliasSetJson: true,
      vocabSnapshotRef: true,
      policyVersionRowId: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    executions: rows,
    // 少于 limit 说明本页已到底；cursor 是本页最后一行的 id
    nextCursor: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
  });
}
