import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * secure-execute 的签名密钥必须 fail-closed（Free 计划界面执行 hotfix，与 aster-api#411 同批）。
 *
 * 缺陷：`SIGNING_SECRET = safeEnv('POLICY_SIGNING_SECRET') || ''`，而该变量在任何部署配置里都不存在，
 * 退化为空串后任何人都能用空密钥算出「合法」签名。修复后：密钥缺失或全空白 → SIGNING_UNAVAILABLE，
 * 不做 nonce 记录、不读版本、不执行；空密钥签出的签名在任何情况下都不被接受。
 */

const { mockPolicyFindFirst, mockVersionFindFirst, mockCheckNonce, mockSafeEnv } = vi.hoisted(() => ({
  mockPolicyFindFirst: vi.fn(),
  mockVersionFindFirst: vi.fn(),
  mockCheckNonce: vi.fn(),
  mockSafeEnv: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      policies: { findFirst: mockPolicyFindFirst },
      policyVersions: { findFirst: mockVersionFindFirst },
    },
  },
  policies: { id: 'policies.id', userId: 'policies.userId', deletedAt: 'policies.deletedAt' },
  policyVersions: { policyId: 'pv.policyId', version: 'pv.version', status: 'pv.status', createdAt: 'pv.createdAt' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  inArray: (col: unknown, val: unknown) => ({ op: 'inArray', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  desc: (col: unknown) => ({ op: 'desc', col }),
  sql: () => ({ op: 'sql' }),
}));
vi.mock('../security-event-service', () => ({ logSecurityEvent: vi.fn() }));
vi.mock('../nonce-service', () => ({ checkAndRecordNonce: mockCheckNonce }));
vi.mock('../../policy/policy-api', () => ({ createPolicyApiClient: vi.fn(() => ({})) }));
vi.mock('@/lib/domain-vocabulary-snapshot', () => ({ loadExecutionVocabulary: vi.fn(async () => undefined) }));
vi.mock('@/lib/runtime/safe-env', () => ({ safeEnv: mockSafeEnv }));

const OWNER = 'user-owner';
const POLICY = 'policy-1';

async function signedUnder(secret: string) {
  const { signRequest } = await import('../policy-security');
  const payload = { policyId: POLICY, hash: 'sha256:h', input: { x: 1 }, timestamp: Date.now(), nonce: 'n-1', version: 1 };
  return { ...payload, signature: signRequest(payload, secret) };
}

describe('executeSecurely — 签名密钥 fail-closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPolicyFindFirst.mockResolvedValue({ id: POLICY });
    mockCheckNonce.mockResolvedValue({ valid: true });
  });

  it.each([[undefined], [''], ['   ']])('密钥为 %j 时返回 SIGNING_UNAVAILABLE，不消费 nonce、不读版本', async (secret) => {
    mockSafeEnv.mockReturnValue(secret);
    const { executeSecurely } = await import('../secure-executor');

    const result = await executeSecurely({ request: await signedUnder(''), userId: OWNER, tenantId: 't' } as never);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('SIGNING_UNAVAILABLE');
    expect(result.engineInvoked).toBeFalsy();
    expect(mockCheckNonce).not.toHaveBeenCalled();
    expect(mockVersionFindFirst).not.toHaveBeenCalled();
  });

  it('密钥已配置时，空密钥签出的签名被拒', async () => {
    mockSafeEnv.mockReturnValue('a-real-secret-at-least-32-chars-long!!');
    const { executeSecurely } = await import('../secure-executor');

    const result = await executeSecurely({ request: await signedUnder(''), userId: OWNER, tenantId: 't' } as never);

    expect(result.errorCode).toBe('SIGNATURE_INVALID');
    expect(mockCheckNonce).not.toHaveBeenCalled();
  });

  it('verifySignature 对空密钥一律返回 false', async () => {
    const { verifySignature } = await import('../policy-security');
    expect(verifySignature(await signedUnder(''), '')).toBe(false);
  });
});
