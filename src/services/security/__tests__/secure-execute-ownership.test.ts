import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `secure-execute` 的**归属校验**回归（2026-07-31 审计 Critical）。
 *
 * 缺陷：`executeSecurely` 只校验登录态。`policyId` 从 URL 直接进服务层，而其内部
 * 所有查询只按 `policyId + version + status` 过滤 → **任何登录用户可执行任意租户
 * 的策略**，读到对方冻结的 `PolicyVersion.source` 并用自选输入求值。
 *
 * ★这是**已修 bug 的漏修**：`version-manager.ts` 的 IDOR 修复注释明确列了 8 个受影响
 * 路由并点名 secure-execute，但那次只收口了走 version-manager 的 7 个；本函数有自己
 * 的服务层，被漏下。
 *
 * ★签名不能充当门禁（这也是为什么必须补归属校验）：
 *   1. `SIGNING_SECRET` 取自 `POLICY_SIGNING_SECRET`，而该变量在全仓**任何配置里都
 *      不存在**（只有 secure-executor.ts 读它），`|| ''` 使其退化为空串——任何人都能
 *      用空密钥算出合法签名；
 *   2. 即便配上，它也是**全局单一密钥**，不区分 user/tenant/policy，本质上无法证明归属。
 *
 * ★归属校验必须在签名校验**之前**：409 分支会把 `expectedHash`/`expectedVersion`
 * 回给调用方，那是攻击者补齐重放所需的最后一块拼图。
 *
 * 本用例钉死：**非所有者必须在触及任何版本数据前就被拒**。
 */

const { mockPolicyFindFirst, mockVersionFindFirst, mockLogSecurityEvent } = vi.hoisted(() => ({
  mockPolicyFindFirst: vi.fn(),
  mockVersionFindFirst: vi.fn(),
  mockLogSecurityEvent: vi.fn(),
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
    policyId: 'pv.policyId',
    version: 'pv.version',
    status: 'pv.status',
    createdAt: 'pv.createdAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  inArray: (col: unknown, val: unknown) => ({ op: 'inArray', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: () => ({ op: 'sql' }),
}));

// 归属校验通过后才会触及的下游，桩掉避免真实副作用。
vi.mock('../security-event-service', () => ({ logSecurityEvent: mockLogSecurityEvent }));
vi.mock('../nonce-service', () => ({ checkAndRecordNonce: vi.fn(async () => true) }));
vi.mock('../../policy/policy-api', () => ({ createPolicyApiClient: vi.fn(() => ({})) }));
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({
  loadExecutionVocabulary: vi.fn(async () => undefined),
}));
vi.mock('@/lib/runtime/safe-env', () => ({ safeEnv: () => '' }));

const OWNER = 'user-owner';
const ATTACKER = 'user-attacker';
const POLICY = 'policy-victim';

function makeRequest() {
  return {
    policyId: POLICY,
    version: 1,
    inputs: { creditScore: 700 },
    sourceHash: 'whatever',
    signature: 'forged-under-empty-key',
    timestamp: Date.now(),
    nonce: 'n-1',
  };
}

describe('executeSecurely — 归属校验', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 受害者的策略确实存在，但属于 OWNER
    mockPolicyFindFirst.mockImplementation(async () => null); // 默认：非所有者查不到
    mockVersionFindFirst.mockResolvedValue({
      id: 'v1',
      policyId: POLICY,
      version: 1,
      status: 'APPROVED',
      source: 'Module secret.\nRule decide given x: Return x.',
      policy: { userId: OWNER },
    });
  });

  it('非所有者被拒，且**不触及任何版本数据**', async () => {
    const { executeSecurely } = await import('../secure-executor');
    const { PolicyAccessDeniedError } = await import('../../policy/version-manager');

    await expect(
      executeSecurely({
        request: makeRequest(),
        userId: ATTACKER,
        tenantId: 'tenant-attacker',
      } as never)
    ).rejects.toBeInstanceOf(PolicyAccessDeniedError);

    // ★关键断言：版本查询根本没被调用 —— 证明拒绝发生在读到 source/expectedHash 之前
    expect(mockVersionFindFirst).not.toHaveBeenCalled();
  });

  it('归属查询按 (policyId, userId) 双条件过滤（不是只按 policyId）', async () => {
    const { executeSecurely } = await import('../secure-executor');
    await executeSecurely({
      request: makeRequest(),
      userId: ATTACKER,
      tenantId: 't',
    } as never).catch(() => undefined);

    expect(mockPolicyFindFirst).toHaveBeenCalled();
    const arg = mockPolicyFindFirst.mock.calls[0]?.[0] as { where?: unknown };
    const flat = JSON.stringify(arg?.where ?? {});
    expect(flat).toContain('policies.id');
    expect(flat).toContain('policies.userId');
    expect(flat).toContain(ATTACKER);
  });

  it('所有者可以通过归属校验（不会把正常用户也挡住）', async () => {
    mockPolicyFindFirst.mockResolvedValue({ id: POLICY });
    const { executeSecurely } = await import('../secure-executor');
    const { PolicyAccessDeniedError } = await import('../../policy/version-manager');

    // 所有者不应因**归属**被拒；后续可能因签名/hash 等其它原因失败，那不是本用例关注点。
    const err = await executeSecurely({
      request: makeRequest(),
      userId: OWNER,
      tenantId: 'tenant-owner',
    } as never).then(() => null, (e) => e);

    expect(err).not.toBeInstanceOf(PolicyAccessDeniedError);
  });
});
