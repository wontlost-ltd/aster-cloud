/**
 * 信贷试点 Article 14 对照期望表与比对（ADR 0044 §5）。
 * 纯函数、无 I/O，供跑通脚本与 E2E spec 共用。
 */
import type { ClauseStatus } from '../../src/services/evidence/article14';

// 试点场景下九款的期望状态：未覆盖的款项显式写 none，防止静默漂移
export const EXPECTED_CLAUSE_STATUS: Record<string, ClauseStatus> = {
  '14(1)': 'evidenced',
  '14(2)': 'evidenced',
  '14(3)': 'evidenced',
  '14(4)(a)': 'partial',
  '14(4)(b)': 'none',
  '14(4)(c)': 'evidenced',
  '14(4)(d)': 'partial',
  '14(4)(e)': 'evidenced',
  '14(5)': 'none',
};

export interface ClauseMappingLike {
  clauses: ReadonlyArray<{ clause: string; status: string }>;
}

// 按期望键顺序列出不符项；空数组即全部一致，导出中多余的款项不计
export function diffClauses(mapping: ClauseMappingLike, expected: Record<string, string>): string[] {
  const actual = new Map(mapping.clauses.map((c) => [c.clause, c.status]));
  return Object.entries(expected).flatMap(([clause, want]) => {
    const got = actual.get(clause);
    if (got === undefined) return [`${clause}: missing`];
    return got === want ? [] : [`${clause}: expected ${want}, got ${got}`];
  });
}
