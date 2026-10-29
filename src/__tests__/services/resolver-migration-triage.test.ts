// resolver 迁移（ADR 0051 §9）的纯函数部分：错误截断不拆代理对、失败按原因/诊断码分组。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ db: {}, policies: {}, policyVersions: {} }));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn() }));

import {
  buildTriage,
  missingResolverMigrationEnv,
  truncateMigrationError,
  type MigrationFailure,
} from '@/services/policy/resolver-migration';

function failure(id: string, patch: Partial<MigrationFailure>): MigrationFailure {
  return { id, policyId: `p-${id}`, version: 1, ownerId: 'u1', category: 'compile', error: 'x', codes: [], ...patch };
}

describe('truncateMigrationError', () => {
  it('不超长原样返回，空值给出占位', () => {
    expect(truncateMigrationError('E802: x')).toBe('E802: x');
    expect(truncateMigrationError('  ')).toBe('unknown error');
    expect(truncateMigrationError(null)).toBe('unknown error');
  });

  it('截到 4000 字符；截断点落在代理对中间时少截一位', () => {
    expect(truncateMigrationError('a'.repeat(5000))).toHaveLength(4000);
    const split = truncateMigrationError(`${'a'.repeat(3999)}😀tail`);
    expect(split).toBe('a'.repeat(3999));
    const whole = truncateMigrationError(`${'a'.repeat(3998)}😀tail`);
    expect(whole).toBe(`${'a'.repeat(3998)}😀`);
  });
});

describe('buildTriage', () => {
  it('按原因与诊断码分组：E801 单列，构造写法单列，词汇按用户，其余编译失败归 otherCompile', () => {
    const triage = buildTriage([
      failure('e8', { codes: ['E802'] }),
      failure('mixed', { codes: ['E801', 'E804'] }),
      failure('e801', { codes: ['E801'] }),
      failure('construct', { codes: ['P005'], invalidConstructForm: true }),
      failure('p005', { codes: ['P005'] }),
      failure('v1', { category: 'vocabulary', ownerId: 'alice', reason: 'field_parent_required', term: 'alter', kind: 'field' }),
      failure('v2', { category: 'vocabulary', ownerId: 'alice', reason: 'literal_conflict' }),
      failure('v3', { category: 'vocabulary', ownerId: 'bob', reason: 'member_parent_required' }),
      failure('int', { category: 'integrity' }),
      failure('infra', { category: 'infrastructure', policyId: null, version: null, ownerId: null }),
    ]);
    const ids = (list: MigrationFailure[]) => list.map((f) => f.id);
    expect(ids(triage.e8xx)).toEqual(['e8', 'mixed']);
    expect(ids(triage.untypedFieldAccess)).toEqual(['mixed', 'e801']);
    expect(ids(triage.invalidConstructForm)).toEqual(['construct']);
    expect(ids(triage.otherCompile)).toEqual(['p005']);
    expect(Object.fromEntries(Object.entries(triage.vocabularyScopeByUser).map(([u, l]) => [u, ids(l)])))
      .toEqual({ alice: ['v1', 'v2'], bob: ['v3'] });
    expect(ids(triage.integrityMismatch)).toEqual(['int']);
    expect(ids(triage.infrastructure)).toEqual(['infra']);
  });
});

describe('missingResolverMigrationEnv（迁移入口 fail closed）', () => {
  it('内部地址与签名密钥缺一不可，空白视为缺失', () => {
    expect(missingResolverMigrationEnv({})).toEqual(['ASTER_POLICY_API_INTERNAL_URL', 'ASTER_PLAN_GATE_HMAC_KEY']);
    expect(missingResolverMigrationEnv({ ASTER_POLICY_API_INTERNAL_URL: 'http://api', ASTER_PLAN_GATE_HMAC_KEY: ' ' }))
      .toEqual(['ASTER_PLAN_GATE_HMAC_KEY']);
    // 公开地址不能替代内部地址：共享客户端会回落到它或生产地址
    expect(missingResolverMigrationEnv({ NEXT_PUBLIC_ASTER_POLICY_API_URL: 'http://api', ASTER_PLAN_GATE_HMAC_KEY: 'k' }))
      .toEqual(['ASTER_POLICY_API_INTERNAL_URL']);
    expect(missingResolverMigrationEnv({ ASTER_POLICY_API_INTERNAL_URL: 'http://api', ASTER_PLAN_GATE_HMAC_KEY: 'k' })).toEqual([]);
  });
});
