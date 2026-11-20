/**
 * 孤儿的决策上下文（ADR 0061 §3.5）：按 (tenantId, decisionId) 组装三个来源，并发、互不影响、各自降级。
 *
 * | 来源 | 404 / 缺失 | 失败 |
 * |---|---|---|
 * | aster-api `GET /guard/decisions/{id}`（经 ReconciliationApi，签真实角色） | `not_found` = 本工作区无此决策行 | `unavailable` |
 * | aster-api `GET /audit/receipts?decisionIds=`（fetchDecisionReceipts，自签 member） | `not_found` | `unavailable` |
 * | cloud Execution（metadata.guardDecisionId，且其策略租户 = 本租户） | null | null |
 *
 * 只在当前租户内查，绝不尝试其他租户：决策 404 只说明「本工作区没有这条决策行」，不断言它在别处不存在，
 * 也不泄露他租户决策是否存在（ADR 0054 §10.3）。`orphan_receipt` 的典型形状正是决策 404 + 链上有决策事件。
 */
import 'server-only';

import { desc, eq, sql } from 'drizzle-orm';
import { db, executions, policies } from '@/lib/prisma';
import {
  fetchDecisionReceipts,
  type ChainApproval,
  type ChainConsume,
  type ChainReceipt,
  type ChainResult,
  type ReceiptLookup,
} from '@/services/evidence/receipts-client';
import type { GuardApprovalStatus, GuardDecision } from '@/services/policy/guard-types';
import { PolicyApiError } from '@/services/policy/policy-api';
import type { ReconciliationApi } from './access';

export type Part<T> = { state: 'ok'; value: T } | { state: 'not_found' } | { state: 'unavailable' };

export interface DecisionChain {
  decision: ChainReceipt | null;
  consumes: ChainConsume[];
  results: ChainResult[];
  approvals: ChainApproval[];
}

export interface ExecutionLink {
  policyId: string;
  executionId: string;
}

export interface DecisionContext {
  decisionId: string;
  decision: Part<GuardDecision>;
  chain: Part<DecisionChain>;
  execution: ExecutionLink | null;
  approvalLink: { status: GuardApprovalStatus } | null;
}

export interface DecisionContextDeps {
  fetchDecisionReceipts: (tenantId: string, decisionIds: string[]) => Promise<ReceiptLookup>;
  findExecutionForDecision: (tenantId: string, decisionId: string) => Promise<ExecutionLink | null>;
}

/** UUID（任意版本，大小写不敏感）；孤儿的 decisionId 来自 aster-api 的 UUID 列。 */
export const DECISION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPROVAL_STATUSES: readonly string[] = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'];

/**
 * 决策的发起执行：按 `metadata->>'guardDecisionId'`（表达式部分索引，迁移 0052）取最新一条，且其策略的租户
 * （团队策略取 teamId，个人策略取 userId，同 policyTenantId）必须等于本租户；他租户的执行一律视为查不到。
 */
export async function findExecutionForDecision(tenantId: string, decisionId: string): Promise<ExecutionLink | null> {
  const rows = await db
    .select({ executionId: executions.id, policyId: executions.policyId })
    .from(executions)
    .innerJoin(policies, eq(policies.id, executions.policyId))
    .where(
      sql`${executions.metadata}->>'guardDecisionId' = ${decisionId}
        AND coalesce(nullif(${policies.teamId}, ''), ${policies.userId}) = ${tenantId}`,
    )
    .orderBy(desc(executions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

const DEFAULT_DEPS: DecisionContextDeps = {
  fetchDecisionReceipts: (tenantId, ids) => fetchDecisionReceipts(tenantId, ids),
  findExecutionForDecision,
};

async function loadDecision(api: ReconciliationApi, decisionId: string): Promise<Part<GuardDecision>> {
  try {
    return { state: 'ok', value: await api.getDecision(decisionId) };
  } catch (e) {
    if (e instanceof PolicyApiError && e.statusCode === 404) return { state: 'not_found' };
    console.warn('[guard-reconciliation] decision lookup failed', decisionId, e);
    return { state: 'unavailable' };
  }
}

async function loadChain(deps: DecisionContextDeps, tenantId: string, decisionId: string): Promise<Part<DecisionChain>> {
  let lookup: ReceiptLookup;
  try {
    lookup = await deps.fetchDecisionReceipts(tenantId, [decisionId]);
  } catch (e) {
    console.warn('[guard-reconciliation] receipts lookup failed', decisionId, e);
    return { state: 'unavailable' };
  }
  if (lookup.unavailable.has(decisionId)) return { state: 'unavailable' };
  const chain: DecisionChain = {
    decision: lookup.receipts.get(decisionId) ?? null,
    consumes: lookup.consumes.get(decisionId) ?? [],
    results: lookup.results.get(decisionId) ?? [],
    approvals: lookup.approvals.get(decisionId) ?? [],
  };
  const empty = !chain.decision && !chain.consumes.length && !chain.results.length && !chain.approvals.length;
  return empty ? { state: 'not_found' } : { state: 'ok', value: chain };
}

async function loadExecution(deps: DecisionContextDeps, tenantId: string, decisionId: string): Promise<ExecutionLink | null> {
  try {
    return await deps.findExecutionForDecision(tenantId, decisionId);
  } catch (e) {
    console.warn('[guard-reconciliation] execution lookup failed', decisionId, e);
    return null;
  }
}

/** 审批链接：优先取链上最新（auditId 最大）的已决审批；无已决审批时取决策行上的审批状态（如 PENDING）。 */
function approvalLinkOf(decision: Part<GuardDecision>, chain: Part<DecisionChain>): DecisionContext['approvalLink'] {
  if (chain.state === 'ok' && chain.value.approvals.length > 0) {
    const latest = chain.value.approvals.reduce((a, b) => (b.auditId > a.auditId ? b : a));
    if (APPROVAL_STATUSES.includes(latest.outcome)) return { status: latest.outcome as GuardApprovalStatus };
  }
  const status = decision.state === 'ok' ? decision.value.approval?.status : undefined;
  return status && APPROVAL_STATUSES.includes(status) ? { status } : null;
}

export async function loadDecisionContext(
  tenantId: string,
  api: ReconciliationApi,
  decisionId: string,
  deps: DecisionContextDeps = DEFAULT_DEPS,
): Promise<DecisionContext> {
  const [decision, chain, execution] = await Promise.all([
    loadDecision(api, decisionId),
    loadChain(deps, tenantId, decisionId),
    loadExecution(deps, tenantId, decisionId),
  ]);
  return { decisionId, decision, chain, execution, approvalLink: approvalLinkOf(decision, chain) };
}
