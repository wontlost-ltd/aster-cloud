/**
 * 执行结果 → guard 决策登记（ADR 0042 §5.1；ADR 0046 §11.8）。
 *
 * 执行结论为 REQUIRE_APPROVAL/ESCALATE，或 Verdict ALLOW 且模块档案要求 verifiedInputs 时，以 aster-api 已上链的
 * 评估事件（evidenceCorrelationId）为锚开 guard 决策；cloud 只给出 correlationId 与动作映射，不解析模块名、不重新评估。
 * 后一种 ALLOW 须过来源门：未附可验证事实即 DENY `unverified_input`（#510 裁定 (a)）。
 * 本模块永不抛错：失败以 `{ guardError }` 记入执行行 metadata，执行本身照常落库。
 */
import { eq } from 'drizzle-orm';
import { runAfterResponse } from '@/lib/after-response';
import { isPolicyTenantMember } from '@/lib/business-roles';
import { notifyApprovalRequested } from '@/lib/guard-notifications';
import { policyTenantId } from '@/lib/policy-tenant';
import { db, executions } from '@/lib/prisma';
import { requiresVerifiedInputs } from '@/services/evidence/control-registry';
import { attachFacts } from '@/services/guard/fact-plan';
import type { PolicyExecutionResult } from '@/services/policy/cnl-executor';
import type { GuardAction } from '@/services/policy/guard-types';
import { PolicyApiError, type AgentIdentity, type PolicyApiClient } from '@/services/policy/policy-api';

/**
 * Execution.metadata 的 guard 部分：成功记决策/审批 id，失败记错误码（供日志页重新登记）。
 * 没有审批的决策（ALLOW / DENY 终态）另记结论与原因码；待审批的结论会随审批变化，不在这里记。
 */
export interface ExecutionMetadata {
  guardDecisionId?: string;
  guardApprovalId?: string;
  guardOutcome?: string;
  guardReasonCode?: string;
  guardError?: string;
}

/** 为什么要开 guard 决策：待处置结论要人工审批；档案要求 verifiedInputs 的 ALLOW 要过来源门。 */
export type GuardRequirement = 'approval' | 'provenance';

/** 评估结果里判定登记条件所需的两项（aster-api 评估响应的 Verdict 结果码与模块档案）。 */
export interface VerdictFacts {
  outcome?: string;
  profile?: string;
}

/** 执行响应的 `guard` 块（ADR 0046 §11.8 第 5 条）。 */
export interface GuardSummary {
  required: GuardRequirement;
  decisionId?: string;
  approvalId?: string;
  effectiveOutcome?: string;
  reasonCode?: string;
  error?: string;
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
    // 事实随首次请求附上（ADR 0046 §11.6 第 11 条）；未启用 cloud 签发方时 action 原样不变。
    // invalid_fact 400 照常记 guardError，不去掉事实重试：翻转后那会用一次 DENY 消耗证据（§11.7 裁定 6）。
    const action = await attachFacts(
      args.client,
      toGuardAction(args.input, args.functionName, args.agent, args.requesterUserId),
      { tenantId: policyTenantId(args.policy), userId: args.requesterUserId, input: args.input },
      new Date(),
    );
    const decision = await args.client.guardFromEvidence({ correlationId, action });
    const approvalId = decision.approval?.id;
    if (!approvalId) {
      return {
        guardDecisionId: decision.decisionId,
        ...(decision.effectiveOutcome ? { guardOutcome: decision.effectiveOutcome } : {}),
        ...(decision.reasonCode ? { guardReasonCode: decision.reasonCode } : {}),
      };
    }

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

/**
 * 执行决策需要哪种 guard 决策；不需要为 null。ALLOW 只看 Verdict 结果码（非 Verdict 函数不产出 inputRefs，
 * ADR 0046 §11.6 第 1 条），档案要求取 cloud 的注册表副本（与 core / locales 由 parity 测试锁定、同车发布）。
 */
export function guardRequirement(
  decision: string | null | undefined,
  verdict: VerdictFacts | null | undefined,
): GuardRequirement | null {
  if (decision === 'require_approval' || decision === 'escalate') return 'approval';
  if (decision === 'approved' && verdict?.outcome === 'ALLOW' && requiresVerifiedInputs(verdict.profile)) {
    return 'provenance';
  }
  return null;
}

/** 执行决策是否需要开 guard 决策。 */
export function needsGuardDecision(decision: string | null | undefined, verdict?: VerdictFacts | null): boolean {
  return guardRequirement(decision, verdict) !== null;
}

/** 执行响应的 guard 块；登记未发生（执行行插入失败）记 `not_registered`。 */
export function guardSummary(required: GuardRequirement, meta: ExecutionMetadata | null): GuardSummary {
  if (!meta || meta.guardError || !meta.guardDecisionId) {
    return { required, error: meta?.guardError ?? 'not_registered' };
  }
  const effectiveOutcome = meta.guardOutcome ?? (meta.guardApprovalId ? 'PENDING' : undefined);
  return {
    required,
    decisionId: meta.guardDecisionId,
    ...(meta.guardApprovalId ? { approvalId: meta.guardApprovalId } : {}),
    ...(effectiveOutcome ? { effectiveOutcome } : {}),
    ...(meta.guardReasonCode ? { reasonCode: meta.guardReasonCode } : {}),
  };
}

/**
 * 执行响应的 `success`：「调用方可据此继续」。来源门要求下只有 guard ALLOW 才为 true——guard DENY、登记失败或
 * 未登记一律 false（fail-closed）；其余情形保持评估的 allowed 不变（ADR 0046 §11.8 第 5 条）。
 */
export function executionSuccess(
  allowed: boolean | undefined,
  required: GuardRequirement | null,
  meta: ExecutionMetadata | null,
): boolean {
  if (required === 'provenance') return meta?.guardOutcome === 'ALLOW' && !meta.guardError;
  return allowed ?? false;
}
