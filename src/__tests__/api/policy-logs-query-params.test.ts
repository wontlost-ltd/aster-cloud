/**
 * GET /api/policies/[id]/logs 的查询参数校验（#479）。
 *
 * 曾直接 parseInt：`?page=abc` → NaN，Drizzle 丢掉 NaN 的 limit/offset → 返回该策略全部日志；
 * `?days=abc` → Invalid Date → 500；非法 source / 日期同样一路传到数据库。
 * 这里断言交给查询层的参数，而不是查询结果。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSession, mockFindFirst, mockQueryLogs, mockStats, mockRecent } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockFindFirst: vi.fn(),
  mockQueryLogs: vi.fn(),
  mockStats: vi.fn(),
  mockRecent: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/prisma', () => ({
  db: { query: { policies: { findFirst: mockFindFirst } } },
  policies: { id: 'id', userId: 'userId', deletedAt: 'deletedAt' },
}));
vi.mock('@/lib/policy-execution-log', () => ({
  queryExecutionLogs: mockQueryLogs,
  getExecutionStats: mockStats,
  getRecentExecutions: mockRecent,
}));

import { GET } from '@/app/api/policies/[id]/logs/route';

const call = (qs: string) =>
  GET(new Request(`https://x.test/api/policies/p1/logs${qs}`), { params: Promise.resolve({ id: 'p1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
  mockFindFirst.mockResolvedValue({ id: 'p1', name: 'Calc' });
  mockQueryLogs.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  mockStats.mockResolvedValue({});
  mockRecent.mockResolvedValue([]);
});

const queryArgs = () => mockQueryLogs.mock.calls[0][0];

describe('GET /api/policies/[id]/logs — 分页参数', () => {
  it('★page / pageSize 非数字时回落默认值，不传 NaN', async () => {
    const res = await call('?page=abc&pageSize=xyz');
    expect(res.status).toBe(200);
    expect(queryArgs()).toMatchObject({ page: 1, pageSize: 20 });
  });

  it('★page=0 / 负数回落 1；pageSize 截到 100', async () => {
    await call('?page=-2&pageSize=5000');
    expect(queryArgs()).toMatchObject({ page: 1, pageSize: 100 });
  });

  it('合法值原样传递', async () => {
    await call('?page=3&pageSize=50');
    expect(queryArgs()).toMatchObject({ page: 3, pageSize: 50 });
  });
});

describe('GET /api/policies/[id]/logs — 过滤参数', () => {
  it('★非法日期与非法 source 被忽略（不传 Invalid Date / 非法枚举）', async () => {
    const res = await call('?startDate=abc&endDate=2026-99-99&source=bogus&decision=nope');
    expect(res.status).toBe(200);
    const args = queryArgs();
    expect(args.startDate).toBeUndefined();
    expect(args.endDate).toBeUndefined();
    expect(args.source).toBeUndefined();
    expect(args.decision).toBeUndefined();
  });

  it('合法日期与 source 原样传递', async () => {
    await call('?startDate=2026-01-02&source=api&decision=denied');
    const args = queryArgs();
    expect(args.startDate.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(args.source).toBe('api');
    expect(args.decision).toBe('denied');
  });
});

describe('GET /api/policies/[id]/logs — stats / recent 模式', () => {
  it('★days 非数字回落 30，过大截到 365', async () => {
    expect((await call('?mode=stats&days=abc')).status).toBe(200);
    expect(mockStats).toHaveBeenLastCalledWith('u1', 'p1', 30);
    await call('?mode=stats&days=99999');
    expect(mockStats).toHaveBeenLastCalledWith('u1', 'p1', 365);
    await call('?mode=stats&days=7');
    expect(mockStats).toHaveBeenLastCalledWith('u1', 'p1', 7);
  });

  it('★recent 的 limit 非数字回落 10，过大截到 100', async () => {
    await call('?mode=recent&limit=abc');
    expect(mockRecent).toHaveBeenLastCalledWith('p1', 'u1', 10);
    await call('?mode=recent&limit=100000');
    expect(mockRecent).toHaveBeenLastCalledWith('p1', 'u1', 100);
  });
});
