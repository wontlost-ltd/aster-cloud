// @vitest-environment jsdom
/**
 * #774 UI 审计发现的仪表盘无障碍缺陷回归：
 * - 用量卡片的进度条没有可访问名称（axe aria-progressbar-name）
 * - 移动端侧栏抽屉打开后焦点不进入抽屉、Tab 会逃出模态层、关闭后焦点不回到汉堡按钮
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));
vi.mock('@/components/docs/docs-overlay-context', () => ({ useDocsOverlay: () => ({ openDocs: vi.fn() }) }));

import { ApiUsageCard } from '@/components/dashboard/api-usage-card';
import { AiUsageCard } from '@/components/dashboard/ai-usage-card';
import { DashboardSidebar } from '@/components/dashboard-sidebar';

const usage = {
  plan: 'pro',
  period: '2026-11',
  monthly: { used: 10, limit: 100, remaining: 90, percent: 10 },
  latency: { p50: 5, p95: 9, sampleCount: 3 },
  cost: { cents: 120 },
  trend: [],
};

describe('用量卡片进度条', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(usage), { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('API 用量进度条以卡片标题为可访问名称', async () => {
    render(<ApiUsageCard locale="en" />);
    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAccessibleName('dashboard.apiUsage.title');
    expect(bar.getAttribute('aria-valuenow')).toBe('10');
  });

  it('AI 用量进度条以卡片标题为可访问名称', async () => {
    render(<AiUsageCard locale="en" />);
    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAccessibleName(/aiUsage\.title$/);
  });
});

describe('移动端侧栏抽屉的焦点管理', () => {
  const labels = new Proxy({} as Record<string, string>, { get: (_t, k) => String(k) }) as never;
  const caps = { riskTier: false, license: false, licenseRevoke: false, issuedLicenses: false, sso: false };

  function open() {
    render(
      <>
        <DashboardSidebar localePrefix="" isAdmin={false} showBilling labels={labels} adminCapabilities={caps} />
        <button type="button">page content</button>
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'openMenu' });
    trigger.focus();
    fireEvent.click(trigger);
    return { trigger, dialog: screen.getByRole('dialog') };
  }

  it('打开后焦点移入抽屉', async () => {
    const { dialog } = open();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it('Tab / Shift+Tab 在抽屉内循环', async () => {
    const { dialog } = open();
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    const last = focusable[focusable.length - 1];
    act(() => last.focus());
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
    act(() => focusable[0].focus());
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('Esc 关闭后焦点回到汉堡按钮', async () => {
    const { trigger } = open();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
