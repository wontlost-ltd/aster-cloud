// 控制注册表（ADR 0045）：发布前读仓内副本，与 aster-lang-locales 真相源深度相等（parity 测试守护）。
import raw from '@/config/controls-registry.json';

export type EvidenceSource =
  | 'control' | 'outcome.pending' | 'outcome.requireApproval' | 'reviewers.any' | 'reviewers.guard.any'
  | 'reviewers.guard.approved' | 'reviewers.guard.rejected' | 'reviewers.guard.two' | 'whatIf.comparable' | 'rule.reason';

export interface LocalizedTitle { en: string; zh: string; de: string }
export interface RegistryClause {
  control: string; clause: string; title: LocalizedTitle; evidenced: EvidenceSource[]; partial: EvidenceSource[];
}
export interface ControlRegistryData {
  version: string;
  frameworks: Array<{ id: string; title: LocalizedTitle }>;
  controls: Array<{ key: string; framework: string; article: string; title: LocalizedTitle }>;
  clauses: RegistryClause[];
}

export const defaultControlRegistry = raw as ControlRegistryData;
