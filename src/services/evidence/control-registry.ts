// 控制注册表（ADR 0045）：发布前读仓内副本，与 aster-lang-locales 真相源深度相等（parity 测试守护）。
import raw from '@/config/controls-registry.json';

export type EvidenceSource =
  | 'control' | 'outcome.pending' | 'outcome.requireApproval' | 'reviewers.any' | 'reviewers.guard.any'
  | 'reviewers.guard.approved' | 'reviewers.guard.rejected' | 'reviewers.guard.two' | 'whatIf.comparable' | 'rule.reason';

export interface LocalizedTitle { en: string; zh: string; de: string }
export interface RegistryClause {
  control: string; clause: string; title: LocalizedTitle; evidenced: EvidenceSource[]; partial: EvidenceSource[];
}
/** 治理档案（ADR 0046 §3）：模块声明的档案 id 对应的标题与编译期要求。 */
export interface RegistryProfile {
  id: string;
  title: LocalizedTitle;
  requires: { ruleId: boolean; registeredControls: boolean; frameworks: string[] };
}
export interface ControlRegistryData {
  version: string;
  frameworks: Array<{ id: string; title: LocalizedTitle }>;
  controls: Array<{ key: string; framework: string; article: string; title: LocalizedTitle }>;
  clauses: RegistryClause[];
  profiles: RegistryProfile[];
}

export const defaultControlRegistry = raw as ControlRegistryData;

/** 档案标题：注册表未登记的 id（如更新版编译器带来的新档案）三语都如实显示 id 本身。 */
export function profileTitle(id: string, registry: ControlRegistryData = defaultControlRegistry): LocalizedTitle {
  return registry.profiles.find((p) => p.id === id)?.title ?? { en: id, zh: id, de: id };
}

// 注册表标题只有 en/zh/de 三语，其余 locale（如 hi）回退英文
export function localizedTitle(title: LocalizedTitle, locale: string): string {
  return locale === 'zh' || locale === 'de' ? title[locale] : title.en;
}
