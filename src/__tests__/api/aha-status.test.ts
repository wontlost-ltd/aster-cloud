// /api/user/aha-status — dashboard tile data source
//
// 三种状态：
//   ① 已达成 → achieved=true + hoursToFirst + withinAhaWindow
//   ② 未达成 + 在窗口内 → expired=false + hoursRemaining > 0
//   ③ 未达成 + 已超窗口 → expired=true

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  usersFindFirst: vi.fn(),
  auditLogsFindFirst: vi.fn(),
  policiesFindFirst: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/policy-access', () => ({ ownPoliciesVisibleTo: vi.fn(() => ({})) }));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: mocks.usersFindFirst },
      auditLogs: { findFirst: mocks.auditLogsFindFirst },
      policies: { findFirst: mocks.policiesFindFirst },
    },
  },
  users: {},
  auditLogs: { userId: {}, action: {} },
  policies: { userId: {}, deletedAt: {} },
}));

import { GET } from '@/app/api/user/aha-status/route';

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.usersFindFirst.mockReset();
  mocks.auditLogsFindFirst.mockReset();
  mocks.policiesFindFirst.mockReset();
  mocks.policiesFindFirst.mockResolvedValue(undefined);
});

describe('GET /api/user/aha-status', () => {
  it('returns 401 when not authenticated', async () => {
    mocks.getSession.mockResolvedValueOnce(null);

    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns achieved=true when user has AHA event', async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'u-1' } });
    mocks.usersFindFirst.mockResolvedValueOnce({ createdAt: new Date('2026-05-10') });
    mocks.auditLogsFindFirst.mockResolvedValueOnce({
      createdAt: new Date('2026-05-10T06:00:00Z'),
      metadata: { hoursToFirst: 6, withinAhaWindow: true, ahaWindowHours: 24 },
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.achieved).toBe(true);
    expect(data.hoursToFirst).toBe(6);
    expect(data.withinAhaWindow).toBe(true);
    expect(data.ahaWindowHours).toBe(24);
  });

  it('returns achieved=false + hoursRemaining when user signed up <24h ago', async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'u-new' } });
    const signedUpRecently = new Date(Date.now() - 6 * 60 * 60 * 1000); // 6h ago
    mocks.usersFindFirst.mockResolvedValueOnce({ createdAt: signedUpRecently });
    mocks.auditLogsFindFirst.mockResolvedValueOnce(undefined);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.achieved).toBe(false);
    expect(data.expired).toBe(false);
    expect(data.hoursSinceSignup).toBeGreaterThan(5);
    expect(data.hoursSinceSignup).toBeLessThan(7);
    expect(data.hoursRemaining).toBeGreaterThan(17);
    expect(data.hoursRemaining).toBeLessThan(19);
  });

  it('returns expired=true when user signed up >24h ago without AHA', async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'u-slow' } });
    const signedUpLongAgo = new Date(Date.now() - 48 * 60 * 60 * 1000); // 2 days
    mocks.usersFindFirst.mockResolvedValueOnce({ createdAt: signedUpLongAgo });
    mocks.auditLogsFindFirst.mockResolvedValueOnce(undefined);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.achieved).toBe(false);
    expect(data.expired).toBe(true);
    expect(data.hoursRemaining).toBe(0);
    expect(data.hasPolicies).toBe(false);
  });

  it('未达成但已有未删除策略 → hasPolicies=true（卡片据此隐藏「创建首个策略」引导）', async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'u-busy' } });
    mocks.usersFindFirst.mockResolvedValueOnce({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });
    mocks.auditLogsFindFirst.mockResolvedValueOnce(undefined);
    mocks.policiesFindFirst.mockResolvedValueOnce({ id: 'p-1' });

    const res = await GET();
    const data = await res.json();
    expect(data.achieved).toBe(false);
    expect(data.hasPolicies).toBe(true);
  });

  it('returns 404 when user record is missing', async () => {
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'u-ghost' } });
    mocks.usersFindFirst.mockResolvedValueOnce(null);

    const res = await GET();
    expect(res.status).toBe(404);
  });
});
