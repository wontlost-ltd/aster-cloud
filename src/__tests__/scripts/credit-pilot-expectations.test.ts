import { describe, it, expect } from 'vitest';
import { EXPECTED_CLAUSE_STATUS, articleClauses, diffClauses } from '../../../scripts/lib/credit-pilot-expectations';

describe('diffClauses', () => {
  it('完全一致为空', () => {
    const mapping = { clauses: Object.entries(EXPECTED_CLAUSE_STATUS).map(([clause, status]) => ({ clause, status })) };
    expect(diffClauses(mapping, EXPECTED_CLAUSE_STATUS)).toEqual([]);
  });
  it('不符与缺款各报一条', () => {
    const mapping = { clauses: [{ clause: '14(1)', status: 'none' }] };
    const d = diffClauses(mapping, { '14(1)': 'evidenced', '14(5)': 'none' });
    expect(d).toEqual(['14(1): expected evidenced, got none', '14(5): missing']);
  });
  it('多余条款不报', () => {
    const mapping = { clauses: [{ clause: '14(1)', status: 'evidenced' }, { clause: '99', status: 'none' }] };
    expect(diffClauses(mapping, { '14(1)': 'evidenced' })).toEqual([]);
  });
});

describe('articleClauses', () => {
  it('取第 14 条组', () => {
    const clauses = [{ clause: '14(1)', status: 'evidenced' }];
    expect(articleClauses({ frameworks: [{ control: 'GDPR:ART17', clauses: [] }, { control: 'EU_AI_ACT:ART14', clauses }] })).toEqual({ clauses });
  });
  it('缺第 14 条组：diffClauses 报九条 missing', () => {
    const d = diffClauses(articleClauses({ frameworks: [] }), EXPECTED_CLAUSE_STATUS);
    expect(d).toEqual(Object.keys(EXPECTED_CLAUSE_STATUS).map((c) => `${c}: missing`));
    expect(d).toHaveLength(9);
  });
});
