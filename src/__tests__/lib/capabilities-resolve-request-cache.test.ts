// resolveEntitlementForRequest 的请求内去重：缓存键必须是原始值，而非每次新建的 ctx 对象。
// 测试环境下 React cache 在请求作用域外是空操作，这里用按参数引用 / 值比较的 Map 记忆化实现替身，
// 与 React cache 的语义一致（原始值按值、对象按引用），从而能证明键的选择是否有效。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ selects: 0 }));

vi.mock('react', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('react')),
  cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
    const store = new Map<unknown, unknown>();
    return (...args: A): R => {
      let node = store;
      for (const arg of args.slice(0, -1)) {
        if (!node.has(arg)) node.set(arg, new Map());
        node = node.get(arg) as Map<unknown, unknown>;
      }
      const last = args[args.length - 1];
      if (!node.has(last)) node.set(last, fn(...args));
      return node.get(last) as R;
    };
  },
}));
vi.mock('@/db/fresh-read', () => {
  const chain = { from: () => chain, leftJoin: () => chain, where: () => chain, orderBy: async () => [] };
  return {
    freshDb: {
      select: () => {
        h.selects += 1;
        return chain;
      },
      query: { users: { findFirst: async () => ({ isAdmin: false }) } },
    },
  };
});
vi.mock('@/lib/platform-settings', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@/lib/platform-settings')),
  getSetting: vi.fn(async () => true),
}));
vi.mock('@/lib/team-plan', () => ({ planHolderForTeam: vi.fn(async (u: string) => u) }));
vi.mock('@/lib/usage', () => ({ hasFeatureAccess: vi.fn(async () => true) }));

import { resolveEntitlementForRequest } from '@/lib/capabilities/resolve';

beforeEach(() => {
  h.selects = 0;
});

describe('resolveEntitlementForRequest 去重', () => {
  it('参数相同但 ctx 对象不同：底层查询只执行一次', async () => {
    await resolveEntitlementForRequest('u-cache-1', 'structured_authoring', { teamId: 't1' });
    const afterFirst = h.selects;
    expect(afterFirst).toBeGreaterThan(0);
    await resolveEntitlementForRequest('u-cache-1', 'structured_authoring', { teamId: 't1' });
    expect(h.selects).toBe(afterFirst);
  });

  it('teamId 不同则各自查询', async () => {
    await resolveEntitlementForRequest('u-cache-2', 'structured_authoring', { teamId: 't1' });
    const afterFirst = h.selects;
    await resolveEntitlementForRequest('u-cache-2', 'structured_authoring', { teamId: null });
    expect(h.selects).toBeGreaterThan(afterFirst);
  });
});
