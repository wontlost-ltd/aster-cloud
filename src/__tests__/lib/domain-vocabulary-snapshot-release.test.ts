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
    policies: tableProxy,
    policyVersions: tableProxy,
    userDomainTerms: tableProxy,
    userVocabularySnapshots: tableProxy,
  };
});
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: vi.fn() }));

import {
  countSnapshotRefs,
  lockPolicyForSnapshotRefs,
  releaseSnapshotRefsForPolicy,
} from '@/lib/domain-vocabulary-snapshot';

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

/**
 * 记录调用的假事务：第一次 select 返回版本行（from→where），第二次返回快照当前计数
 * （from→where→orderBy→for('update')）；update 记录 set/where。
 */
function fakeTx(versionRefs: unknown[], snapshotCounts: Record<string, number> = {}) {
  const updates: Array<{ set: unknown; where: unknown }> = [];
  const lockModes: string[] = [];
  const versionRows = versionRefs.map((refs) => ({ refs }));
  const snapshotRows = Object.entries(snapshotCounts).map(([id, refCount]) => ({ id, refCount }));
  let selects = 0;
  const tx = {
    select: vi.fn(() => {
      selects += 1;
      if (selects === 1) return { from: () => ({ where: async () => versionRows }) };
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({
              for: async (mode: string) => {
                lockModes.push(mode);
                return snapshotRows;
              },
            }),
          }),
        }),
      };
    }),
    update: vi.fn(() => ({
      set: (set: unknown) => ({
        where: async (where: unknown) => {
          updates.push({ set, where });
        },
      }),
    })),
  };
  return { tx, updates, lockModes };
}

const chunksOf = (u: { set: unknown }) => (u.set as { refCount: { queryChunks: unknown[] } }).refCount.queryChunks;

describe('releaseSnapshotRefsForPolicy', () => {
  it('每个被引用快照一次 UPDATE，递减量 = 引用次数，带 0 下限，且先 FOR UPDATE 锁快照行', async () => {
    const { tx, updates, lockModes } = fakeTx([[ref('s1'), ref('s2')], [ref('s1')]], { s1: 5, s2: 1 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = await releaseSnapshotRefsForPolicy('p1', tx as never);
    expect(n).toBe(2);
    expect(lockModes).toEqual(['update']);
    expect(updates).toHaveLength(2);
    // drizzle sql 片段里依次是：GREATEST(… - <times>, 0)
    expect(JSON.stringify(chunksOf(updates[0]))).toContain('GREATEST(');
    expect(JSON.stringify(chunksOf(updates[0]))).toContain(', 0)');
    expect(chunksOf(updates[0])).toContain(2);
    expect(chunksOf(updates[1])).toContain(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('要减的次数超过现有计数：仍夹到 0，但记告警（不变量被破坏不能静默吞掉）', async () => {
    const { tx, updates } = fakeTx([[ref('s1')], [ref('s1')]], { s1: 1 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await releaseSnapshotRefsForPolicy('p1', tx as never);
    expect(updates).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('underflow'),
      expect.objectContaining({ policyId: 'p1', snapshotId: 's1', refCount: 1, times: 2 }),
    );
    warn.mockRestore();
  });

  it('引用指向已不存在的快照行：告警并跳过', async () => {
    const { tx, updates } = fakeTx([[ref('gone')]], {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await releaseSnapshotRefsForPolicy('p1', tx as never)).toBe(0);
    expect(updates).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('underflow'), expect.objectContaining({ refCount: null }));
    warn.mockRestore();
  });

  it('策略没有任何快照引用 → 不锁不改', async () => {
    const { tx, updates } = fakeTx([[], null]);
    expect(await releaseSnapshotRefsForPolicy('p1', tx as never)).toBe(0);
    expect(updates).toEqual([]);
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled();
  });
});

describe('lockPolicyForSnapshotRefs', () => {
  function lockTx(rows: Array<{ id: string; deletedAt: Date | null }>) {
    const modes: string[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: async (mode: string) => {
              modes.push(mode);
              return rows;
            },
          }),
        }),
      }),
    };
    return { tx, modes };
  }

  it('策略存在且未软删 → true，并以 FOR UPDATE 加锁', async () => {
    const { tx, modes } = lockTx([{ id: 'p1', deletedAt: null }]);
    expect(await lockPolicyForSnapshotRefs(tx as never, 'p1')).toBe(true);
    expect(modes).toEqual(['update']);
  });

  it('策略已删除或已软删 → false', async () => {
    expect(await lockPolicyForSnapshotRefs(lockTx([]).tx as never, 'p1')).toBe(false);
    expect(await lockPolicyForSnapshotRefs(lockTx([{ id: 'p1', deletedAt: new Date() }]).tx as never, 'p1')).toBe(false);
  });
});
