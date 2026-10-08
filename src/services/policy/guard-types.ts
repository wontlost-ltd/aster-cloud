/**
 * aster-api Action Guard 契约类型（ADR 0040 §3 / ADR 0042 §4）。
 *
 * 字段与 api 的 GuardDecisionResponse / GuardApprovalView 一一对应；api 侧省略 null 与空集合，
 * 故除 decisionId 外一律可选。
 */

/** 审批状态（api GuardApprovalStatus）。 */
export type GuardApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

/** Agent 提议的动作（api GuardActionRequest.Action）。 */
export interface GuardAction {
  principal: { id: string; type?: string; roles?: string[] };
  action: { name: string };
  resource?: { type?: string; id?: string };
  context?: Record<string, unknown>;
  agent?: { provider?: string; model?: string; version?: string; session?: string };
}

/** 以链上评估事件为锚开决策：api 读 correlationId 对应的已上链评估结论，不重新评估。 */
export interface GuardFromEvidenceRequest {
  correlationId: string;
  action: GuardAction;
}

export interface GuardDecision {
  approval?: { expiresAt?: string; id: string; requiredRole?: string; status: GuardApprovalStatus };
  controls?: string[];
  decisionId: string;
  /** Agent 唯一需要看的结论：ALLOW | DENY | PENDING。 */
  effectiveOutcome?: string;
  outcome?: string;
  policyVersion?: { id?: number; sourceHash?: string; version?: number };
  reason?: string;
  reasonCode?: string;
  receipt?: { auditId?: number; hash?: string; prevHash?: string };
  role?: string;
  ruleId?: string;
}

/** 审批列表项：基础字段 + ADR 0042 §4.3 取自关联决策的扩展字段。 */
export interface GuardApprovalItem {
  comment?: string | null;
  createdAt?: string | null;
  decidedAt?: string | null;
  decidedBy?: string | null;
  decisionId: string;
  expiresAt?: string | null;
  id: string;
  outcome?: string | null;
  principalId?: string | null;
  requiredRole?: string | null;
  status: GuardApprovalStatus;
  policyModule?: string | null;
  policyFunction?: string | null;
  actionName?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  ruleId?: string | null;
  controls?: string[] | null;
  reason?: string | null;
  evidenceCorrelationId?: string | null;
}

export interface GuardApprovalPage {
  items: GuardApprovalItem[];
  page: number;
  size: number;
}
