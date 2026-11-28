import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
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
vi.mock('@/lib/prisma', () => ({
  db: {
    insert, transaction,
    // 真实 getSetting 读库：模拟「行缺失」与「DB 报错」两种情形
    query: { platformSettings: { findFirst: vi.fn() } },
  },
  auditLogs: {},
  platformSettings: { key: 'key' },
}));

import { GET, POST } from '@/app/api/admin/platform-settings/route';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { PLATFORM_SETTING_KEYS, getSetting } from '@/lib/platform-settings';
import { db } from '@/lib/prisma';

const IN_APP = PLATFORM_SETTING_KEYS.GUARD_ORPHAN_NOTIFICATIONS_ENABLED;
const EMAIL = PLATFORM_SETTING_KEYS.GUARD_ORPHAN_NOTIFICATIONS_EMAIL_ENABLED;
function request(body: unknown) {
  return new Request('http://localhost/api/admin/platform-settings', { method: 'POST', body: JSON.stringify(body) });
}

describe('guard.orphan_notifications.* 平台开关写入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ userId: 'admin-1' } as never);
    vi.mocked(requireLicenseWriteOk).mockResolvedValue(null);
    getSettingUncached.mockResolvedValue(false);
    insert.mockReturnValue({ values: auditValues.mockResolvedValue(undefined) });
  });

  it('键名与 ADR 0065 一致', () => {
    expect(IN_APP).toBe('guard.orphan_notifications.enabled');
    expect(EMAIL).toBe('guard.orphan_notifications.email.enabled');
  });

  it.each([IN_APP, EMAIL])('%s 非布尔值 "true" → 400 invalid_capability_setting 且不写入', async (key) => {
    const res = await POST(request({ key, value: 'true' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_capability_setting');
    expect(setSetting).not.toHaveBeenCalled();
    expect(setSettingWithClient).not.toHaveBeenCalled();
    expect(auditValues).not.toHaveBeenCalled();
  });

  it.each([IN_APP, EMAIL])('%s 布尔值 → 设置与审计在同一事务写入', async (key) => {
    const res = await POST(request({ key, value: true }));
    expect(res.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(setSettingWithClient).toHaveBeenCalledWith(tx, key, true, 'admin-1');
    expect(setSetting).not.toHaveBeenCalled();
    expect(getSettingUncached).toHaveBeenCalledWith(key, tx);
    expect(invalidateSettingCache).toHaveBeenCalledWith(key);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(auditValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'admin-1', action: 'platform_setting.update', resource: 'platform-setting',
      resourceId: key, metadata: { old: false, new: true },
    }));
  });

  it('非管理员 → 403 且不写入', async () => {
    vi.mocked(requireAdmin).mockResolvedValue(NextResponse.json({ error: 'forbidden' }, { status: 403 }) as never);
    const res = await POST(request({ key: IN_APP, value: true }));
    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
    expect(setSettingWithClient).not.toHaveBeenCalled();
  });
});

describe('guard.orphan_notifications.* 缺省值（fail-OFF）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAdmin).mockResolvedValue({ userId: 'admin-1' } as never);
  });

  it.each([IN_APP, EMAIL])('%s 行缺失 → false', async (key) => {
    vi.mocked(db.query.platformSettings.findFirst).mockResolvedValue(undefined as never);
    expect(await getSetting(key)).toBe(false);
  });

  it.each([IN_APP, EMAIL])('%s DB 报错 → false', async (key) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(db.query.platformSettings.findFirst).mockRejectedValue(new Error('db down'));
    expect(await getSetting(key)).toBe(false);
  });

  it('GET 返回两个新键且缺省 false', async () => {
    vi.mocked(db.query.platformSettings.findFirst).mockResolvedValue(undefined as never);
    const res = await GET();
    const { settings } = await res.json() as { settings: Record<string, { key: string; value: unknown }> };
    const byKey = Object.fromEntries(Object.values(settings).map((s) => [s.key, s.value]));
    expect(byKey[IN_APP]).toBe(false);
    expect(byKey[EMAIL]).toBe(false);
  });
});
