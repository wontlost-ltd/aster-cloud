// 回收站永久删除 / 过期清理 / 清空，以及孤儿行容错（#603）。
//
// 缺陷：PolicyRecycleBin.policyId 无外键，永久删除只删 Policy，留下孤儿回收站行，
// getTrashItems 在 item.policy.name 处抛 TypeError，回收站整页 500。
// 本文件钉住：三条删除路径都在同一事务里先释放词汇快照引用（#628）、再删回收站行、最后删策略；
// 列表遇孤儿跳过而非崩溃。
// 外键级联本身在真实 Postgres 上验证，见 integration/policy-trash-and-grants.integration.test.ts。

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const deletes: Array<{ table: unknown; inTx: boolean }> = [];
  const makeDelete = (inTx: boolean) =>
    vi.fn((table: unknown) => {
      deletes.push({ table, inTx });
      return { where: vi.fn().mockResolvedValue(undefined) };
    });
  const txDelete = makeDelete(true);
  // 事务回调拿到的 tx 对象；释放函数必须收到的就是它
  const TX = { delete: txDelete };
  return {
    deletes,
    TX,
    // 释放快照引用也记进同一条操作序列，用来校验「先释放、后删版本行」的顺序与事务归属
    release: vi.fn(async (policyId: string, tx: unknown) => {
      deletes.push({ table: `release:${policyId}`, inTx: tx === TX });
      return 0;
    }),
    txDelete,
    dbDelete: makeDelete(false),
    transaction: vi.fn(),
    policyFindFirst: vi.fn(),
    binFindMany: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({
  db: {
    delete: h.dbDelete,
    transaction: h.transaction,
    query: {
      policies: { findFirst: h.policyFindFirst },
      policyRecycleBins: { findMany: h.binFindMany },
    },
  },
  policies: { id: { name: 'Policy.id' }, userId: {}, deletedAt: {}, name: {} },
  policyRecycleBins: { policyId: { name: 'PolicyRecycleBin.policyId' }, userId: {}, deletedAt: {}, expiresAt: {} },
}));

vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  releaseSnapshotRefsForPolicy: h.release,
}));

import { policies, policyRecycleBins } from '@/lib/prisma';
import {
  cleanupExpiredTrashItems,
  emptyTrash,
  getTrashItems,
  permanentDeletePolicy,
} from '@/lib/policy-lifecycle';

const DAY = 24 * 60 * 60 * 1000;

function binRow(id: string, policy: { id: string; name: string; description: string | null } | null) {
  return {
    id,
    policyId: policy?.id ?? `gone-${id}`,
    deletedAt: new Date(),
    deletedBy: 'user-1',
    expiresAt: new Date(Date.now() + 10 * DAY),
    policy,
  };
}

// 每次 purge 必须是：一次事务内「释放快照引用 → 删回收站行 → 删策略」，且不在事务外直接删。
function expectPurgedInTx(policyIds: string[]) {
  expect(h.transaction).toHaveBeenCalledTimes(policyIds.length);
  expect(h.dbDelete).not.toHaveBeenCalled();
  const expected = policyIds.flatMap((id) => [
    { table: `release:${id}`, inTx: true },
    { table: policyRecycleBins, inTx: true },
    { table: policies, inTx: true },
  ]);
  expect(h.deletes).toEqual(expected);
}

describe('policy-lifecycle 永久删除路径（#603）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.deletes.length = 0;
    h.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
      fn(h.TX),
    );
  });

  it('permanentDeletePolicy：同一事务内删除回收站行与策略', async () => {
    h.policyFindFirst.mockResolvedValue({ id: 'p1' });
    const r = await permanentDeletePolicy('p1', 'user-1');
    expect(r).toEqual({ success: true, policyId: 'p1' });
    expectPurgedInTx(['p1']);
  });

  it('permanentDeletePolicy：策略不在回收站 → 不删除任何东西', async () => {
    h.policyFindFirst.mockResolvedValue(undefined);
    const r = await permanentDeletePolicy('p1', 'user-1');
    expect(r.success).toBe(false);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('permanentDeletePolicy：事务失败 → 返回失败而非抛出', async () => {
    h.policyFindFirst.mockResolvedValue({ id: 'p1' });
    h.transaction.mockRejectedValue(new Error('deadlock'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await permanentDeletePolicy('p1', 'user-1');
    expect(r).toMatchObject({ success: false, error: 'deadlock' });
    errSpy.mockRestore();
  });

  it('释放快照引用失败 → 整个删除失败，不删策略（refCount 与版本行同进退）', async () => {
    h.policyFindFirst.mockResolvedValue({ id: 'p1' });
    h.release.mockRejectedValueOnce(new Error('lock timeout'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await permanentDeletePolicy('p1', 'user-1');
    expect(r).toMatchObject({ success: false, error: 'lock timeout' });
    expect(h.txDelete).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('cleanupExpiredTrashItems：每个过期项都在事务内连同回收站行删除', async () => {
    h.binFindMany.mockResolvedValue([{ policyId: 'p1' }, { policyId: 'p2' }]);
    const r = await cleanupExpiredTrashItems();
    expect(r).toEqual({ deletedCount: 2, errors: [] });
    expectPurgedInTx(['p1', 'p2']);
  });

  it('cleanupExpiredTrashItems：单项失败不中断其余项，并记录错误', async () => {
    h.binFindMany.mockResolvedValue([{ policyId: 'p1' }, { policyId: 'p2' }]);
    h.transaction
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(async (fn: (tx: unknown) => Promise<void>) => fn(h.TX));
    const r = await cleanupExpiredTrashItems();
    expect(r.deletedCount).toBe(1);
    expect(r.errors).toEqual([expect.stringContaining('p1')]);
  });

  it('emptyTrash：同样连同回收站行删除', async () => {
    h.binFindMany.mockResolvedValue([{ policyId: 'p1' }]);
    const r = await emptyTrash('user-1');
    expect(r).toEqual({ deletedCount: 1, errors: [] });
    expectPurgedInTx(['p1']);
  });

  it('getTrashItems：孤儿行（策略已不存在）跳过并告警，其余正常返回', async () => {
    h.binFindMany.mockResolvedValue([
      binRow('b1', { id: 'p1', name: '保留的策略', description: null }),
      binRow('b2', null),
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await getTrashItems('user-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'b1', policyId: 'p1', name: '保留的策略', daysRemaining: 10 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('孤儿行'), 'b2', 'gone-b2');
    warn.mockRestore();
  });
});
