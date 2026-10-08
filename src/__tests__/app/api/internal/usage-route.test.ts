import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';

/**
 * /api/internal/api/usage 路由级回归。
 *
 * 重点覆盖缺口修复：打到 aster-api 后端（policy.aster-lang.dev）的 key 用量上报
 * 除了 insert apiCallRecords，还应更新 apiKeys.lastUsedAt，使 dashboard 的"最后使用"
 * 反映纯 API 后端流量（此前只有打 aster-cloud BFF 的 validateApiKey 会更新它）。
 *
 * 约束（Codex 设计审）：所有 status 都更新、insert 与 update 共用同一 usedAt、
 * update best-effort（失败不影响 insert/响应）、where 单调守卫、apiKeyId 缺失则跳过。
 *
 * owner 共享配额池（ADR 0015 §4）：POST 落库 quotaOwnerId（缺省 = userId），
 * GET 的月度用量经 countOwnerPoolUsage 按配额 owner 归池统计。
 */

const {
  mockInsertValues,
  mockInsert,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockCountOwnerPoolUsage,
} = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  const mockCountOwnerPoolUsage = vi.fn();

  return { mockInsertValues, mockInsert, mockUpdateWhere, mockUpdateSet, mockUpdate, mockCountOwnerPoolUsage };
});

vi.mock('@/lib/prisma', () => ({
  db: { insert: mockInsert, update: mockUpdate },
  apiCallRecords: { id: 'apiCallRecords.id' },
  apiKeys: { id: 'apiKeys.id', lastUsedAt: 'apiKeys.lastUsedAt' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  isNull: (col: unknown) => ({ op: 'isNull', col }),
  lt: (col: unknown, val: unknown) => ({ op: 'lt', col, val }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  sql: () => ({ op: 'sql' }),
}));

vi.mock('@/lib/api-quota-pool', () => ({
  countOwnerPoolUsage: mockCountOwnerPoolUsage,
  currentPeriodMonth: () => '2026-10',
}));

const originalKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
const TEST_KEY = 'test-shared-hmac-key';
const PATH = '/api/internal/api/usage';

// ★v2 签名（绑定 nonce + bodyHash）。此前用 v1（method\npath\nts），
// 而 v1 已于 2026-08-01 默认关闭——它不绑 body/nonce，可在时钟窗内换 body 重放。
// 生产早已只发 v2（aster-api InternalCallSigner / cloud signInternalCallerHeaders），
// 这些用例是最后残留的 v1 调用方。
function signedHeaders(key: string, rawBody = '', method = 'POST'): Record<string, string> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = `n-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2)}`;
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const sig = createHmac('sha256', key)
    .update(`${method}\n${PATH}\n${ts}\n${nonce}\n${bodyHash}`)
    .digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Aster-Timestamp': ts,
    'X-Aster-Nonce': nonce,
    'X-Internal-Signature': sig,
  };
}

function post(body: unknown, headers?: Record<string, string>): Request {
  return new Request(`http://cloud.test${PATH}`, {
    method: 'POST',
    headers: headers ?? signedHeaders(TEST_KEY, JSON.stringify(body)),   // ★body 参与 v2 签名
    body: JSON.stringify(body),
  });
}

function get(query: string, headers?: Record<string, string>): Request {
  return new Request(`http://cloud.test${PATH}?${query}`, {
    method: 'GET',
    headers: headers ?? signedHeaders(TEST_KEY, '', 'GET'),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    apiKeyId: 'key-1',
    endpointPath: '/api/v1/policies/evaluate',
    status: 'success' as const,
    latencyMs: 12,
    ...overrides,
  };
}

describe('POST /api/internal/api/usage — lastUsedAt 更新（缺口修复）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockInsertValues.mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockUpdateWhere.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    process.env.ASTER_PLAN_GATE_HMAC_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('带 apiKeyId → insert 用量记录 + 更新 apiKeys.lastUsedAt（同一 usedAt）', async () => {
    const { POST } = await import('@/app/api/internal/api/usage/route');
    const res = await POST(post(validBody()));

    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);

    // insert 的 createdAt 与 update 的 lastUsedAt 必须是同一个 Date（共用 usedAt）
    const inserted = mockInsertValues.mock.calls[0][0];
    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(setArg.lastUsedAt).toBeInstanceOf(Date);
    expect(setArg.lastUsedAt.getTime()).toBe(inserted.createdAt.getTime());

    // where 单调守卫结构：id = ? AND (lastUsedAt IS NULL OR lastUsedAt < usedAt)
    const whereArg = mockUpdateWhere.mock.calls[0][0];
    expect(whereArg).toMatchObject({
      op: 'and',
      args: [
        { op: 'eq', val: 'key-1' },
        { op: 'or', args: [{ op: 'isNull' }, { op: 'lt', val: inserted.createdAt }] },
      ],
    });
  });

  it('缺 apiKeyId → 只 insert，不更新 lastUsedAt', async () => {
    const { POST } = await import('@/app/api/internal/api/usage/route');
    const res = await POST(post(validBody({ apiKeyId: undefined })));

    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('非 success 状态（api_error）也更新 lastUsedAt（"最后使用"含失败尝试）', async () => {
    const { POST } = await import('@/app/api/internal/api/usage/route');
    const res = await POST(post(validBody({ status: 'api_error' })));

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });

  it('lastUsedAt 更新失败 → best-effort：不回滚 insert，仍返回 200', async () => {
    mockUpdateWhere.mockRejectedValueOnce(new Error('db write conflict'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { POST } = await import('@/app/api/internal/api/usage/route');
    const res = await POST(post(validBody()));

    expect(res.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1); // insert 已成功，未被更新失败牵连
    expect(warn).toHaveBeenCalled();
  });

  it('坏签名 → 401，不写库', async () => {
    const { POST } = await import('@/app/api/internal/api/usage/route');
    const res = await POST(post(validBody(), signedHeaders('wrong-key')));

    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('缺必填字段（endpointPath）→ 400，不写库', async () => {
    const { POST } = await import('@/app/api/internal/api/usage/route');
    const res = await POST(post(validBody({ endpointPath: undefined })));

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

describe('/api/internal/api/usage — owner 共享配额池（ADR 0015 §4）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockInsertValues.mockResolvedValue(undefined);
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockUpdateWhere.mockResolvedValue(undefined);
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });
    mockCountOwnerPoolUsage.mockResolvedValue(42);
    process.env.ASTER_PLAN_GATE_HMAC_KEY = TEST_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
    vi.restoreAllMocks();
  });

  it('POST 不带 quotaOwnerId → 落库 quotaOwnerId 缺省为 userId（个人 key / 旧版 aster-api）', async () => {
    const { POST } = await import('@/app/api/internal/api/usage/route');
    const body = validBody();
    const res = await POST(post(body));

    expect(res.status).toBe(200);
    const inserted = mockInsertValues.mock.calls[0][0];
    expect(inserted.quotaOwnerId).toBe(body.userId);
    expect(inserted.userId).toBe(body.userId);
    expect(inserted.periodMonth).toBe('2026-10');
  });

  it('POST 带 quotaOwnerId → 原样落库（团队 key 计入 owner 池），userId 仍是调用者', async () => {
    const { POST } = await import('@/app/api/internal/api/usage/route');
    const res = await POST(post(validBody({ userId: 'member-1', quotaOwnerId: 'owner' })));

    expect(res.status).toBe(200);
    const inserted = mockInsertValues.mock.calls[0][0];
    expect(inserted.quotaOwnerId).toBe('owner');
    expect(inserted.userId).toBe('member-1');
  });

  it('GET → 用量走 countOwnerPoolUsage(userId, periodMonth)', async () => {
    const { GET } = await import('@/app/api/internal/api/usage/route');
    const res = await GET(get('userId=owner-1&periodMonth=2026-09'));

    expect(res.status).toBe(200);
    expect(mockCountOwnerPoolUsage).toHaveBeenCalledWith('owner-1', '2026-09');
    expect(await res.json()).toEqual({ userId: 'owner-1', periodMonth: '2026-09', used: 42 });
  });

  it('GET 缺 periodMonth → 用共享 currentPeriodMonth()', async () => {
    const { GET } = await import('@/app/api/internal/api/usage/route');
    const res = await GET(get('userId=owner-1'));

    expect(res.status).toBe(200);
    expect(mockCountOwnerPoolUsage).toHaveBeenCalledWith('owner-1', '2026-10');
    expect((await res.json()).periodMonth).toBe('2026-10');
  });

  it('GET 坏签名 → 401，不统计', async () => {
    const { GET } = await import('@/app/api/internal/api/usage/route');
    const res = await GET(get('userId=owner-1', signedHeaders('wrong-key', '', 'GET')));

    expect(res.status).toBe(401);
    expect(mockCountOwnerPoolUsage).not.toHaveBeenCalled();
  });
});
