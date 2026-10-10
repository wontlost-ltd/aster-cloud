import { describe, it, expect } from 'vitest';
import { mapRegulatory } from '@/services/evidence/regulatory-mapping';
import type { EvidenceEntry } from '@/services/evidence/types';
import type { Reviewer } from '@/services/evidence/reviewers';

// 条目默认带 EU_AI_ACT:ART14，使第 14 条组出现
function e(over: Partial<EvidenceEntry>): EvidenceEntry {
  return {
    executionId: 'x', policyId: 'p', policyVersion: 1, policyVersionRowId: 'pv', decision: 'approved',
    canonicalInputHash: 'i', canonicalOutputHash: 'o', traceHash: 't', canonicalizationVersion: 'v',
    toolchain: { source: null, runtime: null }, replayabilityStatus: null, replayabilityReasons: null,
    reasonCodes: null, source: 'api', durationMs: 1, createdAt: '2026-10-09T00:00:00.000Z',
    outcome: 'ALLOW', ruleId: null, controls: ['EU_AI_ACT:ART14'], agent: null, evidenceCorrelationId: null,
    receipt: { status: 'legacy' }, reviewers: [], whatIf: null, profile: null, ...over,
  };
}
const rv = (over: Partial<Reviewer>): Reviewer => ({
  userId: 'u', role: 'Credit Officer', source: 'guard-approval', outcome: 'APPROVED',
  decidedAt: '2026-10-09T00:00:00.000Z', ref: 'r', roleVerified: true, ...over,
});
const art14 = (entries: EvidenceEntry[]) =>
  mapRegulatory(entries).frameworks.find((f) => f.control === 'EU_AI_ACT:ART14')!.clauses;
const clause = (entries: EvidenceEntry[], id: string) => art14(entries).find((c) => c.clause === id)!;
const status = (entries: EvidenceEntry[]) => Object.fromEntries(art14(entries).map((c) => [c.clause, c.status]));

describe('mapRegulatory：EU AI Act 第 14 条', () => {
  it('空 entries 全部 none，九条顺序固定', () => {
    const clauses = art14([]);
    expect(clauses.map((c) => c.clause)).toEqual(['14(1)', '14(2)', '14(3)', '14(4)(a)', '14(4)(b)', '14(4)(c)', '14(4)(d)', '14(4)(e)', '14(5)']);
    expect(clauses.every((c) => c.status === 'none' && c.evidence.length === 0)).toBe(true);
  });
  it('14(1) 由 controls 含 EU_AI_ACT:ART14 证实并指向字段', () => {
    const c = clause([e({ executionId: 'a' })], '14(1)');
    expect(c.status).toBe('evidenced');
    expect(c.evidence).toEqual([{ executionId: 'a', field: 'controls' }]);
  });
  it('14(2)/14(4)(e)：REQUIRE_APPROVAL 有复核者 evidenced，无复核者 partial', () => {
    expect(status([e({ outcome: 'REQUIRE_APPROVAL' })])).toMatchObject({ '14(2)': 'evidenced', '14(4)(e)': 'partial' });
    expect(status([e({ outcome: 'REQUIRE_APPROVAL', reviewers: [rv({})] })])['14(4)(e)']).toBe('evidenced');
  });
  it('14(4)(e) 跨条目：REQUIRE_APPROVAL 条目无复核者、另一条目有已验证 guard 复核者 → evidenced（§4.1 不再要求同条目）', () => {
    const c = clause([e({ executionId: 'a', outcome: 'REQUIRE_APPROVAL' }), e({ executionId: 'b', reviewers: [rv({})] })], '14(4)(e)');
    expect(c.status).toBe('evidenced');
    expect(c.evidence).toEqual([{ executionId: 'b', field: 'reviewers' }]);
  });
  it('14(4)(e)：guard 复核者未验证角色只能 partial（§4.1 只认 roleVerified）', () => {
    expect(status([e({ outcome: 'REQUIRE_APPROVAL', reviewers: [rv({ roleVerified: false })] })])['14(4)(e)']).toBe('partial');
  });
  it('14(3)：控制与复核者都在 evidenced，只有其一 partial', () => {
    expect(status([e({})])['14(3)']).toBe('partial');
    expect(status([e({ reviewers: [rv({})] })])['14(3)']).toBe('evidenced');
  });
  it('14(3)：reviewers.any 不看 roleVerified 与来源', () => {
    expect(status([e({ reviewers: [rv({ source: 'policy-proof', roleVerified: false })] })])['14(3)']).toBe('evidenced');
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
    expect(status([e({ reviewers: [rv({})] })])['14(4)(b)']).toBe('none');
  });
  it('14(4)(c)：ruleId 与 reasonCodes 均非空', () => {
    expect(status([e({ ruleId: 'CP-DECIDE', reasonCodes: ['large_exposure'] })])['14(4)(c)']).toBe('evidenced');
    const c = clause([e({ executionId: 'a', ruleId: 'CP-DECIDE', reasonCodes: ['large_exposure'] })], '14(4)(c)');
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
  it('14(5)：同一条目两个 guard 复核者但其一未验证角色 → none（§4.1 只数 roleVerified）', () => {
    expect(status([e({ reviewers: [rv({}), rv({ userId: 'u2', roleVerified: false })] })])['14(5)']).toBe('none');
  });
  it('14(5)：两个已验证复核者分在不同条目 → none', () => {
    expect(status([e({ executionId: 'a', reviewers: [rv({})] }), e({ executionId: 'b', reviewers: [rv({ userId: 'u2' })] })])['14(5)']).toBe('none');
  });
  it('版本级复核者（policy-proof / version-approval）不证 14(4)(d)/(e)/14(5)，但计入 14(3)', () => {
    const proofRejected = e({ outcome: 'REQUIRE_APPROVAL', reviewers: [rv({ source: 'policy-proof', outcome: 'REJECTED' })] });
    expect(status([proofRejected])).toMatchObject({ '14(3)': 'evidenced', '14(4)(d)': 'none', '14(4)(e)': 'partial' });
    const twoVersion = e({ reviewers: [rv({ source: 'version-approval' }), rv({ source: 'version-approval', userId: 'u2' })] });
    expect(status([twoVersion])['14(5)']).toBe('none');
    const twoGuard = e({ reviewers: [rv({}), rv({ userId: 'u2', outcome: 'REJECTED' })] });
    expect(status([twoGuard])).toMatchObject({ '14(4)(d)': 'evidenced', '14(5)': 'evidenced' });
  });
  it('evidence 去重并按（来源顺序, 条目顺序）排列', () => {
    const c = clause([e({ executionId: 'a', reviewers: [rv({})] }), e({ executionId: 'b' })], '14(3)');
    expect(c.evidence).toEqual([
      { executionId: 'a', field: 'controls' }, { executionId: 'b', field: 'controls' }, { executionId: 'a', field: 'reviewers' },
    ]);
  });
});

describe('mapRegulatory：注册表驱动', () => {
  it('entries 为空：所有带条款的组全部 none，并写注册表版本', () => {
    const m = mapRegulatory([]);
    expect(m.registryVersion).toBe('1.1.0');
    expect(m.frameworks.map((f) => f.control)).toEqual(['EU_AI_ACT:ART14']);
    expect(m.frameworks[0]!.clauses.every((c) => c.status === 'none' && c.evidence.length === 0)).toBe(true);
  });

  it('条目都不含该控制点：不生成该组', () => {
    const m = mapRegulatory([e({ controls: ['GDPR:ART17'] })]);
    expect(m.frameworks).toEqual([]);
  });

  it('标题为三语对象', () => {
    const c = mapRegulatory([]).frameworks[0]!.clauses.find((x) => x.clause === '14(4)(d)')!;
    expect(c.title).toEqual({ en: 'Decide not to use or override the output', zh: '决定不使用或推翻输出', de: 'Ausgabe nicht verwenden oder übersteuern' });
  });

  it('注入注册表：新增框架只改数据', () => {
    const registry = {
      version: '9.9.9', frameworks: [{ id: 'X', title: { en: 'X', zh: 'X', de: 'X' } }],
      controls: [{ key: 'X:1', framework: 'X', article: '1', title: { en: 'x', zh: 'x', de: 'x' } }],
      clauses: [{ control: 'X:1', clause: '1(1)', title: { en: 'a', zh: 'a', de: 'a' }, evidenced: ['outcome.pending' as const], partial: [] }],
      profiles: [],
    };
    const m = mapRegulatory([e({ controls: ['X:1'], outcome: 'ESCALATE' })], registry);
    expect(m.frameworks[0]).toMatchObject({ framework: 'X', article: '1', control: 'X:1' });
    expect(m.frameworks[0]!.clauses[0]!.status).toBe('evidenced');
  });
});
