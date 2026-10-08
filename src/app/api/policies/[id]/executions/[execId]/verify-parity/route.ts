/*
 * 手动触发 runner-parity 校验（manual 模式入口 + 上线冒烟测试）。
 * POST /api/policies/[id]/executions/[execId]/verify-parity
 *
 * 对指定的已存 execution 重跑 parity：**复用行上已存的权威侧 A**（canonicalInputHash 等 5 字段），只真跑
 * side-B launcher，结果回写该行 parity 列并返回。★这是管理员/owner 的显式一键校验——用于确认
 * cloud→launcher HMAC 边界（match=全绿；runner-unavailable+403=key 不匹配；divergent=集成分叉）。
 *
 * ★诚实边界：即便本 endpoint 返回 divergent/error，也不改变原 execution 的决策——parity 是影子信号。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, policies, executions, policyVersions } from '@/lib/prisma';
import { and, eq, isNull } from 'drizzle-orm';
import { policyTenantId } from '@/lib/policy-tenant';
import {
  runParityForExecutionNow,
  RUNNER_LAUNCHER_HMAC_ROLE,
} from '@/services/policy/runner-parity-from-execution';
import type { PolicyReplayMetadata } from '@/services/policy/policy-api';

interface RouteParams {
  params: Promise<{ id: string; execId: string }>;
}

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id, execId } = await params;

    // 归属校验：策略必须属于当前用户（沿用 logs route 模式）。
    const policy = await db.query.policies.findFirst({
      where: and(eq(policies.id, id), eq(policies.userId, session.user.id), isNull(policies.deletedAt)),
      columns: { id: true, teamId: true, userId: true },
    });
    if (!policy) return NextResponse.json({ error: 'Policy not found' }, { status: 404 });

    // 取目标 execution（须属于该策略**且属于当前用户**）。★纵深隔离（Codex 抓 P0）：executions 有独立
    //   userId，仅约束 policyId 会依赖「execution.userId==policy.userId」这一跨表不变量——一旦别处写入脏行
    //   （policyId=攻击者策略、userId=受害者）即成跨租户读+触发+回写洞。故直接约束 executions.userId，
    //   与本仓 canonical 读模式（policy-execution-log.ts 恒 eq(executions.userId, …)）一致。
    const exec = await db.query.executions.findFirst({
      where: and(
        eq(executions.id, execId),
        eq(executions.policyId, id),
        eq(executions.userId, session.user.id),
      ),
      columns: {
        id: true, input: true, functionName: true, locale: true, aliasSetJson: true,
        // ★该次执行的**冻结版本引用**（Codex 抓：必须用当次源码，非当前可变 policy.content——否则策略
        //   编辑后=旧 side-A vs 新源码 side-B=假 divergent）。
        policyVersionRowId: true,
        // 已存的权威侧 A（5 字段）——复用不重跑 aster-api evaluate。
        canonicalInputHash: true, canonicalOutputHash: true, canonicalizationVersion: true,
        replayabilityStatus: true, traceHash: true, runtimeToolchainId: true,
      },
    });
    if (!exec) return NextResponse.json({ error: 'Execution not found' }, { status: 404 });

    // ★用**当次冻结源码**（PolicyVersion.content，不可变），非当前 policy.content。历史行缺
    //   policyVersionRowId → 无法恢复当次源码 → 明确不可回放（不跑 side-B，避免假 divergent）。
    if (!exec.policyVersionRowId) {
      return NextResponse.json({
        executionId: exec.id,
        parity: { status: 'authority-failure', reason: '该 execution 缺 policyVersionRowId（历史行），无法恢复当次冻结源码 → parity 不可判' },
        note: 'not-replayable',
      });
    }
    const version = await db.query.policyVersions.findFirst({
      where: and(eq(policyVersions.id, exec.policyVersionRowId), eq(policyVersions.policyId, id)),
      columns: { content: true, aliasSet: true },
    });
    if (!version) {
      return NextResponse.json({
        executionId: exec.id,
        parity: { status: 'authority-failure', reason: '当次 PolicyVersion 不存在（已删/引用错） → parity 不可判' },
        note: 'not-replayable',
      });
    }

    // 行上已存的 side-A → PolicyReplayMetadata（供 wiring 归一化）。
    const authorityReplay: PolicyReplayMetadata = {
      canonicalInputHash: exec.canonicalInputHash,
      canonicalOutputHash: exec.canonicalOutputHash,
      canonicalizationVersion: exec.canonicalizationVersion ?? undefined,
      replayabilityStatus: exec.replayabilityStatus ?? undefined,
      traceHash: exec.traceHash,
      runtimeToolchainId: exec.runtimeToolchainId ?? undefined,
    };

    // aliasSet：优先 execution 行捕获的 aliasSetJson（当次实际用的）；缺则回退当次 version.aliasSet。
    let aliasSet: Record<string, string[]> | null = null;
    if (exec.aliasSetJson && typeof exec.aliasSetJson === 'object' && !Array.isArray(exec.aliasSetJson)) {
      aliasSet = exec.aliasSetJson as Record<string, string[]>;
    } else if (version.aliasSet) {
      try {
        const parsed = JSON.parse(version.aliasSet) as Record<string, string[]>;
        aliasSet = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch {
        aliasSet = null;
      }
    }

    // ★显式路径无外层失败隔离（runParityForExecutionNow 会 reject）——本 endpoint 自 catch，保证
    //   parity 失败不污染 HTTP 响应（返 500 结构化错误，不 5xx 裸抛）。source 用**当次冻结版本**。
    const { result, persisted } = await runParityForExecutionNow({
      executionId: exec.id,
      tenantId: policyTenantId(policy),
      actorUserId: session.user.id,
      source: version.content,
      input: exec.input as Record<string, unknown> | unknown[],
      locale: exec.locale ?? '',
      functionName: exec.functionName ?? '',
      aliasSet,
      role: RUNNER_LAUNCHER_HMAC_ROLE,
      authorityReplay,
    });

    // ★persisted=false（回写 execution 行失败）→ 明示客户端（Codex 抓：否则 200 但徽章不更新，误导）。
    return NextResponse.json({ executionId: exec.id, parity: result, persisted });
  } catch (err) {
    console.error('[verify-parity] handler failed', err);
    return NextResponse.json(
      { error: 'Parity verification failed', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
