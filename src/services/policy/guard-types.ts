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
  /** 签名事实片段（ADR 0040 §11 D3）；cloud 至多附 1 条，未登记 / 未启用 cloud 签发方时不出现该键。 */
  facts?: GuardFact[];
}

/**
 * 签名事实（ADR 0040 §11 D3）：除 signature 外八个成员的 RFC 8785 字节串由 Ed25519 签名，
 * signature 为 base64url 无填充的 64 字节。claims 键为点路径，值须与 action 对应路径 JCS 字节相等。
 */
export interface GuardFact {
  alg: 'Ed25519';
  audience: string;
  claims: Record<string, unknown>;
  expiresAt: string;
  issuedAt: string;
  issuer: string;
  kid: string;
  sources: Record<string, string>;
  signature: string;
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
  /** 输入来源（ADR 0040 §11 D2）：verified 路径、参与背书的 issuer#kid、事实是否已过期。 */
  inputSources?: { verified?: string[]; factIssuers?: string[]; factsStale?: boolean };
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
  /** 转 EXPIRED 的原因（ADR 0040 §11 D4）：自然过期不出现，签发方吊销为 `fact_issuer_revoked`。 */
  expiredReason?: string | null;
}

export interface GuardApprovalPage {
  items: GuardApprovalItem[];
  page: number;
  size: number;
}

/** 签名事实签发方（api GuardFactIssuerResource 视图，ADR 0040 §11 D3）；notAfter 为空时 api 不写出。 */
export interface GuardFactIssuer {
  alg: 'Ed25519';
  createdAt: string;
  createdBy: string;
  enabled: boolean;
  issuer: string;
  kid: string;
  notAfter?: string;
  /** base64url 无填充的 32 字节 Ed25519 原始公钥 */
  publicKey: string;
}

/** 登记人的展示信息（cloud 侧按 createdBy 解析）；查不到（已注销、anonymous）为 null。 */
export interface FactIssuerUser {
  name: string | null;
  email: string | null;
  image: string | null;
}

/** cloud `GET /api/fact-issuers/[tenantId]` 的列表行：api 视图 + 登记人展示信息。 */
export interface FactIssuerListItem extends GuardFactIssuer {
  createdByUser: FactIssuerUser | null;
}

/** 登记 / 更新签发方的请求体：enabled 缺省 true（false 即吊销）；notAfter 为 ISO-8601 时刻。 */
export interface GuardFactIssuerPut {
  publicKey: string;
  enabled?: boolean;
  notAfter?: string;
}
