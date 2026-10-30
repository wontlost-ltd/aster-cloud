// SOX 守护防回归测试（PM v1.1）
// 5 场景：
//   1. Free 自审 → 200（不强制）
//   2. Pro 自审单 seat → 403 invite_reviewer_required + cta
//   3. Pro 自审多 seat → 403 segregation_of_duties
//   4. Pro 他审多 seat → 200 approved
//   5. Enterprise 自审单 seat → 403 invite_reviewer_required
//   6. Pro 自审无 owner team → 403 引导 /teams/new
//   7. 个人策略（无 teamId）自审 → 200，不受套餐约束，交由 approveVersion 以 selfApproved 入审计

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMocks = vi.hoisted(() => ({
  usersFindFirst: vi.fn(),
  teamsFindFirst: vi.fn(),
  policyVersionsFindFirst: vi.fn(),
  policiesFindFirst: vi.fn(),
  selectChain: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: vi.fn() }));
// 同时导出 PolicyAccessDeniedError：路由用 instanceof 区分「非所有者 → 404」
// 与其他失败「→ 400」；mock 漏掉它会让该标识符在路由里是 undefined，
// instanceof 抛 TypeError 后被外层 catch 吞成误导性响应。
vi.mock('@/services/policy/version-manager', async () => {
  const actual = await vi.importActual<typeof import('@/services/policy/version-manager')>(
    '@/services/policy/version-manager',
  );
  return {
    approveVersion: vi.fn(),
    PolicyAccessDeniedError: actual.PolicyAccessDeniedError,
    SegregationOfDutiesError: actual.SegregationOfDutiesError,
    VocabularyFreezeError: actual.VocabularyFreezeError,
    VocabularyChangedSinceSaveError: actual.VocabularyChangedSinceSaveError,
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
import type { NextRequest } from 'next/server';

const mockAuth = vi.mocked(auth);
const mockApprove = vi.mocked(approveVersion);

function makeRequest(): NextRequest {
  return new Request('http://localhost/api/v1/policies/p1/versions/1/approve', {
    method: 'POST',
    body: JSON.stringify({ comment: 'lgtm' }),
    headers: { 'content-type': 'application/json' },
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: 'p1', version: '1' });

interface UserStub {
  plan: 'free' | 'pro' | 'enterprise';
  priceLockedAt: Date | null;
  legacyTier: string | null;
}

function setupMocks(opts: {
  user: UserStub;
  versionAuthor: string;
  team?: { id: string };
  seatCount?: number;
}) {
  prismaMocks.usersFindFirst.mockResolvedValueOnce(opts.user);
  prismaMocks.policyVersionsFindFirst.mockResolvedValueOnce({ createdBy: opts.versionAuthor });
  prismaMocks.teamsFindFirst.mockResolvedValueOnce(opts.team);
  prismaMocks.selectChain.mockReturnValueOnce({
    from: () => ({
      where: () => Promise.resolve([{ count: opts.seatCount ?? 1 }]),
    }),
  });
}

describe('POST /api/v1/policies/[id]/versions/[version]/approve — SOX 守护', () => {
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

  it('Free 计划自审 → 200（不强制 SOX）', async () => {
    setupMocks({
      user: { plan: 'free', priceLockedAt: null, legacyTier: null },
      versionAuthor: 'u1',
    });
    mockApprove.mockResolvedValueOnce(undefined);

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(mockApprove).toHaveBeenCalled();
  });

  it('Pro 自审 + 单 seat → 403 invite_reviewer_required + cta', async () => {
    setupMocks({
      user: { plan: 'pro', priceLockedAt: null, legacyTier: null },
      versionAuthor: 'u1',
      team: { id: 't1' },
      seatCount: 1,
    });

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('invite_reviewer_required');
    expect(data.cta?.href).toBe('/teams/t1/members');
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('Pro 自审 + 2 seat → 403 segregation_of_duties', async () => {
    setupMocks({
      user: { plan: 'pro', priceLockedAt: null, legacyTier: null },
      versionAuthor: 'u1',
      team: { id: 't1' },
      seatCount: 2,
    });

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('segregation_of_duties');
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('Pro 他审 → 200 approved', async () => {
    setupMocks({
      user: { plan: 'pro', priceLockedAt: null, legacyTier: null },
      versionAuthor: 'someone-else',
    });
    mockApprove.mockResolvedValueOnce(undefined);

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(200);
    expect(mockApprove).toHaveBeenCalled();
  });

  it('Enterprise 自审 + 单 seat → 403 invite_reviewer_required', async () => {
    setupMocks({
      user: { plan: 'enterprise', priceLockedAt: null, legacyTier: null },
      versionAuthor: 'u1',
      team: { id: 't1' },
      seatCount: 1,
    });

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('invite_reviewer_required');
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('Pro 自审 + 用户无 owner team → 403 + 引导建团队', async () => {
    setupMocks({
      user: { plan: 'pro', priceLockedAt: null, legacyTier: null },
      versionAuthor: 'u1',
      team: undefined,
    });

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('invite_reviewer_required');
    expect(data.cta?.href).toBe('/teams/new');
  });

  it('服务层判定团队策略作者自审（SegregationOfDutiesError）→ 403 segregation_of_duties', async () => {
    const { SegregationOfDutiesError } = await vi.importActual<typeof import('@/services/policy/version-manager')>(
      '@/services/policy/version-manager',
    );
    setupMocks({ user: { plan: 'free', priceLockedAt: null, legacyTier: null }, versionAuthor: 'u1' });
    mockApprove.mockRejectedValueOnce(new SegregationOfDutiesError());

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('segregation_of_duties');
  });

  it.each(['pro', 'enterprise'] as const)('★%s 个人策略自审 → 200，不受套餐 SOX 约束，交由 approveVersion 标记自审', async (plan) => {
    setupMocks({
      user: { plan, priceLockedAt: null, legacyTier: null },
      versionAuthor: 'u1',
      team: { id: 't1' },
      seatCount: 1,
    });
    prismaMocks.policiesFindFirst.mockResolvedValueOnce({ teamId: null });
    mockApprove.mockResolvedValueOnce(undefined);

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockApprove).toHaveBeenCalledWith(
      expect.objectContaining({ policyId: 'p1', version: 1, approverId: 'u1', decision: 'APPROVED' }),
    );
  });

  it('词汇冻结失败（VocabularyFreezeError）→ 503 vocabulary_freeze_failed，可重试', async () => {
    const { VocabularyFreezeError } = await vi.importActual<typeof import('@/services/policy/version-manager')>(
      '@/services/policy/version-manager',
    );
    setupMocks({ user: { plan: 'free', priceLockedAt: null, legacyTier: null }, versionAuthor: 'u1' });
    mockApprove.mockRejectedValueOnce(new VocabularyFreezeError());

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('vocabulary_freeze_failed');
  });

  it('保存后词汇已变（VocabularyChangedSinceSaveError）→ 409 vocabulary_changed_since_save', async () => {
    const { VocabularyChangedSinceSaveError } = await vi.importActual<typeof import('@/services/policy/version-manager')>(
      '@/services/policy/version-manager',
    );
    setupMocks({ user: { plan: 'free', priceLockedAt: null, legacyTier: null }, versionAuthor: 'u1' });
    mockApprove.mockRejectedValueOnce(new VocabularyChangedSinceSaveError());

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('vocabulary_changed_since_save');
  });

  it('策略不存在 → 不拦截，交由 approveVersion 判定（404 不泄露存在性）', async () => {
    setupMocks({ user: { plan: 'pro', priceLockedAt: null, legacyTier: null }, versionAuthor: 'u1' });
    prismaMocks.policiesFindFirst.mockResolvedValueOnce(undefined);
    mockApprove.mockResolvedValueOnce(undefined);

    const res = await POST(makeRequest(), { params });
    expect(mockApprove).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});
