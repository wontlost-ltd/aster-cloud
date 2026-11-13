// @vitest-environment node
// 用户 id → 展示信息的批量查询（自 version-approvals-inbox 的 loadDisplayNames 抽出，供签发方列表共用）：
// 去重后一次 inArray 查询，空集合不查库，查不到的 id 不出现在结果里。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({ usersFindMany: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  db: { query: { users: { findMany: h.usersFindMany } } },
  users: { id: { name: 'users.id' } },
}));
vi.mock('drizzle-orm', () => ({
  inArray: (col: { name: string }, values: unknown[]) => ({ inArray: [col.name, values] }),
}));

const { loadUserProfiles } = await import('@/lib/user-profiles');

describe('loadUserProfiles', () => {
  beforeEach(() => h.usersFindMany.mockReset());

  it('空集合不查库', async () => {
    expect((await loadUserProfiles([])).size).toBe(0);
    expect(h.usersFindMany).not.toHaveBeenCalled();
  });

  it('去重后一次批量查询，只取展示列；查不到的 id 不在结果里', async () => {
    h.usersFindMany.mockResolvedValue([
      { id: 'u1', name: 'Ann', email: 'ann@x.test', image: null },
      { id: 'u2', name: null, email: 'bob@x.test', image: 'https://img/b.png' },
    ]);
    const map = await loadUserProfiles(['u1', 'u2', 'u1', 'gone']);

    expect(h.usersFindMany).toHaveBeenCalledTimes(1);
    expect(h.usersFindMany).toHaveBeenCalledWith({
      where: { inArray: ['users.id', ['u1', 'u2', 'gone']] },
      columns: { id: true, name: true, email: true, image: true },
    });
    expect(map.get('u1')).toEqual({ name: 'Ann', email: 'ann@x.test', image: null });
    expect(map.get('u2')).toEqual({ name: null, email: 'bob@x.test', image: 'https://img/b.png' });
    expect(map.has('gone')).toBe(false);
  });
});
