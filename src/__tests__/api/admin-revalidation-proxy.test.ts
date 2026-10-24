import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { requireAdmin, signHeaders } = vi.hoisted(() => ({ requireAdmin: vi.fn(), signHeaders: vi.fn() }));
vi.mock('@/lib/admin-auth', () => ({ requireAdmin }));
vi.mock('@/lib/api-signing', () => ({ signByokAllowlistHeaders: signHeaders }));

import { GET, POST } from '@/app/api/admin/revalidation/[...path]/route';

describe('重验管理代理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdmin.mockResolvedValue({ userId: 'admin-1' });
    signHeaders.mockResolvedValue({ 'X-Internal-Signature': 'signed' });
  });

  it('拒绝非管理员请求', async () => {
    requireAdmin.mockResolvedValue(NextResponse.json({ error: 'forbidden' }, { status: 403 }));
    const response = await GET(new NextRequest('https://cloud.test/api/admin/revalidation/invalid'), { params: Promise.resolve({ path: ['invalid'] }) });
    expect(response.status).toBe(403);
  });

  it('拒绝白名单外路径', async () => {
    const response = await GET(new NextRequest('https://cloud.test/api/admin/revalidation/other'), { params: Promise.resolve({ path: ['other'] }) });
    expect(response.status).toBe(404);
  });

  it('透传成功响应及冲突响应', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"runId":"r-1"}', { status: 202 }))
      .mockResolvedValueOnce(new Response('{"error":"active_run"}', { status: 409 }));
    const context = { params: Promise.resolve({ path: ['runs'] }) };
    const request = () => new NextRequest('https://cloud.test/api/admin/revalidation/runs', { method: 'POST', body: '{"scope":"all"}' });
    expect((await POST(request(), context)).status).toBe(202);
    expect((await POST(request(), context)).status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });
});
