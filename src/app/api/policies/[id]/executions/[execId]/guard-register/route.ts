/*
 * 重新登记 guard 决策（ADR 0042 §5.1 第 3 条）。
 * POST /api/policies/[id]/executions/[execId]/guard-register
 *
 * 执行时 from-evidence 失败（metadata.guardError）的行，用同一映射以当前用户身份再调一次并回写 metadata。
 * 已有 guardDecisionId 的行幂等返回，不重复开决策。
 */
import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { db, policies, executions } from '@/lib/prisma';
import { and, eq, isNull } from 'drizzle-orm';
import { policyTenantId } from '@/lib/policy-tenant';
import { needsGuardDecision, registerGuardDecisionWith, type ExecutionMetadata } from '@/lib/guard-register';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import type { PolicyExecutionResult } from '@/services/policy/cnl-executor';
import type { AgentIdentity } from '@/services/policy/policy-api';

interface RouteParams {
  params: Promise<{ id: string; execId: string }>;
}

export async function POST(_req: Request, { params }: RouteParams) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = session.user.id;
    const { id, execId } = await params;

    // 归属校验沿用日志页口径：策略属于当前用户，执行行同时约束 policyId 与 userId
    const policy = await db.query.policies.findFirst({
      where: and(eq(policies.id, id), eq(policies.userId, userId), isNull(policies.deletedAt)),
      columns: { id: true, name: true, teamId: true, userId: true },
    });
    if (!policy) return NextResponse.json({ error: 'Policy not found' }, { status: 404 });

    const where = and(eq(executions.id, execId), eq(executions.policyId, id), eq(executions.userId, userId));
    const exec = await db.query.executions.findFirst({
      where,
      columns: {
        id: true, input: true, output: true, agent: true, decision: true,
        functionName: true, evidenceCorrelationId: true, metadata: true,
      },
    });
    if (!exec) return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
    if (!needsGuardDecision(exec.decision)) {
      return NextResponse.json({ error: 'Execution does not require approval', code: 'not_approvable' }, { status: 409 });
    }

    const existing = (exec.metadata ?? {}) as ExecutionMetadata;
    if (existing.guardDecisionId) return NextResponse.json({ metadata: existing });

    // 证据关联 id 以落库列为准（output 内的副本可能缺失于旧行）
    const output = (exec.output ?? {}) as PolicyExecutionResult;
    const correlationId = exec.evidenceCorrelationId ?? output.metadata?.evidenceCorrelationId;
    const result = { ...output, metadata: { ...output.metadata, evidenceCorrelationId: correlationId ?? undefined } };

    const guardMeta = await registerGuardDecisionWith(
      () => createPolicyApiClientForUser(policyTenantId(policy), userId),
      {
        policy,
        functionName: exec.functionName ?? output.executedFunction ?? policy.name,
        input: (exec.input ?? {}) as Record<string, unknown>,
        agent: (exec.agent ?? null) as AgentIdentity | null,
        result,
        requesterUserId: userId,
      }
    );

    // 新结果整体替换旧的 guard 键：成功时清掉上次的 guardError
    const { guardDecisionId: _d, guardApprovalId: _a, guardError: _e, ...rest } = existing;
    const metadata: ExecutionMetadata = { ...rest, ...guardMeta };
    await db.update(executions).set({ metadata }).where(where);

    return NextResponse.json({ metadata }, { status: guardMeta.guardError ? 502 : 200 });
  } catch (err) {
    console.error('[guard-register] handler failed', err);
    return NextResponse.json({ error: 'Guard registration failed' }, { status: 500 });
  }
}
