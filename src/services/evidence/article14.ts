/**
 * EU AI Act Article 14（人工监督）对照（ADR 0044 §3.1）。
 *
 * 纯函数：只读证据包条目字段，给每款一个 evidenced / partial / none 与指向的 (executionId, field)。
 * 不打分、不给建议；无字段可证的款项如实标 none。子项目 5 控制注册表就绪后由注册表驱动替换本表。
 */
import type { EvidenceEntry } from './types';

export type ClauseStatus = 'evidenced' | 'partial' | 'none';
export interface EvidenceRef { executionId: string; field: string }
export interface Article14Clause { clause: string; title: string; status: ClauseStatus; evidence: EvidenceRef[] }
export interface Article14Mapping { framework: 'EU_AI_ACT'; article: '14'; clauses: Article14Clause[] }

const ART14_CONTROL = 'EU_AI_ACT:ART14';

type Judge = (entries: readonly EvidenceEntry[]) => { status: ClauseStatus; evidence: EvidenceRef[] };

const refs = (entries: readonly EvidenceEntry[], field: string, pick: (e: EvidenceEntry) => boolean): EvidenceRef[] =>
  entries.filter(pick).map((e) => ({ executionId: e.executionId, field }));

const hasControl = (e: EvidenceEntry) => (e.controls ?? []).includes(ART14_CONTROL);
const isPending = (e: EvidenceEntry) => e.outcome === 'REQUIRE_APPROVAL' || e.outcome === 'ESCALATE';
const hasReviewer = (e: EvidenceEntry) => e.reviewers.length > 0;
// 执行级干预只认 guard-approval：版本级 proof/approval 挂在该版本每条执行上，不代表有人复核过这条输出
const executionReviewers = (e: EvidenceEntry) => e.reviewers.filter((r) => r.source === 'guard-approval');
const verified = (e: EvidenceEntry, outcome: string) =>
  executionReviewers(e).some((r) => r.roleVerified && r.outcome === outcome);
// 在途批次（targetOutcome 为 null）与失败项（ERROR）不是完成的比对结论
const hasComparison = (e: EvidenceEntry) =>
  e.whatIf !== null && e.whatIf.targetOutcome !== null && e.whatIf.targetOutcome !== 'ERROR';
const isInterpretable = (e: EvidenceEntry) => e.ruleId !== null && Array.isArray(e.reasonCodes) && e.reasonCodes.length > 0;

/** 两组证据：都有 evidenced、其一 partial、全无 none。 */
function both(a: EvidenceRef[], b: EvidenceRef[]): { status: ClauseStatus; evidence: EvidenceRef[] } {
  const evidence = [...a, ...b];
  if (a.length > 0 && b.length > 0) return { status: 'evidenced', evidence };
  return { status: evidence.length > 0 ? 'partial' : 'none', evidence };
}

function some(evidence: EvidenceRef[], status: ClauseStatus = 'evidenced') {
  return { status: evidence.length > 0 ? status : 'none', evidence };
}

const JUDGES: ReadonlyArray<[string, string, Judge]> = [
  ['14(1)', 'Designed for effective human oversight', (es) => some(refs(es, 'controls', hasControl))],
  ['14(2)', 'Oversight proportionate to risk', (es) => some(refs(es, 'outcome', isPending))],
  ['14(3)', 'Oversight measures built in', (es) => both(refs(es, 'controls', hasControl), refs(es, 'reviewers', hasReviewer))],
  ['14(4)(a)', 'Overseer can understand capacities and limitations', (es) => some(refs(es, 'whatIf', hasComparison), 'partial')],
  ['14(4)(b)', 'Awareness of automation bias', () => ({ status: 'none', evidence: [] })],
  ['14(4)(c)', 'Correctly interpret the output', (es) =>
    some(es.filter(isInterpretable).flatMap((e) => [
      { executionId: e.executionId, field: 'ruleId' },
      { executionId: e.executionId, field: 'reasonCodes' },
    ]))],
  ['14(4)(d)', 'Decide not to use or override the output', (es) => {
    const rejected = refs(es, 'reviewers', (e) => verified(e, 'REJECTED'));
    if (rejected.length > 0) return { status: 'evidenced', evidence: rejected };
    return some(refs(es, 'reviewers', (e) => verified(e, 'APPROVED')), 'partial');
  }],
  ['14(4)(e)', 'Intervene or halt the system', (es) => {
    const blocked = refs(es, 'outcome', (e) => e.outcome === 'REQUIRE_APPROVAL');
    const reviewed = refs(es, 'reviewers', (e) => e.outcome === 'REQUIRE_APPROVAL' && executionReviewers(e).length > 0);
    if (reviewed.length > 0) return { status: 'evidenced', evidence: [...blocked, ...reviewed] };
    return some(blocked, 'partial');
  }],
  ['14(5)', 'Verification by at least two persons', (es) => some(refs(es, 'reviewers', (e) => executionReviewers(e).length >= 2))],
];

export const ARTICLE14_CLAUSES: ReadonlyArray<{ clause: string; title: string }> = JUDGES.map(([clause, title]) => ({ clause, title }));

export function mapArticle14(entries: readonly EvidenceEntry[]): Article14Mapping {
  return {
    framework: 'EU_AI_ACT',
    article: '14',
    clauses: JUDGES.map(([clause, title, judge]) => ({ clause, title, ...judge(entries) })),
  };
}
