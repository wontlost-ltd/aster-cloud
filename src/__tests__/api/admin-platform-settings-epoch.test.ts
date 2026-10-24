import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn() }));
const { setSetting, getSettingUncached, insert, auditValues } = vi.hoisted(() => ({ setSetting: vi.fn(), getSettingUncached: vi.fn(), insert: vi.fn(), auditValues: vi.fn() }));
vi.mock('@/lib/platform-settings', async (original) => ({ ...(await original<typeof import('@/lib/platform-settings')>()), setSetting, getSettingUncached }));
vi.mock('@/lib/prisma', () => ({ db: { insert }, auditLogs: {} }));

import { POST } from '@/app/api/admin/platform-settings/route';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { PLATFORM_SETTING_KEYS } from '@/lib/platform-settings';

function request(body: unknown) { return new Request('http://localhost/api/admin/platform-settings', { method: 'POST', body: JSON.stringify(body) }); }
describe('auth.dbEpoch 写入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ userId: 'admin-1' } as never);
    vi.mocked(requireLicenseWriteOk).mockResolvedValue(null);
    getSettingUncached.mockResolvedValue(3);
    insert.mockReturnValue({ values: auditValues.mockResolvedValue(undefined) });
  });
  it.each([
    { value: 0, confirm: 'logout-all' }, { value: -1, confirm: 'logout-all' },
    { value: 3, confirm: 'logout-all' }, { value: 4 },
  ])('拒绝无效 bump %#', async ({ value, confirm }) => {
    const response = await POST(request({ key: PLATFORM_SETTING_KEYS.AUTH_DB_EPOCH, value, confirm }));
    expect(response.status).toBe(400);
    expect(setSetting).not.toHaveBeenCalled();
  });
  it('递增并写入 oldEpoch/newEpoch 审计字段', async () => {
    const response = await POST(request({ key: PLATFORM_SETTING_KEYS.AUTH_DB_EPOCH, value: 4, confirm: 'logout-all' }));
    expect(response.status).toBe(200);
    expect(setSetting).toHaveBeenCalledWith(PLATFORM_SETTING_KEYS.AUTH_DB_EPOCH, 4, 'admin-1');
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ oldEpoch: 3, newEpoch: 4 }) }));
  });
});
