// 策略物理删除时释放词汇快照引用（#628）。
//
// 缺陷：审批冻结对每个引用的快照 refCount +1，但 purgePolicy 删除策略（级联删除版本行）时
// 从不递减，快照永远显示「仍被引用」。这里钉住：引用计数口径与冻结对称、递减有 0 下限、
// 全部写操作走调用方传入的事务。真实 Postgres 行为见 integration/policy-purge-vocabulary-refs。

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => {
  const tableProxy = new Proxy({}, { get: (_t, k) => ({ column: String(k) }) });
  return {
    db: {},
    domainTerms: tableProxy,
    policyVersions: tableProxy,
    userDomainTerms: tableProxy,
    userVocabularySnapshots: tableProxy,
  };
});
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: vi.fn() }));

import { countSnapshotRefs, releaseSnapshotRefsForPolicy } from '@/lib/domain-vocabulary-snapshot';

const ref = (snapshotId: string) => ({ snapshotId, domain: 'd', locale: 'de' });

describe('countSnapshotRefs', () => {
  it('同一快照被多个版本引用：按版本数累计', () => {
    expect(countSnapshotRefs([[ref('s1'), ref('s2')], [ref('s1')], []])).toEqual([
      ['s1', 2],
      ['s2', 1],
    ]);
  });

  it('结果按 id 排序（稳定的行锁顺序）', () => {
    expect(countSnapshotRefs([[ref('zz'), ref('aa'), ref('mm')]]).map(([id]) => id)).toEqual([
      'aa',
      'mm',
      'zz',
    ]);
  });

  it('忽略 null / 非数组 / 缺 snapshotId 的脏数据', () => {
    expect(
      countSnapshotRefs([null, undefined, 'x', {}, [null, {}, { snapshotId: '' }, { snapshotId: 7 }, ref('ok')]]),
    ).toEqual([['ok', 1]]);
  });

  it('没有任何引用 → 空', () => {
    expect(countSnapshotRefs([])).toEqual([]);
    expect(countSnapshotRefs([[], []])).toEqual([]);
  });
});

/** 记录调用的假事务：select 返回给定版本行，update 记录 set/where。 */
function fakeTx(versionRefs: unknown[]) {
  const updates: Array<{ set: unknown; where: unknown }> = [];
  const selectWhere = vi.fn().mockResolvedValue(versionRefs.map((refs) => ({ refs })));
  const tx = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) })),
    update: vi.fn(() => ({
      set: (set: unknown) => ({
        where: async (where: unknown) => {
          updates.push({ set, where });
        },
      }),
    })),
  };
  return { tx, updates, selectWhere };
}

describe('releaseSnapshotRefsForPolicy', () => {
  it('每个被引用快照一次 UPDATE，递减量 = 引用次数，且带 0 下限', async () => {
    const { tx, updates } = fakeTx([[ref('s1'), ref('s2')], [ref('s1')]]);
    const n = await releaseSnapshotRefsForPolicy('p1', tx as never);
    expect(n).toBe(2);
    expect(updates).toHaveLength(2);
    // drizzle sql 片段里依次是：GREATEST(… - <times>, 0)
    const chunks = (u: { set: unknown }) =>
      JSON.stringify((u.set as { refCount: { queryChunks: unknown[] } }).refCount.queryChunks);
    expect(chunks(updates[0])).toContain('GREATEST(');
    expect(chunks(updates[0])).toContain(', 0)');
    expect((updates[0].set as { refCount: { queryChunks: unknown[] } }).refCount.queryChunks).toContain(2);
    expect((updates[1].set as { refCount: { queryChunks: unknown[] } }).refCount.queryChunks).toContain(1);
  });

  it('策略没有任何快照引用 → 不发 UPDATE', async () => {
    const { tx, updates } = fakeTx([[], null]);
    expect(await releaseSnapshotRefsForPolicy('p1', tx as never)).toBe(0);
    expect(updates).toEqual([]);
    expect(tx.update).not.toHaveBeenCalled();
  });
});
