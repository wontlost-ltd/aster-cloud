/**
 * GET /api/policies/[id]/logs 的查询参数校验（#479）。
 *
 * 曾直接 parseInt：`?page=abc` → NaN，Drizzle 丢掉 NaN 的 limit/offset → 返回该策略全部日志；
 * `?days=abc` → Invalid Date → 500；非法 source / 日期同样一路传到数据库。
 * 这里断言交给查询层的参数，而不是查询结果。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetSession, mockQueryLogs, mockStats, mockRecent } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockQueryLogs: vi.fn(),
  mockStats: vi.fn(),
  mockRecent: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: mockGetSession }));
vi.mock('@/lib/policy-access', async () =>
  (await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule());
vi.mock('@/lib/policy-execution-log', () => ({
  queryExecutionLogs: mockQueryLogs,
  getExecutionStats: mockStats,
  getRecentExecutions: mockRecent,
}));

import { GET } from '@/app/api/policies/[id]/logs/route';
import { policyAccessState } from '@/__tests__/helpers/policy-access-mock';

const call = (qs: string) =>
  GET(new Request(`https://x.test/api/policies/p1/logs${qs}`), { params: Promise.resolve({ id: 'p1' }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({ user: { id: 'u1' } });
  policyAccessState.policy = { id: 'p1', name: 'Calc', userId: 'u1', teamId: null };
  policyAccessState.teamRole = null;
  mockQueryLogs.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });
  mockStats.mockResolvedValue({});
  mockRecent.mockResolvedValue([]);
});

const queryArgs = () => mockQueryLogs.mock.calls.at(-1)![0];

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

  it('旧 success / failed 参数映射到兼容分桶，显式 decision 过滤保持精确', async () => {
    await call('?success=true');
    expect(queryArgs()).toMatchObject({ legacyApproved: true, legacyFailed: false });
    await call('?success=false');
    expect(queryArgs()).toMatchObject({ legacyFailed: true, legacyApproved: false });
    await call('?decision=failed');
    expect(queryArgs()).toMatchObject({ legacyFailed: true });
    await call('?decision=error');
    expect(queryArgs()).toMatchObject({ decision: 'error', legacyError: true });
    await call('?decision=approved');
    expect(queryArgs()).toMatchObject({ decision: 'approved' });
  });

  it('CLI 来源可传入执行日志查询层', async () => {
    await call('?source=cli');
    expect(queryArgs()).toMatchObject({ source: 'cli' });
  });
});

describe('GET /api/policies/[id]/logs — stats / recent 模式', () => {
  it('★days 非数字回落 30，过大截到 365', async () => {
    expect((await call('?mode=stats&days=abc')).status).toBe(200);
    expect(mockStats).toHaveBeenLastCalledWith({ kind: 'user', userId: 'u1' }, 'p1', 30);
    await call('?mode=stats&days=99999');
    expect(mockStats).toHaveBeenLastCalledWith({ kind: 'user', userId: 'u1' }, 'p1', 365);
    await call('?mode=stats&days=7');
    expect(mockStats).toHaveBeenLastCalledWith({ kind: 'user', userId: 'u1' }, 'p1', 7);
  });

  it('★recent 的 limit 非数字回落 10，过大截到 100', async () => {
    await call('?mode=recent&limit=abc');
    expect(mockRecent).toHaveBeenLastCalledWith('p1', { kind: 'user', userId: 'u1' }, 10);
    await call('?mode=recent&limit=100000');
    expect(mockRecent).toHaveBeenLastCalledWith('p1', { kind: 'user', userId: 'u1' }, 100);
  });
});

// 授权与执行人范围（#669 #670 #673）
describe('GET /api/policies/[id]/logs — 授权与执行人范围', () => {
  const teamPolicy = { id: 'p1', name: 'Calc', userId: 'creator', teamId: 't1' };

  it('团队策略：非创建者的成员可看；明细只含团队现任成员的执行，统计计入全部执行（审查 M1）', async () => {
    policyAccessState.policy = teamPolicy;
    policyAccessState.teamRole = 'viewer';
    expect((await call('')).status).toBe(200);
    expect(queryArgs()).toMatchObject({ executors: { kind: 'teamMembers', teamId: 't1' }, policyId: 'p1' });
    await call('?mode=stats');
    expect(mockStats).toHaveBeenLastCalledWith({ kind: 'all' }, 'p1', 30);
    await call('?mode=recent');
    expect(mockRecent).toHaveBeenLastCalledWith('p1', { kind: 'teamMembers', teamId: 't1' }, 10);
  });

  it('个人策略：只看所有者本人的执行', async () => {
    await call('');
    expect(queryArgs()).toMatchObject({ executors: { kind: 'user', userId: 'u1' } });
  });

  it('团队外用户 / 已离队的创建者 → 404，不查日志', async () => {
    policyAccessState.policy = { ...teamPolicy, userId: 'u1' };
    policyAccessState.teamRole = null;
    expect((await call('')).status).toBe(404);
    expect(mockQueryLogs).not.toHaveBeenCalled();
  });

  it('他人的个人策略 → 404', async () => {
    policyAccessState.policy = { id: 'p1', name: 'Calc', userId: 'other', teamId: null };
    expect((await call('')).status).toBe(404);
  });
});
