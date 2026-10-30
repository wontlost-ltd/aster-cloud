import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 版本操作的业务失败抛 VersionStateError（稳定 code + 人读 message），路由据此区分
 * 「可展示给用户的状态错误」与「只写日志的内部异常」（#662）。
 *
 * 以下 mock 与 version-ownership.test.ts 相同：
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
const POLICY = 'policy-1';

import {
  archiveVersion,
  deprecateVersion,
  setDefaultVersion,
  submitForApproval,
  approveVersion,
} from '../version-manager';
import { VersionStateError } from '../version-state-error';

async function captureError(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

describe('版本操作的状态错误（#662）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPolicyFindFirst.mockResolvedValue({ id: POLICY, userId: OWNER, teamId: null });
  });

  const base = { policyId: POLICY, version: 3, userId: OWNER };

  it.each([
    ['submit', () => submitForApproval(base), 'version_not_submittable'],
    ['approve', () => approveVersion({ policyId: POLICY, version: 3, approverId: OWNER, decision: 'APPROVED' }), 'version_not_pending'],
    ['set-default', () => setDefaultVersion(base), 'version_not_approved'],
    ['deprecate', () => deprecateVersion(base), 'version_not_approved'],
    ['archive', () => archiveVersion(base), 'version_not_archivable'],
  ] as const)('%s：版本不存在或状态不符 → VersionStateError(%s)', async (_n, run, code) => {
    mockVersionFindFirst.mockResolvedValue(undefined);
    const err = await captureError(run());
    expect(err).toBeInstanceOf(VersionStateError);
    expect((err as VersionStateError).code).toBe(code);
    expect((err as VersionStateError).message).toContain('v3');
  });

  it.each([
    ['deprecate', () => deprecateVersion(base)],
    ['archive', () => archiveVersion(base)],
  ] as const)('%s：默认版本 → VersionStateError(default_version_locked)', async (_n, run) => {
    mockVersionFindFirst.mockResolvedValue({
      id: 'v3', policyId: POLICY, version: 3, status: 'APPROVED', isDefault: true, createdBy: OWNER,
    });
    const err = await captureError(run());
    expect(err).toBeInstanceOf(VersionStateError);
    expect((err as VersionStateError).code).toBe('default_version_locked');
  });
});
