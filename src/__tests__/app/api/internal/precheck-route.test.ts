import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { getEffectiveLimits } from '@/lib/plans';

/**
 * /api/internal/api/precheck 路由级回归（ADR 0015 §4）。
 *
 * aster-api 对团队 key 传入的 userId 是配额 owner：月度用量必须走 owner 共享池
 * （countOwnerPoolUsage），而非只数 apiCallRecords.userId = owner 的行；
 * 限额取 owner 套餐——owner 为 free 时团队 key 的 apiCallsLimit 必须是 0。
 */

const { mockFindFirst, mockCountOwnerPoolUsage } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockCountOwnerPoolUsage: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: { query: { users: { findFirst: mockFindFirst } } },
  users: { id: 'users.id' },
  apiCallRecords: {},
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  sql: () => ({ op: 'sql' }),
}));

vi.mock('@/lib/api-quota-pool', () => ({
  countOwnerPoolUsage: mockCountOwnerPoolUsage,
  currentPeriodMonth: () => '2026-10',
}));

const originalKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
const TEST_KEY = 'test-shared-hmac-key';
const PATH = '/api/internal/api/precheck';

// v2 签名（绑定 nonce + bodyHash）；GET 的 rawBody 为空串。
function signedHeaders(key: string): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = `n-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2)}`;
  const bodyHash = createHash('sha256').update('').digest('hex');
  const sig = createHmac('sha256', key)
    .update(`GET\n${PATH}\n${ts}\n${nonce}\n${bodyHash}`)
    .digest('hex');
  return {
    'X-Aster-Timestamp': ts,
    'X-Aster-Nonce': nonce,
    'X-Internal-Signature': sig,
  };
}

function get(userId: string, headers?: Record<string, string>): Request {
  return new Request(`http://cloud.test${PATH}?userId=${encodeURIComponent(userId)}`, {
    method: 'GET',
    headers: headers ?? signedHeaders(TEST_KEY),
  });
}

function ownerRow(overrides: Record<string, unknown> = {}) {
  return {
    plan: 'pro',
    priceLockedAt: null,
    legacyTier: null,
    subscriptionStatus: 'active',
    gracePeriodEndsAt: null,
    aiBannedUntil: null,
    ...overrides,
  };
}

describe('GET /api/internal/api/precheck — owner 共享配额池', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockCountOwnerPoolUsage.mockResolvedValue(42);
    process.env.ASTER_PLAN_GATE_HMAC_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('owner 为 pro → monthlyUsed 取共享池计数，限额取 owner 套餐', async () => {
    mockFindFirst.mockResolvedValue(ownerRow());
    const { GET } = await import('@/app/api/internal/api/precheck/route');
    const res = await GET(get('owner-1'));

    expect(res.status).toBe(200);
    expect(mockCountOwnerPoolUsage).toHaveBeenCalledTimes(1);
    expect(mockCountOwnerPoolUsage).toHaveBeenCalledWith('owner-1', '2026-10');
    const body = await res.json();
    expect(body).toMatchObject({
      plan: 'pro',
      monthlyUsed: 42,
      period: '2026-10',
      apiCallsLimit: getEffectiveLimits({ plan: 'pro' }).apiCalls,
      banned: false,
    });
    expect(body.apiCallsLimit).toBeGreaterThan(0);
  });

  it('owner 为 free → apiCallsLimit 为 0（团队 key 随 owner 套餐被拒）', async () => {
    mockFindFirst.mockResolvedValue(ownerRow({ plan: 'free', subscriptionStatus: null }));
    const { GET } = await import('@/app/api/internal/api/precheck/route');
    const res = await GET(get('owner-free'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan).toBe('free');
    expect(body.apiCallsLimit).toBe(0);
    expect(body.monthlyUsed).toBe(42);
    expect(mockCountOwnerPoolUsage).toHaveBeenCalledWith('owner-free', '2026-10');
  });

  it('未知用户 → 既有 free 兜底响应，不查用量', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const { GET } = await import('@/app/api/internal/api/precheck/route');
    const res = await GET(get('ghost'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plan: 'free', apiCallsLimit: 0, monthlyUsed: 0, banned: false });
    expect(mockCountOwnerPoolUsage).not.toHaveBeenCalled();
  });

  it('坏签名 → 401，不查库', async () => {
    const { GET } = await import('@/app/api/internal/api/precheck/route');
    const res = await GET(get('owner-1', signedHeaders('wrong-key')));

    expect(res.status).toBe(401);
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockCountOwnerPoolUsage).not.toHaveBeenCalled();
  });
});
