// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

// 按调用顺序依次返回预置结果；每次 select 链都在 where 处落地为一个 Promise。
const state = vi.hoisted(() => ({ results: [] as unknown[][], calls: 0 }));

vi.mock('@/db/fresh-read', () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.innerJoin = () => chain;
  chain.where = () => {
    state.calls += 1;
    return Promise.resolve(state.results.shift() ?? []);
  };
  return { freshDb: { select: () => chain } };
});

import { resolveOrphanRecipients } from '@/lib/guard-orphan-notify/recipients';

beforeEach(() => {
  state.results = [];
  state.calls = 0;
});

describe('resolveOrphanRecipients', () => {
  it('团队：owner / admin 收，member / viewer / 未知角色不收；去重并排序', async () => {
    state.results = [
      [{ name: 'Team A' }],
      [
        { userId: 'u-3', role: 'owner' },
        { userId: 'u-1', role: 'admin' },
        { userId: 'u-1', role: 'admin' },
        { userId: 'u-2', role: 'member' },
        { userId: 'u-4', role: 'viewer' },
        { userId: 'u-5', role: 'bogus' },
      ],
    ];
    expect(await resolveOrphanRecipients('team-1')).toEqual({
      kind: 'team',
      tenantName: 'Team A',
      userIds: ['u-1', 'u-3'],
    });
  });

  it('团队没有管理员时返回空 userIds 而非 unknown', async () => {
    state.results = [[{ name: 'Team A' }], [{ userId: 'u-2', role: 'member' }]];
    expect(await resolveOrphanRecipients('team-1')).toEqual({ kind: 'team', tenantName: 'Team A', userIds: [] });
  });

  it('个人租户：本人收', async () => {
    state.results = [[], [{ id: 'u-1', deletedAt: null }]];
    expect(await resolveOrphanRecipients('u-1')).toEqual({ kind: 'personal', userIds: ['u-1'] });
  });

  it('个人租户用户已删：personal 且 userIds 为空', async () => {
    state.results = [[], [{ id: 'u-1', deletedAt: new Date() }]];
    expect(await resolveOrphanRecipients('u-1')).toEqual({ kind: 'personal', userIds: [] });
  });

  it('既非团队也非用户：unknown', async () => {
    state.results = [[], []];
    expect(await resolveOrphanRecipients('nobody')).toEqual({ kind: 'unknown' });
  });

  it('每次调用都重新查询，不缓存', async () => {
    state.results = [[{ name: 'T' }], [{ userId: 'u-1', role: 'admin' }]];
    expect(await resolveOrphanRecipients('team-1')).toMatchObject({ userIds: ['u-1'] });
    state.results = [[{ name: 'T' }], [{ userId: 'u-1', role: 'member' }]];
    expect(await resolveOrphanRecipients('team-1')).toMatchObject({ userIds: [] });
    expect(state.calls).toBe(4);
  });
});
