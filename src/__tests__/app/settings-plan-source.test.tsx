import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const h = vi.hoisted(() => ({
  getUsageStats: vi.fn(),
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/en/settings',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
// 页面内的客户端组件（如 ConfirmDialog 包装）在静态渲染时也会调用 useTranslations。
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key, useLocale: () => 'en' }));
vi.mock('@/i18n/navigation', () => ({ Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/lib/auth', () => ({ getSession: async () => ({ user: { id: 'user-1', name: 'A', email: 'a@example.com', plan: 'free' } }) }));
vi.mock('@/lib/usage', () => ({ getUsageStats: h.getUsageStats }));
vi.mock('@/lib/business-roles', () => ({ loadBusinessRoles: async () => [] }));
vi.mock('@/lib/platform-settings', () => ({ getSetting: async () => true, PLATFORM_SETTING_KEYS: { ASSISTANT_ENABLED: 'assistant.enabled' } }));
vi.mock('@/components/settings/settings-client', () => ({
  LocaleDetectionToggle: () => null,
  AssistantToggle: () => null,
  AiInlineCompletionToggle: () => null,
  SignOutButton: () => null,
  DeleteAccountFlow: () => null,
}));
vi.mock('@/components/settings/totp-panel', () => ({ TotpPanel: () => null }));
vi.mock('@/components/settings/trusted-devices-panel', () => ({ TrustedDevicesPanel: () => null }));
vi.mock('@/components/settings/email-verification-panel', () => ({ EmailVerificationPanel: () => null }));
vi.mock('@/components/settings/change-password-panel', () => ({ ChangePasswordPanel: () => null }));
vi.mock('@/components/settings/business-roles-panel', () => ({ BusinessRolesPanel: () => null }));

import SettingsPage from '@/app/[locale]/(dashboard)/settings/page';

describe('Settings 套餐来源', () => {
  it('展示数据库中的套餐映射，而不是 session JWT 中的旧套餐', async () => {
    h.getUsageStats.mockResolvedValue({ plan: 'team' });

    const html = renderToStaticMarkup(await SettingsPage({ params: Promise.resolve({ locale: 'en' }) }));

    expect(html).toContain('pro');
    expect(html).not.toContain('>free<');
    expect(h.getUsageStats).toHaveBeenCalledWith('user-1');
  });
});
