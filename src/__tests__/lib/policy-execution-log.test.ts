// Execution 证据列（ADR 0041 §4、ADR 0046 §6）：profile 随评估响应落库，缺省显式写 null。
import { describe, it, expect } from 'vitest';
import { buildEvidenceColumns } from '@/lib/policy-execution-log';

describe('buildEvidenceColumns', () => {
  it('带 profile 时写入档案 id', () => {
    expect(buildEvidenceColumns({ profile: 'governed' }, null).profile).toBe('governed');
  });

  it('未声明档案时 profile 为 null', () => {
    const cols = buildEvidenceColumns({ ruleId: 'R-1', controls: ['GDPR:ART17'] }, null);
    expect(cols.profile).toBeNull();
    expect(cols).toMatchObject({ ruleId: 'R-1', controls: ['GDPR:ART17'], agent: null, evidenceCorrelationId: null });
  });
});
