// 证据包组装纯函数单测（无 DB）。重点：bundleHash 确定性——这是审计物防篡改的基石。

import { describe, it, expect } from 'vitest';
import {
  buildEvidenceEntry,
  buildBundle,
  buildManifest,
  computeBundleHash,
  receiptFor,
  serializeBundle,
  tallyAgents,
  tallyDecisions,
  tallyReviewers,
  type EvidenceRow,
} from '@/services/evidence/bundle';
import { canonicalHash, CANONICALIZATION_VERSION } from '@/lib/canonical-json';
import type { ReceiptLookup } from '@/services/evidence/receipts-client';
import type { Reviewer } from '@/services/evidence/reviewers';
import type { EvidenceEntry, EvidenceWhatIf, ReceiptRef } from '@/services/evidence/types';

function row(over: Partial<EvidenceRow> = {}): EvidenceRow {
  // 用 'key' in over 区分「未传」与「显式 null」——?? 会把显式 null 折叠成默认值（本测试早期 bug）。
  return {
    id: over.id ?? 'exec-1',
    policyId: over.policyId ?? 'pol-1',
    policyVersion: over.policyVersion ?? 3,
    policyVersionRowId: over.policyVersionRowId ?? 'pv-1',
    decision: 'decision' in over ? over.decision! : 'approved',
    canonicalInputHash: 'canonicalInputHash' in over ? over.canonicalInputHash! : 'in-hash',
    canonicalOutputHash: 'canonicalOutputHash' in over ? over.canonicalOutputHash! : 'out-hash',
    traceHash: over.traceHash ?? 'trace-hash',
    canonicalizationVersion: over.canonicalizationVersion ?? CANONICALIZATION_VERSION,
    sourceToolchainId: over.sourceToolchainId ?? 'tc-src',
    runtimeToolchainId: over.runtimeToolchainId ?? 'tc-run',
    replayabilityStatus: over.replayabilityStatus ?? 'REPLAYABLE',
    replayabilityReasons: over.replayabilityReasons ?? null,
    reasonCodes: over.reasonCodes ?? null,
    source: over.source ?? 'api',
    durationMs: over.durationMs ?? 12,
    createdAt: over.createdAt ?? new Date('2026-07-01T00:00:00Z'),
    outcome: 'outcome' in over ? over.outcome! : 'ALLOW',
    ruleId: 'ruleId' in over ? over.ruleId! : 'R-1',
    controls: 'controls' in over ? over.controls! : ['GDPR:ART17'],
    agent: 'agent' in over ? over.agent! : { provider: 'anthropic', model: 'claude', source: 'declared' },
    evidenceCorrelationId: 'evidenceCorrelationId' in over ? over.evidenceCorrelationId! : null,
    policyTenantId: over.policyTenantId ?? 'tenant-1',
    guardDecisionId: 'guardDecisionId' in over ? over.guardDecisionId! : null,
  };
}

const LEGACY: ReceiptRef = { status: 'legacy' };

/** 默认 legacy 收据、无复核者的条目（既有断言只关心哈希/溯源字段）。 */
function entry(
  over: Partial<EvidenceRow> = {},
  receipt: ReceiptRef = LEGACY,
  reviewers: Reviewer[] = [],
  whatIf: EvidenceWhatIf | null = null,
): EvidenceEntry {
  return buildEvidenceEntry(row(over), receipt, reviewers, whatIf);
}

function reviewer(over: Partial<Reviewer>): Reviewer {
  return {
    userId: 'u-1', role: 'engineer', source: 'policy-proof', outcome: 'VERIFIED',
    decidedAt: '2026-07-01T00:00:00.000Z', ref: 'r-1', roleVerified: true, ...over,
  };
}

function emptyLookup(): ReceiptLookup {
  return { receipts: new Map(), approvals: new Map(), missing: new Set(), unavailable: new Set() };
}

const policy = { id: 'pol-1', name: 'Loan', version: 3, policyVersionRowId: 'pv-1' } as const;
const gen = new Date('2026-07-16T00:00:00Z');
const range = { start: new Date('2026-06-01T00:00:00Z'), end: new Date('2026-07-01T00:00:00Z') };

describe('buildEvidenceEntry', () => {
  it('映射哈希/溯源字段，createdAt 转 ISO，不含明文 input/output', () => {
    const e = entry();
    expect(e).toMatchObject({
      executionId: 'exec-1',
      decision: 'approved',
      canonicalInputHash: 'in-hash',
      canonicalOutputHash: 'out-hash',
      traceHash: 'trace-hash',
      toolchain: { source: 'tc-src', runtime: 'tc-run' },
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    // 绝不出现明文数据字段
    expect(JSON.stringify(e)).not.toContain('traceJson');
    expect(e).not.toHaveProperty('input');
    expect(e).not.toHaveProperty('output');
  });
});

describe('tallyDecisions', () => {
  it('统计各态；decision=null 计入 unknown', () => {
    const entries = [
      entry({ id: 'a', decision: 'approved' }),
      entry({ id: 'b', decision: 'denied' }),
      entry({ id: 'c', decision: null }),
      entry({ id: 'd', decision: 'error' }),
    ];
    expect(tallyDecisions(entries)).toEqual({
      approved: 1, denied: 1, indeterminate: 0, error: 1, require_approval: 0, escalate: 0, unknown: 1,
    });
  });
});

describe('computeBundleHash 确定性', () => {
  const eA = entry({ id: 'a', createdAt: new Date('2026-07-01T00:00:00Z') });
  const eB = entry({ id: 'b', createdAt: new Date('2026-07-02T00:00:00Z') });

  it('★任意输入顺序 → 同 bundleHash（内部按 createdAt,id 排序）', () => {
    expect(computeBundleHash([eA, eB])).toBe(computeBundleHash([eB, eA]));
  });

  it('★改任一 entry 的哈希 → bundleHash 变', () => {
    const base = computeBundleHash([eA, eB]);
    const tampered = entry({ id: 'a', canonicalOutputHash: 'DIFFERENT' });
    expect(computeBundleHash([tampered, eB])).not.toBe(base);
  });

  it('★改 decision → bundleHash 变', () => {
    const base = computeBundleHash([eA, eB]);
    const flipped = entry({ id: 'a', decision: 'denied' });
    expect(computeBundleHash([flipped, eB])).not.toBe(base);
  });

  it('空 entries → 稳定哈希（对 [] 的 canonicalHash）', () => {
    expect(computeBundleHash([])).toBe(computeBundleHash([]));
  });
});

describe('buildManifest', () => {
  it('汇总 count/tally/range/version + legacy 缺哈希计数', () => {
    const entries = [
      entry({ id: 'a', decision: 'approved' }),
      // legacy 行：无 canonical 哈希 + decision=null
      entry({ id: 'b', canonicalInputHash: null, canonicalOutputHash: null, decision: null }),
    ];
    const m = buildManifest({ policy, range, entries, generatedAt: gen });
    expect(m.totals.count).toBe(2);
    expect(m.decisionTally.approved).toBe(1);
    expect(m.decisionTally.unknown).toBe(1);
    expect(m.notes.legacyRowsWithoutHashes).toBe(1);
    expect(m.canonicalizationVersion).toBe(CANONICALIZATION_VERSION);
    expect(m.kind).toBe('evidence-export');
    expect(m.range.start).toBe('2026-06-01T00:00:00.000Z');
  });

  it('scope=all 策略快照', () => {
    const m = buildManifest({ policy: { scope: 'all' }, range, entries: [], generatedAt: gen });
    expect(m.policy).toEqual({ scope: 'all' });
    expect(m.totals.count).toBe(0);
  });
});

describe('serializeBundle', () => {
  const bundle = buildBundle({
    policy,
    range,
    entries: [entry({ id: 'a' }), entry({ id: 'b', createdAt: new Date('2026-07-02T00:00:00Z') })],
    generatedAt: gen,
  });

  it('json：可解析回 { manifest, entries }', () => {
    const parsed = JSON.parse(serializeBundle(bundle, 'json'));
    expect(parsed.manifest.kind).toBe('evidence-export');
    expect(parsed.entries).toHaveLength(2);
  });

  it('★jsonl：首行 _manifest + 每行一 entry（行数 = entries + 1）', () => {
    const lines = serializeBundle(bundle, 'jsonl').trim().split('\n');
    expect(lines).toHaveLength(3); // manifest + 2 entries
    expect(JSON.parse(lines[0])._manifest.kind).toBe('evidence-export');
    expect(JSON.parse(lines[1]).executionId).toBeDefined();
  });
});

describe('bundleHash 版本前缀', () => {
  it('bundleHash 是 hex（复用 canonicalHash：带 CANONICALIZATION_VERSION 前缀的 sha256）', () => {
    const entries: EvidenceEntry[] = [entry()];
    const m = buildManifest({ policy, range, entries, generatedAt: gen });
    expect(m.bundleHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('v2 条目：收据 / 复核者 / agent / outcome', () => {
  it('buildEvidenceEntry 带上 receipt、reviewers、agent、outcome 等 v2 字段', () => {
    const e = entry({}, LEGACY, []);
    expect(e).toMatchObject({
      outcome: 'ALLOW',
      ruleId: 'R-1',
      controls: ['GDPR:ART17'],
      agent: { provider: 'anthropic', model: 'claude', source: 'declared' },
      evidenceCorrelationId: null,
      receipt: { status: 'legacy' },
      reviewers: [],
    });
    // 查询专用字段不进 entry
    expect(e).not.toHaveProperty('policyTenantId');
    expect(e).not.toHaveProperty('guardDecisionId');
  });

  it('agent/controls 缺省为 null', () => {
    const e = entry({ agent: null, controls: null });
    expect(e.agent).toBeNull();
    expect(e.controls).toBeNull();
  });

  it('reviewers 按 (decidedAt, ref) 排序，不改入参', () => {
    const late = reviewer({ ref: 'b', decidedAt: '2026-07-03T00:00:00.000Z' });
    const earlyB = reviewer({ ref: 'b', decidedAt: '2026-07-01T00:00:00.000Z' });
    const earlyA = reviewer({ ref: 'a', decidedAt: '2026-07-01T00:00:00.000Z' });
    const input = [late, earlyB, earlyA];
    const e = entry({}, LEGACY, input);
    expect(e.reviewers.map((r) => [r.decidedAt.slice(0, 10), r.ref])).toEqual([
      ['2026-07-01', 'a'], ['2026-07-01', 'b'], ['2026-07-03', 'b'],
    ]);
    expect(input[0]).toBe(late);
  });
});

describe('receiptFor', () => {
  const lookup = emptyLookup();
  lookup.receipts.set('c-hit', {
    auditId: 7, currentHash: 'h7', prevHash: 'h6', hashVersion: 2,
    eventType: 'POLICY_EVALUATION', timestamp: '2026-07-01T00:00:00Z', metadata: { x: 1 },
  });
  lookup.unavailable.add('c-down');
  lookup.missing.add('c-miss');

  it('无关联 id → legacy', () => {
    expect(receiptFor({ evidenceCorrelationId: null }, lookup)).toEqual({ status: 'legacy' });
  });
  it('在 unavailable 集 → unavailable', () => {
    expect(receiptFor({ evidenceCorrelationId: 'c-down' }, lookup)).toEqual({ status: 'unavailable' });
  });
  it('在 missing 集或未命中 → missing', () => {
    expect(receiptFor({ evidenceCorrelationId: 'c-miss' }, lookup)).toEqual({ status: 'missing' });
    expect(receiptFor({ evidenceCorrelationId: 'c-never-asked' }, lookup)).toEqual({ status: 'missing' });
  });
  it('命中 → 只搬运哈希链坐标（不含 eventType/metadata）', () => {
    expect(receiptFor({ evidenceCorrelationId: 'c-hit' }, lookup)).toEqual({
      auditId: 7, currentHash: 'h7', prevHash: 'h6', hashVersion: 2,
    });
  });
});

describe('v2 bundleHash', () => {
  const rA = row({ id: 'a', evidenceCorrelationId: 'c-a' });
  const rB = row({ id: 'b', createdAt: new Date('2026-07-02T00:00:00Z') });
  const receiptA: ReceiptRef = { auditId: 1, currentHash: 'h1', prevHash: null, hashVersion: 2 };
  const revs = [reviewer({ ref: 'x' }), reviewer({ ref: 'y', source: 'version-approval' })];

  it('★同数据（复核者输入顺序不同）→ 同 bundleHash', () => {
    const h1 = computeBundleHash([buildEvidenceEntry(rA, receiptA, revs), entry({ id: 'b', createdAt: rB.createdAt })]);
    const h2 = computeBundleHash([entry({ id: 'b', createdAt: rB.createdAt }), buildEvidenceEntry(rA, receiptA, [...revs].reverse())]);
    expect(h1).toBe(h2);
  });

  it('★v2 字段进入哈希：与剥掉 v2 字段的 v1 形态不同，v1 形态仍按原 recipe 计算', () => {
    const v2 = [entry({ id: 'a' }), entry({ id: 'b', createdAt: rB.createdAt })];
    const v1 = v2.map((e) => {
      const { outcome, ruleId, controls, agent, evidenceCorrelationId, receipt, reviewers, ...rest } = e;
      void [outcome, ruleId, controls, agent, evidenceCorrelationId, receipt, reviewers];
      return rest;
    });
    const v1Hash = computeBundleHash(v1 as unknown as EvidenceEntry[]);
    expect(v1Hash).toBe(canonicalHash(v1 as unknown[]));
    expect(computeBundleHash(v2)).not.toBe(v1Hash);
  });

  it('★改收据或复核者 → bundleHash 变', () => {
    const base = computeBundleHash([buildEvidenceEntry(rA, receiptA, revs)]);
    expect(computeBundleHash([buildEvidenceEntry(rA, { status: 'unavailable' }, revs)])).not.toBe(base);
    expect(computeBundleHash([buildEvidenceEntry(rA, receiptA, revs.slice(1))])).not.toBe(base);
  });
});

describe('v2 manifest', () => {
  const entries = [
    entry({ id: 'a', evidenceCorrelationId: 'c-a', decision: 'require_approval' },
      { auditId: 1, currentHash: 'h1', prevHash: null, hashVersion: 2 },
      [reviewer({ source: 'policy-proof' }), reviewer({ ref: 'g', source: 'guard-approval', roleVerified: true })]),
    entry({ id: 'b', evidenceCorrelationId: null, agent: null, decision: 'escalate' }),
    entry({ id: 'c', evidenceCorrelationId: 'c-c', agent: { provider: 'openai', model: 'gpt', source: 'declared' } },
      { status: 'unavailable' }, [reviewer({ ref: 'v', source: 'version-approval' })]),
    entry({ id: 'd', evidenceCorrelationId: 'c-d' }, { status: 'missing' }),
  ];

  it('schemaVersion=3、receiptSource、agentTally、reviewerTally、legacy/unavailable/missing 计数', () => {
    const m = buildManifest({ policy, range, entries, generatedAt: gen });
    expect(m.schemaVersion).toBe('3');
    expect(m.receiptSource).toEqual({ kind: 'aster-api-hash-chain', verifier: 'GET /api/v1/audit/receipts' });
    expect(m.agentTally).toEqual({ 'anthropic/claude': 2, unknown: 1, 'openai/gpt': 1 });
    expect(m.reviewerTally).toEqual({ 'guard-approval': 1, 'policy-proof': 1, 'version-approval': 1 });
    expect(m.legacyEntries).toBe(1);
    expect(m.notes.receiptsUnavailable).toBe(1);
    expect(m.notes.receiptsMissing).toBe(1);
    expect(m.decisionTally).toMatchObject({ require_approval: 1, escalate: 1, approved: 2 });
    expect(m.notes.verification).toBe(
      'bundleHash = canonicalHash(entries sorted by [createdAt, executionId]) over schemaVersion 3 entries ' +
      '(includes outcome/ruleId/controls/agent/receipt/reviewers/whatIf); receipts verifiable via GET /api/v1/audit/receipts; ' +
      'v1 bundles use their own recipe.',
    );
  });

  it('空 entries：三来源复核者计数恒为 0，agentTally 为空', () => {
    expect(tallyReviewers([])).toEqual({ 'guard-approval': 0, 'policy-proof': 0, 'version-approval': 0 });
    expect(tallyAgents([])).toEqual({});
  });
});

describe('v3：What-If 与法规对照', () => {
  it('entry 带 whatIf、manifest 带 regulatoryMapping 与 whatIfUnavailable', () => {
    const e = entry({}, LEGACY, [], null);
    expect(e.whatIf).toBeNull();
    const wi = { batchId: 'b1', baseOutcome: 'REQUIRE_APPROVAL', targetOutcome: 'ALLOW', baseLegacy: false };
    const e2 = buildEvidenceEntry(row({ id: 'exec-2' }), LEGACY, [], wi);
    expect(e2.whatIf).toEqual(wi);
    const m = buildManifest({ policy, range: { start: null, end: null }, entries: [e, e2], generatedAt: gen, whatIfUnavailable: 1 });
    expect(m.schemaVersion).toBe('3');
    expect(m.notes.whatIfUnavailable).toBe(1);
    expect(m.regulatoryMapping.framework).toBe('EU_AI_ACT');
    expect(m.regulatoryMapping.clauses.map((c) => c.clause)).toEqual(['14(1)', '14(2)', '14(3)', '14(4)(a)', '14(4)(b)', '14(4)(c)', '14(4)(d)', '14(4)(e)', '14(5)']);
  });
  it('whatIfUnavailable 缺省为 0', () => {
    const m = buildManifest({ policy, range: { start: null, end: null }, entries: [], generatedAt: gen });
    expect(m.notes.whatIfUnavailable).toBe(0);
  });
  it('whatIf 参与 bundleHash（entries 字段）', () => {
    const a = computeBundleHash([entry({}, LEGACY, [], null)]);
    const b = computeBundleHash([buildEvidenceEntry(row(), LEGACY, [], { batchId: 'b', baseOutcome: 'ALLOW', targetOutcome: 'ALLOW', baseLegacy: false })]);
    expect(a).not.toBe(b);
  });
});
