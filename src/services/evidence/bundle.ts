// 证据包组装（纯函数，无 I/O）。
//
// 纯度纪律镜像 canonical-json.ts：所有函数只做数据变换，无 DB/时钟/随机——便于确定性单测。
// bundleHash 复用 canonicalHash（sha256 + CANONICALIZATION_VERSION 前缀），蹭已验证的 canonical 基建，
// 让审计方能用同一规则跨实现重算校验。

import { canonicalHash, CANONICALIZATION_VERSION } from '@/lib/canonical-json';
import type { ReceiptLookup } from './receipts-client';
import type { Reviewer } from './reviewers';
import type {
  DecisionTally,
  EvidenceAgent,
  EvidenceBundle,
  EvidenceDecision,
  EvidenceEntry,
  EvidenceFormat,
  EvidenceManifest,
  ReceiptRef,
} from './types';

/** 从执行行装配证据条目所需的最小投影（由查询层提供，见 lib/evidence-export.ts）。 */
export interface EvidenceRow {
  id: string;
  policyId: string;
  policyVersion: number | null;
  policyVersionRowId: string | null;
  decision: EvidenceDecision | null;
  canonicalInputHash: string | null;
  canonicalOutputHash: string | null;
  traceHash: string | null;
  canonicalizationVersion: string | null;
  sourceToolchainId: string | null;
  runtimeToolchainId: string | null;
  replayabilityStatus: string | null;
  replayabilityReasons: unknown;
  reasonCodes: unknown;
  source: EvidenceEntry['source'];
  durationMs: number;
  createdAt: Date;
  outcome: string | null;
  ruleId: string | null;
  controls: string[] | null;
  agent: EvidenceAgent | null;
  evidenceCorrelationId: string | null;
  /** 收据查询的租户（策略 teamId ?? userId）。只用于查询，不进 entry。 */
  policyTenantId: string;
  /** metadata.guardDecisionId；无则 null。只用于取 guard 审批，不进 entry。 */
  guardDecisionId: string | null;
}

/** 按行的证据关联 id 在收据查找结果中定位：无 id → legacy；取失败 → unavailable；未命中 → missing。 */
export function receiptFor(row: Pick<EvidenceRow, 'evidenceCorrelationId'>, lookup: ReceiptLookup): ReceiptRef {
  const cid = row.evidenceCorrelationId;
  if (cid == null) return { status: 'legacy' };
  if (lookup.unavailable.has(cid)) return { status: 'unavailable' };
  const r = lookup.receipts.get(cid);
  if (!r) return { status: 'missing' };
  return { auditId: r.auditId, currentHash: r.currentHash, prevHash: r.prevHash, hashVersion: r.hashVersion };
}

function compareReviewers(a: Reviewer, b: Reviewer): number {
  return a.decidedAt.localeCompare(b.decidedAt) || a.ref.localeCompare(b.ref);
}

export function buildEvidenceEntry(row: EvidenceRow, receipt: ReceiptRef, reviewers: Reviewer[]): EvidenceEntry {
  return {
    executionId: row.id,
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    policyVersionRowId: row.policyVersionRowId,
    decision: row.decision,
    canonicalInputHash: row.canonicalInputHash,
    canonicalOutputHash: row.canonicalOutputHash,
    traceHash: row.traceHash,
    canonicalizationVersion: row.canonicalizationVersion,
    toolchain: { source: row.sourceToolchainId, runtime: row.runtimeToolchainId },
    replayabilityStatus: row.replayabilityStatus,
    replayabilityReasons: row.replayabilityReasons ?? null,
    reasonCodes: row.reasonCodes ?? null,
    source: row.source,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    outcome: row.outcome,
    ruleId: row.ruleId,
    controls: row.controls ?? null,
    agent: row.agent ?? null,
    evidenceCorrelationId: row.evidenceCorrelationId,
    receipt,
    reviewers: [...reviewers].sort(compareReviewers),
  };
}

export const EMPTY_TALLY: DecisionTally = {
  approved: 0,
  denied: 0,
  indeterminate: 0,
  error: 0,
  require_approval: 0,
  escalate: 0,
  unknown: 0,
};

/** 按 `${provider}/${model}` 统计 agent；无 agent 计入 'unknown'。 */
export function tallyAgents(entries: readonly EvidenceEntry[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const e of entries) {
    const key = e.agent ? `${e.agent.provider}/${e.agent.model}` : 'unknown';
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
}

/** 按来源统计复核者条数（三来源恒出现，缺省为 0）。 */
export function tallyReviewers(entries: readonly EvidenceEntry[]): Record<Reviewer['source'], number> {
  const tally: Record<Reviewer['source'], number> = { 'guard-approval': 0, 'policy-proof': 0, 'version-approval': 0 };
  for (const e of entries) {
    for (const r of e.reviewers) tally[r.source] += 1;
  }
  return tally;
}

function countReceiptStatus(entries: readonly EvidenceEntry[], status: 'missing' | 'legacy' | 'unavailable'): number {
  return entries.filter((e) => 'status' in e.receipt && e.receipt.status === status).length;
}

const VERIFICATION_RECIPE =
  'bundleHash = canonicalHash(entries sorted by [createdAt, executionId]) over schemaVersion 2 entries ' +
  '(includes outcome/ruleId/controls/agent/receipt/reviewers); receipts verifiable via GET /api/v1/audit/receipts; ' +
  'v1 bundles use their own recipe.';

/** 统计 decision 分布；decision=null（legacy）计入 unknown 桶。 */
export function tallyDecisions(entries: readonly { decision: EvidenceDecision | null }[]): DecisionTally {
  const tally: DecisionTally = { ...EMPTY_TALLY };
  for (const e of entries) {
    const key: keyof DecisionTally = e.decision ?? 'unknown';
    tally[key] += 1;
  }
  return tally;
}

/**
 * 排序 entries：按 (createdAt, executionId) 升序——bundleHash 确定性的前提（同一批数据任意输入序 → 同 hash）。
 * 返回新数组，不改入参。
 */
export function sortEntries(entries: readonly EvidenceEntry[]): EvidenceEntry[] {
  return [...entries].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0;
  });
}

/**
 * 计算 bundleHash：对**有序 entries** 的 canonicalHash（不含 manifest，避免自引用）。
 * 入参会被先排序，保证与输入顺序无关。
 */
export function computeBundleHash(entries: readonly EvidenceEntry[]): string {
  return canonicalHash(sortEntries(entries) as unknown[]);
}

export interface BuildManifestInput {
  policy: EvidenceManifest['policy'];
  range: { start: Date | null; end: Date | null };
  entries: EvidenceEntry[];
  generatedAt: Date;
}

export function buildManifest(input: BuildManifestInput): EvidenceManifest {
  const sorted = sortEntries(input.entries);
  const legacyRowsWithoutHashes = sorted.filter(
    (e) => e.canonicalInputHash == null && e.canonicalOutputHash == null,
  ).length;
  return {
    kind: 'evidence-export',
    schemaVersion: '2',
    generatedAt: input.generatedAt.toISOString(),
    policy: input.policy,
    range: {
      start: input.range.start ? input.range.start.toISOString() : null,
      end: input.range.end ? input.range.end.toISOString() : null,
    },
    totals: { count: sorted.length },
    decisionTally: tallyDecisions(sorted),
    canonicalizationVersion: CANONICALIZATION_VERSION,
    bundleHash: computeBundleHash(sorted),
    receiptSource: { kind: 'aster-api-hash-chain', verifier: 'GET /api/v1/audit/receipts' },
    agentTally: tallyAgents(sorted),
    reviewerTally: tallyReviewers(sorted),
    legacyEntries: countReceiptStatus(sorted, 'legacy'),
    notes: {
      legacyRowsWithoutHashes,
      receiptsUnavailable: countReceiptStatus(sorted, 'unavailable'),
      receiptsMissing: countReceiptStatus(sorted, 'missing'),
      verification: VERIFICATION_RECIPE,
    },
  };
}

/** 组装完整 bundle（manifest + 有序 entries）。 */
export function buildBundle(input: BuildManifestInput): EvidenceBundle {
  const entries = sortEntries(input.entries);
  return { manifest: buildManifest({ ...input, entries }), entries };
}

/**
 * 序列化 bundle：
 *   - json：pretty JSON（{ manifest, entries }）。
 *   - jsonl：每行一个 JSON 对象——首行 { _manifest }，其后每行一个 entry（流式友好）。
 */
export function serializeBundle(bundle: EvidenceBundle, format: EvidenceFormat): string {
  if (format === 'jsonl') {
    const lines = [JSON.stringify({ _manifest: bundle.manifest })];
    for (const e of bundle.entries) lines.push(JSON.stringify(e));
    return lines.join('\n') + '\n';
  }
  return JSON.stringify(bundle, null, 2);
}
