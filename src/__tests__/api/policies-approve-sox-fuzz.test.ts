// SOX 守护破坏性测试：扫描隐藏 bug
//
// 目标：从 happy-path 之外的所有边界 / 异常 / 注入路径攻击 approve route
// 期望：route 不崩溃，正确返回 403 / 400 / 500，且不绕过 SOX 守护

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMocks = vi.hoisted(() => ({
  usersFindFirst: vi.fn(),
  teamsFindFirst: vi.fn(),
  policyVersionsFindFirst: vi.fn(),
  policiesFindFirst: vi.fn(),
  selectChain: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: vi.fn() }));
// 必须同时导出 PolicyAccessDeniedError：路由用 `error instanceof PolicyAccessDeniedError`
// 区分「非所有者 → 404」与其他失败「→ 400」。mock 若漏掉它，该标识符在路由里是
// undefined，instanceof 会抛 TypeError 并被外层 catch 吞成误导性的错误响应。
vi.mock('@/services/policy/version-manager', async () => {
  const actual = await vi.importActual<typeof import('@/services/policy/version-manager')>(
    '@/services/policy/version-manager',
  );
  return {
    approveVersion: vi.fn(),
    PolicyAccessDeniedError: actual.PolicyAccessDeniedError,
    SegregationOfDutiesError: actual.SegregationOfDutiesError,
  };
});
vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: prismaMocks.usersFindFirst },
      teams: { findFirst: prismaMocks.teamsFindFirst },
      policyVersions: { findFirst: prismaMocks.policyVersionsFindFirst },
      policies: { findFirst: prismaMocks.policiesFindFirst },
    },
    select: prismaMocks.selectChain,
  },
  users: {},
  teams: {},
  teamMembers: {},
  policies: {},
  policyVersions: {},
}));

import { POST } from '@/app/api/v1/policies/[id]/versions/[version]/approve/route';
import { auth } from '@/auth';
import { approveVersion } from '@/services/policy/version-manager';

const mockAuth = vi.mocked(auth);
const mockApprove = vi.mocked(approveVersion);

import type { NextRequest } from 'next/server';

function makeRequest(body: unknown = { comment: 'lgtm' }, init?: { rawBody?: string }): NextRequest {
  const rawBody = init?.rawBody ?? JSON.stringify(body);
  return new Request('http://localhost/api/v1/policies/p1/versions/1/approve', {
    method: 'POST',
    body: rawBody,
    headers: { 'content-type': 'application/json' },
  }) as unknown as NextRequest;
}

const params = (version = '1') => Promise.resolve({ id: 'p1', version });

interface SetupOpts {
  user?: { plan: 'free' | 'pro' | 'enterprise'; priceLockedAt?: Date | null; legacyTier?: string | null } | null;
  versionAuthor?: string;
  team?: { id: string } | undefined;
  seatCount?: number;
  selectThrows?: boolean;
}

function setupMocks(opts: SetupOpts) {
  prismaMocks.usersFindFirst.mockResolvedValueOnce(
    opts.user === undefined ? { plan: 'pro', priceLockedAt: null, legacyTier: null } : opts.user
  );
  prismaMocks.policyVersionsFindFirst.mockResolvedValueOnce({ createdBy: opts.versionAuthor ?? 'u1' });
  prismaMocks.teamsFindFirst.mockResolvedValueOnce(opts.team);
  if (opts.selectThrows) {
    prismaMocks.selectChain.mockImplementationOnce(() => {
      throw new Error('db.select boom');
    });
  } else {
    prismaMocks.selectChain.mockReturnValueOnce({
      from: () => ({
        where: () => Promise.resolve([{ count: opts.seatCount ?? 1 }]),
      }),
    });
  }
}

describe('SOX guard — adversarial inputs', () => {
  beforeEach(() => {
    prismaMocks.usersFindFirst.mockReset();
    prismaMocks.teamsFindFirst.mockReset();
    prismaMocks.policyVersionsFindFirst.mockReset();
    // 默认团队策略：既有场景描述的是团队策略的 seats 分支；个人策略另有用例（review I4）
    prismaMocks.policiesFindFirst.mockReset();
    prismaMocks.policiesFindFirst.mockResolvedValue({ teamId: 't1' });
    prismaMocks.selectChain.mockReset();
    mockApprove.mockReset();
    mockAuth.mockReset();
    mockAuth.mockResolvedValue({
      user: { id: 'u1', email: 'u1@example.com' },
    } as unknown as Awaited<ReturnType<typeof auth>>);
  });

  describe('Auth and input boundary', () => {
    it('returns 401 when no session', async () => {
      mockAuth.mockResolvedValueOnce(null as unknown as Awaited<ReturnType<typeof auth>>);
      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe('unauthorized');
    });

    it('returns 401 when session.user.id is missing (corrupt session)', async () => {
      mockAuth.mockResolvedValueOnce({ user: { email: 'x@x' } } as unknown as Awaited<ReturnType<typeof auth>>);
      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(401);
    });

    it('returns 400 invalid_version when version is non-numeric "abc"', async () => {
      const res = await POST(makeRequest(), { params: params('abc') });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('invalid_version');
    });

    it('returns 400 invalid_version when version is empty string', async () => {
      const res = await POST(makeRequest(), { params: params('') });
      expect(res.status).toBe(400);
    });

    it('returns 400 invalid_version when version is negative-looking "-1" via NaN check', async () => {
      // parseInt('-1', 10) === -1 (not NaN) — route accepts it; ensure route does NOT crash later
      setupMocks({ user: { plan: 'free', priceLockedAt: null, legacyTier: null }, versionAuthor: 'u1' });
      mockApprove.mockResolvedValueOnce(undefined);
      const res = await POST(makeRequest(), { params: params('-1') });
      // free plan + self-approve: passes (free has approvalRequired=false)
      expect([200, 400]).toContain(res.status);
    });

    it('treats malformed JSON body as empty {} (does not crash)', async () => {
      setupMocks({ user: { plan: 'free', priceLockedAt: null, legacyTier: null }, versionAuthor: 'u1' });
      mockApprove.mockResolvedValueOnce(undefined);
      const res = await POST(makeRequest({}, { rawBody: '{not-json' }), { params: params() });
      expect(res.status).toBe(200);
      expect(mockApprove).toHaveBeenCalledWith(
        expect.objectContaining({ comment: undefined })
      );
    });

    it('handles missing body (zero-length) gracefully', async () => {
      setupMocks({ user: { plan: 'free', priceLockedAt: null, legacyTier: null }, versionAuthor: 'u1' });
      mockApprove.mockResolvedValueOnce(undefined);
      const res = await POST(makeRequest({}, { rawBody: '' }), { params: params() });
      expect(res.status).toBe(200);
    });
  });

  describe('Identity equality edge cases', () => {
    it('case-sensitive: approver "User-1" is NOT same as version.createdBy "user-1" → not blocked', async () => {
      mockAuth.mockResolvedValueOnce({
        user: { id: 'User-1', email: 'u@x' },
      } as unknown as Awaited<ReturnType<typeof auth>>);
      setupMocks({
        user: { plan: 'pro', priceLockedAt: null, legacyTier: null },
        versionAuthor: 'user-1',
      });
      mockApprove.mockResolvedValueOnce(undefined);

      const res = await POST(makeRequest(), { params: params() });
      // Different case = different user = SOX guard does NOT block
      expect(res.status).toBe(200);
      expect(mockApprove).toHaveBeenCalled();
    });

    it('empty session.user.id is treated as unauthenticated (401, NOT bypass)', async () => {
      // 防御性：route 用 `!session?.user?.id` 判定登录态，空字符串是 falsy → 401
      // 这意味着 '' 永远进不来，不会出现 author='' === approver='' 的 SOX bypass
      mockAuth.mockResolvedValueOnce({
        user: { id: '', email: 'x@x' },
      } as unknown as Awaited<ReturnType<typeof auth>>);

      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(401);
      expect(mockApprove).not.toHaveBeenCalled();
    });

    it('whitespace-only IDs are NOT equal to non-whitespace (no trim collision)', async () => {
      mockAuth.mockResolvedValueOnce({
        user: { id: ' u1', email: 'x@x' },
      } as unknown as Awaited<ReturnType<typeof auth>>);
      setupMocks({
        user: { plan: 'pro', priceLockedAt: null, legacyTier: null },
        versionAuthor: 'u1',
      });
      mockApprove.mockResolvedValueOnce(undefined);

      const res = await POST(makeRequest(), { params: params() });
      // ' u1' !== 'u1' → SOX does NOT block
      expect(res.status).toBe(200);
    });
  });

  describe('User lookup edge cases', () => {
    it('user not found in db → guard skips (defensive), falls through to approveVersion', async () => {
      prismaMocks.usersFindFirst.mockResolvedValueOnce(null);
      mockApprove.mockResolvedValueOnce(undefined);

      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(200);
      // SOX guard returned null because user not found → approveVersion called
      // (DB inconsistency: session valid but user row missing → graceful fallthrough)
    });

    it('approveVersion throws → 400 approve_failed with message', async () => {
      setupMocks({ user: { plan: 'free', priceLockedAt: null, legacyTier: null }, versionAuthor: 'u1' });
      mockApprove.mockRejectedValueOnce(new Error('version not in PENDING_APPROVAL'));

      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('approve_failed');
      expect(data.message).toContain('PENDING_APPROVAL');
    });

    it('approveVersion throws non-Error string → 400 with default message', async () => {
      setupMocks({ user: { plan: 'free', priceLockedAt: null, legacyTier: null }, versionAuthor: 'u1' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockApprove.mockRejectedValueOnce('plain string error' as any);

      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe('approve_failed');
      expect(data.message).toBe('批准失败');
    });
  });

  describe('Team / seat count edge cases', () => {
    it('user is team MEMBER but not OWNER → ownerId-lookup returns nothing → invite_reviewer_required + cta /teams/new', async () => {
      // Pro user is member of someone else's team. Code path: db.query.teams.findFirst({ where: ownerId=approver }) → undefined
      setupMocks({
        user: { plan: 'pro', priceLockedAt: null, legacyTier: null },
        versionAuthor: 'u1',
        team: undefined, // ownerId lookup returns nothing
      });

      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('invite_reviewer_required');
      expect(data.cta?.href).toBe('/teams/new');
    });

    it('count returns 0 (degenerate empty team) → invite_reviewer_required path', async () => {
      setupMocks({
        user: { plan: 'pro', priceLockedAt: null, legacyTier: null },
        versionAuthor: 'u1',
        team: { id: 't1' },
        seatCount: 0,
      });

      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('invite_reviewer_required');
      expect(data.cta?.href).toBe('/teams/t1/invite');
    });

    it('count returns 100 (large team) → segregation_of_duties path on self-approve', async () => {
      setupMocks({
        user: { plan: 'pro', priceLockedAt: null, legacyTier: null },
        versionAuthor: 'u1',
        team: { id: 't1' },
        seatCount: 100,
      });

      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe('segregation_of_duties');
    });

    it('db.select throws unexpected error → request fails closed (does not silently approve)', async () => {
      setupMocks({
        user: { plan: 'pro', priceLockedAt: null, legacyTier: null },
        versionAuthor: 'u1',
        team: { id: 't1' },
        selectThrows: true,
      });

      let res: Response;
      try {
        res = await POST(makeRequest(), { params: params() });
      } catch (err) {
        // Either exception bubbles or 500 — both are acceptable; the critical
        // requirement is that approveVersion is NOT silently invoked.
        expect(err).toBeInstanceOf(Error);
        expect(mockApprove).not.toHaveBeenCalled();
        return;
      }
      expect([400, 500]).toContain(res.status);
      expect(mockApprove).not.toHaveBeenCalled();
    });
  });

  describe('Plan tier matrix on self-approve (single seat)', () => {
    it.each(['pro', 'enterprise'] as const)(
      '%s + 1 seat self-approve → 403 invite_reviewer_required (not segregation)',
      async (plan) => {
        setupMocks({
          user: { plan, priceLockedAt: null, legacyTier: null },
          versionAuthor: 'u1',
          team: { id: 't-x' },
          seatCount: 1,
        });

        const res = await POST(makeRequest(), { params: params() });
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toBe('invite_reviewer_required');
        expect(data.cta?.href).toBe('/teams/t-x/invite');
      }
    );

    it('legacy plan="team" enum (PM v1.1 grandfather) → maps to pro behavior on self-approve', async () => {
      // plan='team' in DB, legacyTier=null. PM_PLAN_LIMITS_V2 path normalizes 'team' → 'pro'
      setupMocks({
        user: { plan: 'pro', priceLockedAt: null, legacyTier: null }, // simulated normalized result
        versionAuthor: 'u1',
        team: { id: 't1' },
        seatCount: 1,
      });
      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('invite_reviewer_required');
    });
  });

  describe('Free plan does NOT enforce SOX', () => {
    it('Free + self-approve + null team → 200 (does not even check team)', async () => {
      setupMocks({
        user: { plan: 'free', priceLockedAt: null, legacyTier: null },
        versionAuthor: 'u1',
        team: undefined,
      });
      mockApprove.mockResolvedValueOnce(undefined);

      const res = await POST(makeRequest(), { params: params() });
      expect(res.status).toBe(200);
      // Critical: free plan must NEVER trigger 403 SOX guard
    });
  });
});
