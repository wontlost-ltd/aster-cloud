// UserDropdown 的「帮助」「关于」两项 + AboutDialog 组件测试。
//
// 覆盖：
//   - 「帮助」是指向 /docs 的链接，不再打开版本弹框（生产 E2E F27）
//   - 点「关于」→ 关闭下拉 + 打开弹框，五行版本齐全
//   - 后端版本为 null → 显示「不可用」而非空白/崩溃
//   - a11y：role=dialog / aria-modal / aria-labelledby 指向标题
//   - Esc 关闭、点关闭按钮关闭、点遮罩关闭；点内容不关闭（防误关）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));
vi.mock('@/lib/docs/use-docs-session', () => ({ clearDocsSessionCache: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { UserDropdown } from '@/components/dashboard-nav';
import { AboutDialog } from '@/components/about-dialog';

const LABELS = {
  profile: '用户菜单',
  settings: '设置',
  signOut: '退出登录',
  signingOut: '退出中…',
  help: '帮助',
  about: '关于 Aster Cloud',
};

const ABOUT_LABELS = {
  title: '关于 Aster Cloud',
  version: '版本',
  build: '构建',
  engine: '引擎',
  messages: '文案包',
  apiVersion: '后端 API',
  unavailable: '不可用',
  close: '关闭',
};

const VERSIONS = {
  app: '0.0.9',
  build: 'a3f21c9d8e01',
  engine: '1.0.18',
  messages: '1.0.11',
  api: '1.0.18',
};

afterEach(() => cleanup());

describe('UserDropdown → 帮助 / 关于', () => {
  function openMenu() {
    render(
      <UserDropdown
        userMenuLabels={LABELS}
        aboutLabels={ABOUT_LABELS}
        versions={VERSIONS}
        userName="Ryan"
        userEmail="ryan@example.com"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '用户菜单' }));
  }

  it('「帮助」是指向文档站的链接，不打开版本弹框', () => {
    openMenu();
    const help = screen.getByRole('link', { name: '帮助' });
    expect(help.getAttribute('href')).toBe('/docs');
    expect(screen.queryByRole('button', { name: '帮助' })).toBeNull();
    fireEvent.click(help);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('点「关于」打开弹框并关闭下拉，五行版本齐全', () => {
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: '关于 Aster Cloud' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeTruthy();
    // 下拉已关（「设置」链接消失）——避免菜单浮在弹框上
    expect(screen.queryByRole('link', { name: '设置' })).toBeNull();

    for (const [label, value] of [
      ['版本', '0.0.9'],
      ['构建', 'a3f21c9d8e01'],
      ['引擎', '1.0.18'],
      ['文案包', '1.0.11'],
      ['后端 API', '1.0.18'],
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
    }
  });
});

describe('AboutDialog', () => {
  let onClose: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    onClose = vi.fn<() => void>();
  });

  function renderDialog(api: string | null = '1.0.18') {
    render(
      <AboutDialog
        labels={ABOUT_LABELS}
        versions={{ ...VERSIONS, api }}
        onClose={onClose}
      />,
    );
  }

  it('后端版本取不到时显示「不可用」（不空白、不崩）', () => {
    renderDialog(null);
    expect(screen.getByText('不可用')).toBeTruthy();
  });

  it('a11y：role=dialog + aria-modal + aria-labelledby 指向标题', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBe('about-dialog-title');
    expect(document.getElementById(labelledBy!)?.textContent).toBe('关于 Aster Cloud');
  });

  it('Esc 关闭', () => {
    renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点「关闭」按钮关闭', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('点遮罩关闭，点弹框内容不关闭（防误关）', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    // 点内容区：stopPropagation 应拦住
    fireEvent.click(screen.getByText('关于 Aster Cloud'));
    expect(onClose).not.toHaveBeenCalled();
    // 点遮罩本身：应关闭
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
