import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { requireAdmin, signHeaders, logAuditEvent } = vi.hoisted(() => ({ requireAdmin: vi.fn(), signHeaders: vi.fn(), logAuditEvent: vi.fn() }));
vi.mock('@/lib/admin-auth', () => ({ requireAdmin }));
vi.mock('@/lib/api-signing', () => ({ signByokAllowlistHeaders: signHeaders }));
vi.mock('@/lib/audit-log', () => ({ logAuditEvent, extractClientInfo: () => ({ ipAddress: '203.0.113.9', userAgent: 'vitest' }) }));

import { GET, POST } from '@/app/api/admin/revalidation/[...path]/route';

describe('重验管理代理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdmin.mockResolvedValue({ userId: 'admin-1' });
    signHeaders.mockResolvedValue({ 'X-Internal-Signature': 'signed' });
    logAuditEvent.mockResolvedValue(undefined);
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

  it('签名只覆盖路径，不含查询串', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    await GET(new NextRequest('https://cloud.test/api/admin/revalidation/invalid?page=0&size=5'), { params: Promise.resolve({ path: ['invalid'] }) });
    expect(signHeaders).toHaveBeenLastCalledWith('GET', '/api/v1/admin/revalidation/invalid', null);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/admin/revalidation/invalid?page=0&size=5');
    fetchMock.mockRestore();
  });

  it('发起重验：带上管理员 id 签名转发，并在 api 受理后写审计', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"runId":41}', { status: 202 }));
    const request = new NextRequest('https://cloud.test/api/admin/revalidation/runs', { method: 'POST', body: '{"scope":"all"}' });
    const response = await POST(request, { params: Promise.resolve({ path: ['runs'] }) });
    expect(response.status).toBe(202);
    const sentBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(sentBody).toEqual({ scope: 'all', requestedBy: 'admin-1' });
    expect(signHeaders).toHaveBeenLastCalledWith('POST', '/api/v1/admin/revalidation/runs', JSON.stringify(sentBody));
    expect(logAuditEvent).toHaveBeenCalledTimes(1);
    expect(logAuditEvent.mock.calls[0][0]).toMatchObject({
      userId: 'admin-1', action: 'policy.revalidation.started', resource: 'revalidation-run', resourceId: '41',
      metadata: { scope: 'all', tenantId: null, operatorId: 'admin-1' }, ipAddress: '203.0.113.9', userAgent: 'vitest',
    });
    fetchMock.mockRestore();
  });

  it('api 拒绝（409 已有任务）时不写审计', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":"active_run_exists"}', { status: 409 }));
    await POST(new NextRequest('https://cloud.test/api/admin/revalidation/runs', { method: 'POST', body: '{"scope":"all"}' }), { params: Promise.resolve({ path: ['runs'] }) });
    expect(logAuditEvent).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('审计写入失败不影响已受理的响应', async () => {
    logAuditEvent.mockRejectedValueOnce(new Error('db down'));
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"runId":42}', { status: 202 }));
    const response = await POST(new NextRequest('https://cloud.test/api/admin/revalidation/runs', { method: 'POST', body: '{"scope":"all"}' }), { params: Promise.resolve({ path: ['runs'] }) });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ runId: 42 });
    fetchMock.mockRestore();
  });

  it('发起请求体不是 JSON 对象：400，不转发、不审计', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    for (const body of ['not json', '[1]', '"x"']) {
      const response = await POST(new NextRequest('https://cloud.test/api/admin/revalidation/runs', { method: 'POST', body }), { params: Promise.resolve({ path: ['runs'] }) });
      expect(response.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logAuditEvent).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('preview 在白名单内：签名只覆盖路径，查询串拼到上游 URL，不审计', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"total":12}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const response = await GET(new NextRequest('https://cloud.test/api/admin/revalidation/preview?scope=tenant&tenantId=t1'), { params: Promise.resolve({ path: ['preview'] }) });
    expect(response.status).toBe(200);
    expect(signHeaders).toHaveBeenLastCalledWith('GET', '/api/v1/admin/revalidation/preview', null);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/admin/revalidation/preview?scope=tenant&tenantId=t1');
    expect(logAuditEvent).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('只读请求不写审计、不改写请求体', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"runId":41}', { status: 200 }));
    await GET(new NextRequest('https://cloud.test/api/admin/revalidation/runs/41'), { params: Promise.resolve({ path: ['runs', '41'] }) });
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBeUndefined();
    expect(logAuditEvent).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});
