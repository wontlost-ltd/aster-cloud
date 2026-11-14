// 证据包 v6（ADR 0042 §12 D9 + ADR 0041 §11 D4 / §12 D3）：审批快照键、逐字段来源、执行收据。
// 纯函数单测，无 DB / 网络。fixture 收据形状取自 aster-api ReceiptLookupResponse（#518）。

import { describe, it, expect } from 'vitest';
import {
  buildEvidenceEntry,
  buildManifest,
  computeBundleHash,
  executionFor,
  guardInputSourcesFor,
  inputSourceFor,
  provenanceFor,
  type EvidenceRow,
} from '@/services/evidence/bundle';
import { CANONICALIZATION_VERSION } from '@/lib/canonical-json';
import { defaultControlRegistry, type ControlRegistryData } from '@/services/evidence/control-registry';
import { mapRegulatory } from '@/services/evidence/regulatory-mapping';
import type { ChainReceipt, ReceiptLookup } from '@/services/evidence/receipts-client';
import { guardApprovalReviewers, type Reviewer } from '@/services/evidence/reviewers';
import type { EvidenceEntry } from '@/services/evidence/types';

function row(over: Partial<EvidenceRow> = {}): EvidenceRow {
  return {
    id: 'exec-1', policyId: 'pol-1', policyVersion: 3, policyVersionRowId: 'pv-1', decision: 'require_approval',
    canonicalInputHash: 'in', canonicalOutputHash: 'out', traceHash: 'tr', canonicalizationVersion: CANONICALIZATION_VERSION,
    sourceToolchainId: 'tc-src', runtimeToolchainId: 'tc-run', replayabilityStatus: 'REPLAYABLE',
    replayabilityReasons: null, reasonCodes: null, source: 'api', durationMs: 5,
    createdAt: new Date('2026-11-14T00:00:00Z'), outcome: 'REQUIRE_APPROVAL', ruleId: 'R-1',
    controls: ['EU_AI_ACT:ART14'], agent: null, evidenceCorrelationId: 'c-1', policyTenantId: 'team-1',
    policyOwnerId: 'owner-1', guardDecisionId: 'gd-1', profile: null, ...over,
  };
}

function emptyLookup(): ReceiptLookup {
  return {
    receipts: new Map(), approvals: new Map(), consumes: new Map(), results: new Map(),
    missing: new Set(), unavailable: new Set(),
  };
}

function receipt(metadata: Record<string, unknown>, over: Partial<ChainReceipt> = {}): ChainReceipt {
  return {
    auditId: 100, currentHash: 'h100', prevHash: 'h99', hashVersion: 2, eventType: 'ACTION_GUARD_DECISION',
    timestamp: '2026-11-14T00:00:00Z', metadata, authoritativeConsumeAuditId: null, ...over,
  };
}

/** 一条真实形状的决策收据 metadata（链上已按字典序写列表）。 */
const DECISION_META = {
  decisionId: 'gd-1',
  outcome: 'REQUIRE_APPROVAL',
  verifiedFields: ['context.applicant.id', 'context.applicant.income'],
  factIssuers: ['aster-cloud#k1'],
  factSources: ['context.applicant.id=hmac.userId', 'context.applicant.income=fixture.creditPilot'],
  inputSourcesTruncated: true,
};

function guardReviewer(over: Partial<Reviewer> = {}): Reviewer {
  return {
    userId: 'u-officer', role: 'Credit Officer', source: 'guard-approval', outcome: 'APPROVED',
    decidedAt: '2026-11-14T01:00:00Z', ref: '200', roleVerified: true,
    inputSnapshotHash: 'a'.repeat(64), inputSnapshotMatched: true, inputRevealed: true, inputStatus: 'available',
    ...over,
  };
}

function proofReviewer(): Reviewer {
  return {
    userId: 'u-eng', role: 'engineer', source: 'policy-proof', outcome: 'VERIFIED', decidedAt: '2026-11-13T00:00:00Z',
    ref: 'p-1', roleVerified: true, inputSnapshotHash: null, inputSnapshotMatched: null, inputRevealed: null,
    inputStatus: null,
  };
}

const LEGACY = { status: 'legacy' } as const;
const policy = { id: 'pol-1', name: 'Loan', version: 3, policyVersionRowId: null };
const range = { start: null, end: null };
const gen = new Date('2026-11-14T02:00:00Z');

describe('guardInputSources（ADR 0041 §11 D4 + ADR 0042 §12 D9）', () => {
  it('★v6EntryHasGuardInputSourcesWithFactSourcesVerbatim：factSources 与链上收据逐字相等', () => {
    const guard = emptyLookup();
    guard.receipts.set('gd-1', receipt(DECISION_META));
    const s = guardInputSourcesFor(row(), guard)!;
    expect(s).toEqual({
      verified: ['context.applicant.id', 'context.applicant.income'],
      factIssuers: ['aster-cloud#k1'],
      factSources: ['context.applicant.id=hmac.userId', 'context.applicant.income=fixture.creditPilot'],
      truncated: true,
    });
    expect(s.factSources).toEqual(DECISION_META.factSources);
  });

  it('链上列表若非字典序，按码点序排列但不改写任何元素', () => {
    const guard = emptyLookup();
    guard.receipts.set('gd-1', receipt({ factSources: ['z.b=s2', 'a.b=s1'], unverifiedFields: ['context.x'] }));
    expect(guardInputSourcesFor(row(), guard)).toEqual({
      verified: [], factIssuers: [], factSources: ['a.b=s1', 'z.b=s2'], unverifiedFields: ['context.x'],
    });
  });

  it('无 guardDecisionId、决策收据缺失或不可用 → null；非字符串元素丢弃', () => {
    const guard = emptyLookup();
    expect(guardInputSourcesFor(row({ guardDecisionId: null }), guard)).toBeNull();
    expect(guardInputSourcesFor(row(), guard)).toBeNull();
    guard.receipts.set('gd-1', receipt({ verifiedFields: ['context.a', 7, null], factSources: 'nope' }));
    expect(guardInputSourcesFor(row(), guard)).toEqual({ verified: ['context.a'], factIssuers: [], factSources: [] });
  });
});

describe('inputSource（ADR 0041 §11 D2/D4）', () => {
  it('取评估事件 inputSource', () => {
    const l = emptyLookup();
    l.receipts.set('c-1', receipt({ inputSource: 'declared' }, { eventType: 'POLICY_EVALUATION' }));
    l.receipts.set('c-2', receipt({ inputSource: 'mixed' }, { eventType: 'POLICY_EVALUATION' }));
    expect(inputSourceFor(row(), l)).toBe('declared');
    expect(inputSourceFor(row({ evidenceCorrelationId: 'c-2' }), l)).toBe('mixed');
  });

  it('★legacyEventIsLegacyInputSource：旧事件无键、未知值、无关联 id、收据取不到 → legacy', () => {
    const l = emptyLookup();
    l.receipts.set('c-1', receipt({}, { eventType: 'POLICY_EVALUATION' }));
    l.receipts.set('c-3', receipt({ inputSource: 'signed' }, { eventType: 'POLICY_EVALUATION' }));
    l.unavailable.add('c-2');
    expect(inputSourceFor(row(), l)).toBe('legacy');
    expect(inputSourceFor(row({ evidenceCorrelationId: 'c-3' }), l)).toBe('legacy');
    expect(inputSourceFor(row({ evidenceCorrelationId: null }), l)).toBe('legacy');
    expect(inputSourceFor(row({ evidenceCorrelationId: 'c-2' }), l)).toBe('legacy');
  });
});

describe('execution（ADR 0041 §12 D3）', () => {
  it('权威尝试 + 权威结果 → consumed、执行方、attempt、结果状态与 consumeAuditId', () => {
    const guard = emptyLookup();
    guard.receipts.set('gd-1', receipt(DECISION_META, { authoritativeConsumeAuditId: 301 }));
    guard.consumes.set('gd-1', [
      { auditId: 300, currentHash: 'h300', decisionId: 'gd-1', authoritative: false, attemptId: 'att-0', executorId: 'mcp@a', outcome: 'rejected:receipt_consumed' },
      { auditId: 301, currentHash: 'h301', decisionId: 'gd-1', authoritative: true, attemptId: 'att-1', executorId: 'mcp@b', outcome: 'consumed' },
    ]);
    guard.results.set('gd-1', [
      { auditId: 310, currentHash: 'h310', decisionId: 'gd-1', authoritative: true, attemptId: 'att-1', executorId: 'mcp@b', status: 'failed' },
    ]);
    expect(executionFor(row(), guard)).toEqual({
      consumed: true, executorId: 'mcp@b', attemptId: 'att-1', resultStatus: 'failed', consumeAuditId: 301,
    });
  });

  it('已消耗无结果事件 → resultStatus null；未知结果状态 → null', () => {
    const guard = emptyLookup();
    guard.receipts.set('gd-1', receipt(DECISION_META, { authoritativeConsumeAuditId: 301 }));
    guard.consumes.set('gd-1', [
      { auditId: 301, currentHash: 'h301', decisionId: 'gd-1', authoritative: true, attemptId: null, executorId: null, outcome: 'crashed-unknown' },
    ]);
    expect(executionFor(row(), guard)).toEqual({ consumed: true, resultStatus: null, consumeAuditId: 301 });
    guard.results.set('gd-1', [
      { auditId: 310, currentHash: 'h310', decisionId: 'gd-1', authoritative: true, attemptId: null, executorId: null, status: 'weird' },
    ]);
    expect(executionFor(row(), guard)?.resultStatus).toBeNull();
  });

  it('未消耗 → { consumed: false }；无决策 / 无收据 → null', () => {
    const guard = emptyLookup();
    expect(executionFor(row({ guardDecisionId: null }), guard)).toBeNull();
    expect(executionFor(row(), guard)).toBeNull();
    guard.receipts.set('gd-1', receipt(DECISION_META));
    expect(executionFor(row(), guard)).toEqual({ consumed: false });
  });
});

describe('Reviewer 四字段（ADR 0042 §12 D9）', () => {
  it('★reviewerSnapshotFieldsFromApprovals：guard-approval 取收据 approvals[] 的值', () => {
    const [r] = guardApprovalReviewers([{
      auditId: 200, decisionId: 'gd-1', outcome: 'APPROVED', decidedBy: 'u-officer', requiredRole: 'Credit Officer',
      comment: null, decidedAt: '2026-11-14T01:00:00Z', currentHash: 'h200', decisionReceiptHash: 'h100',
      inputSnapshotHash: 'b'.repeat(64), inputSnapshotMatched: true, inputRevealed: false, inputStatus: 'available',
    }]);
    expect(r).toMatchObject({
      inputSnapshotHash: 'b'.repeat(64), inputSnapshotMatched: true, inputRevealed: false, inputStatus: 'available',
    });
  });

  it('旧 api / 过期事件无四键 → 全部 null，不报错', () => {
    const [r] = guardApprovalReviewers([{
      auditId: 201, decisionId: 'gd-1', outcome: 'EXPIRED', decidedBy: null, requiredRole: null, comment: null,
      decidedAt: '2026-11-14T01:00:00Z', currentHash: 'h201', decisionReceiptHash: null,
      inputSnapshotHash: null, inputSnapshotMatched: null, inputRevealed: null, inputStatus: null,
    }]);
    expect(r).toMatchObject({ inputSnapshotHash: null, inputSnapshotMatched: null, inputRevealed: null, inputStatus: null });
  });
});

describe('v6 条目与 bundleHash', () => {
  function fullLookups() {
    const lookup = emptyLookup();
    lookup.receipts.set('c-1', receipt({ inputSource: 'declared' }, { eventType: 'POLICY_EVALUATION', auditId: 90 }));
    const guard = emptyLookup();
    guard.receipts.set('gd-1', receipt(DECISION_META, { authoritativeConsumeAuditId: 301 }));
    guard.consumes.set('gd-1', [
      { auditId: 301, currentHash: 'h301', decisionId: 'gd-1', authoritative: true, attemptId: 'att-1', executorId: 'mcp@b', outcome: 'consumed' },
    ]);
    guard.results.set('gd-1', [
      { auditId: 310, currentHash: 'h310', decisionId: 'gd-1', authoritative: true, attemptId: 'att-1', executorId: 'mcp@b', status: 'executed' },
    ]);
    return { lookup, guard };
  }

  it('provenanceFor 一次给出三项，条目带上', () => {
    const { lookup, guard } = fullLookups();
    const e = buildEvidenceEntry(row(), LEGACY, [], null, provenanceFor(row(), lookup, guard));
    expect(e.inputSource).toBe('declared');
    expect(e.guardInputSources?.factSources).toEqual(DECISION_META.factSources);
    expect(e.execution).toEqual({ consumed: true, executorId: 'mcp@b', attemptId: 'att-1', resultStatus: 'executed', consumeAuditId: 301 });
    expect(e).not.toHaveProperty('reveals');
    expect(JSON.stringify(e)).not.toContain('"input"');
  });

  it('★bundleHashCoversNewEntryFields：改 inputSource / guardInputSources / execution / reviewer 四字段任一 → 哈希变', () => {
    const { lookup, guard } = fullLookups();
    const prov = provenanceFor(row(), lookup, guard);
    const base = computeBundleHash([buildEvidenceEntry(row(), LEGACY, [guardReviewer()], null, prov)]);
    const variants: EvidenceEntry[] = [
      buildEvidenceEntry(row(), LEGACY, [guardReviewer()], null, { ...prov, inputSource: 'legacy' }),
      buildEvidenceEntry(row(), LEGACY, [guardReviewer()], null, {
        ...prov, guardInputSources: { ...prov.guardInputSources!, factSources: ['context.applicant.id=other'] },
      }),
      buildEvidenceEntry(row(), LEGACY, [guardReviewer()], null, { ...prov, execution: { consumed: false } }),
      buildEvidenceEntry(row(), LEGACY, [guardReviewer({ inputSnapshotHash: 'c'.repeat(64) })], null, prov),
      buildEvidenceEntry(row(), LEGACY, [guardReviewer({ inputSnapshotMatched: false })], null, prov),
      buildEvidenceEntry(row(), LEGACY, [guardReviewer({ inputRevealed: false })], null, prov),
      buildEvidenceEntry(row(), LEGACY, [guardReviewer({ inputStatus: 'purged' })], null, prov),
    ];
    for (const v of variants) expect(computeBundleHash([v])).not.toBe(base);
  });

  it('缺省 provenance：inputSource=legacy、guardInputSources=null、execution=null', () => {
    const e = buildEvidenceEntry(row(), LEGACY, []);
    expect(e).toMatchObject({ inputSource: 'legacy', guardInputSources: null, execution: null });
  });
});

describe('v6 manifest', () => {
  const prov = (over: Partial<Pick<EvidenceEntry, 'inputSource' | 'guardInputSources' | 'execution'>>) => ({
    inputSource: 'declared' as const, guardInputSources: null, execution: null, ...over,
  });
  const entries = [
    buildEvidenceEntry(row({ id: 'a', outcome: 'ALLOW' }), LEGACY, [], null, prov({ execution: { consumed: false } })),
    buildEvidenceEntry(row({ id: 'b', outcome: 'REQUIRE_APPROVAL' }), LEGACY,
      [guardReviewer({ ref: '1' }), guardReviewer({ ref: '2', inputSnapshotMatched: false, inputRevealed: false })], null,
      prov({ execution: { consumed: true, resultStatus: 'executed', consumeAuditId: 1 }, guardInputSources: { verified: ['context.a'], factIssuers: [], factSources: [] } })),
    buildEvidenceEntry(row({ id: 'c', outcome: 'REQUIRE_APPROVAL' }), LEGACY,
      [guardReviewer({ ref: '3', outcome: 'APPROVED', inputStatus: 'purged', inputSnapshotHash: null, inputSnapshotMatched: false }),
        guardReviewer({ ref: '4', inputSnapshotHash: null, inputSnapshotMatched: null, inputRevealed: null, inputStatus: null }),
        proofReviewer()], null,
      prov({ inputSource: 'mixed', execution: { consumed: false }, guardInputSources: { verified: [], factIssuers: [], factSources: [] } })),
    buildEvidenceEntry(row({ id: 'd', outcome: 'ESCALATE' }), LEGACY, [], null,
      prov({ inputSource: 'legacy', execution: { consumed: true, resultStatus: 'failed', consumeAuditId: 2 } })),
    buildEvidenceEntry(row({ id: 'e', outcome: 'REQUIRE_APPROVAL' }), LEGACY, [], null,
      prov({ execution: { consumed: true, resultStatus: 'aborted', consumeAuditId: 3 } })),
  ];
  const m = buildManifest({ policy, range, entries, generatedAt: gen });

  it('schemaVersion 6', () => {
    expect(m.schemaVersion).toBe('6');
  });

  it('inputSourceTally 与 verifiedInputsUsed', () => {
    expect(m.inputSourceTally).toEqual({ declared: 3, mixed: 1, legacy: 1 });
    expect(m.verifiedInputsUsed).toBe(1);
  });

  it('★unconsumedAllowCounted：ALLOW 且 consumed=false 计入 unconsumedAllow；已批准而未消耗同计', () => {
    expect(m.executionTally).toEqual({ consumed: 3, unconsumedAllow: 2, executed: 1, failed: 1, aborted: 1 });
  });

  it('inputSnapshotTally 按 guard-approval 复核者计数：status≠available 或缺键记 unavailable', () => {
    expect(m.inputSnapshotTally).toEqual({ matched: 1, unmatched: 1, unavailable: 2 });
  });

  it('★manifestTalliesNotInBundleHash：manifest 计数不进 bundleHash', () => {
    expect(m.bundleHash).toBe(computeBundleHash(entries));
  });

  it('notes.verification 为 v6 配方', () => {
    expect(m.notes.verification).toContain('schemaVersion 6 entries');
    expect(m.notes.verification).toContain('inputSource/guardInputSources/execution');
    expect(m.notes.verification).toContain('GET /api/v1/audit/receipts?decisionIds=');
  });

  it('空 entries：四个 tally 全零', () => {
    const empty = buildManifest({ policy, range, entries: [], generatedAt: gen });
    expect(empty.inputSourceTally).toEqual({ declared: 0, mixed: 0, legacy: 0 });
    expect(empty.verifiedInputsUsed).toBe(0);
    expect(empty.executionTally).toEqual({ consumed: 0, unconsumedAllow: 0, executed: 0, failed: 0, aborted: 0 });
    expect(empty.inputSnapshotTally).toEqual({ matched: 0, unmatched: 0, unavailable: 0 });
  });
});

describe('证据来源 reviewers.guard.inputSnapshot（ADR 0042 §12 D9 Article 14）', () => {
  const entry = (id: string, reviewers: Reviewer[]) =>
    buildEvidenceEntry(row({ id, outcome: 'REQUIRE_APPROVAL' }), LEGACY, reviewers);
  // 注入一份把 14(4)(a) 改判到新来源的注册表，单测新来源本身的判定
  const withSource: ControlRegistryData = {
    ...defaultControlRegistry,
    clauses: defaultControlRegistry.clauses.map((cl) =>
      cl.control === 'EU_AI_ACT:ART14' && cl.clause === '14(4)(a)'
        ? { ...cl, evidenced: ['reviewers.guard.inputSnapshot'], partial: ['whatIf.comparable'] }
        : cl),
  };
  const clause = (entries: EvidenceEntry[], registry?: ControlRegistryData) =>
    mapRegulatory(entries, registry).frameworks.find((f) => f.control === 'EU_AI_ACT:ART14')!
      .clauses.find((c) => c.clause === '14(4)(a)')!;

  it('★inputSnapshotSourceRequiresMatchedAndAvailable：matched=false 或 status≠available 不计', () => {
    expect(clause([entry('a', [guardReviewer()])], withSource)).toMatchObject({
      status: 'evidenced', evidence: [{ executionId: 'a', field: 'reviewers' }],
    });
    expect(clause([entry('b', [guardReviewer({ inputSnapshotMatched: false })])], withSource).status).toBe('none');
    expect(clause([entry('c', [guardReviewer({ inputStatus: 'purged' })])], withSource).status).toBe('none');
    expect(clause([entry('d', [guardReviewer({ inputSnapshotMatched: null, inputStatus: null })])], withSource).status).toBe('none');
    expect(clause([entry('e', [guardReviewer({ roleVerified: false })])], withSource).status).toBe('none');
    expect(clause([entry('f', [{ ...guardReviewer(), source: 'policy-proof' }])], withSource).status).toBe('none');
  });

  it('★registryWithoutNewSourceKeepsArticle14Unchanged：默认注册表下 14(4)(a) 仍按 whatIf 判定', () => {
    const def = defaultControlRegistry.clauses.find((cl) => cl.control === 'EU_AI_ACT:ART14' && cl.clause === '14(4)(a)')!;
    expect(def.evidenced).toEqual([]);
    expect(def.partial).toEqual(['whatIf.comparable']);
    expect(clause([entry('a', [guardReviewer()])]).status).toBe('none');
    const wi = { batchId: 'b', baseOutcome: 'REQUIRE_APPROVAL', targetOutcome: 'ALLOW', baseLegacy: false };
    const withWhatIf = buildEvidenceEntry(row({ id: 'w' }), LEGACY, [guardReviewer()], wi);
    expect(clause([withWhatIf])).toMatchObject({ status: 'partial', evidence: [{ executionId: 'w', field: 'whatIf' }] });
  });
});
