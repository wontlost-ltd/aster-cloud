// @vitest-environment node
// 审批收件箱「策略版本审批」（生产 E2E Q1）：范围与 approveVersion 同口径——名下未删除策略 ∪ 担任 owner/admin
// 的团队的策略；canAct 走 decideVersionApproval（团队 admin 非作者可审、作者只读、个人策略所有者可自审）；
// 提交人/提交时间取最近一次提交审批事件，缺事件时退回版本作者与创建时间。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  policiesFindMany: vi.fn(),
  membersFindMany: vi.fn(),
  versionsFindMany: vi.fn(),
  eventsQuery: vi.fn(),
  eventsChain: {} as Record<string, unknown>,
  usersFindMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const col = (name: string) => ({ name });
  return {
    db: {
      query: {
        policies: { findMany: h.policiesFindMany },
        teamMembers: { findMany: h.membersFindMany },
        policyVersions: { findMany: h.versionsFindMany },
        users: { findMany: h.usersFindMany },
      },
      // 提交事件走 selectDistinctOn 链：记录每一步的参数，最终 limit() 返回 eventsQuery 的结果
      selectDistinctOn: (on: unknown, fields: unknown) => {
        const chain: Record<string, unknown> = { on, fields };
        h.eventsChain = chain;
        return {
          from: (t: unknown) => (chain.from = t, {
            where: (w: unknown) => (chain.where = w, {
              orderBy: (...o: unknown[]) => (chain.orderBy = o, {
                limit: (n: number) => (chain.limit = n, h.eventsQuery()),
              }),
            }),
          }),
        };
      },
    },
    policies: { userId: col('policies.userId'), teamId: col('policies.teamId'), deletedAt: col('policies.deletedAt') },
    teamMembers: { userId: col('teamMembers.userId'), teamId: col('teamMembers.teamId'), role: col('teamMembers.role') },
    policyVersions: { policyId: col('policyVersions.policyId'), status: col('policyVersions.status') },
    securityEvents: {
      policyId: col('securityEvents.policyId'), eventType: col('securityEvents.eventType'),
      details: col('securityEvents.details'), createdAt: col('securityEvents.createdAt'),
    },
    users: { id: col('users.id') },
  };
});
vi.mock('drizzle-orm', () => ({
  and: (...c: unknown[]) => ({ and: c }),
  or: (...c: unknown[]) => ({ or: c }),
  eq: (c: { name: string }, v: unknown) => ({ eq: [c.name, v] }),
  inArray: (c: { name: string }, v: unknown) => ({ inArray: [c.name, v] }),
  isNull: (c: { name: string }) => ({ isNull: c.name }),
  desc: (c: { name: string }) => ({ desc: c.name }),
  // 模板标签：把字面量片段拼起来、插值按原样收集，便于断言过滤条件
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values }),
    { join: (parts: unknown[]) => ({ join: parts }) },
  ),
}));

import { listPendingVersionApprovals } from '@/lib/version-approvals-inbox';

const T0 = new Date('2026-10-20T00:00:00Z');
const T1 = new Date('2026-10-21T00:00:00Z');
const T2 = new Date('2026-10-22T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.membersFindMany.mockResolvedValue([]);
  h.policiesFindMany.mockResolvedValue([
    { id: 'p1', name: 'loan-evaluation', userId: 'owner', teamId: null },
    { id: 'p2', name: 'refund', userId: 'owner', teamId: null },
  ]);
  h.eventsQuery.mockResolvedValue([]);
  h.usersFindMany.mockResolvedValue([]);
});

/** 个人策略谓词（policy-access 的 isPersonalPolicy，经模板标签替身渲染） */
/** 成员关系读取绕过查询缓存（@/db/fresh-read） */
const FRESH = { sql: 'NOW() IS NOT NULL', values: [] };
const PERSONAL = { sql: "coalesce(?, '') = ''", values: [{ name: 'policies.teamId' }] };

describe('listPendingVersionApprovals', () => {
  it('无团队审阅角色：只查名下未删除个人策略的待审批版本（自己创建的团队策略不带入）', async () => {
    h.versionsFindMany.mockResolvedValue([]);

    await listPendingVersionApprovals('owner');

    expect(h.policiesFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { and: [{ and: [{ eq: ['policies.userId', 'owner'] }, PERSONAL] }, { isNull: 'policies.deletedAt' }] },
    }));
    expect(h.versionsFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { and: [{ inArray: ['policyVersions.policyId', ['p1', 'p2']] }, { eq: ['policyVersions.status', 'PENDING_APPROVAL'] }] },
    }));
  });

  it('没有名下策略：不查版本，直接返回空', async () => {
    h.policiesFindMany.mockResolvedValue([]);

    expect(await listPendingVersionApprovals('nobody')).toEqual([]);
    expect(h.versionsFindMany).not.toHaveBeenCalled();
  });

  it('个人策略：所有者可审批自己提交的版本（自审）', async () => {
    h.versionsFindMany.mockResolvedValue([
      { id: 'v-own', policyId: 'p1', version: 2, createdBy: 'owner', createdAt: T0 },
    ]);

    const items = await listPendingVersionApprovals('owner');

    expect(items.map((i) => [i.versionId, i.canAct])).toEqual([['v-own', true]]);
  });

  it('团队 admin：范围含所在团队的策略，非作者的版本可审，自己写的只读', async () => {
    h.membersFindMany.mockResolvedValue([{ teamId: 'team1', role: 'admin' }]);
    h.policiesFindMany.mockResolvedValue([
      { id: 'tp1', name: 'team-loan', userId: 'author', teamId: 'team1' },
      { id: 'tp2', name: 'team-refund', userId: 'admin1', teamId: 'team1' },
    ]);
    h.versionsFindMany.mockResolvedValue([
      { id: 'v-author', policyId: 'tp1', version: 3, createdBy: 'author', createdAt: T1 },
      { id: 'v-mine', policyId: 'tp2', version: 1, createdBy: 'admin1', createdAt: T0 },
    ]);

    const items = await listPendingVersionApprovals('admin1');

    expect(h.membersFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { and: [{ eq: ['teamMembers.userId', 'admin1'] }, { inArray: ['teamMembers.role', ['owner', 'admin']] }, FRESH] },
    }));
    expect(h.policiesFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { and: [
        { or: [{ and: [{ eq: ['policies.userId', 'admin1'] }, PERSONAL] }, { inArray: ['policies.teamId', ['team1']] }] },
        { isNull: 'policies.deletedAt' },
      ] },
    }));
    expect(Object.fromEntries(items.map((i) => [i.versionId, i.canAct]))).toEqual({ 'v-author': true, 'v-mine': false });
  });

  it('团队策略的作者只是普通成员：自己的提交只读', async () => {
    h.policiesFindMany.mockResolvedValue([{ id: 'tp1', name: 'team-loan', userId: 'author', teamId: 'team1' }]);
    h.versionsFindMany.mockResolvedValue([
      { id: 'v1', policyId: 'tp1', version: 3, createdBy: 'author', createdAt: T1 },
    ]);

    const items = await listPendingVersionApprovals('author');

    expect(items.map((i) => i.canAct)).toEqual([false]);
  });

  it('★团队只有一位 owner 加普通成员（review I3）：owner 的提交无人能审批，标记 noEligibleReviewer', async () => {
    h.membersFindMany
      .mockResolvedValueOnce([{ teamId: 'team1', role: 'owner' }])
      .mockResolvedValueOnce([{ teamId: 'team1', userId: 'owner' }]);
    h.policiesFindMany.mockResolvedValue([{ id: 'tp1', name: 'team-loan', userId: 'owner', teamId: 'team1' }]);
    h.versionsFindMany.mockResolvedValue([
      { id: 'v1', policyId: 'tp1', version: 1, createdBy: 'owner', createdAt: T1 },
    ]);

    const items = await listPendingVersionApprovals('owner');

    expect(h.membersFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { and: [{ inArray: ['teamMembers.teamId', ['team1']] }, { inArray: ['teamMembers.role', ['admin', 'owner']] }, FRESH] },
    }));
    expect(items.map((i) => [i.canAct, i.noEligibleReviewer, i.teamId])).toEqual([[false, true, 'team1']]);
  });

  it('团队另有一位 admin：作者的提交只读但有人可审批，不标记 noEligibleReviewer', async () => {
    h.membersFindMany
      .mockResolvedValueOnce([{ teamId: 'team1', role: 'owner' }])
      .mockResolvedValueOnce([{ teamId: 'team1', userId: 'owner' }, { teamId: 'team1', userId: 'admin1' }]);
    h.policiesFindMany.mockResolvedValue([{ id: 'tp1', name: 'team-loan', userId: 'owner', teamId: 'team1' }]);
    h.versionsFindMany.mockResolvedValue([
      { id: 'v1', policyId: 'tp1', version: 1, createdBy: 'owner', createdAt: T1 },
    ]);

    const items = await listPendingVersionApprovals('owner');

    expect(items.map((i) => [i.canAct, i.noEligibleReviewer])).toEqual([[false, false]]);
  });

  it('个人策略不查团队管理员，也不标记 noEligibleReviewer', async () => {
    h.versionsFindMany.mockResolvedValue([
      { id: 'v-own', policyId: 'p1', version: 2, createdBy: 'owner', createdAt: T0 },
    ]);

    const items = await listPendingVersionApprovals('owner');

    expect(h.membersFindMany).toHaveBeenCalledTimes(1);
    expect(items.map((i) => [i.noEligibleReviewer, i.teamId])).toEqual([[false, null]]);
  });

  it('提交人/时间取最近一次提交事件；无事件时退回作者与创建时间；按提交时间倒序', async () => {
    h.versionsFindMany.mockResolvedValue([
      { id: 'v1', policyId: 'p1', version: 2, createdBy: 'author', createdAt: T0 },
      { id: 'v2', policyId: 'p2', version: 5, createdBy: 'colleague', createdAt: T1 },
    ]);
    // DISTINCT ON 已在 SQL 里每版只取最新一条
    h.eventsQuery.mockResolvedValue([
      { policyId: 'p1', version: '2', userId: 'submitter', createdAt: T2 },
    ]);
    h.usersFindMany.mockResolvedValue([
      { id: 'submitter', name: 'Sam', email: 'sam@example.com' },
      { id: 'colleague', name: null, email: 'col@example.com' },
    ]);

    const items = await listPendingVersionApprovals('owner');

    expect(items.map((i) => [i.versionId, i.policyName, i.version, i.submittedBy, i.submittedAt])).toEqual([
      ['v1', 'loan-evaluation', 2, 'Sam', T2.toISOString()],
      ['v2', 'refund', 5, 'col@example.com', T1.toISOString()],
    ]);
    // 只查待审批的 (policyId, version) 对，每版取最新一条，行数上限 = 待审批版本数
    const chain = h.eventsChain as { where: { and: Array<{ sql?: string; values?: unknown[] }> }; limit: number; orderBy: unknown[] };
    expect(chain.limit).toBe(2);
    const pairFilter = chain.where.and.find((c) => c.sql?.includes(') IN ('));
    expect(pairFilter?.values?.[2]).toEqual({
      join: [
        { sql: '(?, ?)', values: ['p1', '2'] },
        { sql: '(?, ?)', values: ['p2', '5'] },
      ],
    });
    expect(chain.orderBy).toHaveLength(3);
    expect(h.usersFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { inArray: ['users.id', ['submitter', 'colleague']] },
    }));
  });
});
