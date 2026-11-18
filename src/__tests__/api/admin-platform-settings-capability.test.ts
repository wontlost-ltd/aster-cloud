import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn() }));
vi.mock('@/lib/license-write-gate', () => ({ requireLicenseWriteOk: vi.fn() }));
const { setSetting, setSettingWithClient, invalidateSettingCache, getSettingUncached, insert, auditValues, transaction, tx } = vi.hoisted(() => {
  const insert = vi.fn();
  const tx = { insert };
  return {
    setSetting: vi.fn(), setSettingWithClient: vi.fn(), invalidateSettingCache: vi.fn(),
    getSettingUncached: vi.fn(), insert, auditValues: vi.fn(), tx,
    transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
});
vi.mock('@/lib/platform-settings', async (original) => ({
  ...(await original<typeof import('@/lib/platform-settings')>()),
  setSetting, setSettingWithClient, invalidateSettingCache, getSettingUncached,
}));
vi.mock('@/lib/prisma', () => ({ db: { insert, transaction }, auditLogs: {} }));

import { POST } from '@/app/api/admin/platform-settings/route';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { PLATFORM_SETTING_KEYS, getSetting } from '@/lib/platform-settings';

const ENABLED = PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_ENABLED;
const DELEGATION = PLATFORM_SETTING_KEYS.STRUCTURED_AUTHORING_TEAM_DELEGATION;
const PACKAGE_EXPORT = PLATFORM_SETTING_KEYS.POLICY_PACKAGE_EXPORT_ENABLED;
function request(body: unknown) {
  return new Request('http://localhost/api/admin/platform-settings', { method: 'POST', body: JSON.stringify(body) });
}

describe('capability.* 平台开关写入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ userId: 'admin-1' } as never);
    vi.mocked(requireLicenseWriteOk).mockResolvedValue(null);
    getSettingUncached.mockResolvedValue(false);
    insert.mockReturnValue({ values: auditValues.mockResolvedValue(undefined) });
  });

  it.each([ENABLED, DELEGATION, PACKAGE_EXPORT])('%s 非布尔值 → 400 invalid_capability_setting 且不写入', async (key) => {
    const res = await POST(request({ key, value: 'yes' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_capability_setting');
    expect(setSetting).not.toHaveBeenCalled();
    expect(setSettingWithClient).not.toHaveBeenCalled();
    expect(auditValues).not.toHaveBeenCalled();
  });

  it('布尔值 → 200 并写 platform_setting.update 审计（含旧值与新值）', async () => {
    const res = await POST(request({ key: ENABLED, value: true }));
    expect(res.status).toBe(200);
    expect(setSettingWithClient).toHaveBeenCalledWith(tx, ENABLED, true, 'admin-1');
    expect(setSetting).not.toHaveBeenCalled();
    expect(getSettingUncached).toHaveBeenCalledWith(ENABLED, tx);
    expect(invalidateSettingCache).toHaveBeenCalledWith(ENABLED);
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1', action: 'platform_setting.update', resource: 'platform-setting',
      resourceId: ENABLED, metadata: { old: false, new: true },
    }));
  });

  it('审计写入失败 → 不返回 200 { ok: true }（500）', async () => {
    auditValues.mockRejectedValueOnce(new Error('db down'));
    const res = await POST(request({ key: ENABLED, value: true }));
    expect(res.status).toBe(500);
    expect(await res.json()).not.toEqual({ ok: true });
    // 写入发生在事务客户端上、事务因审计失败而 reject；事务外没有任何直接写入，缓存也未失效
    expect(transaction).toHaveBeenCalledTimes(1);
    await expect(transaction.mock.results[0].value).rejects.toThrow('db down');
    expect(setSettingWithClient).toHaveBeenCalledWith(tx, ENABLED, true, 'admin-1');
    expect(setSetting).not.toHaveBeenCalled();
    expect(invalidateSettingCache).not.toHaveBeenCalled();
  });

  it('团队委派开关同样写审计', async () => {
    getSettingUncached.mockResolvedValue(true);
    const res = await POST(request({ key: DELEGATION, value: false }));
    expect(res.status).toBe(200);
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: DELEGATION, metadata: { old: true, new: false },
    }));
  });

  it('策略包导出开关（ADR 0059 P2）同样要求布尔值并写审计', async () => {
    const res = await POST(request({ key: PACKAGE_EXPORT, value: true }));
    expect(res.status).toBe(200);
    expect(setSettingWithClient).toHaveBeenCalledWith(tx, PACKAGE_EXPORT, true, 'admin-1');
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: PACKAGE_EXPORT, metadata: { old: false, new: true },
    }));
  });

  it('非 capability.* 键不写审计（现状不变）', async () => {
    const res = await POST(request({ key: PLATFORM_SETTING_KEYS.POLICY_SHARING_ENABLED, value: true }));
    expect(res.status).toBe(200);
    expect(setSetting).toHaveBeenCalled();
    expect(auditValues).not.toHaveBeenCalled();
  });
});

describe('capability 开关缺行默认值', () => {
  it('structured_authoring 缺行默认 false，团队委派缺行默认 true', async () => {
    // 未 mock 的真实 getSetting 在 DB 不可用时走 fail-OFF 分支，返回 DEFAULTS
    expect(await getSetting(ENABLED)).toBe(false);
    expect(await getSetting(DELEGATION)).toBe(true);
  });
});
