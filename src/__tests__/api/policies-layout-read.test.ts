// ADR 0058 §5.2、§7.2 / 计划 T6：读接口返回 StoredLayout。只读查看不设能力门；layout 只在既有读权限检查之后读取。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadVersionLayout: vi.fn(),
  resolveEntitlement: vi.fn(),
  policyFindFirst: vi.fn(),
  versionFindFirst: vi.fn(),
  versionFindMany: vi.fn(),
  userId: 'user-1',
}));

vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => ({ user: { id: h.userId } })) }));
vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ user: { id: h.userId } })) }));
vi.mock('@/lib/policy-layout/store', () => ({
  loadVersionLayout: h.loadVersionLayout,
  activeLayoutSha256: vi.fn(),
  activeLayoutSha256ForPolicy: vi.fn(),
  loadCarryCandidate: vi.fn(),
  insertVersionLayout: vi.fn(),
  prepareLayout: vi.fn(),
}));
vi.mock('@/lib/capabilities/resolve', () => ({ resolveEntitlement: h.resolveEntitlement }));
vi.mock('@/lib/policy-freeze', () => ({ isPolicyFrozen: vi.fn(async () => ({ isFrozen: false })) }));
vi.mock('@/lib/platform-settings', () => ({ isPolicySharingEnabled: vi.fn(async () => false) }));
vi.mock('@/lib/cache', () => ({ invalidatePolicyCache: vi.fn(async () => undefined) }));
vi.mock('@/lib/policy-access', async () =>
  (await import('@/__tests__/helpers/policy-access-mock')).policyAccessModule());
vi.mock('@/lib/prisma', () => {
  const countWhere = vi.fn(async () => [{ count: 0 }]);
  return {
    db: {
      query: {
        policies: { findFirst: h.policyFindFirst },
        policyVersions: { findFirst: h.versionFindFirst, findMany: h.versionFindMany },
      },
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: countWhere })) })),
    },
    policies: { id: {}, userId: {}, deletedAt: {}, isPublic: {} },
    policyVersions: { id: {}, policyId: {}, version: {} },
    policyApprovals: { createdAt: {} },
    policyGroups: { id: {}, userId: {} },
    executions: { policyId: {} },
    teamMembers: {},
  };
});

import { GET as GET_POLICY } from '@/app/api/policies/[id]/route';
import { GET as GET_VERSION } from '@/app/api/v1/policies/[id]/versions/[version]/route';
import { policyAccessState } from '@/__tests__/helpers/policy-access-mock';
import type { StoredLayout } from '@/lib/policy-layout/types';

const OWNER = 'user-1';
const POLICY = { id: 'p1', userId: OWNER, teamId: null, name: 'p', content: 'Module m.', version: 3, isPublic: false, deletedAt: null };
const STATUSES: StoredLayout[] = [
  { status: 'none' },
  { status: 'ok', layout: { v: 1, spans: [{ text: 'Module m.' }] }, layoutSha256: 'a'.repeat(64) },
  { status: 'inconsistent', layoutSha256: 'b'.repeat(64) },
];

const getPolicy = () => GET_POLICY(new Request('http://localhost/api/policies/p1'), { params: Promise.resolve({ id: 'p1' }) });
const getVersion = () =>
  GET_VERSION(new Request('http://localhost/api/v1/policies/p1/versions/3') as never, {
    params: Promise.resolve({ id: 'p1', version: '3' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.userId = OWNER;
  policyAccessState.policy = { ...POLICY };
  policyAccessState.teamRole = null;
  policyAccessState.loader = null;
  h.policyFindFirst.mockResolvedValue(undefined);
  h.versionFindMany.mockResolvedValue([]);
  h.versionFindFirst.mockResolvedValue({ id: 'ver-3', policyId: 'p1', version: 3, aliasSet: null, approvals: [] });
  h.loadVersionLayout.mockResolvedValue({ status: 'none' });
});

describe.each([
  ['GET /api/policies/[id]', getPolicy],
  ['GET /api/v1/policies/[id]/versions/[version]', getVersion],
])('%s', (_name, get) => {
  it.each(STATUSES.map((s) => [s.status, s] as const))('returns layout status %s as stored, 200', async (_s, stored) => {
    h.loadVersionLayout.mockResolvedValue(stored);
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).layout).toEqual(stored);
    expect(h.loadVersionLayout).toHaveBeenCalledWith('ver-3');
  });

  it('access denied → 404 and the layout is never read', async () => {
    h.userId = 'user-outsider';
    const res = await get();
    expect(res.status).toBe(404);
    expect(h.loadVersionLayout).not.toHaveBeenCalled();
  });

  it('never resolves structured_authoring (read-only viewing is ungated)', async () => {
    h.loadVersionLayout.mockResolvedValue(STATUSES[1]);
    await get();
    expect(h.resolveEntitlement).not.toHaveBeenCalled();
  });
});

describe('GET /api/policies/[id]：公开策略与无活跃版本', () => {
  it('public policy read by a non-owner still carries the layout', async () => {
    h.userId = 'user-outsider';
    h.policyFindFirst.mockResolvedValue({ ...POLICY, isPublic: true });
    h.loadVersionLayout.mockResolvedValue(STATUSES[1]);
    const res = await getPolicy();
    expect(res.status).toBe(200);
    expect((await res.json()).layout).toEqual(STATUSES[1]);
    expect(h.resolveEntitlement).not.toHaveBeenCalled();
  });

  it('no active version row → layout none without a lookup', async () => {
    h.versionFindFirst.mockResolvedValue(undefined);
    const res = await getPolicy();
    expect((await res.json()).layout).toEqual({ status: 'none' });
    expect(h.loadVersionLayout).not.toHaveBeenCalled();
  });
});
