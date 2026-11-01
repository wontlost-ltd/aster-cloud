// DELETE /api/admin/pilot-applications/{id} —— 管理员删除试点申请
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const m = vi.hoisted(() => ({ requireAdmin: vi.fn(), del: vi.fn(), audit: vi.fn(), isSaas: true }));

vi.mock('@/lib/admin-auth', () => ({ requireAdmin: m.requireAdmin }));
vi.mock('@/lib/audit-log', () => ({ logAuditEvent: m.audit }));
vi.mock('@/lib/pilot-applications', () => ({ deletePilotApplication: m.del }));
vi.mock('@/lib/deployment-mode', () => ({ get IS_SAAS() { return m.isSaas; } }));

import { DELETE } from '@/app/api/admin/pilot-applications/[id]/route';

const call = (id = 'app-1') =>
  DELETE(new Request(`http://localhost/api/admin/pilot-applications/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  m.isSaas = true;
  m.requireAdmin.mockResolvedValue({ userId: 'admin-1' });
  m.del.mockResolvedValue(true);
});

describe('DELETE /api/admin/pilot-applications/{id}', () => {
  it('admin 删除 → 204 并写审计（只记 id）', async () => {
    const res = await call();
    expect(res.status).toBe(204);
    expect(m.del).toHaveBeenCalledWith('app-1');
    expect(m.audit).toHaveBeenCalledWith({
      userId: 'admin-1', action: 'pilot-application.delete', resource: 'pilot-application', resourceId: 'app-1',
    });
  });

  it('不存在 → 404，不写审计', async () => {
    m.del.mockResolvedValue(false);
    expect((await call('missing')).status).toBe(404);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it('非 admin → 透传 403，不删除', async () => {
    m.requireAdmin.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    expect((await call()).status).toBe(403);
    expect(m.del).not.toHaveBeenCalled();
  });

  it('on-prem → 404', async () => {
    m.isSaas = false;
    expect((await call()).status).toBe(404);
    expect(m.requireAdmin).not.toHaveBeenCalled();
  });
});
