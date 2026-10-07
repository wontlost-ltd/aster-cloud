import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET, POST } from '@/app/api/api-keys/route';
import { getSession } from '@/lib/auth';
import { hasFeatureAccess } from '@/lib/usage';
import { createApiKey, listApiKeys } from '@/lib/api-keys';
import { checkTeamAccess } from '@/lib/team-permissions';

const { mockTeamsFindFirst } = vi.hoisted(() => ({
  mockTeamsFindFirst: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/usage', () => ({
  hasFeatureAccess: vi.fn(),
}));

vi.mock('@/lib/api-keys', () => ({
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
}));

vi.mock('@/lib/team-permissions', () => ({
  checkTeamAccess: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  db: { query: { teams: { findFirst: mockTeamsFindFirst } } },
  teams: { id: 'teams.id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
}));

const mockGetSession = vi.mocked(getSession);
const mockHasFeatureAccess = vi.mocked(hasFeatureAccess);
const mockCreateApiKey = vi.mocked(createApiKey);
const mockListApiKeys = vi.mocked(listApiKeys);
const mockCheckTeamAccess = vi.mocked(checkTeamAccess);

function createPostRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/api-keys', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('API Keys API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      user: { id: 'user-1' },
    } as unknown as Awaited<ReturnType<typeof getSession>>);
  });

  describe('GET /api/api-keys', () => {
    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return api keys list on success', async () => {
      mockListApiKeys.mockResolvedValue([
        { id: 'key-1', prefix: 'ak_abc', name: 'Key 1', teamId: null, teamName: null, createdAt: new Date(), lastUsedAt: null, expiresAt: null },
        { id: 'key-2', prefix: 'ak_def', name: 'Key 2', teamId: 't1', teamName: 'Acme', createdAt: new Date(), lastUsedAt: new Date(), expiresAt: null },
      ]);

      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body[0].id).toBe('key-1');
      expect(body[1].teamName).toBe('Acme');
      expect(mockListApiKeys).toHaveBeenCalledWith('user-1');
    });

    it('should return 500 on internal error', async () => {
      mockListApiKeys.mockRejectedValue(new Error('Database error'));

      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });
  });

  describe('POST /api/api-keys', () => {
    it('should return 401 when not authenticated', async () => {
      mockGetSession.mockResolvedValue(null);

      const response = await POST(createPostRequest({ name: 'My Key' }));
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 403 when user lacks API access', async () => {
      mockHasFeatureAccess.mockResolvedValue(false);

      const response = await POST(createPostRequest({ name: 'My Key' }));
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('API access requires');
      expect(body.upgrade).toBe(true);
      expect(mockHasFeatureAccess).toHaveBeenCalledWith('user-1', 'apiAccess');
      expect(mockCreateApiKey).not.toHaveBeenCalled();
    });

    it('should return 400 when name is missing', async () => {
      mockHasFeatureAccess.mockResolvedValue(true);

      const response = await POST(createPostRequest({}));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Name is required');
    });

    it('should return 400 when name is not a string', async () => {
      mockHasFeatureAccess.mockResolvedValue(true);

      const response = await POST(createPostRequest({ name: 123 }));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Name is required');
    });

    it('should return 201 and create key on success', async () => {
      mockHasFeatureAccess.mockResolvedValue(true);
      mockCreateApiKey.mockResolvedValue({
        id: 'key-1',
        key: 'ak_test_full_key',
        prefix: 'ak_test',
        name: 'My Key',
        teamId: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      });

      const response = await POST(createPostRequest({ name: 'My Key' }));
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.id).toBe('key-1');
      expect(body.key).toBe('ak_test_full_key');
      expect(body.teamId).toBeNull();
      expect(mockCreateApiKey).toHaveBeenCalledWith('user-1', 'My Key', null);
      expect(mockCheckTeamAccess).not.toHaveBeenCalled();
    });

    it('treats an explicit null teamId as a personal key', async () => {
      mockHasFeatureAccess.mockResolvedValue(true);
      mockCreateApiKey.mockResolvedValue({
        id: 'key-1',
        key: 'ak_test_full_key',
        prefix: 'ak_test',
        name: 'My Key',
        teamId: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
      });

      const response = await POST(createPostRequest({ name: 'My Key', teamId: null }));

      expect(response.status).toBe(201);
      expect(mockCreateApiKey).toHaveBeenCalledWith('user-1', 'My Key', null);
      expect(mockCheckTeamAccess).not.toHaveBeenCalled();
    });

    it('should return 400 when teamId is not a string', async () => {
      const response = await POST(createPostRequest({ name: 'k', teamId: 123 }));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'teamId must be a string' });
      expect(mockCheckTeamAccess).not.toHaveBeenCalled();
      expect(mockCreateApiKey).not.toHaveBeenCalled();
    });

    it('POST 带 teamId：非成员 403 not_a_member', async () => {
      mockCheckTeamAccess.mockResolvedValue({ allowed: false, error: 'x', status: 403 });
      const res = await POST(createPostRequest({ name: 'k', teamId: 't1' }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_a_member' });
      expect(mockCreateApiKey).not.toHaveBeenCalled();
      expect(mockCheckTeamAccess).toHaveBeenCalledWith('user-1', 't1');
      expect(mockTeamsFindFirst).not.toHaveBeenCalled();
    });

    it('POST 带 teamId：成员关系在但团队行已不存在 → 403 not_a_member', async () => {
      mockCheckTeamAccess.mockResolvedValue({ allowed: true, role: 'member', teamId: 't1' });
      mockTeamsFindFirst.mockResolvedValue(undefined);
      const res = await POST(createPostRequest({ name: 'k', teamId: 't1' }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'not_a_member' });
      expect(mockHasFeatureAccess).not.toHaveBeenCalled();
      expect(mockCreateApiKey).not.toHaveBeenCalled();
    });

    it('POST 带 teamId：owner 套餐无 apiAccess → 403 plan_no_api_access', async () => {
      mockCheckTeamAccess.mockResolvedValue({ allowed: true, role: 'member', teamId: 't1' });
      mockTeamsFindFirst.mockResolvedValue({ ownerId: 'owner' });
      mockHasFeatureAccess.mockResolvedValue(false);
      const res = await POST(createPostRequest({ name: 'k', teamId: 't1' }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'plan_no_api_access', upgrade: true });
      expect(mockHasFeatureAccess).toHaveBeenCalledWith('owner', 'apiAccess');
      expect(mockCreateApiKey).not.toHaveBeenCalled();
    });

    it('POST 带 teamId：成员且 owner 有 apiAccess → 201，createApiKey(uid, name, "t1")', async () => {
      mockCheckTeamAccess.mockResolvedValue({ allowed: true, role: 'member', teamId: 't1' });
      mockTeamsFindFirst.mockResolvedValue({ ownerId: 'owner' });
      mockHasFeatureAccess.mockResolvedValue(true);
      mockCreateApiKey.mockResolvedValue({ id: 'k9', key: 'ak_x', prefix: 'p', name: 'k', teamId: 't1', createdAt: new Date() });
      const res = await POST(createPostRequest({ name: 'k', teamId: 't1' }));
      expect(res.status).toBe(201);
      expect(mockCreateApiKey).toHaveBeenCalledWith('user-1', 'k', 't1');
      expect((await res.json()).teamId).toBe('t1');
      expect(mockTeamsFindFirst).toHaveBeenCalledWith({ where: { eq: ['teams.id', 't1'] }, columns: { ownerId: true } });
      // 套餐门槛只看 team owner，不看调用者本人
      expect(mockHasFeatureAccess).not.toHaveBeenCalledWith('user-1', 'apiAccess');
    });

    it('should return 500 on internal error', async () => {
      mockHasFeatureAccess.mockResolvedValue(true);
      mockCreateApiKey.mockRejectedValue(new Error('Database error'));

      const response = await POST(createPostRequest({ name: 'My Key' }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Internal server error');
    });
  });
});
