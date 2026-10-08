/**
 * 执行结果 → guard 决策登记（ADR 0042 §5.1）。
 *
 * 执行结论为 REQUIRE_APPROVAL/ESCALATE 时，以 aster-api 已上链的评估事件（evidenceCorrelationId）为锚
 * 开 guard 决策；cloud 只给出 correlationId 与动作映射，不解析模块名、不重新评估。
 * 本模块永不抛错：失败以 `{ guardError }` 记入执行行 metadata，执行本身照常落库。
 */
import { notifyApprovalRequested } from '@/lib/guard-notifications';
import { policyTenantId } from '@/lib/policy-tenant';
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

/** 执行输入 → guard 动作：约定键优先，缺省回退到发起人与策略函数名。 */
export function toGuardAction(
  input: Record<string, unknown>,
  functionName: string,
  agent: AgentIdentity | null,
  requesterUserId: string
): GuardAction {
  return {
    principal: {
      id: str(input.principal_id) ?? requesterUserId,
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

    void notifyApprovalRequested(policyTenantId(args.policy), {
      tenantId: policyTenantId(args.policy),
      decisionId: decision.decisionId,
      approvalId,
      policyId: args.policy.id,
      policyName: args.policy.name,
      requiredRole: decision.approval?.requiredRole ?? null,
    });
    return { guardDecisionId: decision.decisionId, guardApprovalId: approvalId };
  } catch (err) {
    console.error('[guard-register] from-evidence failed', { policyId: args.policy.id, correlationId, err });
    return { guardError: guardErrorCode(err) };
  }
}

/**
 * 先装配客户端再登记：客户端装配（现查业务角色）失败同样降级为 guardError，保证调用方永不因此抛错。
 */
export async function registerGuardDecisionWith(
  createClient: () => Promise<PolicyApiClient>,
  args: Omit<RegisterGuardArgs, 'client'>
): Promise<ExecutionMetadata> {
  if (!args.result.metadata.evidenceCorrelationId) return { guardError: 'no_evidence' };
  let client: PolicyApiClient;
  try {
    client = await createClient();
  } catch (err) {
    console.error('[guard-register] client setup failed', { policyId: args.policy.id, err });
    return { guardError: 'client_error' };
  }
  return registerGuardDecision({ ...args, client });
}

/** 执行决策是否需要开 guard 决策。 */
export function needsGuardDecision(decision: string | null | undefined): boolean {
  return decision === 'require_approval' || decision === 'escalate';
}
