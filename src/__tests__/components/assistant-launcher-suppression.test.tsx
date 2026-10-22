// @vitest-environment jsdom
import { beforeAll, describe, it, expect, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { act, render, screen } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => 'en',
}));

import { AssistantPanel } from '@/components/assistant/assistant-panel';
import {
  AssistantLauncherSafeArea,
  AssistantProvider,
  useAssistant,
  useSuppressAssistantLauncher,
} from '@/components/assistant/assistant-context';

/**
 * F1/F25：悬浮助手按钮曾盖住编辑器 AI 面板的「发送」与仪表盘底部的「查看全部」。
 * - AI tab 打开期间让出按钮（那里本身就是 AI 入口）；
 * - 按钮显示时页面末尾留出安全区，滚到底不会有内容压在按钮下。
 */

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

const handle: { current: ReturnType<typeof useAssistant> } = { current: null };
function Controls() {
  const state = useAssistant();
  useEffect(() => {
    handle.current = state;
  });
  return null;
}

const toggles: { setA?: (v: boolean) => void; setB?: (v: boolean) => void } = {};
function Suppressor({ name, initial }: { name: 'setA' | 'setB'; initial: boolean }) {
  const [active, setActive] = useState(initial);
  useEffect(() => {
    toggles[name] = setActive;
  }, [name]);
  useSuppressAssistantLauncher(active);
  return null;
}

const launcher = () => screen.queryByRole('button', { name: 'open' });
const safeArea = () => screen.queryByTestId('assistant-launcher-safe-area');

function renderAll(children: React.ReactNode = null) {
  render(
    <AssistantProvider>
      <Controls />
      {children}
      <AssistantLauncherSafeArea />
      <AssistantPanel />
    </AssistantProvider>,
  );
  act(() => handle.current!.setEnabled(true));
}

describe('悬浮助手按钮让位', () => {
  it('按钮显示时页面末尾有安全区；面板展开或助手关闭（按钮消失）时安全区随之消失', () => {
    renderAll();
    expect(launcher()).not.toBeNull();
    expect(safeArea()).not.toBeNull();

    act(() => handle.current!.setOpen(true));
    expect(launcher()).toBeNull();
    expect(safeArea()).toBeNull();

    act(() => handle.current!.setOpen(false));
    act(() => handle.current!.setEnabled(false));
    expect(safeArea()).toBeNull();
  });

  it('★申请让出期间按钮与安全区都不渲染，释放后恢复', () => {
    renderAll(<Suppressor name="setA" initial />);
    expect(launcher()).toBeNull();
    expect(safeArea()).toBeNull();

    act(() => toggles.setA!(false));
    expect(launcher()).not.toBeNull();
    expect(safeArea()).not.toBeNull();
  });

  it('多个申请方按计数叠加：一方释放不让按钮提前回来', () => {
    renderAll(
      <>
        <Suppressor name="setA" initial />
        <Suppressor name="setB" initial />
      </>,
    );
    act(() => toggles.setA!(false));
    expect(launcher()).toBeNull();
    act(() => toggles.setB!(false));
    expect(launcher()).not.toBeNull();
  });

  it('让出不改变助手开关与已展开的面板', () => {
    renderAll(<Suppressor name="setA" initial />);
    act(() => handle.current!.setOpen(true));
    expect(screen.getByRole('complementary')).toBeTruthy();
    expect(handle.current!.enabled).toBe(true);
  });

  it('Provider 之外调用 hook 不抛错', () => {
    function Bare() {
      useSuppressAssistantLauncher(true);
      return <span>ok</span>;
    }
    render(<Bare />);
    expect(screen.getByText('ok')).toBeTruthy();
  });
});
