// @vitest-environment node
// 审批收件箱「策略版本审批」（生产 E2E Q1）：范围与 approveVersion 同口径（名下未删除策略的 PENDING_APPROVAL 版本），
// canAct 按四眼原则（作者只读），提交人/提交时间取最近一次提交审批事件，缺事件时退回版本作者与创建时间。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const h = vi.hoisted(() => ({
  policiesFindMany: vi.fn(),
  versionsFindMany: vi.fn(),
  eventsFindMany: vi.fn(),
  usersFindMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => {
  const col = (name: string) => ({ name });
  return {
    db: {
      query: {
        policies: { findMany: h.policiesFindMany },
        policyVersions: { findMany: h.versionsFindMany },
        securityEvents: { findMany: h.eventsFindMany },
        users: { findMany: h.usersFindMany },
      },
    },
    policies: { userId: col('policies.userId'), deletedAt: col('policies.deletedAt') },
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
  eq: (c: { name: string }, v: unknown) => ({ eq: [c.name, v] }),
  inArray: (c: { name: string }, v: unknown) => ({ inArray: [c.name, v] }),
  isNull: (c: { name: string }) => ({ isNull: c.name }),
  desc: (c: { name: string }) => ({ desc: c.name }),
  sql: () => ({ sql: 'submit-action' }),
}));

import { listPendingVersionApprovals } from '@/lib/version-approvals-inbox';

const T0 = new Date('2026-10-20T00:00:00Z');
const T1 = new Date('2026-10-21T00:00:00Z');
const T2 = new Date('2026-10-22T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  h.policiesFindMany.mockResolvedValue([{ id: 'p1', name: 'loan-evaluation' }, { id: 'p2', name: 'refund' }]);
  h.eventsFindMany.mockResolvedValue([]);
  h.usersFindMany.mockResolvedValue([]);
});

describe('listPendingVersionApprovals', () => {
  it('只查名下未删除策略的待审批版本', async () => {
    h.versionsFindMany.mockResolvedValue([]);

    await listPendingVersionApprovals('owner');

    expect(h.policiesFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { and: [{ eq: ['policies.userId', 'owner'] }, { isNull: 'policies.deletedAt' }] },
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

  it('canAct：他人创建的版本可审，自己创建的只读（四眼原则）', async () => {
    h.versionsFindMany.mockResolvedValue([
      { id: 'v-own', policyId: 'p1', version: 2, createdBy: 'owner', createdAt: T0 },
      { id: 'v-other', policyId: 'p2', version: 5, createdBy: 'colleague', createdAt: T1 },
    ]);

    const items = await listPendingVersionApprovals('owner');

    expect(Object.fromEntries(items.map((i) => [i.versionId, i.canAct]))).toEqual({ 'v-own': false, 'v-other': true });
  });

  it('提交人/时间取最近一次提交事件；无事件时退回作者与创建时间；按提交时间倒序', async () => {
    h.versionsFindMany.mockResolvedValue([
      { id: 'v1', policyId: 'p1', version: 2, createdBy: 'author', createdAt: T0 },
      { id: 'v2', policyId: 'p2', version: 5, createdBy: 'colleague', createdAt: T1 },
    ]);
    h.eventsFindMany.mockResolvedValue([
      { policyId: 'p1', userId: 'submitter', details: { version: 2, action: 'SUBMIT_FOR_APPROVAL' }, createdAt: T2 },
      { policyId: 'p1', userId: 'older', details: { version: 2, action: 'SUBMIT_FOR_APPROVAL' }, createdAt: T0 },
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
    expect(h.eventsFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { and: [
        { inArray: ['securityEvents.policyId', ['p1', 'p2']] },
        { eq: ['securityEvents.eventType', 'APPROVAL_DECISION'] },
        { sql: 'submit-action' },
      ] },
    }));
    expect(h.usersFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { inArray: ['users.id', ['submitter', 'colleague']] },
    }));
  });
});
