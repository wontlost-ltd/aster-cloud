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
  /**
   * 执行收据（ADR 0040 §12 D1，仅 ALLOW）。payload 内的策略地址 `policyModule / policyFunction` 是签名覆盖的
   * （#517 之前签发的收据没有）；其余键 cloud 不解读。
   */
  executionReceipt?: { payload?: { policyModule?: string; policyFunction?: string; [key: string]: unknown } };
  /** 以下三项只有回读端点 `GET /guard/decisions/{id}` 才有（ADR 0054 §3.3）：已 consume 时的动作摘要与消耗方。 */
  actionHash?: string;
  consumedBy?: { attemptId: string; consumedAt: string; executorId?: string };
  /** 已回写结果时。 */
  result?: { resultAt: string; status: string };
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
  /** 审批输入状态（ADR 0042 §12 D8）：PENDING 按输入快照是否存在；已决为审批时记下的值。旧 api 不返回。 */
  inputStatus?: GuardApprovalInputStatus | null;
  /** 以下三项仅已决且有记录时出现。 */
  inputSnapshotHash?: string | null;
  inputSnapshotMatched?: boolean | null;
  inputRevealed?: boolean | null;
}

/** 审批输入视图状态（ADR 0042 §12 D8）。 */
export type GuardApprovalInputStatus = 'available' | 'unavailable' | 'purged' | 'integrity_failed' | 'too_large';

/** 输入视图中一个 `@pii` 字段的标记。 */
export interface GuardPiiMark {
  path: string;
  level: string;
  category?: string;
  source: string;
}

/**
 * 审批输入视图（aster-api `GuardApprovalInputView`，ADR 0042 §12 D8，与 aster-guard SDK 同形）。
 * `input` 中 `@pii` 字段为 `{ $pii: { level, category } }`，未声明子树为 `{ $pii: { level: 'unknown' } }`；
 * `status ≠ available` 时没有 `input / piiMarks / inputSnapshotHash`。
 */
export interface GuardApprovalInput {
  approvalId: string;
  decisionId: string;
  contextHash?: string;
  status: GuardApprovalInputStatus;
  marksSource?: 'version' | 'evaluation' | 'none';
  inputBinding?: 'direct' | 'evaluated' | 'unbound';
  maskRules?: string;
  revealed: boolean;
  revealedByMe: boolean;
  input?: Record<string, unknown>;
  piiMarks?: GuardPiiMark[];
  inputSnapshotHash?: string;
  inputSources?: { verified: string[]; factIssuers: string[]; factSources: string[] };
  factsStale?: boolean;
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

/** 登记人的展示信息（cloud 侧按 createdBy 解析，只限本租户当前成员）；离队成员、已注销、anonymous 为 null。 */
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

/**
 * Guard 对账（aster-api ADR 0054 §10，查询扩展见 ADR 0061 §3.4）。字面量与 aster-api `OrphanKind` 一一对应，
 * 两侧测试同时钉住（cloud：`kinds.test.ts`）。
 */
export type GuardOrphanKind =
  | 'side_effect_without_decision'
  | 'side_effect_unconsumed'
  | 'side_effect_mismatch'
  | 'consumed_without_result'
  | 'allow_unconsumed'
  | 'consume_on_non_allow'
  | 'result_without_consume'
  | 'orphan_receipt';

export type GuardOrphanSeverity = 'critical' | 'warning' | 'info';

export type GuardOrphanStatus = 'OPEN' | 'RESOLVED' | 'ACKNOWLEDGED';

/**
 * 孤儿列表项（aster-api `GuardOrphanAdminService.view`）。null 字段不写出，故可选项缺省即无。
 * `detail`、`executor`、`executorId` 含上报方可控文本，只能按纯文本展示（ADR 0061 §3.6）。
 */
export interface GuardOrphan {
  id: number;
  kind: GuardOrphanKind;
  severity: GuardOrphanSeverity;
  status: GuardOrphanStatus;
  decisionId?: string;
  sideEffectId?: number;
  executor: string;
  executorId?: string;
  detectedAt: string;
  resolvedAt?: string;
  resolution?: 'late_result' | 'aged_out' | 'acknowledged';
  acknowledgedBy?: string;
  /** 确认说明；旧 aster-api（ADR 0061 之前）不返回。 */
  ackComment?: string;
  detail: Record<string, unknown>;
}

export interface GuardOrphanPage {
  items: GuardOrphan[];
  /** 下一页的 `before` 游标；没有更多时缺省。 */
  next?: number;
}

/** 对账摘要（`GET /guard/reconciliation`）；`open` 只列非零的 kind。 */
export interface GuardReconciliationSummary {
  lastRun: {
    runId: number;
    finishedAt: string;
    windowStart: string;
    windowEnd: string;
    newOrphans: number;
    resolvedOrphans: number;
    openOrphans: number;
  } | null;
  open: Partial<Record<GuardOrphanKind, number>>;
  openTotal: number;
  resultGrace: string;
  lookback: string;
}

/** 孤儿列表查询；`severities` 为空数组表示不按 severity 过滤。 */
export interface GuardOrphanQuery {
  status: GuardOrphanStatus;
  severities: GuardOrphanSeverity[];
  kind?: GuardOrphanKind;
  before?: number;
  limit: number;
}
