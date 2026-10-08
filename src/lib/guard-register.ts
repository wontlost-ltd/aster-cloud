/**
 * 执行结果 → guard 决策登记（ADR 0042 §5.1）。
 *
 * 执行结论为 REQUIRE_APPROVAL/ESCALATE 时，以 aster-api 已上链的评估事件（evidenceCorrelationId）为锚
 * 开 guard 决策；cloud 只给出 correlationId 与动作映射，不解析模块名、不重新评估。
 * 本模块永不抛错：失败以 `{ guardError }` 记入执行行 metadata，执行本身照常落库。
 */
import { eq } from 'drizzle-orm';
import { runAfterResponse } from '@/lib/after-response';
import { isPolicyTenantMember } from '@/lib/business-roles';
import { notifyApprovalRequested } from '@/lib/guard-notifications';
import { policyTenantId } from '@/lib/policy-tenant';
import { db, executions } from '@/lib/prisma';
import type { PolicyExecutionResult } from '@/services/policy/cnl-executor';
import type { GuardAction } from '@/services/policy/guard-types';
import { PolicyApiError, type AgentIdentity, type PolicyApiClient } from '@/services/policy/policy-api';

/** Execution.metadata 的 guard 部分：成功记决策/审批 id，失败记错误码（供日志页重新登记）。 */
export interface ExecutionMetadata {
  guardDecisionId?: string;
  guardApprovalId?: string;
  guardError?: string;
}

export interface RegisterGuardArgs {
  client: PolicyApiClient;
  policy: { id: string; name: string; teamId: string | null; userId: string };
  functionName: string;
  input: Record<string, unknown>;
  /** 执行声明的 agent；落库行上的 EvidenceAgent（带 source）同样可传，映射时剥离 source。 */
  agent: AgentIdentity | null;
  result: PolicyExecutionResult;
  requesterUserId: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * 执行输入 → guard 动作：约定键优先，缺省回退到策略函数名。
 * principal.id 恒为发起人：api 四眼同时拦 decidedBy == principalId，若允许输入指定 principal_id，
 * 执行人可借此让某位审批人永远无法批准；业务侧主体 id 仍随整个输入留在 context 中。
 */
export function toGuardAction(
  input: Record<string, unknown>,
  functionName: string,
  agent: AgentIdentity | null,
  requesterUserId: string
): GuardAction {
  return {
    principal: {
      id: requesterUserId,
      type: str(input.principal_type) ?? 'user',
      roles: stringList(input.principal_roles),
    },
    action: { name: str(input.action) ?? functionName },
    resource: { type: str(input.resource_type) ?? '', id: str(input.resource_id) ?? '' },
    context: input,
    ...(agent
      ? { agent: { provider: agent.provider, model: agent.model, version: agent.version, session: agent.session } }
      : {}),
  };
}

/** 错误码口径：api 错误码优先，其次 HTTP 状态，非 api 错误（网络/超时等）统一 client_error。 */
export function guardErrorCode(err: unknown): string {
  if (err instanceof PolicyApiError) return err.code ?? `http_${err.statusCode}`;
  return 'client_error';
}

export async function registerGuardDecision(args: RegisterGuardArgs): Promise<ExecutionMetadata> {
  const correlationId = args.result.metadata.evidenceCorrelationId;
  // simulate / 旧 api 无证据关联 id：无锚可开决策
  if (!correlationId) return { guardError: 'no_evidence' };

  try {
    const decision = await args.client.guardFromEvidence({
      correlationId,
      action: toGuardAction(args.input, args.functionName, args.agent, args.requesterUserId),
    });
    const approvalId = decision.approval?.id;
    if (!approvalId) return { guardDecisionId: decision.decisionId };

    const payload = {
      tenantId: policyTenantId(args.policy),
      decisionId: decision.decisionId,
      approvalId,
      policyId: args.policy.id,
      policyName: args.policy.name,
      requiredRole: decision.approval?.requiredRole ?? null,
    };
    runAfterResponse(() => notifyApprovalRequested(args.policy.userId, payload));
    return { guardDecisionId: decision.decisionId, guardApprovalId: approvalId };
  } catch (err) {
    console.error('[guard-register] from-evidence failed', { policyId: args.policy.id, correlationId, err });
    return { guardError: guardErrorCode(err) };
  }
}

/**
 * 先校验租户成员、再装配客户端、最后登记：任一步失败都降级为 guardError，保证调用方永不因此抛错。
 * 执行人不属于策略租户（公开/共享策略的外部执行人）→ not_tenant_member，不开决策、不发通知。
 */
export async function registerGuardDecisionWith(
  createClient: () => Promise<PolicyApiClient>,
  args: Omit<RegisterGuardArgs, 'client'>
): Promise<ExecutionMetadata> {
  if (!args.result.metadata.evidenceCorrelationId) return { guardError: 'no_evidence' };
  let client: PolicyApiClient;
  try {
    if (!(await isPolicyTenantMember(args.requesterUserId, args.policy))) {
      return { guardError: 'not_tenant_member' };
    }
    client = await createClient();
  } catch (err) {
    console.error('[guard-register] client setup failed', { policyId: args.policy.id, err });
    return { guardError: 'client_error' };
  }
  return registerGuardDecision({ ...args, client });
}

/**
 * 执行行先落库、再登记、再回写 metadata（ADR 0042 §5.1）：api 挂起或实例被回收都不会丢执行行及其链锚，
 * 最坏结果只是 metadata 仍为 null。插入失败（无行可更）则不登记。永不抛错。
 */
export async function registerGuardAfterInsert(
  executionInsert: Promise<unknown>,
  executionId: string,
  register: () => Promise<ExecutionMetadata>
): Promise<ExecutionMetadata | null> {
  try {
    await executionInsert;
  } catch {
    // 插入失败由调用方的写入聚合记日志；此处只放弃登记
    return null;
  }
  const metadata = await register();
  try {
    await db.update(executions).set({ metadata }).where(eq(executions.id, executionId));
  } catch (err) {
    console.error('[guard-register] metadata update failed', { executionId, err });
  }
  return metadata;
}

/** 执行决策是否需要开 guard 决策。 */
export function needsGuardDecision(decision: string | null | undefined): boolean {
  return decision === 'require_approval' || decision === 'escalate';
}
