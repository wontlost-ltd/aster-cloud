// 证据导出（evidence export）领域类型。
//
// 「证据包」= 从**真实执行链**导出的可验证证据（decision + canonical 哈希 + 双引擎溯源 +
// replayability），供用户交给自己的合规/审计团队归档。**不含任何假合规分数或硬编码法规建议**——
// 与被替换的旧 compliance-score 报告根本不同：这里只呈现执行链**已经产生**的权威事实。

import type { ExecutionSource } from '@/lib/prisma';
import type { Article14Mapping } from './article14';
import type { Reviewer } from './reviewers';

/** 执行决策六态（与 executionDecisionEnum 一致）；legacy 行可能为 null → 归入 'unknown' 统计桶。 */
export type EvidenceDecision =
  | 'approved'
  | 'denied'
  | 'indeterminate'
  | 'error'
  | 'require_approval'
  | 'escalate';

/** decision 分布统计（含 unknown 桶容纳 legacy decision=null 行）。 */
export interface DecisionTally {
  approved: number;
  denied: number;
  indeterminate: number;
  error: number;
  require_approval: number;
  escalate: number;
  unknown: number;
}

/**
 * 链收据引用（ADR 0041 §2.4）：命中时只搬运可校验的哈希链坐标，供审计方经
 * GET /api/v1/audit/receipts 独立复核；否则如实标状态——legacy=无关联 id 的旧行，
 * missing=aster-api 未找到，unavailable=取收据失败（超时/网络/非 2xx）。绝不伪造。
 */
export type ReceiptRef =
  | { auditId: number; currentHash: string; prevHash: string | null; hashVersion: number }
  | { status: 'missing' | 'legacy' | 'unavailable' };

/** 调用方自报的 agent 身份（非认证事实，source 恒为 declared）。 */
export interface EvidenceAgent {
  provider: string;
  model: string;
  version?: string;
  session?: string;
  source: 'declared';
}

/** 最近一次 What-If 回放的结论摘要（ADR 0044 §3）。 */
export interface EvidenceWhatIf {
  batchId: string;
  baseOutcome: string;
  targetOutcome: string | null;
  baseLegacy: boolean;
}

/**
 * 单条执行的证据条目。全部来自 executions 表已存的权威字段——哈希由 aster-api 计算，cloud 只搬运。
 * **不含明文 input/output/traceJson**（PII）；只含可交叉验证的哈希 + 溯源。legacy 行哈希/decision 可能为 null。
 */
export interface EvidenceEntry {
  executionId: string;
  policyId: string;
  policyVersion: number | null;
  /** 不可变版本行引用（可精确定位当时编译产物）。 */
  policyVersionRowId: string | null;
  decision: EvidenceDecision | null;
  canonicalInputHash: string | null;
  canonicalOutputHash: string | null;
  traceHash: string | null;
  canonicalizationVersion: string | null;
  /** 双引擎溯源：源/运行时 toolchain id。 */
  toolchain: { source: string | null; runtime: string | null };
  replayabilityStatus: string | null;
  replayabilityReasons: unknown;
  reasonCodes: unknown;
  source: ExecutionSource;
  durationMs: number;
  /** ISO-8601 UTC。 */
  createdAt: string;
  /** 服务端派生的结果大写码（ALLOW/DENY/REQUIRE_APPROVAL/…）；旧行为 null。 */
  outcome: string | null;
  ruleId: string | null;
  controls: string[] | null;
  agent: EvidenceAgent | null;
  evidenceCorrelationId: string | null;
  receipt: ReceiptRef;
  /** 三来源统一复核者，按 (decidedAt, ref) 排序以保证 bundleHash 确定。 */
  reviewers: Reviewer[];
  /** 最近一次 What-If 回放的结论码；无回放或取不到为 null。 */
  whatIf: EvidenceWhatIf | null;
}

/** 导出格式。 */
export type EvidenceFormat = 'json' | 'jsonl';

/**
 * 证据包顶层 manifest（自描述 + 防篡改）。bundleHash 对**有序 entries** 的 canonicalHash——
 * 审计方可用同一 canonical 规则重算校验（recipe 见 notes）。manifest 本身不进 bundleHash（避免自引用）。
 */
export interface EvidenceManifest {
  kind: 'evidence-export';
  /** v3 起 entries 含 whatIf、manifest 含 regulatoryMapping；已存的 v1/v2 包按原样下载。 */
  schemaVersion: '3';
  generatedAt: string;
  /** 单策略快照，或全部策略范围。 */
  policy:
    | { id: string; name: string; version: number | null; policyVersionRowId: string | null }
    | { scope: 'all' };
  range: { start: string | null; end: string | null };
  totals: { count: number };
  decisionTally: DecisionTally;
  canonicalizationVersion: string;
  /** hex sha256（复用 canonicalHash，带 CANONICALIZATION_VERSION 前缀）。 */
  bundleHash: string;
  /** 收据来源与独立校验入口。 */
  receiptSource: { kind: 'aster-api-hash-chain'; verifier: 'GET /api/v1/audit/receipts' };
  /** 按 `${provider}/${model}` 计数；无 agent 计入 'unknown'。 */
  agentTally: Record<string, number>;
  reviewerTally: Record<Reviewer['source'], number>;
  /** 无证据关联 id（receipt=legacy）的条目数。 */
  legacyEntries: number;
  /** EU AI Act 第 14 条对照。 */
  regulatoryMapping: Article14Mapping;
  notes: {
    /** 缺 canonical 哈希的 legacy 行数（导出覆盖缺口，供审计方知情——绝不伪造哈希）。 */
    legacyRowsWithoutHashes: number;
    /** 收据取不到（超时/网络/非 2xx）的条目数——导出仍完成，如实标注。 */
    receiptsUnavailable: number;
    /** aster-api 未找到收据的条目数。 */
    receiptsMissing: number;
    /** What-If 回放取不到（超时/网络/非 2xx）的条目数。 */
    whatIfUnavailable: number;
    /** 校验 recipe：告诉审计方如何重算 bundleHash。 */
    verification: string;
  };
}

/** 完整证据包（manifest + 有序 entries）。 */
export interface EvidenceBundle {
  manifest: EvidenceManifest;
  entries: EvidenceEntry[];
}

// ---- schemaVersion '1' 冻结类型：只用于读取已持久化的历史导出，绝不再生成；字段与 v1 发布时一致，不得修改。

/** v1 决策四态。 */
export type EvidenceDecisionV1 = 'approved' | 'denied' | 'indeterminate' | 'error';

/** v1 决策分布（无 require_approval/escalate 桶）。 */
export interface DecisionTallyV1 {
  approved: number;
  denied: number;
  indeterminate: number;
  error: number;
  unknown: number;
}

/** v1 条目：无 outcome/ruleId/controls/agent/receipt/reviewers。 */
export interface EvidenceEntryV1 {
  executionId: string;
  policyId: string;
  policyVersion: number | null;
  policyVersionRowId: string | null;
  decision: EvidenceDecisionV1 | null;
  canonicalInputHash: string | null;
  canonicalOutputHash: string | null;
  traceHash: string | null;
  canonicalizationVersion: string | null;
  toolchain: { source: string | null; runtime: string | null };
  replayabilityStatus: string | null;
  replayabilityReasons: unknown;
  reasonCodes: unknown;
  source: ExecutionSource;
  durationMs: number;
  createdAt: string;
}

/** v1 manifest：无收据/复核者/agent 统计。 */
export interface EvidenceManifestV1 {
  kind: 'evidence-export';
  schemaVersion: '1';
  generatedAt: string;
  policy:
    | { id: string; name: string; version: number | null; policyVersionRowId: string | null }
    | { scope: 'all' };
  range: { start: string | null; end: string | null };
  totals: { count: number };
  decisionTally: DecisionTallyV1;
  canonicalizationVersion: string;
  bundleHash: string;
  notes: {
    legacyRowsWithoutHashes: number;
    verification: string;
  };
}

export interface EvidenceBundleV1 {
  manifest: EvidenceManifestV1;
  entries: EvidenceEntryV1[];
}

// ---- schemaVersion '2' 冻结类型：ADR 0044 起只读。

export interface EvidenceEntryV2 {
  executionId: string;
  policyId: string;
  policyVersion: number | null;
  /** 不可变版本行引用（可精确定位当时编译产物）。 */
  policyVersionRowId: string | null;
  decision: EvidenceDecision | null;
  canonicalInputHash: string | null;
  canonicalOutputHash: string | null;
  traceHash: string | null;
  canonicalizationVersion: string | null;
  /** 双引擎溯源：源/运行时 toolchain id。 */
  toolchain: { source: string | null; runtime: string | null };
  replayabilityStatus: string | null;
  replayabilityReasons: unknown;
  reasonCodes: unknown;
  source: ExecutionSource;
  durationMs: number;
  /** ISO-8601 UTC。 */
  createdAt: string;
  /** 服务端派生的结果大写码（ALLOW/DENY/REQUIRE_APPROVAL/…）；旧行为 null。 */
  outcome: string | null;
  ruleId: string | null;
  controls: string[] | null;
  agent: EvidenceAgent | null;
  evidenceCorrelationId: string | null;
  receipt: ReceiptRef;
  /** 三来源统一复核者，按 (decidedAt, ref) 排序以保证 bundleHash 确定。 */
  reviewers: Reviewer[];
}


export interface EvidenceManifestV2 {
  kind: 'evidence-export';
  /** v2 entries 含 outcome/ruleId/controls/agent/receipt/reviewers；已存的 v1 包按原样下载。 */
  schemaVersion: '2';
  generatedAt: string;
  /** 单策略快照，或全部策略范围。 */
  policy:
    | { id: string; name: string; version: number | null; policyVersionRowId: string | null }
    | { scope: 'all' };
  range: { start: string | null; end: string | null };
  totals: { count: number };
  decisionTally: DecisionTally;
  canonicalizationVersion: string;
  /** hex sha256（复用 canonicalHash，带 CANONICALIZATION_VERSION 前缀）。 */
  bundleHash: string;
  /** 收据来源与独立校验入口。 */
  receiptSource: { kind: 'aster-api-hash-chain'; verifier: 'GET /api/v1/audit/receipts' };
  /** 按 `${provider}/${model}` 计数；无 agent 计入 'unknown'。 */
  agentTally: Record<string, number>;
  reviewerTally: Record<Reviewer['source'], number>;
  /** 无证据关联 id（receipt=legacy）的条目数。 */
  legacyEntries: number;
  notes: {
    /** 缺 canonical 哈希的 legacy 行数（导出覆盖缺口，供审计方知情——绝不伪造哈希）。 */
    legacyRowsWithoutHashes: number;
    /** 收据取不到（超时/网络/非 2xx）的条目数——导出仍完成，如实标注。 */
    receiptsUnavailable: number;
    /** aster-api 未找到收据的条目数。 */
    receiptsMissing: number;
    /** 校验 recipe：告诉审计方如何重算 bundleHash。 */
    verification: string;
  };
}

export interface EvidenceBundleV2 {
  manifest: EvidenceManifestV2;
  entries: EvidenceEntryV2[];
}

/** 已持久化的 manifest / bundle：读取侧须按 schemaVersion 收窄后再访问版本专有字段。 */
export type StoredEvidenceManifest = EvidenceManifestV1 | EvidenceManifestV2 | EvidenceManifest;
export type StoredEvidenceBundle = EvidenceBundleV1 | EvidenceBundleV2 | EvidenceBundle;

/** 预览（导出前给 UI 看规模，不含行体）。 */
export interface EvidencePreview {
  count: number;
  decisionTally: DecisionTally;
  /**
   * 哈希覆盖率：verifiable=有 canonical 哈希的条数（真可验证证据）；legacy=无哈希（早于 ADR 0030
   * 哈希采集接线的历史执行，导出会是 null 字段）。让用户看清这批里多少条真有证据。
   */
  coverage: { verifiable: number; legacy: number };
  /** 是否超过导出行数上限（超则不允许导出，提示用户缩小范围）。 */
  exceedsLimit: boolean;
  limit: number;
}

/** 导出请求参数。 */
export interface EvidenceExportRequest {
  /** undefined = 全部策略。 */
  policyId?: string;
  startDate?: Date;
  endDate?: Date;
  format: EvidenceFormat;
  /** 仅导有可验证哈希的执行（排除 legacy 无哈希行）。默认 false=导全部。 */
  verifiableOnly?: boolean;
}
