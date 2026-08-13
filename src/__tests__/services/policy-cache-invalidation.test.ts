import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 改变「执行时用哪份源码」的写操作，必须失效执行缓存。
 *
 * <h2>被修复的真实事故</h2>
 *
 * <p>执行入口 <code>/api/policies/[id]/execute</code> 命中 KV 缓存时
 * <b>完全不查库</b>——那条 SQL 分支把 <code>policy_content</code> 直接选成
 * <code>NULL::text</code>，源码取自 <code>getCachedPolicyMeta()</code>。
 *
 * <p>而此前只有 <code>PUT /api/policies/[id]</code> 会失效缓存，
 * version-manager 里 7 个改版本的函数<b>一个都不失效</b>。
 * 后果：用户改了策略，执行的仍是旧源码。
 *
 * <p>真实表现：用户源码里明明写着 <code>is greater than 750</code>，
 * 执行却报「<code>is</code> 后面不能直接跟符号」——因为跑的是缓存里的旧版本
 * （含 <code>is &gt; 750</code>）。用户反复重建策略、甚至直接改库都无效，
 * 因为**执行根本没读库**。
 *
 * <p>★本测试断言的是「失效函数被调用」这个<b>行为</b>，
 * 而不是「源码里出现了某个字符串」——后者挡不住调用被放进死代码
 * （本次修复过程中就真出现过：调用被插到 <code>return</code> 之后）。
 */
const { mockInvalidate, mockInsertReturning, mockVersionsFindFirst, mockUpdateWhere } =
  vi.hoisted(() => ({
    mockInvalidate: vi.fn().mockResolvedValue(undefined),
    mockInsertReturning: vi.fn(),
    mockVersionsFindFirst: vi.fn(),
    mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@/lib/cache', () => ({
  invalidatePolicyCache: mockInvalidate,
}));

vi.mock('@/lib/prisma', () => {
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ returning: mockInsertReturning })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn(() => ({ where: mockUpdateWhere })),
  }));
  return {
    db: {
      insert,
      update,
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ update })),
      query: { policyVersions: { findFirst: mockVersionsFindFirst } },
    },
    policies: { id: {}, version: {}, content: {} },
    policyVersions: {
      id: {}, policyId: {}, version: {}, status: {}, isDefault: {},
      sourceHash: {}, sourceEnvelopeSha256: {}, source: {}, content: {},
    },
    policyApprovals: {},
  };
});

vi.mock('@/lib/metrics/aha-detection', () => ({
  recordAhaMomentIfFirst: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/security/security-event-service', () => ({
  logSecurityEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  snapshotOnPolicyApprove: vi.fn().mockResolvedValue(undefined),
}));

import { createVersion, updateVersionSource } from '@/services/policy/version-manager';

describe('执行缓存失效（防「改了策略仍跑旧源码」）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVersionsFindFirst.mockResolvedValue({
      id: 'v1', version: 1, status: 'DRAFT', prevHash: null, policyId: 'p1',
    });
    mockInsertReturning.mockResolvedValue([
      { id: 'v1', version: 1, sourceHash: 'h', sourceEnvelopeSha256: 'e' },
    ]);
  });

  it('★createVersion 必须失效缓存', async () => {
    await createVersion({
      policyId: 'p1',
      source: 'Module X.',
      createdBy: 'u1',
      locale: 'en-US',
    });
    expect(mockInvalidate).toHaveBeenCalledWith('p1');
  });

  it('★updateVersionSource 必须失效缓存', async () => {
    await updateVersionSource({
      policyId: 'p1',
      version: 1,
      source: 'Module Y.',
      userId: 'u1',
    });
    expect(mockInvalidate).toHaveBeenCalledWith('p1');
  });

  it('★缓存失效失败不得阻断写入——写已提交，缓存另有 TTL 兜底', async () => {
    mockInvalidate.mockRejectedValueOnce(new Error('KV down'));
    await expect(
      createVersion({
        policyId: 'p1',
        source: 'Module X.',
        createdBy: 'u1',
        locale: 'en-US',
      }),
    ).resolves.toBeDefined();
  });
});
