import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const originalKey = process.env.ASTER_PLAN_GATE_HMAC_KEY;
const originalUrl = process.env.ASTER_API_INTERNAL_URL;

const { mockFindFirst, mockResolve, mockTeamsFindMany } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockResolve: vi.fn(),
  mockTeamsFindMany: vi.fn(),
}));

// 身份口径由解析器决定（ADR 0015 §2），这里只替换按 hash 解析的函数；
// 快照体映射 toApiKeySnapshotBody 取真实实现，以钉住实际下发的请求体
vi.mock('@/lib/api-key-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-key-identity')>()),
  resolveApiKeyIdentity: mockResolve,
}));

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      users: { findFirst: mockFindFirst },
      // owner 套餐 fan-out（plan-gate-client.invalidatePlanCacheForOwner）查名下团队
      teams: { findMany: mockTeamsFindMany },
    },
  },
  users: { id: {} },
  teams: { id: {}, ownerId: {} },
}));

describe('pushUserSnapshot', () => {
  beforeEach(() => {
    vi.resetModules();
    mockFindFirst.mockReset();
    mockTeamsFindMany.mockReset();
    mockTeamsFindMany.mockResolvedValue([]);
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

  // 团队 key 的限速按 owner 套餐（ADR 0015 §5）：owner 快照推完后，其名下每个团队的 plan 缓存都要失效。
  // 不 mock plan-gate-client：fan-out 在其模块内部调用 invalidatePlanCache，只能在出站请求上观察。
  it('推送用户快照后，失效其名下每个团队的 plan 缓存（t1、t2）', async () => {
    mockFindFirst.mockResolvedValue({
      plan: 'team',
      priceLockedAt: null,
      legacyTier: null,
      subscriptionStatus: 'active',
      aiBannedUntil: null,
      gracePeriodEndsAt: null,
    });
    mockTeamsFindMany.mockResolvedValue([{ id: 't1' }, { id: 't2' }]);
    const { pushUserSnapshot } = await import('@/lib/snapshot-pusher');
    await pushUserSnapshot('owner-1');

    const urls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => url as string);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe('http://aster-api.test/api/internal/snapshot/user/owner-1');
    expect(urls.slice(1).sort()).toEqual([
      'http://aster-api.test/api/internal/plan-cache/t1',
      'http://aster-api.test/api/internal/plan-cache/t2',
    ]);
    expect(mockTeamsFindMany).toHaveBeenCalledTimes(1);
  });

  it('user 不存在 → 不 fetch（让 aster-api 缓存自然过期）', async () => {
    mockFindFirst.mockResolvedValue(undefined);
    const { pushUserSnapshot } = await import('@/lib/snapshot-pusher');
    await pushUserSnapshot('ghost');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockTeamsFindMany).not.toHaveBeenCalled();
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
    mockResolve.mockReset();
    process.env.ASTER_PLAN_GATE_HMAC_KEY = 'test-secret-32chars-min-len-please';
    process.env.ASTER_API_INTERNAL_URL = 'http://aster-api.test';
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never;
  });

  async function pushedBody(hash: string): Promise<Record<string, unknown>> {
    const { pushApiKeySnapshot } = await import('@/lib/snapshot-pusher');
    await pushApiKeySnapshot(hash);
    expect(mockResolve).toHaveBeenCalledWith(hash);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`http://aster-api.test/api/internal/snapshot/apikey/${hash}`);
    return JSON.parse((init as RequestInit).body as string);
  }

  it('keyHash 长度不是 64 → no-op', async () => {
    const { pushApiKeySnapshot } = await import('@/lib/snapshot-pusher');
    await pushApiKeySnapshot('short');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keyHash 长度 64 但非 hex → no-op（不解析、不 fetch）', async () => {
    const { pushApiKeySnapshot } = await import('@/lib/snapshot-pusher');
    await pushApiKeySnapshot('g'.repeat(64));
    expect(mockResolve).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('身份直接取 resolveApiKeyIdentity(keyHash)，pusher 不自己查库', async () => {
    mockResolve.mockResolvedValue({ valid: false, reason: 'not_found' });
    const body = await pushedBody('a'.repeat(64));
    expect(body).toEqual({ valid: false, reason: 'not_found' });
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('团队不存在 → valid:false reason:team_not_found', async () => {
    mockResolve.mockResolvedValue({ valid: false, reason: 'team_not_found' });
    expect(await pushedBody('e'.repeat(64))).toEqual({ valid: false, reason: 'team_not_found' });
  });

  it('已撤销 key → valid:false reason:revoked + revokedAtEpochMs', async () => {
    const revokedAt = new Date('2026-04-01');
    mockResolve.mockResolvedValue({ valid: false, reason: 'revoked', revokedAt });
    expect(await pushedBody('b'.repeat(64))).toEqual({
      valid: false, reason: 'revoked', revokedAtEpochMs: revokedAt.getTime(),
    });
  });

  it('过期 key → reason:expired（不带时间字段）', async () => {
    mockResolve.mockResolvedValue({ valid: false, reason: 'expired', expiredAt: new Date('2020-01-01') });
    expect(await pushedBody('c'.repeat(64))).toEqual({ valid: false, reason: 'expired' });
  });

  it('成员已被移出的团队 key → valid:false reason:membership_revoked', async () => {
    mockResolve.mockResolvedValue({ valid: false, reason: 'membership_revoked' });
    expect(await pushedBody('f'.repeat(64))).toEqual({ valid: false, reason: 'membership_revoked' });
  });

  // 铁律：个人 key 的快照体 = 改前字段 + quotaOwnerId(=userId)，多一个或改名一个字段都要红。
  // tenantId 缺失会让 aster-api snapshot 命中路径丢失租户；role 用于无条件覆盖 X-User-Role（防提权）。
  it('个人 key → 完整体：tenantId=userId、role=owner、quotaOwnerId=userId（租户隔离回归）', async () => {
    mockResolve.mockResolvedValue({
      valid: true, apiKeyId: 'k1', userId: 'u1', tenantId: 'u1', teamId: null, quotaOwnerId: 'u1',
      role: 'owner', businessRoles: [], plan: 'pro', subscriptionStatus: 'active',
    });
    // 无业务角色时快照体不含 businessRoles 键（与 aster-api 快照 NON_EMPTY 对称，ADR 0042 §2.2）
    expect(await pushedBody('d'.repeat(64))).toEqual({
      valid: true,
      apiKeyId: 'k1',
      userId: 'u1',
      tenantId: 'u1',
      quotaOwnerId: 'u1',
      role: 'owner',
      plan: 'pro',
      revokedAtEpochMs: null,
    });
  });

  it('团队 key → tenantId=teamId、role=成员角色、quotaOwnerId=owner、套餐取 owner', async () => {
    mockResolve.mockResolvedValue({
      valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', teamId: 't1', quotaOwnerId: 'owner',
      role: 'member', businessRoles: ['DPO'], plan: 'team', subscriptionStatus: 'active',
    });
    expect(await pushedBody('9'.repeat(64))).toEqual({
      valid: true,
      apiKeyId: 'k2',
      userId: 'u2',
      tenantId: 't1',
      quotaOwnerId: 'owner',
      role: 'member',
      businessRoles: ['DPO'],
      plan: 'team',
      revokedAtEpochMs: null,
    });
  });

  it('解析器抛错 → fail-open（不抛、不 fetch）', async () => {
    mockResolve.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { pushApiKeySnapshot } = await import('@/lib/snapshot-pusher');
    await expect(pushApiKeySnapshot('8'.repeat(64))).resolves.toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
