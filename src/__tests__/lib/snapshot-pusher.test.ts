import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
const originalUrl = process.env.ASTER_API_INTERNAL_URL;

const { mockFindFirst } = vi.hoisted(() => ({ mockFindFirst: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: mockFindFirst },
      apiKeys: { findFirst: mockFindFirst },
    },
  },
  users: { id: {} },
  apiKeys: { id: {}, key: {} },
}));

describe('pushUserSnapshot', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFindFirst.mockReset();
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'test-secret-32chars-min-len-please';
    process.env.ASTER_API_INTERNAL_URL = 'http://aster-api.test';
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ASTER_PLAN_GATE_HMAC_KEY;
    else process.env.ASTER_PLAN_GATE_HMAC_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.ASTER_API_INTERNAL_URL;
    else process.env.ASTER_API_INTERNAL_URL = originalUrl;
    vi.restoreAllMocks();
  });

  it('POST 到 /api/internal/snapshot/user/{userId} with HMAC + traceparent', async () => {
    mockFindFirst.mockResolvedValue({
      plan: 'pro',
      priceLockedAt: null,
      legacyTier: null,
      subscriptionStatus: 'active',
      aiBannedUntil: null,
      gracePeriodEndsAt: null,
    });
    const { pushUserSnapshot } = await import('@/lib/snapshot-pusher');
    await pushUserSnapshot('user-123');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://aster-api.test/api/internal/snapshot/user/user-123');
    expect((init as RequestInit).method).toBe('POST');

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Aster-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-Aster-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.plan).toBe('pro');
    expect(body.subscriptionStatus).toBe('active');
    expect(body.aiBannedUntilEpochMs).toBeNull();
  });

  // ============================================================
  // ★跨仓签名契约（2026-08-17 安全审计）
  //
  // 对端：aster-api 的 SnapshotPushResource.canonicalV2
  //   canonical = method \n path \n ts \n nonce \n sha256hex(body)
  //
  // 此前 v1 只签 method\npath\nts —— 不绑 body、无 nonce，
  // 截获一条合法签名后可在 5 分钟窗口内替换请求体（如把 role 提成 ADMIN）或重放。
  //
  // 本用例**不复刻 canonical 再自我比对**（那只能证明 HMAC 原语对输入敏感，
  // 数学上恒真）。做法是：拿生产代码**实际发出**的 header 与 body，
  // 按 aster-api 的规格重算签名并要求匹配。
  // 删掉生产代码里的 bodySha、调换字段顺序、或漏发 nonce，本用例都会红。
  // ============================================================
  it('签名必须按 v2 canonical 绑定 nonce 与 body（与 aster-api 逐字段一致）', async () => {
    const { createHash, createHmac } = await import('node:crypto');
    mockFindFirst.mockResolvedValue({
      plan: 'pro',
      priceLockedAt: null,
      legacyTier: null,
      subscriptionStatus: 'active',
      aiBannedUntil: null,
      gracePeriodEndsAt: null,
    });
    const { pushUserSnapshot } = await import('@/lib/snapshot-pusher');
    await pushUserSnapshot('user-123');

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    const body = (init as RequestInit).body as string;

    // nonce 必须存在且为 UUID —— 缺它服务端只能回落到可重放的 v1
    expect(headers['X-Aster-Nonce'], 'v2 必须发送 X-Aster-Nonce').toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    // 按 aster-api SnapshotPushResource.canonicalV2 的规格重算
    const bodySha = createHash('sha256').update(body).digest('hex');
    const canonical = [
      'POST',
      '/api/internal/snapshot/user/user-123',
      headers['X-Aster-Timestamp'],
      headers['X-Aster-Nonce'],
      bodySha,
    ].join('\n');
    const expected = createHmac('sha256', process.env.ASTER_PLAN_GATE_HMAC_KEY!)
      .update(canonical)
      .digest('hex');

    expect(
      headers['X-Aster-Signature'],
      '签名必须覆盖 method/path/ts/nonce/sha256(body)——与 aster-api 的 canonicalV2 逐字段一致'
    ).toBe(expected);
  });

  it('签名绑定 body：改一个字节即签名失配（防截获后替换请求体）', async () => {
    const { createHash, createHmac } = await import('node:crypto');
    mockFindFirst.mockResolvedValue({
      plan: 'pro',
      priceLockedAt: null,
      legacyTier: null,
      subscriptionStatus: 'active',
      aiBannedUntil: null,
      gracePeriodEndsAt: null,
    });
    const { pushUserSnapshot } = await import('@/lib/snapshot-pusher');
    await pushUserSnapshot('user-123');

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    const body = (init as RequestInit).body as string;

    // 攻击形态：截获签名后把 plan 换成 enterprise（提额）
    const tampered = body.replace('"pro"', '"enterprise"');
    expect(tampered).not.toBe(body);

    const sign = (b: string) =>
      createHmac('sha256', process.env.ASTER_PLAN_GATE_HMAC_KEY!)
        .update(
          [
            'POST',
            '/api/internal/snapshot/user/user-123',
            headers['X-Aster-Timestamp'],
            headers['X-Aster-Nonce'],
            createHash('sha256').update(b).digest('hex'),
          ].join('\n')
        )
        .digest('hex');

    expect(sign(tampered)).not.toBe(headers['X-Aster-Signature']);
    expect(sign(body)).toBe(headers['X-Aster-Signature']);
  });

  it('user 不存在 → 不 fetch（让 aster-api 缓存自然过期）', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const { pushUserSnapshot } = await import('@/lib/snapshot-pusher');
    await pushUserSnapshot('ghost');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('空 userId → no-op', async () => {
    const { pushUserSnapshot } = await import('@/lib/snapshot-pusher');
    await pushUserSnapshot('');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('aiBannedUntil 转 epoch ms', async () => {
    const banDate = new Date('2026-06-01T00:00:00Z');
    mockFindFirst.mockResolvedValue({
      plan: 'free',
      priceLockedAt: null,
      legacyTier: null,
      subscriptionStatus: null,
      aiBannedUntil: banDate,
      gracePeriodEndsAt: null,
    });
    const { pushUserSnapshot } = await import('@/lib/snapshot-pusher');
    await pushUserSnapshot('user-1');
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.aiBannedUntilEpochMs).toBe(banDate.getTime());
  });

  it('fetch 失败 fail-open（不抛）', async () => {
    mockFindFirst.mockResolvedValue({
      plan: 'pro',
      priceLockedAt: null,
      legacyTier: null,
      subscriptionStatus: 'active',
      aiBannedUntil: null,
      gracePeriodEndsAt: null,
    });
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as never;
    const { pushUserSnapshot } = await import('@/lib/snapshot-pusher');
    await expect(pushUserSnapshot('user-1')).resolves.toBeUndefined();
  });
});

describe('pushApiKeySnapshot', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFindFirst.mockReset();
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'test-secret-32chars-min-len-please';
    process.env.ASTER_API_INTERNAL_URL = 'http://aster-api.test';
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
  });

  it('keyHash 长度不是 64 → no-op', async () => {
    const { pushApiKeySnapshot } = await import('@/lib/snapshot-pusher');
    await pushApiKeySnapshot('short');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keyHash 长度 64 但非 hex → no-op（不查 DB、不 fetch）', async () => {
    const { pushApiKeySnapshot } = await import('@/lib/snapshot-pusher');
    await pushApiKeySnapshot('g'.repeat(64));
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('未找到 key → 推送 valid:false reason:not_found', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const hash = 'a'.repeat(64);
    const { pushApiKeySnapshot } = await import('@/lib/snapshot-pusher');
    await pushApiKeySnapshot(hash);
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('not_found');
  });

  it('已撤销 key → valid:false reason:revoked', async () => {
    const revokedAt = new Date('2026-04-01');
    mockFindFirst.mockResolvedValue({
      id: 'k1',
      userId: 'u1',
      revokedAt,
      expiresAt: null,
    });
    const hash = 'b'.repeat(64);
    const { pushApiKeySnapshot } = await import('@/lib/snapshot-pusher');
    await pushApiKeySnapshot(hash);
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('revoked');
    expect(body.revokedAtEpochMs).toBe(revokedAt.getTime());
  });

  it('过期 key → reason:expired', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'k1',
      userId: 'u1',
      revokedAt: null,
      expiresAt: new Date('2020-01-01'), // 已过期
    });
    const hash = 'c'.repeat(64);
    const { pushApiKeySnapshot } = await import('@/lib/snapshot-pusher');
    await pushApiKeySnapshot(hash);
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('expired');
  });

  it('有效 key → 下发 tenantId（租户隔离回归）', async () => {
    // 第一次 findFirst = apiKeys 查询；第二次 = users plan 查询
    mockFindFirst
      .mockResolvedValueOnce({
        id: 'k1',
        userId: 'u1',
        revokedAt: null,
        expiresAt: null, // 永不过期
      })
      .mockResolvedValueOnce({ plan: 'pro' });
    const hash = 'd'.repeat(64);
    const { pushApiKeySnapshot } = await import('@/lib/snapshot-pusher');
    await pushApiKeySnapshot(hash);
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.valid).toBe(true);
    expect(body.apiKeyId).toBe('k1');
    expect(body.userId).toBe('u1');
    // 核心断言：snapshot 必须带权威 tenantId（当前与 userId 同源）。
    // 缺失会让 aster-api snapshot 命中路径丢失租户、退化为跨租户隔离风险。
    expect(body.tenantId).toBe('u1');
    // 权威 RBAC 角色：aster-api 用它无条件覆盖 X-User-Role（防提权）。
    // tenantId===userId → owner。
    expect(body.role).toBe('owner');
    expect(body.plan).toBe('pro');
  });
});
