// 证据包组装（纯函数，无 I/O）。
//
// 纯度纪律镜像 canonical-json.ts：所有函数只做数据变换，无 DB/时钟/随机——便于确定性单测。
// bundleHash 复用 canonicalHash（sha256 + CANONICALIZATION_VERSION 前缀），蹭已验证的 canonical 基建，
// 让审计方能用同一规则跨实现重算校验。

import { canonicalHash, CANONICALIZATION_VERSION } from '@/lib/canonical-json';
import { defaultControlRegistry, profileTitle, type ControlRegistryData } from './control-registry';
import type { ReceiptLookup } from './receipts-client';
import { mapRegulatory } from './regulatory-mapping';
import type { Reviewer } from './reviewers';
import type {
  DecisionTally,
  EvidenceAgent,
  EvidenceBundle,
  EvidenceDecision,
  EvidenceEntry,
  EvidenceExecution,
  EvidenceFormat,
  EvidenceInputSource,
  EvidenceManifest,
  EvidenceWhatIf,
  ExecutionResultStatus,
  GuardInputSources,
  ProfileUsed,
  ReceiptRef,
  StoredEvidenceBundle,
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
  /** 收据查询的租户（policyTenantId：策略 teamId || userId）。只用于查询，不进 entry。 */
  policyTenantId: string;
  /** 策略所有者 userId，What-If 批次的租户口径（ADR 0034 §4.3）。只用于查询，不进 entry。 */
  policyOwnerId: string;
  /** metadata.guardDecisionId；无则 null。只用于取 guard 审批，不进 entry。 */
  guardDecisionId: string | null;
  /** 模块声明的治理档案 id；旧行或未声明为 null。 */
  profile: string | null;
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

/** 按码点比较（与 sortEntries 一致，不依赖 ICU/区域设置，非 JS 校验方可复现）。 */
function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareReviewers(a: Reviewer, b: Reviewer): number {
  return compareCodePoints(a.decidedAt, b.decidedAt) || compareCodePoints(a.ref, b.ref);
}

/** v6 条目从链收据派生的三项（ADR 0042 §12 D9）。 */
export type EntryProvenance = Pick<EvidenceEntry, 'inputSource' | 'guardInputSources' | 'execution'>;

/** 无收据可依时的三项：评估来源记 legacy，guard 来源与执行收据为 null。 */
export const NO_PROVENANCE: EntryProvenance = { inputSource: 'legacy', guardInputSources: null, execution: null };

/**
 * 评估输入来源（ADR 0041 §11 D2/D4）：取该行评估事件收据的 metadata.inputSource。
 * 旧事件无键、无关联 id、收据缺失或取不到、或值不在已知集合内 → legacy（收据状态由 entry.receipt 另行如实标注）。
 */
export function inputSourceFor(row: Pick<EvidenceRow, 'evidenceCorrelationId'>, lookup: ReceiptLookup): EvidenceInputSource {
  const cid = row.evidenceCorrelationId;
  const value = cid == null ? undefined : lookup.receipts.get(cid)?.metadata.inputSource;
  return value === 'declared' || value === 'mixed' ? value : 'legacy';
}

/**
 * metadata 中的字符串列表，按码点序排列（链上已是字典序，排序只是兜底，不改写元素）。
 * 类型已由收据客户端校验（错类型整批 unavailable）；此处的过滤只防御直接构造的查找结果。
 */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').sort(compareCodePoints);
}

/**
 * guard 决策的逐字段来源（ADR 0041 §11 D1/D4、ADR 0042 §12 D9）：取决策收据 metadata 的
 * verifiedFields / factIssuers / factSources / unverifiedFields / inputSourcesTruncated。
 * factSources 元素原样保留，审计方可与收据接口逐字核对。无 guard 决策或决策收据取不到 → null；
 * 链上旧行 metadata 无法解析（收据接口以 `_raw` 原文返回）→ null，不把「读不出」说成「没有来源」。
 */
export function guardInputSourcesFor(
  row: Pick<EvidenceRow, 'guardDecisionId'>,
  guardLookup: ReceiptLookup,
): GuardInputSources | null {
  const did = row.guardDecisionId;
  const metadata = did == null ? undefined : guardLookup.receipts.get(did)?.metadata;
  if (!metadata || Object.hasOwn(metadata, '_raw')) return null;
  return {
    verified: stringList(metadata.verifiedFields),
    factIssuers: stringList(metadata.factIssuers),
    factSources: stringList(metadata.factSources),
    ...(Array.isArray(metadata.unverifiedFields) ? { unverifiedFields: stringList(metadata.unverifiedFields) } : {}),
    ...(metadata.inputSourcesTruncated === true ? { truncated: true } : {}),
  };
}

const RESULT_STATUSES: ReadonlySet<unknown> = new Set<ExecutionResultStatus>(['executed', 'failed', 'aborted']);

/**
 * guard 执行收据状态（ADR 0041 §12 D3）。读法遵循 §12 D1：有效消耗只认决策收据的
 * authoritativeConsumeAuditId（guard_receipts.consume_audit_id），不数尝试事件、不看 success；
 * executorId / attemptId 取该权威尝试事件，resultStatus 取 authoritative 结果事件（无或未知状态 → null）。
 * 无 guard 决策或决策收据取不到 → null。旧 api 不返回 authoritativeConsumeAuditId，此时记为未消耗。
 */
export function executionFor(
  row: Pick<EvidenceRow, 'guardDecisionId'>,
  guardLookup: ReceiptLookup,
): EvidenceExecution | null {
  const did = row.guardDecisionId;
  const receipt = did == null ? undefined : guardLookup.receipts.get(did);
  if (did == null || !receipt) return null;
  const consumeAuditId = receipt.authoritativeConsumeAuditId;
  if (consumeAuditId === null) return { consumed: false };
  const attempt = (guardLookup.consumes.get(did) ?? []).find((c) => c.auditId === consumeAuditId);
  const result = (guardLookup.results.get(did) ?? []).find((r) => r.authoritative);
  const status = result?.status;
  return {
    consumed: true,
    ...(attempt?.executorId ? { executorId: attempt.executorId } : {}),
    ...(attempt?.attemptId ? { attemptId: attempt.attemptId } : {}),
    resultStatus: RESULT_STATUSES.has(status) ? (status as ExecutionResultStatus) : null,
    consumeAuditId,
  };
}

/** 一行的 v6 三项：评估来源取评估收据查找，guard 来源与执行收据取决策收据查找。 */
export function provenanceFor(row: EvidenceRow, lookup: ReceiptLookup, guardLookup: ReceiptLookup): EntryProvenance {
  return {
    inputSource: inputSourceFor(row, lookup),
    guardInputSources: guardInputSourcesFor(row, guardLookup),
    execution: executionFor(row, guardLookup),
  };
}

export function buildEvidenceEntry(
  row: EvidenceRow,
  receipt: ReceiptRef,
  reviewers: Reviewer[],
  whatIf: EvidenceWhatIf | null = null,
  provenance: EntryProvenance = NO_PROVENANCE,
): EvidenceEntry {
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
    whatIf,
    profile: row.profile,
    inputSource: provenance.inputSource,
    guardInputSources: provenance.guardInputSources,
    execution: provenance.execution,
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

/** 按条目 inputSource 计数（三桶恒出现）。 */
export function tallyInputSources(entries: readonly EvidenceEntry[]): Record<EvidenceInputSource, number> {
  const tally: Record<EvidenceInputSource, number> = { declared: 0, mixed: 0, legacy: 0 };
  for (const e of entries) tally[e.inputSource] += 1;
  return tally;
}

/**
 * 决策可执行 = 对 Agent 的 effectiveOutcome 为 ALLOW：结论本身为 ALLOW，或 guard 审批 APPROVED
 * （aster-api GuardApprovalStatus.APPROVED 的 effectiveOutcome 即 ALLOW，批准后才可消耗）。
 * cloud 只为 REQUIRE_APPROVAL / ESCALATE 登记 guard 决策，若只认结论 ALLOW，此计数在 cloud 恒为 0。
 */
function isExecutable(e: EvidenceEntry): boolean {
  return e.outcome === 'ALLOW' || e.reviewers.some((r) => r.source === 'guard-approval' && r.outcome === 'APPROVED');
}

/** 执行收据计数（ADR 0041 §12 D3）。 */
export function tallyExecution(entries: readonly EvidenceEntry[]): EvidenceManifest['executionTally'] {
  const tally = { consumed: 0, unconsumedAllow: 0, executed: 0, failed: 0, aborted: 0 };
  for (const e of entries) {
    if (e.execution === null) continue;
    if (e.execution.consumed) tally.consumed += 1;
    else if (isExecutable(e)) tally.unconsumedAllow += 1;
    if (e.execution.resultStatus) tally[e.execution.resultStatus] += 1;
  }
  return tally;
}

/** 按 guard-approval 复核者计审批快照（ADR 0042 §12 D9）；判定口径与证据来源 reviewers.guard.inputSnapshot 一致。 */
export function tallyInputSnapshots(entries: readonly EvidenceEntry[]): EvidenceManifest['inputSnapshotTally'] {
  const tally = { matched: 0, unmatched: 0, unavailable: 0 };
  for (const r of entries.flatMap((e) => e.reviewers)) {
    if (r.source !== 'guard-approval') continue;
    if (r.inputStatus !== 'available') tally.unavailable += 1;
    else if (r.inputSnapshotMatched === true) tally.matched += 1;
    else tally.unmatched += 1;
  }
  return tally;
}

function countReceiptStatus(entries: readonly EvidenceEntry[], status: 'missing' | 'legacy' | 'unavailable'): number {
  return entries.filter((e) => 'status' in e.receipt && e.receipt.status === status).length;
}

const VERIFICATION_RECIPE =
  'bundleHash = canonicalHash(entries sorted by [createdAt, executionId]) over schemaVersion 6 entries ' +
  '(includes outcome/ruleId/controls/agent/receipt/reviewers (with inputSnapshotHash/inputSnapshotMatched/inputRevealed/inputStatus)/' +
  'whatIf/profile/inputSource/guardInputSources/execution); manifest tallies are not hashed; ' +
  'receipts verifiable via GET /api/v1/audit/receipts, guard decision receipts (factSources verbatim), approvals and ' +
  'consumes/results via GET /api/v1/audit/receipts?decisionIds=; earlier schemaVersions use the recipe stored in their own manifest.';

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

/**
 * 条目中出现过的档案 id 去重后，按注册表 profiles 顺序映射标题；
 * 注册表未登记的 id 排在已登记之后、按码点序，标题三语均为 id 本身。
 */
export function collectProfiles(
  entries: readonly EvidenceEntry[],
  registry: ControlRegistryData = defaultControlRegistry,
): ProfileUsed[] {
  const used = new Set(entries.flatMap((e) => (e.profile === null ? [] : [e.profile])));
  const known = registry.profiles.map((p) => p.id).filter((id) => used.has(id));
  const unknown = [...used].filter((id) => !known.includes(id)).sort(compareCodePoints);
  return [...known, ...unknown].map((id) => ({ id, title: profileTitle(id, registry) }));
}

export interface BuildManifestInput {
  policy: EvidenceManifest['policy'];
  range: { start: Date | null; end: Date | null };
  entries: EvidenceEntry[];
  generatedAt: Date;
  /** What-If 回放取不到的条目数；缺省 0。 */
  whatIfUnavailable?: number;
}

export function buildManifest(input: BuildManifestInput): EvidenceManifest {
  const policy = input.policy;
  const sorted = sortEntries(input.entries);
  const legacyRowsWithoutHashes = sorted.filter(
    (e) => e.canonicalInputHash == null && e.canonicalOutputHash == null,
  ).length;
  return {
    kind: 'evidence-export',
    schemaVersion: '6',
    generatedAt: input.generatedAt.toISOString(),
    policy: 'scope' in policy ? policy : {
      ...policy,
      version: sorted.reduce<number | null>((max, entry) => entry.policyVersion === null ? max : max === null ? entry.policyVersion : Math.max(max, entry.policyVersion), null),
    },
    ...('scope' in policy ? {} : { currentPolicyVersion: policy.version }),
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
    inputSourceTally: tallyInputSources(sorted),
    verifiedInputsUsed: sorted.filter((e) => (e.guardInputSources?.verified.length ?? 0) > 0).length,
    executionTally: tallyExecution(sorted),
    inputSnapshotTally: tallyInputSnapshots(sorted),
    legacyEntries: countReceiptStatus(sorted, 'legacy'),
    regulatoryMapping: mapRegulatory(sorted),
    profilesUsed: collectProfiles(sorted),
    notes: {
      legacyRowsWithoutHashes,
      receiptsUnavailable: countReceiptStatus(sorted, 'unavailable'),
      receiptsMissing: countReceiptStatus(sorted, 'missing'),
      whatIfUnavailable: input.whatIfUnavailable ?? 0,
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
export function serializeBundle(bundle: StoredEvidenceBundle, format: EvidenceFormat): string {
  if (format === 'jsonl') {
    const lines = [JSON.stringify({ _manifest: bundle.manifest })];
    for (const e of bundle.entries) lines.push(JSON.stringify(e));
    return lines.join('\n') + '\n';
  }
  return JSON.stringify(bundle, null, 2);
}
