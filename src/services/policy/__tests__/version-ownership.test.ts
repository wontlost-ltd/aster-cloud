import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 版本操作的**归属校验**回归（2026-07-29 审计 P0-1）。
 *
 * 缺陷：8 个版本路由只校验登录态，`policyId` 从 URL 直接进服务层，而服务层查询
 * 只按 `policyId + version + status` 过滤——任何登录用户可操作任意租户的策略版本。
 *
 * ★最危险的是审批链：`approveVersion` 的四眼原则判 `createdBy === approverId`，
 * 对**外部攻击者恒为 false**（攻击者本就不是创建者）→ SOX 守护反而主动放行。
 * 配合 submit 可把他人策略从 DRAFT 一路推到 APPROVED。
 *
 * 这些用例钉死：**非所有者必须在触及任何版本状态前就被拒**。
 */

const { mockPolicyFindFirst, mockVersionFindFirst } = vi.hoisted(() => ({
  mockPolicyFindFirst: vi.fn(),
  mockVersionFindFirst: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policies: { findFirst: mockPolicyFindFirst },
      policyVersions: { findFirst: mockVersionFindFirst },
    },
  },
  policies: { id: 'policies.id', userId: 'policies.userId', deletedAt: 'policies.deletedAt' },
  policyVersions: {
    policyId: 'pv.policyId', version: 'pv.version', status: 'pv.status',
  },
  policyApprovals: { createdAt: 'pa.createdAt' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  inArray: (col: unknown, val: unknown) => ({ op: 'inArray', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: () => ({ op: 'sql' }),
}));

// 以下模块在归属校验通过后才会被触及；桩掉避免真实副作用。
vi.mock('../../security/policy-security', () => ({
  computeChainedHash: () => 'h', computeSourceHash: () => 'h',
}));
vi.mock('../../security/security-event-service', () => ({ logSecurityEvent: vi.fn() }));
vi.mock('@/lib/metrics/aha-detection', () => ({ recordAhaMomentIfFirst: vi.fn() }));
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({ freezeVocabularyForApproval: vi.fn(async () => []) }));
vi.mock('@/lib/policy-alias', () => ({
  canonicalAliasJson: () => '{}', cloudToolchainId: () => 'tc',
  computeSourceEnvelope: () => ({}), STRUCTURAL_KINDS: [],
  validateUserAliases: () => ({ ok: true }),
}));

const OWNER = 'user-owner';
const ATTACKER = 'user-attacker';
const POLICY = 'policy-victim';

describe('版本操作归属校验（跨租户 IDOR 修复）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 两种查询口径：
    //  · 所有者专属操作（submit/set-default/…）按 (id, userId, deletedAt IS NULL) 过滤，攻击者查不到；
    //  · 审阅类操作（approve/reject、版本详情）按 (id, deletedAt IS NULL) 取出所有者与团队，
    //    再由 version-approval-rules 判定审阅权。这里是个人策略，所有者是 OWNER。
    mockPolicyFindFirst.mockImplementation((args: { where?: { args?: unknown[] } }) => {
      const conds = JSON.stringify(args?.where ?? {});
      return conds.includes(ATTACKER)
        ? Promise.resolve(undefined)
        : Promise.resolve({ id: POLICY, userId: OWNER, teamId: null });
    });
    // 版本存在且处于可操作状态——证明拒绝来自归属校验而非状态不匹配
    mockVersionFindFirst.mockResolvedValue({
      id: 'v1', policyId: POLICY, version: 1, status: 'PENDING_APPROVAL',
      createdBy: OWNER, source: 'x', sourceHash: 'h',
    });
  });

  it('★攻击者 approve 他人策略 → 抛 PolicyAccessDeniedError，且不触碰版本表', async () => {
    const { approveVersion, PolicyAccessDeniedError } = await import('../version-manager');

    await expect(approveVersion({
      policyId: POLICY, version: 1, approverId: ATTACKER, decision: 'APPROVED',
    })).rejects.toBeInstanceOf(PolicyAccessDeniedError);

    // 必须在查版本之前就被拒——否则四眼原则会拿 createdBy!==approverId 放行
    expect(mockVersionFindFirst).not.toHaveBeenCalled();
  });

  it('★四眼原则不能替代归属校验：攻击者不是创建者，恒满足 createdBy!==approverId', async () => {
    const { approveVersion, PolicyAccessDeniedError } = await import('../version-manager');

    // 版本由 OWNER 创建，攻击者审批——四眼原则「通过」，只有归属校验能拦住
    await expect(approveVersion({
      policyId: POLICY, version: 1, approverId: ATTACKER, decision: 'APPROVED',
    })).rejects.toBeInstanceOf(PolicyAccessDeniedError);
  });

  it('攻击者 submit 他人策略 → 拒绝（阻断 submit→approve 提权链）', async () => {
    const { submitForApproval, PolicyAccessDeniedError } = await import('../version-manager');

    await expect(submitForApproval({
      policyId: POLICY, version: 1, userId: ATTACKER,
    })).rejects.toBeInstanceOf(PolicyAccessDeniedError);
    expect(mockVersionFindFirst).not.toHaveBeenCalled();
  });

  type VersionManagerModule = typeof import('../version-manager');
  const attackerArgs = { policyId: POLICY, version: 1, userId: ATTACKER };

  it.each<[string, (m: VersionManagerModule) => Promise<unknown>]>([
    ['setDefaultVersion', (m) => m.setDefaultVersion(attackerArgs)],
    ['deprecateVersion', (m) => m.deprecateVersion(attackerArgs)],
    ['archiveVersion', (m) => m.archiveVersion(attackerArgs)],
    ['getVersionDetail', (m) => m.getVersionDetail(attackerArgs)],
  ])('攻击者调用 %s → 拒绝', async (_name, invoke) => {
    const mod = await import('../version-manager');
    await expect(invoke(mod)).rejects.toBeInstanceOf(mod.PolicyAccessDeniedError);
  });

  it('所有者本人调用 → 通过归属校验，继续走到版本查询', async () => {
    const { getVersionDetail } = await import('../version-manager');

    await getVersionDetail({ policyId: POLICY, version: 1, userId: OWNER });
    expect(mockVersionFindFirst).toHaveBeenCalled();
  });

  it('读访问的策略查询必须含 deletedAt 守卫（软删策略不可读）', async () => {
    const { getVersionDetail } = await import('../version-manager');

    await getVersionDetail({ policyId: POLICY, version: 1, userId: OWNER });

    const where = JSON.stringify(mockPolicyFindFirst.mock.calls[0]?.[0]?.where ?? {});
    expect(where).toContain(POLICY);
    expect(where).toContain('deletedAt');
  });

  it('策略已软删（查不到）→ 所有者读版本详情同样被拒', async () => {
    mockPolicyFindFirst.mockResolvedValue(undefined);
    const { getVersionDetail, PolicyAccessDeniedError } = await import('../version-manager');

    await expect(getVersionDetail({ policyId: POLICY, version: 1, userId: OWNER }))
      .rejects.toBeInstanceOf(PolicyAccessDeniedError);
    expect(mockVersionFindFirst).not.toHaveBeenCalled();
  });
});
