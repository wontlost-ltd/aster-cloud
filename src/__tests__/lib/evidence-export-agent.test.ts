// 证据查询层 agent 校验单测：畸形 jsonb agent 归一为 null，导出组装不抛错（ADR 0041 §5）。

import { describe, it, expect, vi } from 'vitest';

const findMany = vi.fn();

// select().from().where() 链：buildConditions 的子查询与 count 守卫共用；count 取 [{count}]。
const whereResult = Promise.resolve([{ count: 1 }]);
vi.mock('@/lib/prisma', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => whereResult }) }),
    query: { executions: { findMany: (...a: unknown[]) => findMany(...a) } },
  },
  executions: {},
  policies: {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ op: 'and', a }),
  eq: () => ({}),
  gte: () => ({}),
  lte: () => ({}),
  asc: () => ({}),
  isNull: () => ({}),
  isNotNull: () => ({}),
  inArray: () => ({}),
  sql: () => ({}),
}));

import { agentOf, queryEvidenceExecutions } from '@/lib/evidence-export';
import { buildBundle, buildEvidenceEntry } from '@/services/evidence/bundle';

function dbRow(agent: unknown) {
  return {
    id: 'e1', policyId: 'pol', policyVersion: 1, policyVersionRowId: null, decision: 'approved',
    canonicalInputHash: 'in', canonicalOutputHash: 'out', traceHash: 'tr', canonicalizationVersion: 'v1',
    sourceToolchainId: null, runtimeToolchainId: null, replayabilityStatus: null, replayabilityReasons: null,
    reasonCodes: null, source: 'api', durationMs: 1, createdAt: new Date('2026-10-01T00:00:00Z'),
    outcome: 'ALLOW', ruleId: null, controls: null, agent, evidenceCorrelationId: null, metadata: null,
    policy: { teamId: null, userId: 'u-1' },
  };
}

describe('queryEvidenceExecutions agent 校验', () => {
  it('★畸形 agent（model 非字符串、含非整数）→ entry.agent=null，导出组装不抛错', async () => {
    findMany.mockResolvedValue([dbRow({ provider: 'acme', model: 3, temperature: 0.7 })]);
    const [row] = await queryEvidenceExecutions({ userId: 'u-1' });
    expect(row.agent).toBeNull();
    const entry = buildEvidenceEntry(row, { status: 'legacy' }, []);
    expect(entry.agent).toBeNull();
    expect(() =>
      buildBundle({ policy: { scope: 'all' }, range: { start: null, end: null }, entries: [entry], generatedAt: new Date() }),
    ).not.toThrow();
  });

  it('agentOf：合法值只保留已知字段；可选字段类型错或非对象 → null', () => {
    expect(agentOf({ provider: 'p', model: 'm', version: '1', session: 's', source: 'declared', extra: 0.7 }))
      .toEqual({ provider: 'p', model: 'm', version: '1', session: 's', source: 'declared' });
    expect(agentOf({ provider: 'p', model: 'm' })).toEqual({ provider: 'p', model: 'm', source: 'declared' });
    expect(agentOf({ provider: 'p', model: 'm', version: 2 })).toBeNull();
    expect(agentOf(['p', 'm'])).toBeNull();
    expect(agentOf('p/m')).toBeNull();
    expect(agentOf(null)).toBeNull();
  });
});
