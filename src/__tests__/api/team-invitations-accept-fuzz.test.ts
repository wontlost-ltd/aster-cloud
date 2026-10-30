// invitation accept + syncStripeSeats 破坏性测试
//
// 攻击向量：
// - 邮箱大小写 / 邀请过期 / 已是成员 / token 不存在
// - syncStripeSeats: 无 owner / 非 active / 数量已等 / Stripe 抛错（不能阻塞 invite）
// - race condition：双重接受同一 token

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  invitationFindFirst: vi.fn(),
  userFindFirst: vi.fn(),
  teamFindFirst: vi.fn(),
  memberFindFirst: vi.fn(),
  insertValues: vi.fn().mockResolvedValue(undefined),
  insert: vi.fn(),
  deleteWhere: vi.fn().mockResolvedValue(undefined),
  deleteFn: vi.fn(),
  selectChain: vi.fn(),
  transaction: vi.fn(),
  stripeRetrieve: vi.fn(),
  stripeUpdate: vi.fn(),
}));

mocks.insert.mockReturnValue({ values: mocks.insertValues });
mocks.deleteFn.mockReturnValue({ where: mocks.deleteWhere });

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      teamInvitations: { findFirst: mocks.invitationFindFirst },
      users: { findFirst: mocks.userFindFirst },
      teams: { findFirst: mocks.teamFindFirst },
      teamMembers: { findFirst: mocks.memberFindFirst },
    },
    insert: mocks.insert,
    delete: mocks.deleteFn,
    select: mocks.selectChain,
    transaction: mocks.transaction,
  },
  teams: {},
  teamInvitations: {},
  teamMembers: {},
  users: {},
}));
// deployment-mode: 默认 SaaS（CAN_BILLING + IS_SAAS = true）让 syncStripeSeats 跑
vi.mock('@/lib/deployment-mode', () => ({
  CAN_BILLING: true,
  IS_SAAS: true,
  IS_ONPREM: false,
}));
// Stripe mock 是共享单例对象 —— 每次 getStripe() 都返回它
const mockStripeInstance = {
  subscriptions: { retrieve: mocks.stripeRetrieve },
  subscriptionItems: { update: mocks.stripeUpdate },
};
vi.mock('@/lib/stripe', () => ({
  getStripe: vi.fn(async () => mockStripeInstance),
}));

// 接受时在锁住团队行的事务内检查席位（审查 L3）
const seat = vi.hoisted(() => ({ lock: vi.fn(), available: vi.fn() }));
vi.mock('@/lib/team-plan', () => ({ lockTeamRow: seat.lock, teamSeatAvailable: seat.available }));

import { POST } from '@/app/api/teams/invitations/accept/route';
import { getSession } from '@/lib/auth';

const mockSession = vi.mocked(getSession);

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/teams/invitations/accept', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function defaultSession() {
  mockSession.mockResolvedValue({
    user: { id: 'u-invitee', email: 'invitee@example.com' },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => {
    if (typeof m === 'function' && 'mockReset' in m) m.mockReset();
  });
  mocks.insert.mockReturnValue({ values: mocks.insertValues });
  mocks.deleteFn.mockReturnValue({ where: mocks.deleteWhere });
  mocks.deleteWhere.mockResolvedValue(undefined);
  mocks.insertValues.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
    await fn({
      insert: mocks.insert,
      delete: mocks.deleteFn,
    });
  });
  mockSession.mockReset();
  seat.lock.mockReset().mockResolvedValue({ ownerId: 'u-owner' });
  seat.available.mockReset().mockResolvedValue({ ok: true });
});

describe('POST /api/teams/invitations/accept — adversarial', () => {
  describe('Auth and input boundary', () => {
    it('returns 401 when no session', async () => {
      mockSession.mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof getSession>>);
      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(401);
    });

    it('returns 400 when token missing', async () => {
      defaultSession();
      const res = await POST(makeRequest({}));
      expect(res.status).toBe(400);
    });

    it('returns 400 when token is non-string', async () => {
      defaultSession();
      const res = await POST(makeRequest({ token: 12345 }));
      expect(res.status).toBe(400);
    });

    it('returns 400 when token is empty string', async () => {
      defaultSession();
      const res = await POST(makeRequest({ token: '' }));
      expect(res.status).toBe(400);
    });
  });

  describe('Invitation lifecycle', () => {
    it('returns 404 when invitation not found', async () => {
      defaultSession();
      mocks.invitationFindFirst.mockResolvedValueOnce(undefined);
      const res = await POST(makeRequest({ token: 'tok-bogus' }));
      expect(res.status).toBe(404);
    });

    it('returns 400 expired and deletes record when invitation past expiry', async () => {
      defaultSession();
      mocks.invitationFindFirst.mockResolvedValueOnce({
        id: 'inv-1',
        teamId: 't1',
        email: 'invitee@example.com',
        role: 'member',
        token: 'tok',
        expiresAt: new Date('2020-01-01'),
        team: { id: 't1', name: 'Team', slug: 't1' },
      });

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(400);
      expect(mocks.deleteFn).toHaveBeenCalled();
    });

    it('returns 400 when current user is already a member', async () => {
      defaultSession();
      mocks.invitationFindFirst.mockResolvedValueOnce({
        id: 'inv-1',
        teamId: 't1',
        email: 'invitee@example.com',
        role: 'member',
        token: 'tok',
        expiresAt: new Date('2099-01-01'),
        team: { id: 't1', name: 'Team', slug: 't1' },
      });
      mocks.userFindFirst.mockResolvedValueOnce({ email: 'invitee@example.com' });
      mocks.memberFindFirst.mockResolvedValueOnce({ id: 'mem-1' });

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(400);
      // 已存在的邀请也应被清理
      expect(mocks.deleteFn).toHaveBeenCalled();
    });
  });

  describe('Seat limit on accept（审查 L3）', () => {
    it('团队已满（按 owner 套餐上限）→ 402，不加成员、不删邀请', async () => {
      defaultSession();
      mocks.invitationFindFirst.mockResolvedValue({
        id: 'inv-1', teamId: 't1', email: 'invitee@example.com', role: 'member',
        expiresAt: new Date(Date.now() + 86_400_000), team: { id: 't1', name: 'T', slug: 't' },
      });
      mocks.userFindFirst.mockResolvedValue({ email: 'invitee@example.com' });
      mocks.memberFindFirst.mockResolvedValue(undefined);
      seat.available.mockResolvedValue({ ok: false, memberCount: 5, limit: 5 });

      const res = await POST(makeRequest({ token: 'tok' }));

      expect(res.status).toBe(402);
      expect(seat.lock).toHaveBeenCalledWith(expect.anything(), 't1');
      expect(seat.available).toHaveBeenCalledWith(expect.anything(), 't1', 'u-owner');
      expect(mocks.insertValues).not.toHaveBeenCalled();
      expect(mocks.deleteWhere).not.toHaveBeenCalled();
    });
  });

  describe('Email matching — case sensitivity', () => {
    it('email case mismatch is allowed (lowercase compare)', async () => {
      mockSession.mockResolvedValueOnce({
        user: { id: 'u-invitee', email: 'Invitee@Example.COM' },
      } as unknown as Awaited<ReturnType<typeof getSession>>);
      mocks.invitationFindFirst.mockResolvedValueOnce({
        id: 'inv-1',
        teamId: 't1',
        email: 'INVITEE@example.com',
        role: 'member',
        token: 'tok',
        expiresAt: new Date('2099-01-01'),
        team: { id: 't1', name: 'Team', slug: 't1' },
      });
      mocks.userFindFirst.mockResolvedValueOnce({ email: 'Invitee@Example.COM' });
      mocks.memberFindFirst.mockResolvedValueOnce(undefined);
      mocks.teamFindFirst.mockResolvedValueOnce({ ownerId: 'u-owner' });
      // owner is not on active subscription → syncStripeSeats skips
      mocks.userFindFirst.mockResolvedValueOnce({ subscriptionId: null, subscriptionStatus: null });

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(200);
    });

    it('email totally different → 403', async () => {
      mockSession.mockResolvedValueOnce({
        user: { id: 'u-attacker', email: 'attacker@evil.com' },
      } as unknown as Awaited<ReturnType<typeof getSession>>);
      mocks.invitationFindFirst.mockResolvedValueOnce({
        id: 'inv-1',
        teamId: 't1',
        email: 'invitee@example.com',
        role: 'member',
        token: 'tok',
        expiresAt: new Date('2099-01-01'),
        team: { id: 't1', name: 'Team', slug: 't1' },
      });
      mocks.userFindFirst.mockResolvedValueOnce({ email: 'attacker@evil.com' });

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(403);
    });

    it('current user email is null → 403 (cannot match)', async () => {
      defaultSession();
      mocks.invitationFindFirst.mockResolvedValueOnce({
        id: 'inv-1',
        teamId: 't1',
        email: 'invitee@example.com',
        role: 'member',
        token: 'tok',
        expiresAt: new Date('2099-01-01'),
        team: { id: 't1', name: 'Team', slug: 't1' },
      });
      mocks.userFindFirst.mockResolvedValueOnce({ email: null });

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(403);
    });
  });

  describe('syncStripeSeats failure modes (must not block invite)', () => {
    function setupHappyAccept() {
      defaultSession();
      mocks.invitationFindFirst.mockResolvedValueOnce({
        id: 'inv-1',
        teamId: 't1',
        email: 'invitee@example.com',
        role: 'member',
        token: 'tok',
        expiresAt: new Date('2099-01-01'),
        team: { id: 't1', name: 'Team', slug: 't1' },
      });
      mocks.userFindFirst.mockResolvedValueOnce({ email: 'invitee@example.com' });
      mocks.memberFindFirst.mockResolvedValueOnce(undefined);
    }

    it('subscription past_due → skip Stripe update but accept succeeds', async () => {
      setupHappyAccept();
      mocks.teamFindFirst.mockResolvedValueOnce({ ownerId: 'u-owner' });
      mocks.userFindFirst.mockResolvedValueOnce({
        subscriptionId: 'sub_1',
        subscriptionStatus: 'past_due',
      });

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(200);
      expect(mocks.stripeUpdate).not.toHaveBeenCalled();
    });

    it('owner has no subscription → skip Stripe update', async () => {
      setupHappyAccept();
      mocks.teamFindFirst.mockResolvedValueOnce({ ownerId: 'u-owner' });
      mocks.userFindFirst.mockResolvedValueOnce({ subscriptionId: null, subscriptionStatus: null });

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(200);
      expect(mocks.stripeUpdate).not.toHaveBeenCalled();
    });

    it('Stripe.subscriptions.retrieve throws → invite still accepted (catch + log)', async () => {
      setupHappyAccept();
      mocks.teamFindFirst.mockResolvedValueOnce({ ownerId: 'u-owner' });
      mocks.userFindFirst.mockResolvedValueOnce({
        subscriptionId: 'sub_1',
        subscriptionStatus: 'active',
      });
      // Mock count select
      mocks.selectChain.mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ count: 2 }]) }),
      });
      mocks.stripeRetrieve.mockRejectedValueOnce(new Error('Stripe API down'));

      const res = await POST(makeRequest({ token: 'tok' }));
      // Critical: 邀请仍然成功（200），Stripe 失败靠 reconcile cron 兜底
      expect(res.status).toBe(200);
    });

    it('Stripe quantity already equals member count → skip update (idempotent)', async () => {
      setupHappyAccept();
      mocks.teamFindFirst.mockResolvedValueOnce({ ownerId: 'u-owner' });
      mocks.userFindFirst.mockResolvedValueOnce({
        subscriptionId: 'sub_1',
        subscriptionStatus: 'active',
      });
      mocks.selectChain.mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ count: 3 }]) }),
      });
      mocks.stripeRetrieve.mockResolvedValueOnce({
        items: { data: [{ id: 'si_1', quantity: 3 }] },
      });

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(200);
      expect(mocks.stripeUpdate).not.toHaveBeenCalled();
    });

    it('subscription items array is empty → skip update without crashing', async () => {
      setupHappyAccept();
      mocks.teamFindFirst.mockResolvedValueOnce({ ownerId: 'u-owner' });
      mocks.userFindFirst.mockResolvedValueOnce({
        subscriptionId: 'sub_1',
        subscriptionStatus: 'active',
      });
      mocks.selectChain.mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ count: 5 }]) }),
      });
      mocks.stripeRetrieve.mockResolvedValueOnce({ items: { data: [] } });

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(200);
      expect(mocks.stripeUpdate).not.toHaveBeenCalled();
    });

    it('happy path: count differs → call subscriptionItems.update with prorate', async () => {
      setupHappyAccept();
      mocks.teamFindFirst.mockResolvedValueOnce({ ownerId: 'u-owner' });
      mocks.userFindFirst.mockResolvedValueOnce({
        subscriptionId: 'sub_1',
        subscriptionStatus: 'active',
      });
      mocks.selectChain.mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([{ count: 2 }]) }),
      });
      mocks.stripeRetrieve.mockResolvedValueOnce({
        items: { data: [{ id: 'si_1', quantity: 1 }] },
      });
      mocks.stripeUpdate.mockResolvedValueOnce({ id: 'si_1', quantity: 2 });

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(200);
      expect(mocks.stripeUpdate).toHaveBeenCalledWith('si_1', {
        quantity: 2,
        proration_behavior: 'create_prorations',
      });
    });

    it('team not found in Stripe sync → skip silently', async () => {
      setupHappyAccept();
      mocks.teamFindFirst.mockResolvedValueOnce(undefined);

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(200);
      expect(mocks.stripeRetrieve).not.toHaveBeenCalled();
    });
  });

  describe('Server error path', () => {
    it('returns 500 when invitation lookup throws unexpectedly', async () => {
      defaultSession();
      mocks.invitationFindFirst.mockRejectedValueOnce(new Error('db down'));

      const res = await POST(makeRequest({ token: 'tok' }));
      expect(res.status).toBe(500);
    });
  });
});
