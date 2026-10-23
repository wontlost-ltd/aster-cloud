import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: { users: { findMany: vi.fn() } },
    update: vi.fn(),
    insert: vi.fn(),
  },
}));

import { GET, POST } from '@/app/api/admin/ai-workspace-access/route';
import { requireAdmin } from '@/lib/admin-auth';
import { db } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';

function request(url: string, body?: unknown) {
  return new Request(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

import type { NextRequest } from 'next/server';

describe('/api/admin/ai-workspace-access', () => {
  beforeEach(() => vi.clearAllMocks());

  it('非管理员请求返回 403', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce(NextResponse.json({}, { status: 403 }));
    expect((await GET(request('http://localhost/api/admin/ai-workspace-access'))).status).toBe(403);
  });

  it('GET 按邮箱过滤并返回用户列表', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({ userId: 'admin-1' });
    vi.mocked(db.query.users.findMany).mockResolvedValueOnce([{
      id: 'user-1',
      email: 'person@example.com',
      name: '示例用户',
      isAdmin: false,
      aiWorkspaceEnabled: true,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    }] as never);

    const response = await GET(request('http://localhost/api/admin/ai-workspace-access?q=person'));
    expect(response.status).toBe(200);
    expect((await response.json()).users[0].email).toBe('person@example.com');
    const query = vi.mocked(db.query.users.findMany).mock.calls[0][0];
    expect(query).toEqual(expect.objectContaining({
      limit: 100,
      where: expect.anything(),
    }));
    const where = query?.where;
    if (!where || typeof where === 'function') throw new Error('邮箱过滤查询缺少 SQL 条件');
    const compiled = new PgDialect().sqlToQuery(where);
    expect(compiled.sql).toContain('"User"."deletedAt" is null');
    expect(compiled.sql).toContain('"User"."email" ilike');
    expect(compiled.params).toContain('%person%');
  });

  it('GET 将最大条数限制为 500', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({ userId: 'admin-1' });
    vi.mocked(db.query.users.findMany).mockResolvedValueOnce([] as never);
    await GET(request('http://localhost/api/admin/ai-workspace-access?limit=900'));
    expect(vi.mocked(db.query.users.findMany).mock.calls[0]?.[0]?.limit).toBe(500);
  });

  it('POST 校验失败返回 400', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({ userId: 'admin-1' });
    expect((await POST(request('http://localhost/api/admin/ai-workspace-access', { userId: '', enabled: 'yes' }))).status).toBe(400);
  });

  it('POST 找不到目标用户时返回 404', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({ userId: 'admin-1' });
    const where = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) });
    const set = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set } as never);

    expect((await POST(request('http://localhost/api/admin/ai-workspace-access', { userId: 'missing', enabled: true }))).status).toBe(404);
  });

  it('POST 更新授权并写入操作者审计记录', async () => {
    vi.mocked(requireAdmin).mockResolvedValueOnce({ userId: 'admin-1' });
    const updated = {
      id: 'user-1',
      email: 'person@example.com',
      name: '示例用户',
      isAdmin: false,
      aiWorkspaceEnabled: true,
      createdAt: new Date('2026-10-01T00:00:00Z'),
    };
    const returning = vi.fn().mockResolvedValue([updated]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    vi.mocked(db.update).mockReturnValue({ set } as never);
    const values = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values } as never);

    const response = await POST(request('http://localhost/api/admin/ai-workspace-access', { userId: 'user-1', enabled: true }));
    expect(response.status).toBe(200);
    expect((await response.json()).user.aiWorkspaceEnabled).toBe(true);
    expect(set).toHaveBeenCalledWith({ aiWorkspaceEnabled: true });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1',
      action: 'ai_workspace.access.grant',
      resource: 'user',
      resourceId: 'user-1',
      metadata: { adminUserId: 'admin-1' },
    }));
  });
});
