// @vitest-environment jsdom
/**
 * #774：/dashboard 的 React 水合错误 #418。根因：AdminLaunchpad 用 useState 惰性初始化在客户端首渲时读
 * localStorage，已收起清单的用户在客户端首渲得到 null，而服务端渲染的是完整清单 → 文本 / 结构不一致。
 * 修复后：水合期间与服务端一致，水合完成后再按 localStorage 隐藏，且不产生可恢复错误。
 */
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/docs/docs-overlay-context', () => ({ useDocsOverlay: () => ({ openDocs: vi.fn() }) }));
vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));

import { AdminLaunchpad } from '@/components/dashboard/admin-launchpad';

const step = { label: 'L', desc: 'D', cta: 'C' };
const props = {
  signals: { hasPolicy: true, hasApiKey: false, hasAiKey: false, hasTeammate: false, hasReviewedBilling: false },
  translations: {
    title: 'Get set up', body: 'b', progressTemplate: '{done}/{total}', dismiss: 'Hide this checklist',
    steps: { createPolicy: step, addApiKey: step, addAiKey: step, inviteTeam: step, reviewBilling: step },
  },
};

afterEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
});

describe('AdminLaunchpad hydration (#774)', () => {
  it('hydrates without a mismatch when the user has dismissed it, then hides', async () => {
    // 服务端没有 localStorage：渲染完整清单
    window.localStorage.clear();
    const html = renderToString(<AdminLaunchpad {...props} />);
    expect(html).toContain('Get set up');

    window.localStorage.setItem('aster.admin.launchpad.dismissed', '1');
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, <AdminLaunchpad {...props} />, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Get set up');
  });

  it('stays visible when not dismissed', async () => {
    const html = renderToString(<AdminLaunchpad {...props} />);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, <AdminLaunchpad {...props} />, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Get set up');
  });
});

describe('DashboardSidebar hydration (#774)', () => {
  it('hydrates without a mismatch when the sidebar was collapsed, then collapses', async () => {
    const { DashboardSidebar } = await import('@/components/dashboard-sidebar');
    const labels = new Proxy({} as Record<string, string>, { get: (_t, k) => String(k) }) as never;
    const caps = { riskTier: false, license: false, licenseRevoke: false, issuedLicenses: false, sso: false };
    const tree = <DashboardSidebar localePrefix="" isAdmin={false} showBilling labels={labels} adminCapabilities={caps} />;
    window.localStorage.clear();
    const html = renderToString(tree);
    window.localStorage.setItem('aster.sidebar.collapsed', '1');
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const recoverable = vi.fn();
    await act(async () => {
      hydrateRoot(container, tree, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    // 收起后折叠按钮的名称变为「展开」
    expect(container.querySelector('[aria-label="expandSidebar"]')).not.toBeNull();
  });
});

describe('useLocalStorageFlag after hydration (#774)', () => {
  it('toggling writes storage and updates; a later change from another tab still wins', async () => {
    const { DashboardSidebar } = await import('@/components/dashboard-sidebar');
    const labels = new Proxy({} as Record<string, string>, { get: (_t, k) => String(k) }) as never;
    const caps = { riskTier: false, license: false, licenseRevoke: false, issuedLicenses: false, sso: false };
    const tree = <DashboardSidebar localePrefix="" isAdmin={false} showBilling labels={labels} adminCapabilities={caps} />;
    window.localStorage.clear();
    const container = document.createElement('div');
    container.innerHTML = renderToString(tree);
    document.body.appendChild(container);
    await act(async () => {
      hydrateRoot(container, tree);
    });
    const toggle = () => container.querySelector('[aria-label="collapseSidebar"], [aria-label="expandSidebar"]') as HTMLButtonElement;
    expect(toggle().getAttribute('aria-label')).toBe('collapseSidebar');

    // 本标签页点击：写入存储并收起
    await act(async () => toggle().click());
    expect(window.localStorage.getItem('aster.sidebar.collapsed')).toBe('1');
    expect(toggle().getAttribute('aria-label')).toBe('expandSidebar');

    // 另一个标签页之后改回展开：storage 事件到达后以存储为准（点击不会留下压住外部更新的本地覆盖）
    window.localStorage.setItem('aster.sidebar.collapsed', '0');
    await act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'aster.sidebar.collapsed', newValue: '0' }));
    });
    expect(toggle().getAttribute('aria-label')).toBe('collapseSidebar');
  });

  it('dismissing the launchpad hides it and persists', async () => {
    window.localStorage.clear();
    const container = document.createElement('div');
    container.innerHTML = renderToString(<AdminLaunchpad {...props} />);
    document.body.appendChild(container);
    await act(async () => {
      hydrateRoot(container, <AdminLaunchpad {...props} />);
    });
    const hide = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Hide this checklist') as HTMLButtonElement;
    await act(async () => hide.click());
    expect(container.textContent).not.toContain('Get set up');
    expect(window.localStorage.getItem('aster.admin.launchpad.dismissed')).toBe('1');
  });
});

describe('useLocalStorageFlag without storage (#774)', () => {
  it('still toggles for the session when localStorage throws', async () => {
    const { useLocalStorageFlag } = await import('@/hooks/use-local-storage-flag');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    function Probe() {
      const [on, setOn] = useLocalStorageFlag('aster.test.flag');
      return <button type="button" onClick={() => setOn(!on)}>{on ? 'on' : 'off'}</button>;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { createRoot } = await import('react-dom/client');
    await act(async () => createRoot(container).render(<Probe />));
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.textContent).toBe('off');
    await act(async () => btn.click());
    expect(btn.textContent).toBe('on');
    setItem.mockRestore();
  });
});
