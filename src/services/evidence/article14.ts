// EU AI Act 第 14 条（人类监督）对照的类型与条款清单（ADR 0044 §3）。
//
// 各条款的判定逻辑在下一任务补全；当前 mapArticle14 对每个条款一律返回 none / 无证据，
// 仅保证 manifest 的形状稳定，绝不臆造「已满足」。

import type { EvidenceEntry } from './types';

/** 条款覆盖状态。 */
export type ClauseStatus = 'covered' | 'partial' | 'none';

/** 支撑某条款的证据引用（指向 manifest 字段或条目集合）。 */
export interface EvidenceRef {
  field: string;
  count: number;
}

export interface Article14Clause {
  clause: string;
  title: string;
  status: ClauseStatus;
  evidence: EvidenceRef[];
}

export interface Article14Mapping {
  framework: 'EU_AI_ACT';
  article: '14';
  clauses: Article14Clause[];
}

/** 第 14 条九个条款，按法条顺序。 */
export const ARTICLE14_CLAUSES: ReadonlyArray<{ clause: string; title: string }> = [
  { clause: '14(1)', title: 'Designed to be effectively overseen by natural persons' },
  { clause: '14(2)', title: 'Oversight aims to prevent or minimise risks' },
  { clause: '14(3)', title: 'Oversight measures commensurate with risk and context' },
  { clause: '14(4)(a)', title: 'Understand the capacities and limitations of the system' },
  { clause: '14(4)(b)', title: 'Remain aware of automation bias' },
  { clause: '14(4)(c)', title: 'Correctly interpret the output' },
  { clause: '14(4)(d)', title: 'Decide not to use, disregard, override or reverse the output' },
  { clause: '14(4)(e)', title: 'Intervene or interrupt the system' },
  { clause: '14(5)', title: 'Two-person verification for biometric identification' },
];

/** 占位判定：全部 none；真实判定见下一任务。 */
export function mapArticle14(_entries: readonly EvidenceEntry[]): Article14Mapping {
  return {
    framework: 'EU_AI_ACT',
    article: '14',
    clauses: ARTICLE14_CLAUSES.map((c) => ({ ...c, status: 'none', evidence: [] })),
  };
}
