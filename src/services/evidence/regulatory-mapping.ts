/**
 * 法规对照（ADR 0045 §4）：由控制注册表的条款数据驱动，判定规则统一。
 * 只陈述证据包内已有的字段，不打分、不给建议；无来源可证的条款如实为 none。
 */
import { defaultControlRegistry, type ControlRegistryData, type EvidenceSource, type LocalizedTitle } from './control-registry';
import type { EvidenceEntry } from './types';

export type ClauseStatus = 'evidenced' | 'partial' | 'none';
export interface EvidenceRef { executionId: string; field: string }
export interface RegulatoryClause { clause: string; title: LocalizedTitle; status: ClauseStatus; evidence: EvidenceRef[] }
export interface FrameworkMapping { framework: string; article: string; control: string; clauses: RegulatoryClause[] }
export interface RegulatoryMapping { registryVersion: string; frameworks: FrameworkMapping[] }

type SourceFn = (entries: readonly EvidenceEntry[], control: string) => EvidenceRef[];

const ref = (e: EvidenceEntry, field: string): EvidenceRef => ({ executionId: e.executionId, field });
const pick = (field: string, test: (e: EvidenceEntry, control: string) => boolean): SourceFn =>
  (entries, control) => entries.filter((e) => test(e, control)).map((e) => ref(e, field));

// 执行级干预只认已验证角色的 guard-approval：版本级 proof/approval 挂在该版本每条执行上，不代表有人复核过这条输出
const guardReviewers = (e: EvidenceEntry) => e.reviewers.filter((r) => r.source === 'guard-approval' && r.roleVerified);

const SOURCES: Record<EvidenceSource, SourceFn> = {
  control: pick('controls', (e, control) => (e.controls ?? []).includes(control)),
  'outcome.pending': pick('outcome', (e) => e.outcome === 'REQUIRE_APPROVAL' || e.outcome === 'ESCALATE'),
  'outcome.requireApproval': pick('outcome', (e) => e.outcome === 'REQUIRE_APPROVAL'),
  'reviewers.any': pick('reviewers', (e) => e.reviewers.length > 0),
  'reviewers.guard.any': pick('reviewers', (e) => guardReviewers(e).length > 0),
  'reviewers.guard.approved': pick('reviewers', (e) => guardReviewers(e).some((r) => r.outcome === 'APPROVED')),
  'reviewers.guard.rejected': pick('reviewers', (e) => guardReviewers(e).some((r) => r.outcome === 'REJECTED')),
  'reviewers.guard.two': pick('reviewers', (e) => guardReviewers(e).length >= 2),
  // 在途批次（targetOutcome 为 null）与失败项（ERROR）不是完成的比对结论
  'whatIf.comparable': pick('whatIf', (e) => e.whatIf !== null && e.whatIf.targetOutcome !== null && e.whatIf.targetOutcome !== 'ERROR'),
  'rule.reason': (entries) => entries
    .filter((e) => e.ruleId !== null && Array.isArray(e.reasonCodes) && e.reasonCodes.length > 0)
    .flatMap((e) => [ref(e, 'ruleId'), ref(e, 'reasonCodes')]),
};

/** 证据来源是否为本引擎可判定的已知名（注册表副本的来源词表须是 SOURCES 键的子集）。 */
export function isEvidenceSource(name: string): name is EvidenceSource {
  return Object.hasOwn(SOURCES, name);
}

function dedupe(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.executionId}\u0000${r.field}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/** evidenced 非空且每个来源都命中 → evidenced；否则 partial 中任一命中 → partial；否则 none。 */
function judge(entries: readonly EvidenceEntry[], control: string, evidenced: EvidenceSource[], partial: EvidenceSource[]) {
  const hits = (sources: EvidenceSource[]) => sources.map((s) => SOURCES[s](entries, control));
  const full = hits(evidenced);
  if (full.length > 0 && full.every((h) => h.length > 0)) {
    return { status: 'evidenced' as const, evidence: dedupe(full.flat()) };
  }
  const some = hits(partial).filter((h) => h.length > 0);
  if (some.length > 0) return { status: 'partial' as const, evidence: dedupe(some.flat()) };
  return { status: 'none' as const, evidence: [] };
}

export function mapRegulatory(entries: readonly EvidenceEntry[], registry: ControlRegistryData = defaultControlRegistry): RegulatoryMapping {
  const used = new Set(entries.flatMap((e) => e.controls ?? []));
  const groups = registry.controls.filter((c) =>
    registry.clauses.some((cl) => cl.control === c.key) && (entries.length === 0 || used.has(c.key)));
  return {
    registryVersion: registry.version,
    frameworks: groups.map((c) => ({
      framework: c.framework,
      article: c.article,
      control: c.key,
      clauses: registry.clauses
        .filter((cl) => cl.control === c.key)
        .map((cl) => ({ clause: cl.clause, title: cl.title, ...judge(entries, c.key, cl.evidenced, cl.partial) })),
    })),
  };
}
