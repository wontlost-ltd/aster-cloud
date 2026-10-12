import { beforeAll, describe, it, expect, vi } from 'vitest';
import { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';

vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
}));

import { StatusBar } from '@/components/policy/policy-form/status-bar';
import { AssistantPanel } from '@/components/assistant/assistant-panel';
import { AssistantProvider, useAssistant } from '@/components/assistant/assistant-context';

/**
 * 状态栏右端（⌘K 提示）曾被右下角悬浮助手按钮盖住。
 * 状态栏须在且仅在按钮显示时右侧让位；判断与 AssistantPanel 同源，故两者一起渲染比对。
 */

// jsdom 未实现 scrollIntoView；助手面板展开时会调用它
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

const baseProps = { content: '', cnlLocale: 'zh', isDirty: false, lastSavedAt: 0 };

const handle: { current: ReturnType<typeof useAssistant> } = { current: null };
function Controls() {
  const state = useAssistant();
  useEffect(() => {
    handle.current = state;
  });
  return null;
}
const controls = () => handle.current!;

function renderWithAssistant() {
  return render(
    <AssistantProvider>
      <Controls />
      <StatusBar {...baseProps} />
      <AssistantPanel />
    </AssistantProvider>,
  );
}

const footer = () => screen.getByTestId('policy-status-bar');
const launcher = () => screen.queryByRole('button', { name: 'open' });
const reserves = () => footer().className.split(/\s+/).includes('mr-20');

describe('状态栏给悬浮助手按钮让位', () => {
  it('没有 AssistantProvider 时不让位', () => {
    render(<StatusBar {...baseProps} />);
    expect(reserves()).toBe(false);
    expect(footer().className).toContain('mr-4');
  });

  it('★按钮显示时让位；关闭助手或展开面板（按钮消失）后取消让位', () => {
    renderWithAssistant();
    act(() => controls().setEnabled(true));
    expect(launcher()).not.toBeNull();
    expect(reserves()).toBe(true);

    act(() => controls().setOpen(true));
    expect(launcher()).toBeNull();
    expect(screen.getByRole('complementary')).toBeTruthy();
    expect(reserves()).toBe(false);

    act(() => controls().setOpen(false));
    expect(launcher()).not.toBeNull();
    expect(reserves()).toBe(true);

    act(() => controls().setEnabled(false));
    expect(launcher()).toBeNull();
    expect(reserves()).toBe(false);
  });
});

describe('状态栏让位：服务端首帧', () => {
  // 服务端与客户端首帧 hydrating=true，面板不渲染按钮；状态栏此时也不能让位，
  // 否则 SSR HTML 与挂载后不一致，页面加载时右端会跳一下
  it('★hydrating 期间不让位，与面板不渲染按钮一致', () => {
    const html = renderToString(
      <AssistantProvider>
        <StatusBar {...baseProps} />
        <AssistantPanel />
      </AssistantProvider>,
    );
    expect(html).not.toContain('aria-label="open"');
    const footerTag = html.match(/<footer[^>]*>/)![0];
    expect(footerTag).not.toMatch(/\bmr-20\b/);
    expect(footerTag).toMatch(/\bmr-4\b/);
  });
});

describe('状态栏警示文字颜色', () => {
  // text-warning-fg 是「实底警示色上的前景色」（亮色 #fff / 暗色 #09090b），
  // 放在浅底状态栏上对比度仅 1.04 / 1.12；text-warning 为 4.81 / 8.25（线上实测）
  it('★未保存更改用 text-warning，而非实底前景色 text-warning-fg', () => {
    render(<StatusBar {...baseProps} isDirty />);
    const cls = screen.getByText('statusUnsaved').className.split(/\s+/);
    expect(cls).toContain('text-warning');
    expect(cls).not.toContain('text-warning-fg');
  });

  it('★编译警告徽标用 text-warning', () => {
    render(
      <StatusBar
        {...baseProps}
        compileState="ok"
        compileDiagnostics={[{ severity: 'warning', message: 'w', startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }]}
      />,
    );
    const chip = screen.getByText('compileWarnings').closest('span')!;
    expect(chip.className.split(/\s+/)).toContain('text-warning');
    expect(chip.className).not.toContain('text-warning-fg');
  });
});
