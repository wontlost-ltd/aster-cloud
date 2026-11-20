// 策略包导出的计划门与平台开关（ADR 0059 P2，修订 3 P2-R16）。
// policyExport：free 不可用，trial / pro / team / enterprise 可用；开关 policy_export.package.enabled 缺行为 false。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  db: { query: { platformSettings: { findFirst: (...a: unknown[]) => h.findFirst(...a) } } },
  platformSettings: { key: 'key' },
}));

import { PLANS, hasCapability, type PlanType } from '@/lib/plans';
import {
  PLATFORM_SETTING_KEYS,
  invalidateSettingCache,
  isPolicyPackageExportEnabled,
  isPolicyPackageLayoutExportEnabled,
} from '@/lib/platform-settings';

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSettingCache(PLATFORM_SETTING_KEYS.POLICY_PACKAGE_EXPORT_ENABLED);
  invalidateSettingCache(PLATFORM_SETTING_KEYS.POLICY_PACKAGE_LAYOUT_EXPORT_ENABLED);
});

describe('PlanCapabilities.policyExport', () => {
  it.each<[PlanType, boolean]>([
    ['free', false],
    ['trial', true],
    ['pro', true],
    ['team', true],
    ['enterprise', true],
  ])('%s → %s', (plan, expected) => {
    expect(PLANS[plan].capabilities.policyExport).toBe(expected);
    expect(hasCapability(plan, 'policyExport')).toBe(expected);
  });
});

describe('policy_export.package.enabled', () => {
  it('键名固定', () => {
    expect(PLATFORM_SETTING_KEYS.POLICY_PACKAGE_EXPORT_ENABLED).toBe('policy_export.package.enabled');
  });

  it('缺行时为 false（fail-OFF）', async () => {
    h.findFirst.mockResolvedValue(undefined);
    await expect(isPolicyPackageExportEnabled()).resolves.toBe(false);
  });

  it('只有布尔 true 才算打开', async () => {
    h.findFirst.mockResolvedValue({ key: 'policy_export.package.enabled', value: 'true' });
    await expect(isPolicyPackageExportEnabled()).resolves.toBe(false);
    invalidateSettingCache(PLATFORM_SETTING_KEYS.POLICY_PACKAGE_EXPORT_ENABLED);
    h.findFirst.mockResolvedValue({ key: 'policy_export.package.enabled', value: true });
    await expect(isPolicyPackageExportEnabled()).resolves.toBe(true);
  });

  it('读库失败时为 false', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.findFirst.mockRejectedValue(new Error('db down'));
    await expect(isPolicyPackageExportEnabled()).resolves.toBe(false);
  });
});

describe('policy_export.package.layout.enabled（ADR 0059 修订 4 D13）', () => {
  it('键名固定', () => {
    expect(PLATFORM_SETTING_KEYS.POLICY_PACKAGE_LAYOUT_EXPORT_ENABLED).toBe('policy_export.package.layout.enabled');
  });

  it('缺行时为 false；只有布尔 true 才算打开；读库失败为 false', async () => {
    h.findFirst.mockResolvedValue(undefined);
    await expect(isPolicyPackageLayoutExportEnabled()).resolves.toBe(false);
    invalidateSettingCache(PLATFORM_SETTING_KEYS.POLICY_PACKAGE_LAYOUT_EXPORT_ENABLED);
    h.findFirst.mockResolvedValue({ key: 'policy_export.package.layout.enabled', value: 'true' });
    await expect(isPolicyPackageLayoutExportEnabled()).resolves.toBe(false);
    invalidateSettingCache(PLATFORM_SETTING_KEYS.POLICY_PACKAGE_LAYOUT_EXPORT_ENABLED);
    h.findFirst.mockResolvedValue({ key: 'policy_export.package.layout.enabled', value: true });
    await expect(isPolicyPackageLayoutExportEnabled()).resolves.toBe(true);
    invalidateSettingCache(PLATFORM_SETTING_KEYS.POLICY_PACKAGE_LAYOUT_EXPORT_ENABLED);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    h.findFirst.mockRejectedValue(new Error('db down'));
    await expect(isPolicyPackageLayoutExportEnabled()).resolves.toBe(false);
  });
});
