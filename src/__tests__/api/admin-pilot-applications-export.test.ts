// /api/admin/pilot-applications/export —— 管理端试点申请 CSV 导出（仅 SaaS + admin）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), list: vi.fn(), isSaas: true }));

vi.mock('@/lib/admin-auth', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/lib/deployment-mode', async () => {
  const actual = await vi.importActual<typeof import('@/lib/deployment-mode')>('@/lib/deployment-mode');
  return { ...actual, get IS_SAAS() { return mocks.isSaas; } };
});
vi.mock('@/lib/pilot-applications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pilot-applications')>('@/lib/pilot-applications');
  return { ...actual, listPilotApplications: mocks.list };
});

import { GET } from '@/app/api/admin/pilot-applications/export/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSaas = true;
  mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1' });
  mocks.list.mockResolvedValue([]);
});

describe('GET /api/admin/pilot-applications/export', () => {
  it('admin → 200 text/csv 附件，不缓存', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="pilot-applications-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store, max-age=0');
    expect((await res.text()).startsWith('createdAt,email,')).toBe(true);
  });

  it('非 admin → 透传 requireAdmin 的 401/403，不读表', async () => {
    mocks.requireAdmin.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    const res = await GET();
    expect(res.status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('on-prem → 404', async () => {
    mocks.isSaas = false;
    expect((await GET()).status).toBe(404);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });
});
