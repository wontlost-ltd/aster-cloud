// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { buildCommands } from '@/components/dashboard/command-palette-commands';

vi.mock('next/navigation', () => ({ usePathname: () => '/zh/dashboard', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/i18n/navigation', () => ({
  // 模拟 next-intl Link：会加上 locale 前缀，用于证明外链项没有走它。
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={`/zh${href}`} {...rest}>{children}</a>
  ),
}));
// 全局 setup 的 lucide mock 只含固定图标集；侧栏需要全部图标，这里用 Proxy 兜底。
vi.mock('lucide-react', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('lucide-react');
  return { ...actual };
});
vi.mock('@/components/docs/docs-overlay-context', () => ({ useDocsOverlay: () => ({ openDocs: vi.fn() }) }));

import { DashboardSidebar } from '@/components/dashboard-sidebar';

const labels = new Proxy({} as Record<string, string>, { get: (_t, k) => String(k) }) as never;
const caps = { riskTier: false, license: false, licenseRevoke: false, issuedLicenses: false, sso: false };
const HREF = '/api/ai-workspace/handoff?next=%2F&locale=zh';

function renderSidebar(aiWorkspaceHref?: string) {
  return render(
    <DashboardSidebar
      localePrefix="/zh"
      isAdmin={false}
      showBilling={false}
      labels={labels}
      adminCapabilities={caps}
      aiWorkspaceHref={aiWorkspaceHref}
    />,
  );
}

describe('侧栏 AI 工作台入口', () => {
  it('传入 href 时渲染原生链接且不加 locale 前缀', () => {
    renderSidebar(HREF);
    const links = screen.getAllByRole('link', { name: 'aiWorkspace' });
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) expect(a.getAttribute('href')).toBe(HREF);
  });

  it('未传 href 时不渲染入口', () => {
    renderSidebar(undefined);
    expect(screen.queryAllByRole('link', { name: 'aiWorkspace' })).toHaveLength(0);
  });
});

describe('命令面板 AI 工作台入口', () => {
  const base = { routePrefix: '/zh', labels: new Proxy({}, { get: (_t, k) => String(k) }) as never };
  it('提供 href 时追加外链命令且不加前缀', () => {
    const cmd = buildCommands({ ...base, aiWorkspace: { label: 'AI workspace', href: HREF } }).find((c) => c.id === 'ai-workspace');
    expect(cmd?.href).toBe(HREF);
    expect(cmd?.external).toBe(true);
  });
  it('未提供时不出现', () => {
    expect(buildCommands(base).some((c) => c.id === 'ai-workspace')).toBe(false);
  });
});
