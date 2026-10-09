import { describe, it, expect } from 'vitest';
import { mapArticle14 } from '@/services/evidence/article14';
import type { EvidenceEntry } from '@/services/evidence/types';
import type { Reviewer } from '@/services/evidence/reviewers';

function e(over: Partial<EvidenceEntry>): EvidenceEntry {
  return {
    executionId: 'x', policyId: 'p', policyVersion: 1, policyVersionRowId: 'pv', decision: 'approved',
    canonicalInputHash: 'i', canonicalOutputHash: 'o', traceHash: 't', canonicalizationVersion: 'v',
    toolchain: { source: null, runtime: null }, replayabilityStatus: null, replayabilityReasons: null,
    reasonCodes: null, source: 'api', durationMs: 1, createdAt: '2026-10-09T00:00:00.000Z',
    outcome: 'ALLOW', ruleId: null, controls: null, agent: null, evidenceCorrelationId: null,
    receipt: { status: 'legacy' }, reviewers: [], whatIf: null, ...over,
  };
}
const rv = (over: Partial<Reviewer>): Reviewer => ({
  userId: 'u', role: 'Credit Officer', source: 'guard-approval', outcome: 'APPROVED',
  decidedAt: '2026-10-09T00:00:00.000Z', ref: 'r', roleVerified: true, ...over,
});
const status = (entries: EvidenceEntry[]) => Object.fromEntries(mapArticle14(entries).clauses.map((c) => [c.clause, c.status]));

describe('mapArticle14', () => {
  it('空 entries 全部 none，九条顺序固定', () => {
    const m = mapArticle14([]);
    expect(m.clauses.map((c) => c.clause)).toEqual(['14(1)', '14(2)', '14(3)', '14(4)(a)', '14(4)(b)', '14(4)(c)', '14(4)(d)', '14(4)(e)', '14(5)']);
    expect(m.clauses.every((c) => c.status === 'none' && c.evidence.length === 0)).toBe(true);
  });
  it('14(1) 由 controls 含 EU_AI_ACT:ART14 证实并指向字段', () => {
    const m = mapArticle14([e({ executionId: 'a', controls: ['EU_AI_ACT:ART14'] })]);
    const c = m.clauses.find((x) => x.clause === '14(1)')!;
    expect(c.status).toBe('evidenced');
    expect(c.evidence).toEqual([{ executionId: 'a', field: 'controls' }]);
  });
  it('14(2)/14(4)(e)：REQUIRE_APPROVAL 有复核者 evidenced，无复核者 partial', () => {
    expect(status([e({ outcome: 'REQUIRE_APPROVAL' })])).toMatchObject({ '14(2)': 'evidenced', '14(4)(e)': 'partial' });
    expect(status([e({ outcome: 'REQUIRE_APPROVAL', reviewers: [rv({})] })])['14(4)(e)']).toBe('evidenced');
  });
  it('14(3)：控制与复核者都在 evidenced，只有其一 partial', () => {
    expect(status([e({ controls: ['EU_AI_ACT:ART14'] })])['14(3)']).toBe('partial');
    expect(status([e({ controls: ['EU_AI_ACT:ART14'], reviewers: [rv({})] })])['14(3)']).toBe('evidenced');
  });
  it('14(4)(a)：有 whatIf 为 partial，否则 none', () => {
    expect(status([e({ whatIf: { batchId: 'b', baseOutcome: 'ALLOW', targetOutcome: 'ALLOW', baseLegacy: false } })])['14(4)(a)']).toBe('partial');
    expect(status([e({})])['14(4)(a)']).toBe('none');
  });
  it('14(4)(a)：在途（targetOutcome 为 null）或失败（ERROR）的比对不算', () => {
    const w = (targetOutcome: string | null) => e({ whatIf: { batchId: 'b', baseOutcome: 'ALLOW', targetOutcome, baseLegacy: false } });
    expect(status([w(null)])['14(4)(a)']).toBe('none');
    expect(status([w('ERROR')])['14(4)(a)']).toBe('none');
  });
  it('14(4)(b) 恒 none', () => {
    expect(status([e({ controls: ['EU_AI_ACT:ART14'], reviewers: [rv({})] })])['14(4)(b)']).toBe('none');
  });
  it('14(4)(c)：ruleId 与 reasonCodes 均非空', () => {
    expect(status([e({ ruleId: 'CP-DECIDE', reasonCodes: ['large_exposure'] })])['14(4)(c)']).toBe('evidenced');
    const c = mapArticle14([e({ executionId: 'a', ruleId: 'CP-DECIDE', reasonCodes: ['large_exposure'] })]).clauses.find((x) => x.clause === '14(4)(c)')!;
    expect(c.evidence).toEqual([{ executionId: 'a', field: 'ruleId' }, { executionId: 'a', field: 'reasonCodes' }]);
    expect(status([e({ ruleId: 'CP-DECIDE', reasonCodes: [] })])['14(4)(c)']).toBe('none');
  });
  it('14(4)(d)：已验证角色 REJECTED evidenced；APPROVED partial；未验证角色的 REJECTED 不算', () => {
    expect(status([e({ reviewers: [rv({ outcome: 'REJECTED' })] })])['14(4)(d)']).toBe('evidenced');
    expect(status([e({ reviewers: [rv({ outcome: 'APPROVED' })] })])['14(4)(d)']).toBe('partial');
    expect(status([e({ reviewers: [rv({ outcome: 'REJECTED', roleVerified: false })] })])['14(4)(d)']).toBe('none');
  });
  it('14(5)：复核者 ≥ 2 才 evidenced', () => {
    expect(status([e({ reviewers: [rv({}), rv({ userId: 'u2' })] })])['14(5)']).toBe('evidenced');
    expect(status([e({ reviewers: [rv({})] })])['14(5)']).toBe('none');
  });
  it('版本级复核者（policy-proof / version-approval）不证 14(4)(d)/(e)/14(5)，但计入 14(3)', () => {
    const proofRejected = e({ outcome: 'REQUIRE_APPROVAL', controls: ['EU_AI_ACT:ART14'], reviewers: [rv({ source: 'policy-proof', outcome: 'REJECTED' })] });
    expect(status([proofRejected])).toMatchObject({ '14(3)': 'evidenced', '14(4)(d)': 'none', '14(4)(e)': 'partial' });
    const twoVersion = e({ reviewers: [rv({ source: 'version-approval' }), rv({ source: 'version-approval', userId: 'u2' })] });
    expect(status([twoVersion])['14(5)']).toBe('none');
    const twoGuard = e({ reviewers: [rv({}), rv({ userId: 'u2', outcome: 'REJECTED' })] });
    expect(status([twoGuard])).toMatchObject({ '14(4)(d)': 'evidenced', '14(5)': 'evidenced' });
  });
});
