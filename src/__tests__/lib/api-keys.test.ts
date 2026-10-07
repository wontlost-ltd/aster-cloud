import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// P0-R18: complete Drizzle mock coverage for api-keys.ts (closes Jan 2026
// migration TODO). Same vi.hoisted pattern as usage.test.ts / compliance.test.ts.
const {
  mockFindMany,
  mockInsertReturning,
  mockInsertValues,
  mockInsert,
  mockUpdateReturning,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockResolve,
  mockPushApiKeySnapshot,
  mockInvalidateApiKeyCache,
  mockHasFeatureAccess,
} = vi.hoisted(() => {
  const mockFindMany = vi.fn();

  const mockInsertReturning = vi.fn();
  const mockInsertValues = vi.fn(() => ({ returning: mockInsertReturning }));
  const mockInsert = vi.fn(() => ({ values: mockInsertValues }));

  const mockUpdateReturning = vi.fn();
  // mockUpdateWhere 需要既能 await（validateApiKey 的 lastUsedAt update 不接
  // .returning() 直接 await）又能 .returning()（吊销类函数接 .returning()）.
  // 让它返回一个既是 thenable 又有 returning 方法的对象.
  const mockUpdateWhere = vi.fn(() => {
    const p: Promise<undefined> & { returning?: typeof mockUpdateReturning } =
      Promise.resolve(undefined) as Promise<undefined> & {
        returning?: typeof mockUpdateReturning;
      };
    p.returning = mockUpdateReturning;
    return p;
  });
  const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));
  const mockUpdate = vi.fn(() => ({ set: mockUpdateSet }));

  return {
    mockFindMany,
    mockInsertReturning,
    mockInsertValues,
    mockInsert,
    mockUpdateReturning,
    mockUpdateWhere,
    mockUpdateSet,
    mockUpdate,
    mockResolve: vi.fn(),
    mockPushApiKeySnapshot: vi.fn(),
    mockInvalidateApiKeyCache: vi.fn(),
    mockHasFeatureAccess: vi.fn(),
  };
});

vi.mock('@/lib/prisma', () => ({
  db: {
    query: {
      apiKeys: {
        findMany: mockFindMany,
      },
    },
    insert: mockInsert,
    update: mockUpdate,
  },
  // 列用字符串标记，配合下方 drizzle-orm mock 断言 where 的作用范围
  apiKeys: {
    id: 'apiKeys.id',
    userId: 'apiKeys.userId',
    teamId: 'apiKeys.teamId',
    key: 'apiKeys.key',
    name: 'apiKeys.name',
    prefix: 'apiKeys.prefix',
    createdAt: 'apiKeys.createdAt',
    lastUsedAt: 'apiKeys.lastUsedAt',
    revokedAt: 'apiKeys.revokedAt',
    expiresAt: 'apiKeys.expiresAt',
  },
  teams: {
    id: 'teams.id',
    name: 'teams.name',
    ownerId: 'teams.ownerId',
  },
}));

// 把查询条件变成可比较的普通对象：吊销/重推的范围（整队 vs 某成员）必须钉死
vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  isNull: (column: unknown) => ({ isNull: column }),
  and: (...conds: unknown[]) => ({ and: conds }),
  desc: (column: unknown) => ({ desc: column }),
}));

vi.mock('@/lib/api-key-identity', () => ({
  resolveApiKeyIdentity: mockResolve,
}));

vi.mock('@/lib/snapshot-pusher', () => ({
  pushApiKeySnapshot: mockPushApiKeySnapshot,
}));

vi.mock('@/lib/plan-gate-client', () => ({
  invalidateApiKeyCache: mockInvalidateApiKeyCache,
}));

vi.mock('@/lib/usage', () => ({
  hasFeatureAccess: mockHasFeatureAccess,
}));

import {
  generateApiKey,
  hashApiKey,
  createApiKey,
  validateApiKey,
  listApiKeys,
  revokeApiKey,
  revokeTeamKeys,
  refreshTeamKeySnapshots,
  authenticateApiRequest,
} from '@/lib/api-keys';

const PERSONAL_IDENTITY = {
  valid: true,
  apiKeyId: 'k1',
  userId: 'u1',
  tenantId: 'u1',
  teamId: null,
  quotaOwnerId: 'u1',
  role: 'owner',
  plan: 'pro',
  subscriptionStatus: 'active',
} as const;

const TEAM_IDENTITY = {
  valid: true,
  apiKeyId: 'k2',
  userId: 'u2',
  tenantId: 't1',
  teamId: 't1',
  quotaOwnerId: 'owner',
  role: 'member',
  plan: 'team',
  subscriptionStatus: 'active',
} as const;

function firstArg(mock: { mock: { calls: unknown[][] } }, call = 0): unknown {
  return (mock.mock.calls[call] as unknown[])[0];
}

describe('API Keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Pure functions (kept for regression after R18 expansion)
  // ──────────────────────────────────────────────────────────────────────

  describe('generateApiKey', () => {
    it('should generate a key with correct format', () => {
      const { key, hash, prefix } = generateApiKey();
      expect(key).toMatch(/^ak_[a-f0-9]{64}$/);
      expect(prefix).toHaveLength(8);
      expect(hash).toHaveLength(64); // SHA256 hex
    });

    it('should generate unique keys', () => {
      const key1 = generateApiKey();
      const key2 = generateApiKey();
      expect(key1.key).not.toBe(key2.key);
      expect(key1.hash).not.toBe(key2.hash);
    });
  });

  describe('hashApiKey', () => {
    it('should hash consistently', () => {
      const key = 'ak_test123';
      expect(hashApiKey(key)).toBe(hashApiKey(key));
    });

    it('should produce valid SHA256 hash', () => {
      const key = 'ak_test123';
      const expectedHash = createHash('sha256').update(key).digest('hex');
      expect(hashApiKey(key)).toBe(expectedHash);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // createApiKey
  // ──────────────────────────────────────────────────────────────────────

  describe('createApiKey', () => {
    it('inserts a new key row and returns the raw key + metadata', async () => {
      const fixedDate = new Date('2026-01-01T00:00:00Z');
      mockInsertReturning.mockResolvedValue([
        {
          id: 'key-id-123',
          userId: 'user-1',
          name: 'My Key',
          prefix: 'abcdef12',
          createdAt: fixedDate,
        },
      ]);

      const result = await createApiKey('user-1', 'My Key');

      expect(result.id).toBe('key-id-123');
      expect(result.name).toBe('My Key');
      expect(result.prefix).toBe('abcdef12');
      expect(result.createdAt).toEqual(fixedDate);
      // raw key returned to caller exactly once
      expect(result.key).toMatch(/^ak_[a-f0-9]{64}$/);
      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsertValues).toHaveBeenCalledTimes(1);
      const insertedRow = firstArg(mockInsertValues) as Record<string, unknown>;
      expect(insertedRow.userId).toBe('user-1');
      expect(insertedRow.name).toBe('My Key');
      // stored value is hash, not raw key
      expect(insertedRow.key).toBe(hashApiKey(result.key));
      // 推送的是落库的 hash，而不是明文 key
      expect(mockPushApiKeySnapshot).toHaveBeenCalledWith(insertedRow.key);
    });

    it('createApiKey 带 teamId 落库并推送快照', async () => {
      mockInsertReturning.mockResolvedValue([{ id: 'k9', prefix: 'abcdefgh', name: 'n', teamId: 't1', createdAt: new Date() }]);
      const { createApiKey } = await import('@/lib/api-keys');
      const r = await createApiKey('u2', 'n', 't1');
      expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u2', teamId: 't1' }));
      expect(r.teamId).toBe('t1');
      expect(mockPushApiKeySnapshot).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
    });

    it('createApiKey 不带 teamId 时 teamId 为 null（个人 key 不变）', async () => {
      mockInsertReturning.mockResolvedValue([{ id: 'k1', prefix: 'abcdefgh', name: 'n', teamId: null, createdAt: new Date() }]);
      const { createApiKey } = await import('@/lib/api-keys');
      const r = await createApiKey('u1', 'n');
      expect(mockInsertValues).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', teamId: null }));
      expect(r.teamId).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // validateApiKey
  // ──────────────────────────────────────────────────────────────────────

  describe('validateApiKey', () => {
    it('rejects empty key', async () => {
      const r = await validateApiKey('');
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/Invalid API key format/);
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('rejects key without ak_ prefix', async () => {
      const r = await validateApiKey('sk_wrong_prefix');
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/Invalid API key format/);
      expect(mockResolve).not.toHaveBeenCalled();
    });

    it('resolves identity by the sha256 hash of the raw key', async () => {
      mockResolve.mockResolvedValue({ valid: false, reason: 'not_found' });
      const raw = 'ak_' + 'a'.repeat(64);
      await validateApiKey(raw);
      expect(mockResolve).toHaveBeenCalledWith(hashApiKey(raw));
    });

    it.each([
      ['not_found', /^Invalid API key$/],
      ['revoked', /revoked/],
      ['expired', /expired/],
      ['orphan_key', /^Invalid API key$/],
      ['team_not_found', /team no longer exists/],
      ['membership_revoked', /no longer a member of the team/],
    ])('rejects %s keys without touching plan gate or lastUsedAt', async (reason, message) => {
      mockResolve.mockResolvedValue({ valid: false, reason });
      const r = await validateApiKey('ak_' + 'a'.repeat(64));
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(message);
      expect(mockHasFeatureAccess).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rejects when the quota owner lacks apiAccess (free plan or expired trial)', async () => {
      mockResolve.mockResolvedValue(PERSONAL_IDENTITY);
      mockHasFeatureAccess.mockResolvedValue(false);
      const r = await validateApiKey('ak_' + 'a'.repeat(64));
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/Pro or Team/);
      expect(mockHasFeatureAccess).toHaveBeenCalledWith('u1', 'apiAccess');
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('accepts valid personal key, gates on the holder and updates lastUsedAt', async () => {
      mockResolve.mockResolvedValue(PERSONAL_IDENTITY);
      mockHasFeatureAccess.mockResolvedValue(true);
      const r = await validateApiKey('ak_' + 'a'.repeat(64));
      expect(r).toEqual({ valid: true, userId: 'u1', apiKeyId: 'k1', teamId: null });
      expect(mockHasFeatureAccess).toHaveBeenCalledWith('u1', 'apiAccess');
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const setArg = firstArg(mockUpdateSet) as Record<string, unknown>;
      expect(setArg.lastUsedAt).toBeInstanceOf(Date);
      expect(firstArg(mockUpdateWhere)).toEqual({ eq: ['apiKeys.id', 'k1'] });
    });

    it('validateApiKey：团队 key 以 quotaOwnerId 判断 apiAccess；membership_revoked → 无效', async () => {
      mockResolve.mockResolvedValue({ valid: true, apiKeyId: 'k2', userId: 'u2', tenantId: 't1', teamId: 't1', quotaOwnerId: 'owner', role: 'member', plan: 'team', subscriptionStatus: 'active' });
      mockHasFeatureAccess.mockResolvedValue(true);
      const { validateApiKey } = await import('@/lib/api-keys');
      expect(await validateApiKey('ak_' + 'f'.repeat(64))).toEqual({ valid: true, userId: 'u2', apiKeyId: 'k2', teamId: 't1' });
      expect(mockHasFeatureAccess).toHaveBeenCalledWith('owner', 'apiAccess');
      mockResolve.mockResolvedValue({ valid: false, reason: 'membership_revoked' });
      expect((await validateApiKey('ak_' + 'f'.repeat(64))).valid).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // listApiKeys
  // ──────────────────────────────────────────────────────────────────────

  describe('listApiKeys', () => {
    it('returns active keys with teamId/teamName flattened from the team relation', async () => {
      const k1 = {
        id: 'k1',
        name: 'Production',
        prefix: 'abc12345',
        teamId: null,
        lastUsedAt: new Date('2026-05-01'),
        expiresAt: null,
        createdAt: new Date('2026-04-01'),
      };
      const k2 = {
        id: 'k2',
        name: 'Staging',
        prefix: 'def67890',
        teamId: 't1',
        lastUsedAt: null,
        expiresAt: new Date('2026-12-31'),
        createdAt: new Date('2026-05-15'),
      };
      mockFindMany.mockResolvedValue([
        { ...k1, team: null },
        { ...k2, team: { name: 'Acme' } },
      ]);

      const result = await listApiKeys('u1');

      expect(result).toEqual([
        { ...k1, teamName: null },
        { ...k2, teamName: 'Acme' },
      ]);
      expect(mockFindMany).toHaveBeenCalledTimes(1);
      const query = firstArg(mockFindMany) as Record<string, unknown>;
      expect(query.where).toEqual({ and: [{ eq: ['apiKeys.userId', 'u1'] }, { isNull: 'apiKeys.revokedAt' }] });
      expect(query.columns).toMatchObject({ teamId: true });
      expect(query.columns).not.toHaveProperty('key');
      expect(query.with).toEqual({ team: { columns: { name: true } } });
    });

    it('returns empty array when user has no keys', async () => {
      mockFindMany.mockResolvedValue([]);
      const result = await listApiKeys('u1');
      expect(result).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // revokeApiKey
  // ──────────────────────────────────────────────────────────────────────

  describe('revokeApiKey', () => {
    it('returns true when revocation matched a row, scoped to the owner and still-active key', async () => {
      mockUpdateReturning.mockResolvedValue([{ key: 'h'.repeat(64), userId: 'u1' }]);
      const ok = await revokeApiKey('u1', 'k1');
      expect(ok).toBe(true);
      const setArg = firstArg(mockUpdateSet) as Record<string, unknown>;
      expect(setArg.revokedAt).toBeInstanceOf(Date);
      expect(firstArg(mockUpdateWhere)).toEqual({
        and: [{ eq: ['apiKeys.id', 'k1'] }, { eq: ['apiKeys.userId', 'u1'] }, { isNull: 'apiKeys.revokedAt' }],
      });
    });

    it('returns false when no row matched (e.g. already revoked or wrong user)', async () => {
      mockUpdateReturning.mockResolvedValue([]);
      const ok = await revokeApiKey('u1', 'k1');
      expect(ok).toBe(false);
    });

    it('revokeApiKey 成功后推送无效快照并失效缓存；未命中则都不调用', async () => {
      mockUpdateReturning.mockResolvedValueOnce([{ key: 'h'.repeat(64), userId: 'u1' }]);
      const { revokeApiKey } = await import('@/lib/api-keys');
      expect(await revokeApiKey('u1', 'k1')).toBe(true);
      expect(mockPushApiKeySnapshot).toHaveBeenCalledWith('h'.repeat(64));
      expect(mockInvalidateApiKeyCache).toHaveBeenCalledWith('u1');
      vi.clearAllMocks();
      mockUpdateReturning.mockResolvedValueOnce([]);
      expect(await revokeApiKey('u1', 'nope')).toBe(false);
      expect(mockPushApiKeySnapshot).not.toHaveBeenCalled();
      expect(mockInvalidateApiKeyCache).not.toHaveBeenCalled();
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // revokeTeamKeys / refreshTeamKeySnapshots（ADR 0015 §5）
  // ──────────────────────────────────────────────────────────────────────

  describe('revokeTeamKeys', () => {
    it('revokeTeamKeys(teamId, userId) 逐 key 推送，按用户去重失效缓存，返回条数', async () => {
      mockUpdateReturning.mockResolvedValueOnce([{ key: 'a'.repeat(64), userId: 'u2' }, { key: 'b'.repeat(64), userId: 'u2' }]);
      const { revokeTeamKeys } = await import('@/lib/api-keys');
      expect(await revokeTeamKeys('t1', 'u2')).toBe(2);
      expect(mockPushApiKeySnapshot).toHaveBeenCalledTimes(2);
      expect(mockInvalidateApiKeyCache).toHaveBeenCalledTimes(1);
      expect(mockInvalidateApiKeyCache).toHaveBeenCalledWith('u2');
    });

    it('with userId only revokes that member’s active keys in the team', async () => {
      mockUpdateReturning.mockResolvedValueOnce([]);
      await revokeTeamKeys('t1', 'u2');
      expect((firstArg(mockUpdateSet) as Record<string, unknown>).revokedAt).toBeInstanceOf(Date);
      expect(firstArg(mockUpdateWhere)).toEqual({
        and: [{ eq: ['apiKeys.teamId', 't1'] }, { isNull: 'apiKeys.revokedAt' }, { eq: ['apiKeys.userId', 'u2'] }],
      });
    });

    it('without userId revokes every active key of the team and invalidates each holder once', async () => {
      mockUpdateReturning.mockResolvedValueOnce([
        { key: 'a'.repeat(64), userId: 'u2' },
        { key: 'b'.repeat(64), userId: 'u3' },
        { key: 'c'.repeat(64), userId: 'u2' },
      ]);
      expect(await revokeTeamKeys('t1')).toBe(3);
      expect(firstArg(mockUpdateWhere)).toEqual({
        and: [{ eq: ['apiKeys.teamId', 't1'] }, { isNull: 'apiKeys.revokedAt' }],
      });
      expect(mockPushApiKeySnapshot.mock.calls).toEqual([['a'.repeat(64)], ['b'.repeat(64)], ['c'.repeat(64)]]);
      expect(mockInvalidateApiKeyCache.mock.calls).toEqual([['u2'], ['u3']]);
    });

    it('returns 0 and notifies nobody when the team has no active keys', async () => {
      mockUpdateReturning.mockResolvedValueOnce([]);
      expect(await revokeTeamKeys('t1')).toBe(0);
      expect(mockPushApiKeySnapshot).not.toHaveBeenCalled();
      expect(mockInvalidateApiKeyCache).not.toHaveBeenCalled();
    });
  });

  describe('refreshTeamKeySnapshots', () => {
    it('refreshTeamKeySnapshots(teamId) 对每把活跃 key 推送一次，按用户失效缓存', async () => {
      mockFindMany.mockResolvedValueOnce([{ key: 'a'.repeat(64), userId: 'u2' }, { key: 'c'.repeat(64), userId: 'u3' }]);
      const { refreshTeamKeySnapshots } = await import('@/lib/api-keys');
      expect(await refreshTeamKeySnapshots('t1')).toBe(2);
      expect(mockPushApiKeySnapshot).toHaveBeenCalledTimes(2);
      expect(mockInvalidateApiKeyCache).toHaveBeenCalledTimes(2);
    });

    it('reads (never revokes) the active keys, narrowed to one member when userId is given', async () => {
      mockFindMany.mockResolvedValueOnce([{ key: 'a'.repeat(64), userId: 'u2' }]);
      expect(await refreshTeamKeySnapshots('t1', 'u2')).toBe(1);
      expect(firstArg(mockFindMany)).toEqual({
        where: { and: [{ eq: ['apiKeys.teamId', 't1'] }, { isNull: 'apiKeys.revokedAt' }, { eq: ['apiKeys.userId', 'u2'] }] },
        columns: { key: true, userId: true },
      });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockPushApiKeySnapshot).toHaveBeenCalledWith('a'.repeat(64));
      expect(mockInvalidateApiKeyCache).toHaveBeenCalledWith('u2');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // authenticateApiRequest
  // ──────────────────────────────────────────────────────────────────────

  describe('authenticateApiRequest', () => {
    function makeReq(authHeader?: string): Request {
      const headers = new Headers();
      if (authHeader) headers.set('authorization', authHeader);
      return new Request('https://example.com/api/v1/policies', {
        method: 'POST',
        headers,
      });
    }

    it('rejects requests with no Authorization header', async () => {
      const r = await authenticateApiRequest(makeReq());
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.status).toBe(401);
        expect(r.error).toMatch(/Authorization header/);
      }
    });

    it('rejects non-Bearer auth schemes', async () => {
      const r = await authenticateApiRequest(makeReq('Basic dXNlcjpwYXNz'));
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.status).toBe(401);
      }
    });

    it('rejects when underlying validation fails', async () => {
      mockResolve.mockResolvedValue({ valid: false, reason: 'not_found' });
      const r = await authenticateApiRequest(
        makeReq('Bearer ak_' + 'a'.repeat(64)),
      );
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.status).toBe(401);
        expect(r.error).toMatch(/Invalid API key/);
      }
    });

    it('returns success with userId + apiKeyId + null teamId for a personal key', async () => {
      mockResolve.mockResolvedValue(PERSONAL_IDENTITY);
      mockHasFeatureAccess.mockResolvedValue(true);
      const r = await authenticateApiRequest(
        makeReq('Bearer ak_' + 'a'.repeat(64)),
      );
      expect(r).toEqual({ success: true, userId: 'u1', apiKeyId: 'k1', teamId: null });
    });

    it('returns the key teamId for a team key', async () => {
      mockResolve.mockResolvedValue(TEAM_IDENTITY);
      mockHasFeatureAccess.mockResolvedValue(true);
      const r = await authenticateApiRequest(
        makeReq('Bearer ak_' + 'a'.repeat(64)),
      );
      expect(r).toEqual({ success: true, userId: 'u2', apiKeyId: 'k2', teamId: 't1' });
    });
  });
});
